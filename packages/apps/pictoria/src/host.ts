import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeHost, ApplicationDataLease } from '@infos/node-host'
import { validateApplicationDiscovery, type NodeProvider } from '@infos/node-sdk'
import type { ApplicationDiscoveryRecord } from '@infos/shared'
import { identifier, object, type HostPort } from './domain'
import { Store } from './store'
import { PictoriaApplication } from './application'
import { operations, pictoriaManifest } from './manifest'
import { BrowserSurface } from './browserSurface'

export function bridgeKey(dataPath: string): string {
  mkdirSync(dataPath, { recursive: true })
  const target = path.join(dataPath, 'bridge.key')
  try {
    writeFileSync(target, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const key = readFileSync(target, 'utf8').trim()
  if (!/^[\da-f]{64}$/.test(key)) throw new Error('应用桥接密钥损坏')
  return key
}
export function authorized(actual: unknown, key: string): boolean {
  return (
    typeof actual === 'string' &&
    Buffer.byteLength(actual) === Buffer.byteLength(key) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(key))
  )
}

export class PictoriaHost {
  readonly nodeHost: NodeHost
  readonly application: PictoriaApplication
  readonly instanceId = randomUUID()
  private http?: Server
  private discovery?: ApplicationDiscoveryRecord
  private readonly lease: ApplicationDataLease
  private started = false
  private browser?: BrowserSurface
  browserUrl?: string
  private stopping?: Promise<void>
  readonly key: string
  constructor(
    readonly options: {
      dataPath: string
      discoveryPath: string
      migrationRoot?: string
      host?: HostPort
      standalone?: boolean
      httpPort?: number
      uiRoot?: string
      developmentUi?: boolean
      bindDesktop?: (value: unknown) => Promise<void>
      shutdown?: () => Promise<void>
    },
  ) {
    this.key = bridgeKey(options.dataPath)
    this.lease = new ApplicationDataLease(options.dataPath)
    try {
      this.nodeHost = new NodeHost({
        identityPath: path.join(options.dataPath, 'identity.json'),
        displayName: 'Pictoria',
        facets: ['application', 'capability', 'storage'],
        application: {
          protocolVersion: 1,
          appId: pictoriaManifest.id,
          instanceId: this.instanceId,
          name: 'Pictoria',
          appVersion: '0.9.6',
          adapterVersion: '1.0.0',
          state: 'ready',
          endpoints: pictoriaManifest.endpoints,
        },
      })
      const root =
        options.migrationRoot ?? fileURLToPath(new URL('./database/migrations', import.meta.url))
      this.application = new PictoriaApplication(new Store(options.dataPath, root), options.host)
      if (options.standalone)
        this.browser = new BrowserSurface(
          this.application,
          options.uiRoot ?? fileURLToPath(new URL('../client/dist', import.meta.url)),
          options.developmentUi,
          () => (options.shutdown ? options.shutdown() : this.stop()),
        )
      this.nodeHost.register(this.provider())
    } catch (error) {
      this.lease.release()
      throw error
    }
  }
  async start(): Promise<{ websocketPort: number; httpPort: number }> {
    if (this.started) throw new Error('应用已启动')
    try {
      await this.nodeHost.start()
      const websocketPort = await this.nodeHost.listenLoopback(0)
      this.http = createServer((req, res) => {
        void this.handle(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: '应用请求失败' }))
          } else res.destroy()
        })
      })
      await new Promise<void>((resolve, reject) => {
        this.http!.once('error', reject)
        this.http!.listen(this.options.httpPort ?? 0, '127.0.0.1', resolve)
      })
      const address = this.http.address()
      if (!address || typeof address === 'string') throw new Error('应用端口不可用')
      this.browserUrl = this.browser?.entry(`http://127.0.0.1:${address.port}`)
      this.discovery = validateApplicationDiscovery({
        protocolVersion: 1,
        applicationProtocolVersion: 1,
        application: this.nodeHost.hello().application!,
        nodeId: this.nodeHost.identity.descriptor.nodeId,
        pid: process.pid,
        generation: Date.now(),
        carrier: 'websocket',
        endpoint: `ws://127.0.0.1:${websocketPort}`,
        startedAt: new Date().toISOString(),
      })
      mkdirSync(path.dirname(this.options.discoveryPath), { recursive: true })
      const temporary = `${this.options.discoveryPath}.${this.instanceId}.tmp`
      writeFileSync(
        temporary,
        JSON.stringify({ ...this.discovery, httpEndpoint: `http://127.0.0.1:${address.port}` }),
        { mode: 0o600 },
      )
      renameSync(temporary, this.options.discoveryPath)
      this.started = true
      this.application.execution.start()
      return { websocketPort, httpPort: address.port }
    } catch (error) {
      await this.stop()
      throw error
    }
  }
  stop(): Promise<void> {
    this.stopping ??= this.close()
    return this.stopping
  }
  private async close(): Promise<void> {
    await this.application.execution.stop()
    await this.nodeHost.stop()
    if (this.http) {
      this.http.closeAllConnections()
      await new Promise<void>((resolve) => this.http!.close(() => resolve()))
      this.http = undefined
    }
    if (existsSync(this.options.discoveryPath)) {
      try {
        const record = JSON.parse(
          readFileSync(this.options.discoveryPath, 'utf8'),
        ) as ApplicationDiscoveryRecord
        if (record.application.instanceId === this.instanceId) rmSync(this.options.discoveryPath)
      } catch {
        /* 保留不属于当前实例的发现记录。 */
      }
    }
    this.started = false
    this.application.store.close()
    this.lease.release()
  }
  private async dispatch(
    operation: string,
    input: Record<string, unknown>,
    owner: string,
    key?: string,
  ): Promise<unknown> {
    const { __applicationAuth, __callId, ...value } = input
    if (!authorized(__applicationAuth, this.key)) throw new Error('应用调用未授权')
    if (operation === 'events.list') return this.application.store.events()
    if (operation === 'events.ack') {
      this.application.store.acknowledge(String(value.eventId))
      return { acknowledged: true }
    }
    if (operation === 'tool.execute') {
      const actions: Record<string, string> = {
        catalog: 'catalog.get',
        run: 'task.submit',
        get: 'task.get',
        list: 'task.list',
        cancel: 'task.cancel',
        resume: 'task.resume',
        canvas: 'project.save',
      }
      const target = actions[String(value.action)]
      if (!target) throw new Error('工具操作无效')
      return this.application.invoke(target, value, {
        owner,
        key,
        callId: typeof __callId === 'string' ? __callId : undefined,
      })
    }
    return this.application.invoke(operation, value, {
      owner,
      key,
      callId: typeof __callId === 'string' ? __callId : undefined,
    })
  }
  private provider(): NodeProvider {
    return {
      manifest: {
        manifestVersion: 1,
        providerId: 'infos.pictoria.creative',
        name: 'Pictoria 创作服务',
        version: '1.0.0',
        definition: {
          capabilityType: 'media.creative',
          contractVersion: '1.0',
          operations: Object.fromEntries(
            operations.map((operation) => [
              operation,
              {
                risk:
                  operation.endsWith('.get') || operation.endsWith('.list') ? 'read' : 'interact',
                idempotency: operation === 'task.submit' ? 'keyed' : 'unsafe',
              },
            ]),
          ),
        },
        offer: {
          offerId: `pictoria:${this.nodeHost.identity.descriptor.nodeId}`,
          capabilityType: 'media.creative',
          contractVersion: '1.0',
          operations: [...operations],
          resourceKinds: ['image', 'video', 'text'],
        },
      },
      invoke: async (envelope, context) => {
        context.signal.throwIfAborted()
        return this.dispatch(
          envelope.payload.operation,
          object(envelope.payload.input),
          envelope.principalId,
          context.idempotencyKey ?? context.invocationId,
        )
      },
    }
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = this.http?.address()
    if (
      this.browser &&
      address &&
      typeof address !== 'string' &&
      (await this.browser.handle(req, res, `http://127.0.0.1:${address.port}`))
    )
      return
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (!authorized(req.headers.authorization?.replace(/^Bearer /, ''), this.key)) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: '应用请求未授权' }))
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const owner =
      typeof req.headers['x-application-owner'] === 'string'
        ? req.headers['x-application-owner']
        : ''
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        res.end(
          JSON.stringify({
            ready: this.started,
            instanceId: this.instanceId,
            appId: pictoriaManifest.id,
          }),
        )
        return
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        res.writeHead(202)
        res.end(JSON.stringify({ stopping: true }))
        setImmediate(() => {
          void (this.options.shutdown ? this.options.shutdown() : this.stop()).catch(() => {
            process.exitCode = 1
          })
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/lifecycle/desktop') {
        if (!this.options.bindDesktop || this.options.standalone)
          throw new Error('当前实例不接受桌面生命周期绑定')
        const parts: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk)
          if (size > 1024) throw new Error('桌面绑定请求过大')
          parts.push(Buffer.from(chunk))
        }
        await this.options.bindDesktop(JSON.parse(Buffer.concat(parts).toString('utf8')))
        res.end(JSON.stringify({ bound: true }))
        return
      }
      identifier.parse(owner)
      if (req.method === 'POST' && url.pathname === '/assets') {
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of req) {
          length += Buffer.byteLength(chunk)
          if (length > 100 * 1024 * 1024) throw new Error('素材超过 100 MB 限制')
          chunks.push(Buffer.from(chunk))
        }
        const name =
          typeof req.headers['x-file-name'] === 'string'
            ? decodeURIComponent(req.headers['x-file-name'])
            : '素材'
        const asset = await this.application.assets.save(
          owner,
          name,
          req.headers['content-type'] ?? 'application/octet-stream',
          Buffer.concat(chunks),
        )
        res.end(JSON.stringify({ assetId: asset.id }))
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const asset = this.application.store.asset(url.pathname.slice(8), owner)
        let start = 0
        let end = asset.sizeBytes - 1
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
          if (!match) {
            res.writeHead(416)
            res.end()
            return
          }
          start = Number(match[1])
          end = match[2] ? Math.min(end, Number(match[2])) : end
          if (start > end || start >= asset.sizeBytes) {
            res.writeHead(416)
            res.end()
            return
          }
          res.statusCode = 206
          res.setHeader('content-range', `bytes ${start}-${end}/${asset.sizeBytes}`)
        }
        res.setHeader('content-type', asset.mimeType)
        res.setHeader('content-length', end - start + 1)
        res.setHeader('accept-ranges', 'bytes')
        res.setHeader('content-security-policy', "sandbox; default-src 'none'")
        res.setHeader('x-content-type-options', 'nosniff')
        createReadStream(this.application.assets.path(asset), { start, end })
          .on('error', () => res.destroy())
          .pipe(res)
        return
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/operations/')) {
        res.writeHead(404)
        res.end()
        return
      }
      const parts: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk)
        if (size > 32 * 1024 * 1024) throw new Error('请求内容过大')
        parts.push(Buffer.from(chunk))
      }
      const input = object(JSON.parse(Buffer.concat(parts).toString('utf8')))
      const operation = decodeURIComponent(url.pathname.slice(12))
      const output = await this.dispatch(
        operation,
        { ...input, __applicationAuth: this.key },
        owner,
        typeof req.headers['idempotency-key'] === 'string'
          ? req.headers['idempotency-key']
          : undefined,
      )
      res.end(JSON.stringify({ data: output }))
    } catch (error) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : '请求无效' }))
    }
  }
}
