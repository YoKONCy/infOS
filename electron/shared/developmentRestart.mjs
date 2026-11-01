// 此退出码仅供开发启动器与 Electron 在完成退出清理后交接重启请求。
export const DEVELOPMENT_RESTART_EXIT_CODE = 75

/** 等待旧 CLI 完整退出后重建 Vite 和 Electron，顶层开发进程始终保持存活。 */
export async function runDevelopmentSessions(runOnce, isStopping, onRestart = () => {}) {
  let restart = true
  let code = 0
  while (restart) {
    code = await runOnce()
    restart = code === DEVELOPMENT_RESTART_EXIT_CODE && !isStopping()
    if (restart) onRestart()
  }
  return code
}
