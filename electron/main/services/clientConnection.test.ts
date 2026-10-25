import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClientConnectionStore,
  configureClientConnection,
  ensureSelectedBackend,
  getBackendOrigin,
  getCapabilityEndpoint,
  isRemoteConnection,
  normalizeServerOrigin,
} from './clientConnection'
import { getClientCredential } from '../utils/clientCredential'
let directory: string
const root = path.resolve('TEMP/client-connection-tests')
const codec = {
  encrypt: (value: string) => Buffer.from(value).toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString(),
}
function setup() {
  const request = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify({
          data: String(url).endsWith('capability-invites')
            ? { pairingCode: 'one-time-code' }
            : { serverId: 'server-a' },
        }),
      ),
  )
  const store = new ClientConnectionStore(directory, codec, request as typeof fetch)
  configureClientConnection(store)
  return { store, request }
}
const remote = {
  mode: 'remote' as const,
  origin: 'https://server.example',
  token: 'remote-secret',
  capabilityEndpoint: 'wss://server.example/capabilities',
}
beforeEach(() => {
  fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'run-'))
})
afterEach(() => {
  configureClientConnection(new ClientConnectionStore(directory, codec))
  if (path.dirname(path.resolve(directory)) !== root) throw new Error('测试目录越界')
  fs.rmSync(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
describe('Electron 后端启动模式', () => {
  it('首次启动没有配置，不提前创建后台或凭据文件', async () => {
    const { store, request } = setup()
    expect(store.load()).toBeNull()
    expect(fs.readdirSync(directory)).toEqual([])
    expect(request).not.toHaveBeenCalled()
    const startLocal = vi.fn(async () => true)
    await expect(ensureSelectedBackend(startLocal)).rejects.toThrow('CONNECTION_SELECTION_REQUIRED')
    expect(startLocal).not.toHaveBeenCalled()
  })
  it('远程配置加密持久化，重开后跳过本地启动且使用远程凭据', async () => {
    const { store, request } = setup()
    await store.save(remote)
    expect(fs.readFileSync(path.join(directory, 'client-connection.json'), 'utf8')).not.toContain(
      remote.token,
    )
    const restarted = new ClientConnectionStore(directory, codec, request as typeof fetch)
    configureClientConnection(restarted)
    expect(restarted.load()).toMatchObject(remote)
    vi.stubEnv('INFOS_API_TOKEN', 'local-only-secret')
    const startLocal = vi.fn(async () => true)
    expect(await ensureSelectedBackend(startLocal)).toBe(true)
    expect(startLocal).not.toHaveBeenCalled()
    expect(getClientCredential()).toBe(remote.token)
    expect(getBackendOrigin()).toBe(remote.origin)
    expect(getCapabilityEndpoint()).toBe(remote.capabilityEndpoint)
  })
  it('远程离线或服务器身份变化时拒绝继续，绝不回退启动本机后台', async () => {
    const { store, request } = setup()
    await store.save(remote)
    const startLocal = vi.fn(async () => true)
    request.mockRejectedValueOnce(new Error('模拟断网'))
    await expect(ensureSelectedBackend(startLocal)).rejects.toThrow('模拟断网')
    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { serverId: 'another-server' } })),
    )
    await expect(ensureSelectedBackend(startLocal)).rejects.toThrow('REMOTE_IDENTITY_CHANGED')
    expect(startLocal).not.toHaveBeenCalled()
  })
  it('运行中修改只写下次启动配置，旧窗口和退出清理继续使用原服务器', async () => {
    const { store } = setup()
    await store.save({ mode: 'local' })
    await store.save(remote, false)
    expect(isRemoteConnection()).toBe(false)
    expect(getBackendOrigin()).toContain('localhost')
    expect(store.load()?.mode).toBe('remote')
  })
  it('本地选择走原启动入口，取消连接时不会保存迟到的结果', async () => {
    const { store } = setup()
    await store.save({ mode: 'local' })
    const startLocal = vi.fn(async () => true)
    await ensureSelectedBackend(startLocal)
    expect(startLocal).toHaveBeenCalledOnce()
    const controller = new AbortController()
    controller.abort()
    await expect(store.save(remote, true, controller.signal)).rejects.toThrow()
    expect(store.load()?.mode).toBe('local')
  })
  it('拒绝带账号、路径或 HTTPS 降级的地址，并以一次性配对码注册能力', async () => {
    const { store, request } = setup()
    expect(() => normalizeServerOrigin('https://user:pass@example.com')).toThrow()
    expect(() => normalizeServerOrigin('https://example.com/api')).toThrow()
    await expect(
      store.save({ ...remote, capabilityEndpoint: 'ws://server.example' }),
    ).rejects.toThrow('CONNECTION_TLS_REQUIRED')
    await store.save(remote)
    expect(await store.capabilityPairingCode()).toBe('one-time-code')
    expect(request).toHaveBeenLastCalledWith(
      `${remote.origin}/api/distributed/capability-invites`,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer remote-secret' },
      }),
    )
  })
  it('密钥服务失败不落盘明文，也不改变之前的本地选择', async () => {
    const { request } = setup()
    const store = new ClientConnectionStore(
      directory,
      {
        ...codec,
        encrypt() {
          throw new Error('CONNECTION_ENCRYPTION_UNAVAILABLE')
        },
      },
      request as typeof fetch,
    )
    await store.save({ mode: 'local' })
    await expect(store.save(remote)).rejects.toThrow('CONNECTION_ENCRYPTION_UNAVAILABLE')
    expect(store.current?.mode).toBe('local')
    expect(
      JSON.parse(fs.readFileSync(path.join(directory, 'client-connection.json'), 'utf8')),
    ).toEqual({ version: 1, mode: 'local' })
    expect(fs.existsSync(path.join(directory, 'client-connection.json.tmp'))).toBe(false)
  })
})
