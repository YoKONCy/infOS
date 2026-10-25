/** 验收判断保持无副作用，缺失证据与致命错误使用稳定错误码。 */
function isHealthyResponse(status, body) {
  if (status !== 200) return false
  try {
    const result = JSON.parse(body)
    return result?.code === 'OK' && result?.data?.status === 'ok'
  } catch {
    return false
  }
}

function assertStartupLogs(applicationLogs, processLogs = '') {
  if (!applicationLogs.trim()) throw new Error('STARTUP_LOGS_MISSING')
  const logs = `${applicationLogs}\n${processLogs}`
  const forbidden = [
    'App whenReady 失败',
    'App whenReady 失敗',
    'App whenReady failed',
    'ERR_INVALID_ARG_VALUE',
    'Cannot find module',
    'Daemon 提前退出',
    '未捕获的异常',
    '未捕獲的例外狀況',
    'Uncaught exception',
  ]
  const failures = forbidden.filter((text) => logs.includes(text))
  if (failures.length) throw new Error(`STARTUP_FATAL_ERROR: ${failures.join(', ')}`)
}

module.exports = { isHealthyResponse, assertStartupLogs }
