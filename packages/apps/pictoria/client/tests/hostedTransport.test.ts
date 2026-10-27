import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())
async function transport(address: string) {
  vi.resetModules()
  vi.stubGlobal('window', { location: new URL(address) })
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => (key === 'infos.currentServerToken' ? 'paired-token' : ''),
  })
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ code: 'OK', data: { agents: [] } })),
  )
  vi.stubGlobal('fetch', fetcher)
  return { api: await import('../src/services/transport'), fetcher }
}
describe('Pictoria 网页入口', () => {
  it('Docker 裸页面走同源宿主 API，并使用现有设备凭据', async () => {
    const { api, fetcher } = await transport('https://infos.example/applications/pictoria/')
    await api.pictoria.bootstrap()
    expect(fetcher).toHaveBeenCalledWith(
      'https://infos.example/api/applications/pictoria/canvas/bootstrap',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer paired-token' }),
      }),
    )
  })
  it('独立开发页面继续使用 Pictoria 自己的本机 API', async () => {
    const { api, fetcher } = await transport('http://localhost:7363/')
    await api.pictoria.bootstrap()
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:7364/pictoria-api/request',
      expect.objectContaining({ body: JSON.stringify({ action: 'bootstrap' }) }),
    )
  })
  it('相似名称的远程路径不能冒充宿主挂载入口', async () => {
    const { api, fetcher } = await transport('https://other.example/applications/pictoria-other/')
    await expect(api.pictoria.bootstrap()).rejects.toThrow('独立后台必须使用本机地址')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
