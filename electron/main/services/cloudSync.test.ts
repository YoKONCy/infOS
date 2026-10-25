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
import { cloudSyncService } from './cloudSync'
afterEach(() => {
  state.remote = true
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
describe('Steam 远程模式备份边界', () => {
  it('远程连接时禁用本地业务快照上传、恢复及旧同步入口，不向本机后台发请求', async () => {
    vi.stubGlobal('fetch', vi.fn())
    expect(cloudSyncService.getStatus().enabled).toBe(false)
    for (const result of [
      await cloudSyncService.uploadFullSnapshot(),
      await cloudSyncService.downloadFullSnapshot(),
      await cloudSyncService.sync(),
    ]) {
      expect(result.success).toBe(false)
      expect(result.errors[0]).toContain('服务器备份')
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(state.writeFile).not.toHaveBeenCalled()
    expect(state.readFile).not.toHaveBeenCalled()
  })
  it('切回本地后保留手动快照上传，不混入远程凭据或改变连接模式', async () => {
    state.remote = false
    state.writeFile.mockReturnValue(true)
    const request = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('fetch', request)
    expect((await cloudSyncService.uploadFullSnapshot()).success).toBe(true)
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
      }),
    )
    expect(state.writeFile).toHaveBeenCalledWith(
      'infos/full-snapshot.bundle',
      expect.stringMatching(/^base64:/),
    )
  })
})
