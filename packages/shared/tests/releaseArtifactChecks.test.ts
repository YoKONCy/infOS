import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { isHealthyResponse, assertStartupLogs } = createRequire(import.meta.url)(
  '../../../scripts/release-artifact-checks.cjs',
)

describe('发行验收证据', () => {
  it.each([
    [200, '{"code":"OK","data":{"status":"ok"}}', true],
    [200, '{"code":"OK","data":{"status":"failed"},"detail":"ok"}', false],
    [200, '{"ok":false}', false],
    [200, 'null', false],
    [200, 'invalid JSON', false],
    [503, '{"code":"OK","data":{"status":"ok"}}', false],
  ])('健康响应 %s %s 必须按结构判断为 %s', (status, body, expected) => {
    expect(isHealthyResponse(status, body)).toBe(expected)
  })

  it.each(['', ' \r\n '])('缺少非空应用日志时失败，标准输出不能补足证据：%j', (logs) => {
    expect(() => assertStartupLogs(logs, 'Daemon ready')).toThrow('STARTUP_LOGS_MISSING')
  })

  it.each([
    ['Cannot find module missing.cjs', ''],
    ['[INFO] 启动完成', 'ERR_INVALID_ARG_VALUE'],
    ['App whenReady failed: startup', ''],
  ])('应用日志或进程输出中的致命错误阻止验收：%s %s', (logs, stdout) => {
    expect(() => assertStartupLogs(logs, stdout)).toThrow('STARTUP_FATAL_ERROR')
  })

  it('正常应用日志允许通过', () => {
    expect(() => assertStartupLogs('[INFO] 启动完成', '')).not.toThrow()
  })
})
