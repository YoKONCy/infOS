import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { Hono } from 'hono'

const backendRoot = fileURLToPath(new URL('../../../', import.meta.url))
const temporaryRoot = resolve(backendRoot, '../../TEMP')
let outputDir = ''
let server: Server | undefined
let runtime:
  | {
      initialize(ctx: unknown): Promise<{ success: boolean; error?: string }>
      onStop(): Promise<unknown>
    }
  | undefined
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await runtime?.onStop()
  runtime = undefined
  if (server?.listening) await new Promise<void>((done) => server!.close(() => done()))
  server = undefined
  vi.unstubAllEnvs()
  if (outputDir && dirname(resolve(outputDir)) === temporaryRoot)
    rmSync(outputDir, { recursive: true, force: true })
})

describe('独立 bundle 的社交传输', () => {
  it('真实 Social runtime 通过宿主注入注册，反向 WS 与状态接口共享同一个适配器', async () => {
    const require = createRequire(import.meta.url)
    const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
    mkdirSync(temporaryRoot, { recursive: true })
    outputDir = mkdtempSync(join(temporaryRoot, 'social-bundle-test-'))
    const modules = join(outputDir, 'node_modules')
    mkdirSync(modules)
    // 与发行包相同，独立产物同时拥有宿主和社交应用声明的外部依赖。
    for (const source of [
      join(backendRoot, 'node_modules'),
      resolve(backendRoot, '../apps/social/node_modules'),
    ]) {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const target = join(modules, entry.name)
        if (existsSync(target)) continue
        symlinkSync(realpathSync(join(source, entry.name)), target, 'junction')
      }
    }
    const hostFile = join(outputDir, 'host.mjs')
    const socialFile = join(outputDir, 'social.mjs')
    const options = {
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: 'external',
      tsconfig: resolve(backendRoot, '../../tsconfig.base.json'),
      logLevel: 'silent',
    }
    await build({
      ...options,
      stdin: {
        contents: `export { registerSocialNapcatAdapter, getSocialNapcatAdapter } from './src/applications/socialWsBridge.ts'; export { setupGatewayWebSocket } from './src/services/gateway/wsUpgrade.ts';`,
        resolveDir: backendRoot,
        loader: 'ts',
      },
      outfile: hostFile,
    })
    await build({
      ...options,
      entryPoints: [resolve(backendRoot, '../apps/social/runtime/index.ts')],
      outfile: socialFile,
    })
    vi.stubEnv('PERO_APP_ROOT', resolve(backendRoot, '..'))
    const host = await import(/* @vite-ignore */ pathToFileURL(hostFile).href)
    const social = await import(/* @vite-ignore */ pathToFileURL(socialFile).href)
    const app = new Hono()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const instance = social.default()
    runtime = instance
    const initialized = await instance.initialize({
      instanceId: 'social-test',
      appId: 'social',
      hostAgentId: 'pero',
      logger,
      socialStorage: { getRecentChannelsForPlatform: vi.fn(async () => []) },
      socialEvents: { publish: vi.fn(async () => undefined) },
      socialExecutions: {},
      storeRegistry: {},
      configRepo: {
        get: vi.fn(async (key: string) =>
          key === 'social' ? JSON.stringify({ agentId: 'pero' }) : undefined,
        ),
        set: vi.fn(),
      },
      agentManager: { getAgent: vi.fn(() => ({ id: 'pero', name: 'Pero' })) },
      mdpEngine: { addTemplateRoot: vi.fn() },
      llmService: {},
      grantRegistry: { grant: vi.fn(async () => 'grant-test'), revoke: vi.fn(async () => true) },
      realm: { descriptor: { realmId: 'infos.social' }, registerTool: vi.fn() },
      mountRouter: (prefix: string, router: Hono) => app.route(prefix, router),
      registerSocialTransport: host.registerSocialNapcatAdapter,
    })
    expect(initialized, JSON.stringify(logger.error.mock.calls)).toEqual({ success: true })
    expect(host.getSocialNapcatAdapter()).not.toBeNull()
    server = createServer(async (request, response) => {
      const result = await app.request(request.url ?? '/')
      response.writeHead(result.status, { 'Content-Type': 'application/json' })
      response.end(await result.text())
    })
    host.setupGatewayWebSocket(server, {})
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/social/ws`, {
      headers: { 'X-Self-ID': '10000001' },
    })
    sockets.push(socket)
    socket.on('message', (raw) => {
      const request = JSON.parse(String(raw))
      const data =
        request.action === 'get_login_info'
          ? { user_id: 10000001, nickname: '测试账号' }
          : { app_name: '测试', app_version: '1' }
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }))
    })
    await once(socket, 'open')
    const response = await fetch(`http://127.0.0.1:${port}/api/social/status`)
    const status = (await response.json()) as {
      data: { adapters: Array<{ platform: string; connected: boolean; latencyMs: number }> }
    }
    expect(status.data.adapters).toEqual(
      expect.arrayContaining([expect.objectContaining({ platform: 'qq', connected: true })]),
    )
    expect(
      status.data.adapters.find((adapter: { platform: string }) => adapter.platform === 'qq')!
        .latencyMs,
    ).toBeGreaterThanOrEqual(0)
    await instance.onStop()
    runtime = undefined
    expect(host.getSocialNapcatAdapter()).toBeNull()
    const refused = new WebSocket(`ws://127.0.0.1:${port}/api/social/ws`)
    sockets.push(refused)
    const [code] = await once(refused, 'close')
    expect(code).toBe(1013)
  }, 20_000)
})
