import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@infos/backend/app'

/**
 * 观测性集成测试。
 *
 * 这里刻意走 createApp()，而不是只测单个 router，确保全局中间件顺序也被覆盖：
 * CORS → requestContext → requestLogger → 路由。
 */

/** 创建最小 AppContext；本测试只访问 health 与日志格式化，不需要真实业务服务 */
function createAppContext() {
  return {
    pathResolver: { getRoot: () => process.env.INFOS_TEST_TEMP_ROOT! },
    ttsService: {},
    asrService: {},
    gatewayHub: { connectedCount: 0 },
    agentManager: { listAgents: () => [], activeAgentId: null },
    systemService: {
      getSnapshot: async () => ({
        memoryUsedMB: 1,
        heapUsedMB: 1,
        cpuPercent: 0,
        totalMemoryMB: 1,
        sqliteSizeMB: 0,
        triviumSizeMB: 0,
      }),
      openPath: async () => undefined,
    },
  }
}

/** 创建隔离应用实例，并清空 metrics 运行时采集值，避免测试之间互相污染。 */
async function createIsolatedApp() {
  vi.resetModules()
  const [{ createApp: createIsolatedAppInstance }, { resetMetricsForTest }] = await Promise.all([
    import('@infos/backend/app'),
    import('@infos/backend/lib/metrics'),
  ])
  resetMetricsForTest()
  return createIsolatedAppInstance(createAppContext() as never)
}

describe('观测性集成', () => {
  afterEach(() => {
    // 部分测试会重载环境变量和模块缓存，清理后避免污染后续用例
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('应当透传外部 requestId 并写入响应头', async () => {
    const app = createApp(createAppContext() as never)

    const response = await app.request('/api/health', {
      headers: { 'x-request-id': 'req_external' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('req_external')
  })

  it('应当在缺少 requestId 时自动生成响应头', async () => {
    const app = createApp(createAppContext() as never)

    const response = await app.request('/api/health')
    const requestId = response.headers.get('x-request-id')

    expect(response.status).toBe(200)
    expect(requestId).toMatch(/^req_/)
  })

  it('应当在 HTTP 响应中返回有效的 OpenTelemetry traceId', async () => {
    const app = createApp(createAppContext() as never)

    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('x-trace-id')).toMatch(/^[a-f0-9]{32}$/)
  })

  it('应当在请求上下文中读取 requestId 并注入文本日志行', async () => {
    // 与 formatLogLine 使用同一轮动态 import，避免 resetModules 后出现两个 AsyncLocalStorage 实例
    const [{ formatLogLine }, { getRequestId, runWithRequestContext }] = await Promise.all([
      import('@infos/backend/lib/logFileTransport'),
      import('@infos/backend/lib/requestContext'),
    ])
    const line = runWithRequestContext({ requestId: 'req_log' }, () => {
      expect(getRequestId()).toBe('req_log')
      return formatLogLine(3, 'Test', '完成', [{ ok: true }])
    })

    expect(line).toContain('[INFO]')
    expect(line).toContain('[Test]')
    expect(line).toContain('[req_log]')
    expect(line).toContain('完成')
    expect(line).toContain('{"ok":true}')
  })

  it('应当在 json 日志格式下输出 JSON Lines 记录', async () => {
    // LOG_FORMAT 在 env 模块加载时确定，因此要先设置环境变量，再重载相关模块
    vi.stubEnv('PERO_LOG_FORMAT', 'json')
    vi.resetModules()

    const [{ formatLogLine }, { runWithRequestContext: runIsolatedContext }] = await Promise.all([
      import('@infos/backend/lib/logFileTransport'),
      import('@infos/backend/lib/requestContext'),
    ])

    const line = runIsolatedContext(
      {
        requestId: 'req_json',
        traceId: '0123456789abcdef0123456789abcdef',
        agentId: 'pero',
        sessionId: 's1',
        source: 'desktop',
      },
      () => formatLogLine(3, 'JsonTest', '完成', [{ ok: true }, 'extra']),
    )
    const record = JSON.parse(line) as Record<string, unknown>

    expect(record).toMatchObject({
      level: 'INFO',
      tag: 'JsonTest',
      message: '完成',
      requestId: 'req_json',
      traceId: '0123456789abcdef0123456789abcdef',
      agentId: 'pero',
      sessionId: 's1',
      source: 'desktop',
      ok: true,
      extra: ['extra'],
    })
    expect(typeof record.timestamp).toBe('string')
  })

  it('应当暴露 Prometheus metrics 端点', async () => {
    const app = await createIsolatedApp()

    const response = await app.request('/metrics')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(body).toContain('# HELP infos_http_requests_total')
    expect(body).toContain('# HELP infos_http_request_duration_seconds')
    expect(body).toContain('infos_process_cpu_user_seconds_total')
  })

  it('应当记录 HTTP 请求计数和耗时指标', async () => {
    const app = await createIsolatedApp()

    await app.request('/api/health')
    const response = await app.request('/metrics')
    const body = await response.text()

    expect(body).toContain(
      'infos_http_requests_total{method="GET",route="/api/health",status="200"} 1',
    )
    expect(body).toContain(
      'infos_http_request_duration_seconds_count{method="GET",route="/api/health",status="200"} 1',
    )
  })
})
