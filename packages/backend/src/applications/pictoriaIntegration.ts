import { t as __t } from '../lib/i18n'
import { createServer, type Server } from 'node:http'
import { createReadStream, readFileSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import path from 'node:path'
import {
  authorized,
  bridgeKey,
  requestFingerprint,
  readDismissedCanvasRuns,
  pictoriaManifest,
  type Asset,
  type Run,
  type Step,
  desktopGuardSchema,
  watchDesktopGuard,
  type DesktopGuard,
} from '@infos/pictoria'
import type { KernelNodeId, TaskOrigin, ApplicationCreativePort } from '@infos/shared'
import type { AppContext } from '../container'
import type { ApplicationToolDeclaration } from './applicationToolManager'
import type { CapabilityDirectory } from '../kernel/capabilityDirectory'
import type { CapabilityHandleRegistry } from '../kernel/capabilityHandleRegistry'
import type { NodeRegistry } from '../kernel/nodeRegistry'
import type { ToolContext, ToolRegistry } from '../services/agent/toolRegistry'
import type { ToolDefinition } from '../services/pipeline/types'
import type { ModelRoleResolver } from '../services/llm/modelRoles'
import { ApplicationFederationConnector } from '../capabilities/arcaFederationConnector'
import { ApplicationController, type ApplicationControllerOptions } from './applicationController'
import { ApplicationCapabilityRuntime } from './applicationCapabilityRuntime'
import { ApplicationCallRepository } from '../repositories/applicationCall.repo'
import { boundedResourceBytes, downloadResource } from '../services/attachment/resourceSource'
import type { TaskDeliveryService } from '../services/task/taskDeliveryService'
import { createLogger } from '../lib/logger'

import { PictoriaDelivery, assetIds } from './pictoriaDelivery'

const logger = createLogger('PictoriaIntegration')
type Dependencies = Pick<
  AppContext,
  | 'db'
  | 'configRepo'
  | 'threadService'
  | 'resourceService'
  | 'attachmentService'
  | 'llmService'
  | 'applicationIntegration'
  | 'conversationProjection'
  | 'gatewayHub'
  | 'kernelOutboxRepo'
> & { modelRoles: ModelRoleResolver }
type Paths = Omit<
  ApplicationControllerOptions,
  'applicationId' | 'directoryName' | 'environmentPrefix' | 'environment'
>
export class PictoriaIntegration {
  readonly federation: ApplicationFederationConnector
  readonly controller: ApplicationController
  readonly runtime: ApplicationCapabilityRuntime
  readonly calls: ApplicationCallRepository
  private readonly resultDelivery: PictoriaDelivery
  private readonly key: string
  private readonly callbackKey = randomBytes(32).toString('hex')
  private callback?: Server
  private callbackUrl = ''
  private timer?: ReturnType<typeof setInterval>
  private activeFlush?: Promise<void>
  private readonly shutdownSignal = new AbortController()
  private enabled = true
  private releaseDefinition?: () => void
  private releaseManifest?: () => void
  private closing = false
  private desktopGuard?: DesktopGuard
  private desktopWatch?: ReturnType<typeof watchDesktopGuard>
  private desktopLost = false
  private starting?: Promise<ReturnType<ApplicationController['status']>>
  private readonly deliveryRoot: string
  private readonly dataPath: string
  private releaseNotifications?: () => void
  private social?: {
    authorize: (origin: TaskOrigin) => Promise<string | undefined>
    delivery: TaskDeliveryService
  }
  constructor(
    private readonly deps: Dependencies,
    private readonly tools: ToolRegistry,
    paths: Paths,
    directory: CapabilityDirectory,
    handles: CapabilityHandleRegistry,
    nodes: NodeRegistry,
    applicationTools: ApplicationToolDeclaration,
    localNodeId: KernelNodeId,
  ) {
    this.key = bridgeKey(paths.dataPath)
    this.dataPath = paths.dataPath
    this.deliveryRoot = path.join(paths.dataPath, 'host-deliveries')
    this.calls = new ApplicationCallRepository(deps.db)
    this.federation = new ApplicationFederationConnector(
      paths.discoveryPath,
      localNodeId,
      directory,
      nodes,
      pictoriaManifest.id,
    )
    this.controller = new ApplicationController(this.federation, {
      ...paths,
      applicationId: pictoriaManifest.id,
      directoryName: 'pictoria',
      environmentPrefix: 'INFOS_PICTORIA',
      environment: () => ({
        INFOS_PICTORIA_CALLBACK: this.callbackUrl,
        INFOS_PICTORIA_CALLBACK_KEY: this.callbackKey,
        INFOS_PICTORIA_DESKTOP_GUARD: this.desktopGuard ? JSON.stringify(this.desktopGuard) : '',
      }),
      requestStop: async () => {
        const response = await fetch(new URL('/shutdown', this.httpEndpoint()), {
          method: 'POST',
          headers: { authorization: `Bearer ${this.key}` },
          signal: AbortSignal.timeout(3000),
        })
        if (!response.ok) throw new Error('应用停止请求未确认')
      },
    })
    this.runtime = new ApplicationCapabilityRuntime(
      directory,
      handles,
      applicationTools,
      localNodeId,
      pictoriaManifest,
      {
        enabled: () => this.enabled,
        preferredNode: () => this.federation.status().discovery?.nodeId,
        prepareInput: (value) => ({ ...(value as object), __applicationAuth: this.key }),
        toolInvocation: async (_projection, args, context) => {
          try {
            return JSON.stringify({ success: true, result: await this.invokeTool(args, context) })
          } catch (error) {
            return JSON.stringify({
              error: error instanceof Error ? error.message : '绘图调用失败',
            })
          }
        },
      },
    )
    this.resultDelivery = new PictoriaDelivery(
      deps,
      this.calls,
      this.deliveryRoot,
      (owner, id) => this.asset(owner, id),
      () => this.social,
    )
  }
  async initialize(): Promise<void> {
    this.releaseNotifications = this.deps.gatewayHub.addNotificationSuppression(
      async (owner, notifications) => {
        const calls = notifications.flatMap((notification) => {
          if (!notification.notificationId.startsWith('application:')) return []
          const call = this.calls.get(notification.notificationId.slice('application:'.length))
          return call?.appId === pictoriaManifest.id && call.agentId === owner && call.runId
            ? [{ notificationId: notification.notificationId, runId: call.runId }]
            : []
        })
        if (!calls.length) return []
        const dismissed = new Set(
          this.runtime.available()
            ? await this.runtime.invoke<string[]>(
                'task.dismissed',
                {},
                { principalId: owner, correlationId: randomUUID() },
              )
            : readDismissedCanvasRuns(this.dataPath, owner),
        )
        return calls.filter((call) => dismissed.has(call.runId)).map((call) => call.notificationId)
      },
    )
    const settings = await this.deps.configRepo.getJson<{
      enabled?: boolean
      chatEnabled?: boolean
    }>('pictoria.settings')
    this.enabled = settings?.enabled !== false
    for (const call of this.calls.pending(pictoriaManifest.id))
      if (call.deliveryStatus === 'sending')
        this.calls.patch(call.id, {
          deliveryStatus: 'uncertain',
          error: '外部发送过程中应用中断，请核验是否送达',
        })
    this.releaseManifest = this.deps.applicationIntegration.register(pictoriaManifest, () => {
      const discovery = this.federation.status().discovery
      return discovery
        ? { instanceId: discovery.application.instanceId, nodeId: discovery.nodeId }
        : undefined
    })
    this.releaseDefinition = this.tools.registerDefinitionProvider(
      'pictoria',
      (definition, owner) => this.describe(definition, owner),
    )
    this.callback = createServer((req, res) => {
      void (async () => {
        if (
          !authorized(req.headers.authorization?.replace(/^Bearer /, ''), this.callbackKey) ||
          req.method !== 'POST' ||
          req.url !== '/model'
        ) {
          res.writeHead(401)
          res.end()
          return
        }
        const parts: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk)
          if (size > 1024 * 1024) throw new Error('模型请求过大')
          parts.push(Buffer.from(chunk))
        }
        const value = JSON.parse(Buffer.concat(parts).toString('utf8')) as {
          callId: string
          system: string
          inputs: Record<string, unknown>
          modelId?: string
        }
        const result = await this.generate(value)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
      })().catch((error) => {
        logger.warn(__t('logs.applications', '子应用模型调用失败'), {
          error: error instanceof Error ? error.message : __t('logs.applications', '未知错误'),
        })
        if (!res.headersSent)
          res.writeHead(
            error && typeof error === 'object' && 'mayHaveSubmitted' in error ? 502 : 400,
          )
        res.end(JSON.stringify({ error: '模型调用失败，请检查授权与配置' }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.callback!.once('error', reject)
      this.callback!.listen(0, '127.0.0.1', resolve)
    })
    const address = this.callback.address()
    if (!address || typeof address === 'string') throw new Error('模型桥接端口不可用')
    this.callbackUrl = `http://127.0.0.1:${address.port}/model`
    await this.runtime.start()
    this.federation.start()
    this.timer = setInterval(() => {
      void this.flush().catch((error) =>
        logger.warn(__t('logs.applications', '绘图结果同步失败'), { error: String(error) }),
      )
    }, 3000)
    this.timer.unref()
  }
  start(desktopGuard?: unknown): Promise<ReturnType<ApplicationController['status']>> {
    // 启动和归属变更串行处理，桌面退出期间不让其他请求清掉尚未完成启动的归属。
    const next = (this.starting ? this.starting.catch(() => undefined) : Promise.resolve()).then(
      () => this.startCurrent(desktopGuard),
    )
    this.starting = next
    const clear = () => {
      if (this.starting === next) this.starting = undefined
    }
    void next.then(clear, clear)
    return next
  }
  stop(): Promise<ReturnType<ApplicationController['status']>> {
    // 与启动共用队列，避免刚退出的后台被尚未完成的启动请求重新拉起。
    const next = (this.starting ? this.starting.catch(() => undefined) : Promise.resolve()).then(
      async () => {
        if (this.controller.status().ownership === 'adopted')
          throw new Error('此 Pictoria 后台由外部启动，请在原启动位置退出')
        await this.controller.shutdownManaged()
        // 立即清理已退出实例的发现状态，重新打开时无需等待定时同步。
        await this.federation.reconnect()
        return this.controller.status()
      },
    )
    this.starting = next
    const clear = () => {
      if (this.starting === next) this.starting = undefined
    }
    void next.then(clear, clear)
    return next
  }
  private async startCurrent(
    desktopGuard?: unknown,
  ): Promise<ReturnType<ApplicationController['status']>> {
    if (this.closing) throw new Error('宿主正在退出')
    // 外部发现实例保持独立，不把桌面生命周期强加给用户自行启动的后台。
    if (this.controller.status().ownership === 'adopted') {
      await this.controller.reconnect()
      if (this.controller.status().ownership === 'adopted') return this.controller.status()
    }
    if (desktopGuard !== undefined) {
      const value = desktopGuardSchema.parse(desktopGuard)
      if (
        this.desktopGuard &&
        (value.pipe !== this.desktopGuard.pipe || value.token !== this.desktopGuard.token)
      ) {
        if (this.controller.status().ownership === 'managed')
          throw new Error('Pictoria 已归属于另一个桌面进程')
        this.desktopWatch?.dispose()
        this.desktopWatch = undefined
        this.desktopLost = false
      }
      this.desktopGuard = value
    } else if (this.controller.status().ownership === 'offline') {
      this.desktopWatch?.dispose()
      this.desktopWatch = undefined
      this.desktopGuard = undefined
      this.desktopLost = false
    }
    if (this.desktopGuard && !this.desktopWatch) {
      const value = this.desktopGuard
      this.desktopWatch = watchDesktopGuard(value, () => {
        if (this.desktopGuard?.pipe !== value.pipe || this.closing) return
        this.desktopLost = true
        logger.info(__t('logs.applications', '桌面连接已断开，正在回收托管 Pictoria'))
        void this.controller.shutdownManaged().catch((failure) =>
          logger.warn(__t('logs.applications', '托管 Pictoria 回收失败'), {
            error: String(failure),
          }),
        )
      })
    }
    await this.desktopWatch?.ready
    if (this.closing || this.desktopLost) throw new Error('桌面或宿主已退出，已取消启动 Pictoria')
    const status = await this.controller.start()
    if (status.ownership !== 'managed') return status
    if (this.closing || this.desktopLost) throw new Error('桌面或宿主已退出，已取消启动 Pictoria')
    if (status.ownership === 'managed' && this.desktopGuard) {
      const response = await fetch(new URL('/lifecycle/desktop', this.httpEndpoint()), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.desktopGuard),
        signal: AbortSignal.timeout(6000),
        redirect: 'error',
      })
      if (!response.ok) throw new Error('Pictoria 桌面生命周期绑定失败，请重启托管后台')
    }
    return this.controller.status()
  }
  async shutdown(): Promise<void> {
    this.closing = true
    this.releaseNotifications?.()
    this.desktopWatch?.dispose()
    this.desktopWatch = undefined
    this.shutdownSignal.abort(new Error('宿主正在停止'))
    if (this.timer) clearInterval(this.timer)
    await this.activeFlush?.catch(() => undefined)
    await this.controller.shutdown()
    await this.runtime.stop()
    await this.federation.stop()
    if (this.callback) {
      this.callback.closeAllConnections()
      await new Promise<void>((resolve) => this.callback!.close(() => resolve()))
    }
    this.releaseDefinition?.()
    this.releaseManifest?.()
  }
  async settings(value?: { enabled: boolean; chatEnabled: boolean }) {
    if (value) {
      await this.deps.configRepo.set('pictoria.settings', JSON.stringify(value))
      this.enabled = value.enabled
      await this.runtime.refresh()
      this.tools.setChatEnabled('pictoria', value.chatEnabled)
    }
    return (
      (await this.deps.configRepo.getJson<{ enabled: boolean; chatEnabled: boolean }>(
        'pictoria.settings',
      )) ?? { enabled: true, chatEnabled: false }
    )
  }
  socialPort(
    authorize: (origin: TaskOrigin) => Promise<string | undefined>,
    delivery: TaskDeliveryService,
  ): ApplicationCreativePort {
    this.social = { authorize, delivery }
    return {
      describe: async (origin) => {
        const owner = await authorize(origin)
        if (
          !owner ||
          !this.runtime.available() ||
          !this.enabled ||
          !(await this.settings()).chatEnabled
        )
          return undefined
        const definition = await this.describe(pictoriaManifest.toolProjections![0]!, owner)
        return {
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
        }
      },
      invoke: async (origin, input, requestKey) => {
        const owner = await authorize(origin)
        if (!owner || !this.enabled || !(await this.settings()).chatEnabled)
          throw new Error('绘图能力未向当前社交身份开放')
        return this.invokeTool(
          input,
          {
            agentId: owner,
            threadId: `social:${origin.accountId}:${origin.channelId}`,
            sessionId: origin.messageId,
            source: 'social',
            channel: 'social',
            toolCallId: requestKey,
          },
          origin,
        )
      },
    }
  }
  resolveDelivery(callId: string, decision: 'sent' | 'retry'): void {
    const call = this.calls.get(callId)
    if (!call || call.appId !== pictoriaManifest.id || call.deliveryStatus !== 'uncertain')
      throw new Error('交付记录不处于待核验状态')
    this.calls.patch(callId, {
      deliveryStatus: decision === 'sent' ? 'sent' : 'pending',
      error: null,
    })
  }
  async operation(
    operation: string,
    input: Record<string, unknown>,
    agentId: string,
    threadId?: string,
    key?: string,
  ) {
    if (operation === 'task.submit') {
      if (!threadId || !key) throw new Error('提交任务需要原会话和幂等键')
      return this.invokeTool(
        { ...input, action: 'run' },
        {
          agentId,
          threadId,
          sessionId: threadId,
          source: 'desktop',
          channel: 'desktop',
          toolCallId: key,
        },
      )
    }
    const result = await this.runtime.invoke(operation, input, {
      principalId: agentId,
      correlationId: key ?? randomUUID(),
      idempotencyKey: key,
    })
    if (operation === 'task.resume' && typeof input.id === 'string')
      this.rearmDelivery(input.id, agentId)
    return result
  }

  /** 画布使用独立的内部会话承接创作交付，不借用用户正在聊天的 Thread。 */
  async runCanvas(agentId: string, input: Record<string, unknown>, key: string) {
    const projectId = String(input.projectId ?? '')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(projectId)) throw new Error('画布项目 ID 无效')
    const id = `pictoria_${createHash('sha256').update(`${agentId}:${projectId}`).digest('hex').slice(0, 32)}`
    let thread = await this.deps.threadService.getThread(id)
    if (!thread) {
      try {
        thread = await this.deps.threadService.createThread({
          id,
          agentId,
          channel: 'group',
          platform: 'app_internal',
          purpose: 'app_internal',
          title: __t('server.applications', 'Pictoria 创作画布'),
        })
      } catch (error) {
        thread = await this.deps.threadService.getThread(id)
        if (!thread) throw error
      }
    }
    if (thread.agentId !== agentId) throw new Error('画布会话归属无效')
    return this.operation('task.submit', input, agentId, thread.id, key)
  }

  async importCanvasAsset(owner: string, name: string, mimeType: string, bytes: Buffer) {
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('画布素材上限为 20 MB')
    if (
      ![
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
        'video/mp4',
        'video/webm',
        'audio/mpeg',
        'audio/wav',
        'audio/ogg',
      ].includes(mimeType)
    )
      throw new Error('画布暂不支持此素材格式')
    const response = await fetch(new URL('/assets', this.httpEndpoint()), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.key}`,
        'x-application-owner': owner,
        'x-file-name': encodeURIComponent(name.slice(0, 180)),
        'content-type': mimeType,
      },
      body: new Uint8Array(bytes),
      redirect: 'error',
      signal: AbortSignal.any([this.shutdownSignal.signal, AbortSignal.timeout(60_000)]),
    })
    if (!response.ok) throw new Error('素材上传失败')
    const result = (await response.json()) as { assetId: string }
    return this.runtime.invoke<Asset>(
      'asset.get',
      { id: result.assetId },
      { principalId: owner, correlationId: randomUUID() },
    )
  }

  async canvasAsset(owner: string, id: string) {
    const metadata = await this.runtime.invoke<Asset>(
      'asset.get',
      { id },
      { principalId: owner, correlationId: randomUUID() },
    )
    if (metadata.sizeBytes > 20 * 1024 * 1024) throw new Error('此素材超过画布预览上限 20 MB')
    const { info, bytes } = await this.asset(owner, id)
    if (bytes.length > 20 * 1024 * 1024) throw new Error('此素材超过画布预览上限 20 MB')
    return { info, base64: bytes.toString('base64') }
  }
  private rearmDelivery(runId: string, agentId: string): void {
    const call = this.calls.byRun(pictoriaManifest.id, runId)
    if (!call || call.agentId !== agentId) return
    if (call.deliveryStatus === 'uncertain' || call.deliveryStatus === 'sending') return
    this.calls.patch(call.id, {
      deliveryStatus: 'pending',
      messageId: null,
      state: 'queued',
      error: null,
    })
  }
  private async invokeTool(
    args: Record<string, unknown>,
    context: ToolContext,
    origin?: TaskOrigin,
  ) {
    if (!origin) {
      const target = await this.deps.threadService.getThread(context.threadId)
      if (!target || target.agentId !== context.agentId) throw new Error('创作调用与原会话不匹配')
    }
    if (args.action !== 'run') {
      const result = await this.runtime.invoke('tool.execute', args, {
        principalId: context.agentId,
        correlationId: context.toolCallId ?? randomUUID(),
        idempotencyKey: context.toolCallId,
      })
      if (args.action === 'resume' && typeof args.id === 'string')
        this.rearmDelivery(args.id, context.agentId)
      return result
    }
    const key = createHash('sha256')
      .update(`${context.agentId}:${context.threadId}:${context.toolCallId ?? randomUUID()}`)
      .digest('hex')
    const previous = this.calls.get(key)
    const request = JSON.stringify(args)
    if (
      previous &&
      requestFingerprint(JSON.parse(JSON.parse(previous.requestJson).original)) !==
        requestFingerprint(args)
    )
      throw new Error('幂等调用内容发生变化')
    if (previous?.runId) return { accepted: true, taskId: previous.runId }
    const call =
      previous ??
      this.calls.create({
        id: key,
        appId: pictoriaManifest.id,
        agentId: context.agentId,
        threadId: context.threadId,
        requestJson: JSON.stringify({ original: request, prepared: null, origin }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    let prepared = (JSON.parse(call.requestJson) as { prepared: Record<string, unknown> | null })
      .prepared
    if (!prepared) {
      prepared = { ...args, inputs: await this.importInputs(args.inputs ?? {}, context) }
      this.calls.patch(key, {
        requestJson: JSON.stringify({ original: request, prepared, origin }),
      })
    }
    const accepted = await this.runtime.invoke<{
      accepted: true
      taskId: string
      projectId: string
    }>(
      'tool.execute',
      { ...prepared, __callId: key },
      {
        principalId: context.agentId,
        correlationId: context.toolCallId ?? key,
        idempotencyKey: key,
      },
    )
    this.calls.patch(key, { runId: accepted.taskId, state: 'queued' })
    return accepted
  }
  private async importInputs(value: unknown, context: ToolContext): Promise<unknown> {
    if (Array.isArray(value))
      return Promise.all(value.map((entry) => this.importInputs(entry, context)))
    if (!value || typeof value !== 'object') return value
    const input = value as Record<string, unknown>
    if (typeof input.resourceSource === 'string') {
      const source = input.resourceSource
      if (!/^https?:\/\//i.test(source))
        throw new Error('resourceSource 只接受在线资源；工作区资源请先创建授权附件')
      const resource = await downloadResource(source, context.signal)
      const response = await fetch(new URL('/assets', this.httpEndpoint()), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.key}`,
          'x-application-owner': context.agentId,
          'content-type': resource.mimeType,
          'x-file-name': encodeURIComponent(resource.name),
        },
        body: new Uint8Array(resource.bytes),
        signal: context.signal,
      })
      if (!response.ok) throw new Error('在线素材传入失败')
      return (await response.json()) as { assetId: string }
    }
    if (typeof input.resourceId === 'string') {
      const { resource, filePath } = await this.deps.resourceService.prepare(
        context,
        `attachment:${input.resourceId}`,
      )
      const url = new URL('/assets', this.httpEndpoint())
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.key}`,
          'x-application-owner': context.agentId,
          'content-type': resource.mimeType,
          'x-file-name': encodeURIComponent(resource.name),
        },
        body: Readable.toWeb(createReadStream(filePath)) as ReadableStream,
        duplex: 'half',
        signal: context.signal,
      } as RequestInit)
      if (!response.ok) throw new Error('素材传入绘图应用失败')
      const result = (await response.json()) as { assetId: string }
      return result
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(input).map(async ([key, entry]) => [
          key,
          await this.importInputs(entry, context),
        ]),
      ),
    )
  }
  private async describe(definition: ToolDefinition, owner: string): Promise<ToolDefinition> {
    const base = pictoriaManifest.toolProjections![0]!
    try {
      const result = await this.runtime.invoke<{ steps: Array<Step & { available: boolean }> }>(
        'catalog.get',
        {},
        {
          principalId: owner,
          correlationId: randomUUID(),
          deadline: new Date(Date.now() + 5000).toISOString(),
        },
      )
      let description: string = base.description
      for (const step of result.steps.filter((s) => s.available)) {
        const section = `\n${step.id}@${step.revision} ${step.name}\n${step.usageDescription}\n输入字段：${JSON.stringify(step.inputSchema)}`
        if (description.length + section.length > 24000) {
          description += '\n其他步骤请用 catalog 查看完整要求。'
          break
        }
        description += section
      }
      return { ...definition, description }
    } catch {
      return { ...definition, description: base.description }
    }
  }
  private httpEndpoint(): string {
    const pathName = this.federation.status().discoveryPath
    const value = JSON.parse(readFileSync(pathName, 'utf8')) as {
      httpEndpoint?: string
      application?: { appId?: string; instanceId?: string }
      generation?: number
    }
    const connected = this.federation.status().discovery
    if (
      !connected ||
      value.application?.appId !== pictoriaManifest.id ||
      value.application.instanceId !== connected.application.instanceId ||
      value.generation !== connected.generation
    )
      throw new Error('应用资源端点与当前连接实例不匹配')
    const url = new URL(value.httpEndpoint ?? '')
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
      throw new Error('应用资源端点无效')
    return url.toString()
  }
  private async asset(owner: string, id: string) {
    const info = await this.runtime.invoke<Asset>(
      'asset.get',
      { id },
      { principalId: owner, correlationId: randomUUID() },
    )
    const response = await fetch(
      new URL(`/assets/${encodeURIComponent(id)}`, this.httpEndpoint()),
      {
        headers: { authorization: `Bearer ${this.key}`, 'x-application-owner': owner },
        redirect: 'error',
        signal: AbortSignal.any([this.shutdownSignal.signal, AbortSignal.timeout(120000)]),
      },
    )
    if (!response.ok || !response.body) throw new Error('作品读取失败')
    const bytes = await boundedResourceBytes(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    )
    if (createHash('sha256').update(bytes).digest('hex') !== info.sha256)
      throw new Error('作品内容校验失败')
    return { info, bytes }
  }
  private async generate(value: {
    callId: string
    system: string
    inputs: Record<string, unknown>
    modelId?: string
  }) {
    const call = this.calls.get(value.callId)
    if (!call || call.appId !== pictoriaManifest.id) throw new Error('模型调用缺少有效创作任务')
    const grants = await this.deps.applicationIntegration.listGrants(pictoriaManifest.id)
    const selected = value.modelId ? Number(value.modelId) : undefined
    if (value.modelId && (!Number.isSafeInteger(selected) || selected! <= 0))
      throw new Error('模型配置 ID 无效')
    const grant = grants.find(
      (entry) =>
        entry.ownerAgentId === call.agentId &&
        !entry.revoked &&
        (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()) &&
        entry.permissions.includes('derive') &&
        entry.resource.kind === 'model' &&
        (entry.resource.modelConfigId === undefined || entry.resource.modelConfigId === selected),
    )
    if (!grant) throw new Error('绘图应用未获得此模型的使用授权')
    const model = selected
      ? await this.deps.modelRoles.resolveById(selected)
      : await this.deps.modelRoles.resolveAgent(call.agentId)
    if (!model) throw new Error('模型未配置')
    const content: import('../services/llm/types').ContentPart[] = [
      { type: 'text', text: JSON.stringify(value.inputs) },
    ]
    for (const id of assetIds(value.inputs)) {
      const { info, bytes } = await this.asset(call.agentId, id)
      if (
        !info.mimeType.startsWith('image/') ||
        bytes.length > 20 * 1024 * 1024 ||
        !model.enableVision
      )
        throw new Error('所选模型无法分析此素材')
      content.push({
        type: 'image_url',
        image_url: { url: `data:${info.mimeType};base64,${bytes.toString('base64')}` },
      })
    }
    try {
      const result = await this.deps.llmService.chat(
        { ...model, usageAgentId: call.agentId, usagePurpose: 'task' },
        [
          { role: 'system', content: value.system },
          { role: 'user', content },
        ],
        {
          usageContext: { agentId: call.agentId, purpose: 'task' },
          signal: this.shutdownSignal.signal,
        },
      )
      return { text: result.choices[0]?.message.content ?? '' }
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : '模型调用未确认'), {
        mayHaveSubmitted: true,
      })
    }
  }
  flush(): Promise<void> {
    this.activeFlush ??= this.flushPending().finally(() => {
      this.activeFlush = undefined
    })
    return this.activeFlush
  }
  private async flushPending(): Promise<void> {
    if (this.closing || !this.runtime.available()) return
    const settings = await this.settings()
    this.tools.setChatEnabled('pictoria', settings.chatEnabled)
    // 主应用在收到 accepted 前中断时，用相同持久请求键重新交接，不重新生成。
    for (const call of this.calls.pending(pictoriaManifest.id)) {
      if (!call.runId) {
        const stored = JSON.parse(call.requestJson) as {
          prepared: Record<string, unknown> | null
        }
        if (!stored.prepared) continue
        try {
          const accepted = await this.runtime.invoke<{ taskId: string }>(
            'tool.execute',
            { ...stored.prepared, __callId: call.id },
            { principalId: call.agentId, correlationId: call.id, idempotencyKey: call.id },
          )
          this.calls.patch(call.id, { runId: accepted.taskId, state: 'queued' })
        } catch (error) {
          this.calls.patch(call.id, { error: String(error) })
          continue
        }
      }
      const current = this.calls.get(call.id)!
      if (!current.runId) continue
      const run = await this.runtime.invoke<Run | null>(
        'task.get',
        { id: current.runId },
        { principalId: call.agentId, correlationId: randomUUID() },
      )
      if (!run) continue
      this.calls.patch(call.id, {
        state: run.state,
        revision: run.revision,
        resultJson: JSON.stringify(run),
        error: run.error ?? null,
      })
      if (
        ['completed', 'partial', 'failed', 'cancelled'].includes(run.state) &&
        current.deliveryStatus === 'pending'
      ) {
        try {
          await this.resultDelivery.deliver(current, run)
        } catch (error) {
          this.calls.patch(call.id, { error: `结果交付待恢复：${String(error)}` })
        }
      }
    }
    const events = await this.runtime.invoke<Array<{ eventId: string }>>('events.list', {})
    for (const event of events) await this.runtime.invoke('events.ack', { eventId: event.eventId })
  }
}
