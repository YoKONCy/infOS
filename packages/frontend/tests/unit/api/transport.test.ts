import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function setWindow(overrides: Record<string, unknown>) {
  vi.stubGlobal('window', overrides)
}

async function importTransport() {
  vi.resetModules()
  return import('@infos/frontend/api/transport')
}

describe('transport runtime helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    [undefined, false],
    [{}, false],
    [{ connectionMode: () => 'remote' }, false],
    [{ connectionMode: () => 'local' }, true],
  ])('系统打开只接受明确的本机后端连接：%j', async (electron, expected) => {
    setWindow({ electron, location: { origin: 'https://server.example' } })
    const { isLocalBackendRuntime } = await importTransport()
    expect(isLocalBackendRuntime()).toBe(expected)
  })

  it('应当在 Web 环境生成 ws 网关和 API 地址', async () => {
    setWindow({
      location: { origin: 'https://pero.example', protocol: 'https:', host: 'pero.example' },
    })

    const { getApiBaseUrl, getGatewayWsUrl, isElectronRuntime } = await importTransport()

    expect(isElectronRuntime()).toBe(false)
    expect(getGatewayWsUrl()).toBe('wss://pero.example/ws/gateway')
    expect(getApiBaseUrl()).toBe('https://pero.example/api')
  })

  it('应当在 Electron 环境生成 localhost 网关和 API 地址', async () => {
    setWindow({
      electron: { invoke: vi.fn() },
      location: { origin: 'http://web', protocol: 'http:', host: 'web' },
    })

    const { ELECTRON_BACKEND_ORIGIN, getApiBaseUrl, getGatewayWsUrl, isElectronRuntime } =
      await importTransport()

    expect(isElectronRuntime()).toBe(true)
    expect(getGatewayWsUrl()).toBe(`${ELECTRON_BACKEND_ORIGIN.replace(/^http/, 'ws')}/ws/gateway`)
    expect(getApiBaseUrl()).toBe(`${ELECTRON_BACKEND_ORIGIN}/api`)
  })

  it('远程 Electron 的业务请求、网关与资源鉴权统一使用已选服务器', async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ code: 'OK', data: [] })),
    )
    vi.stubGlobal('fetch', request)
    setWindow({
      electron: {
        backendOrigin: () => 'https://remote.example',
        clientCredential: () => 'remote-token',
        invoke: vi.fn(),
      },
    })
    const api = await importTransport()
    expect(api.getApiBaseUrl()).toBe('https://remote.example/api')
    expect(api.getGatewayWsUrl()).toBe('wss://remote.example/ws/gateway?token=remote-token')
    expect(api.getApiResourceHeaders('https://remote.example/api/files/document')).toEqual({
      Authorization: 'Bearer remote-token',
    })
    expect(api.getApiResourceHeaders('http://localhost:9120/api/files/document')).toEqual({})
    await api.transport.request('/agents')
    expect(request).toHaveBeenCalledWith(
      'https://remote.example/api/agents',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(new Headers(request.mock.calls[0]![1]?.headers).get('Authorization')).toBe(
      'Bearer remote-token',
    )
  })
})

