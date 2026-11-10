import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ remote: true, writeFile: vi.fn(), readFile: vi.fn() }))
vi.mock('./clientConnection', () => ({ isRemoteConnection: () => state.remote }))
vi.mock('../utils/clientCredential', () => ({ getClientCredential: () => 'local-token' }))
vi.mock('./steam', () => ({
  IS_STEAM: () => true,
  getSteamUser: () => ({ steamId: 'test-account' }),
  getSteamCloudApi: () => ({ writeFile: state.writeFile, readFile: state.readFile }),
}))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
// 快照传输边界独立验证，保存队列在自己的核心用例中覆盖。
vi.mock('./cloudAutoSave', () => ({ steamCloudAutoSave: {} }))
import { cloudSyncService } from './cloudSync'
afterEach(() => {
  state.remote = true
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
describe('Steam 一致性快照边界', () => {
  it('远程模式拒绝本机快照导出和暂存，不向本机后台发请求', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(cloudSyncService.captureSnapshot()).rejects.toThrow(
      'STEAM_CLOUD_REMOTE_CONNECTION',
    )
    await expect(cloudSyncService.stageSnapshot(Buffer.from('fixture'))).rejects.toThrow(
      'STEAM_CLOUD_REMOTE_CONNECTION',
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(state.writeFile).not.toHaveBeenCalled()
    expect(state.readFile).not.toHaveBeenCalled()
  })
  it('本地快照返回后端正文，并使用本机凭据与传输密钥', async () => {
    state.remote = false
    const request = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('fetch', request)
    expect(await cloudSyncService.captureSnapshot()).toEqual(Buffer.from([1, 2, 3]))
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
      }),
    )
    expect(state.writeFile).not.toHaveBeenCalled()
  })
  it('恢复必须取得后端快照回执，不把 HTTP 成功当成已应用', async () => {
    state.remote = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: {} }, { status: 202 })),
    )
    await expect(cloudSyncService.stageSnapshot(Buffer.from('encrypted fixture'))).rejects.toThrow(
      'STEAM_CLOUD_RESTORE_RECEIPT_MISSING',
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            data: { manifest: { snapshotId: 'accepted-snapshot' }, restartRequired: true },
          },
          { status: 202 },
        ),
      ),
    )
    expect(await cloudSyncService.stageSnapshot(Buffer.from('encrypted fixture'))).toBe(
      'accepted-snapshot',
    )
  })

  it('旧导出清理期间等待资源释放，取得下一次完整快照', async () => {
    state.remote = false
    const bytes = Buffer.from('snapshot captured after cleanup')
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 'RESOURCE_BUSY' }, { status: 422 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)))
    vi.stubGlobal('fetch', request)

    expect(await cloudSyncService.captureSnapshot()).toEqual(bytes)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('等待旧导出释放时可以取消，取消后不再重发请求', async () => {
    state.remote = false
    const controller = new AbortController()
    const request = vi.fn(async () => Response.json({ code: 'RESOURCE_BUSY' }, { status: 422 }))
    vi.stubGlobal('fetch', request)
    const result = cloudSyncService.captureSnapshot(controller.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    // 让已返回的响应完成解包并进入等待阶段，再撤销调用。
    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort()

    await rejected
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('永久性快照错误保留业务错误码并立即返回', async () => {
    state.remote = false
    const request = vi.fn(async () =>
      Response.json({ code: 'PRECONDITION_FAILED' }, { status: 422 }),
    )
    vi.stubGlobal('fetch', request)

    await expect(cloudSyncService.captureSnapshot()).rejects.toThrow(
      'STEAM_CLOUD_SNAPSHOT_HTTP_422:PRECONDITION_FAILED',
    )
    expect(request).toHaveBeenCalledTimes(1)
  })
})