describe('本机鉴权恢复', () => {
  afterEach(() => vi.unstubAllGlobals())

  function desktop(credential: (refresh?: boolean) => string) {
    const dispatchEvent = vi.fn()
    setWindow({
      dispatchEvent,
      electron: {
        backendOrigin: () => 'http://local.example',
        connectionMode: () => 'local',
        clientCredential: credential,
      },
    })
    return dispatchEvent
  }

  it('凭据更新后只重试一次读取，成功恢复不广播失效事件', async () => {
    const dispatched = desktop((refresh) => (refresh ? 'new-token' : 'old-token'))
    const used: Array<string | null> = []
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url, options) => {
        used.push(new Headers(options?.headers).get('Authorization'))
        return used.length === 1 ? new Response('', { status: 401 }) : new Response('{}')
      }),
    )
    const { clientFetch } = await importTransport()
    expect((await clientFetch('http://local.example/api/chat/queue/thread')).status).toBe(200)
    expect(used).toEqual(['Bearer old-token', 'Bearer new-token'])
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('相同失效凭据不重复请求，保留真实的未授权状态', async () => {
    const dispatched = desktop(() => 'revoked-token')
    const request = vi.fn(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', request)
    const { clientFetch } = await importTransport()
    expect((await clientFetch('http://local.example/api/chat/queue/thread')).status).toBe(401)
    expect(request).toHaveBeenCalledTimes(1)
    expect(dispatched.mock.calls[0]?.[0].type).toBe('infos:unauthorized')
  })

  it('写操作不会因凭据刷新自动重放', async () => {
    desktop((refresh) => (refresh ? 'new-token' : 'old-token'))
    const request = vi.fn(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', request)
    const { clientFetch } = await importTransport()
    await clientFetch('http://local.example/api/chat', { method: 'POST', body: '{}' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('保留调用方显式身份，也不向其他服务器附加当前凭据', async () => {
    desktop(() => 'current-token')
    const used: Array<string | null> = []
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url, options) => {
        used.push(new Headers(options?.headers).get('Authorization'))
        return new Response('{}')
      }),
    )
    const { clientFetch } = await importTransport()
    await clientFetch('http://local.example/api/client-access/status', {
      headers: { authorization: 'Bearer explicit-token' },
    })
    await clientFetch('https://other.example/api/health')
    expect(used).toEqual(['Bearer explicit-token', null])
  })

  it('切换服务器后，旧请求的迟到 401 不清退当前连接', async () => {
    let origin = 'http://first.example'
    const dispatchEvent = desktop(() => 'credential')
    window.electron!.backendOrigin = () => origin
    const request = vi.fn(async () => {
      origin = 'https://next.example'
      return new Response('', { status: 401 })
    })
    vi.stubGlobal('fetch', request)
    const { clientFetch } = await importTransport()
    await clientFetch('http://first.example/api/chat/queue/thread')
    expect(request).toHaveBeenCalledTimes(1)
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})

describe('transport singleton', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('应当在 Web 环境通过 HTTP 请求 API 并合并 JSON 头', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ code: 'OK', message: '成功', data: { id: 1 } }),
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    setWindow({
      location: { origin: 'http://localhost:7359', protocol: 'http:', host: 'localhost:7359' },
    })

    const { transport } = await importTransport()
    const result = await transport.request('/agents', { headers: { 'X-Test': '1' } })

    expect(result).toEqual({ code: 'OK', message: '成功', data: { id: 1 } })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:7359/api/agents', {
      headers: expect.any(Headers),
      signal: expect.any(AbortSignal),
      credentials: 'include',
    })
    const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-Test')).toBe('1')
  })

  it('应当在 Web 环境将 HTTP 错误 JSON 信封原样返回', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: () => Promise.resolve({ code: 'VALIDATION_ERROR', message: '参数错误' }),
        }),
      ),
    )
    setWindow({
      location: { origin: 'http://localhost:7359', protocol: 'http:', host: 'localhost:7359' },
    })

    const { transport } = await importTransport()

    await expect(transport.request('/agents')).resolves.toEqual({
      code: 'VALIDATION_ERROR',
      message: '参数错误',
    })
  })

  it('应当在 Web 环境将不可解析错误降级为 NETWORK_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: () => Promise.reject(new Error('不是 JSON')),
        }),
      ),
    )
    setWindow({
      location: { origin: 'http://localhost:7359', protocol: 'http:', host: 'localhost:7359' },
    })

    const { transport } = await importTransport()

    await expect(transport.request('/health')).resolves.toMatchObject({
      code: 'NETWORK_ERROR',
      message: expect.stringContaining('503'),
    })
  })

  it('Web 客户端不能把原生窗口调用映射成虚构的 HTTP 接口', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        json: () => Promise.resolve({ code: 'OK', data: { path: 'C:/Pero' } }),
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    setWindow({
      location: { origin: 'http://localhost:7359', protocol: 'http:', host: 'localhost:7359' },
    })

    const { transport } = await importTransport()
    await expect(transport.invoke('dialog:open', 'workspace')).rejects.toThrow(
      '浏览器客户端不提供本机窗口接口',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('应当在 Electron 环境请求 localhost API 并通过 IPC invoke', async () => {
    const invoke = vi.fn(() => Promise.resolve('完成'))
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ code: 'OK', message: '成功' }),
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    setWindow({
      electron: { invoke },
      location: { origin: 'http://web', protocol: 'http:', host: 'web' },
    })

    const { ELECTRON_BACKEND_ORIGIN, transport } = await importTransport()
    await expect(transport.request('/system/info')).resolves.toEqual({
      code: 'OK',
      message: '成功',
    })
    await expect(transport.invoke('system:open-path', 'C:/Pero')).resolves.toBe('完成')

    expect(fetchMock).toHaveBeenCalledWith(`${ELECTRON_BACKEND_ORIGIN}/api/system/info`, {
      headers: expect.any(Headers),
      signal: expect.any(AbortSignal),
      credentials: 'include',
    })
    expect(invoke).toHaveBeenCalledWith('system:open-path', 'C:/Pero')
  })

  it('读取请求默认有等待上限，调用方取消信号优先，写操作不套用读取时限', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ code: 'OK' }) }))
    vi.stubGlobal('fetch', fetchMock)
    setWindow({ location: { origin: 'http://infos.local' } })
    const { transport } = await importTransport()
    await transport.request('/chat/tasks')
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    const controller = new AbortController()
    await transport.request('/health', { signal: controller.signal })
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.signal).toBe(controller.signal)
    await transport.request('/chat', { method: 'POST', body: '{}' })
    expect(vi.mocked(fetch).mock.calls[2]?.[1]?.signal).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
