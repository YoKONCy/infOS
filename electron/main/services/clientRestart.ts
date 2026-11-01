import { app, dialog } from 'electron'
import { isDevelopmentRuntime } from '../utils/runtimeMode'
import { t } from '../utils/i18n'
import { DEVELOPMENT_RESTART_EXIT_CODE } from '../../shared/developmentRestart.mjs'
let requested = false

/** 连接配置已落盘；实际重启要等现有应用同意退出及清理全部完成。 */
export async function requestClientRestart(): Promise<void> {
  if (isDevelopmentRuntime && process.env.INFOS_DEV_RESTART_MANAGED !== '1') {
    await dialog.showMessageBox({
      type: 'info',
      title: t('electron.ui.connection', '请重启开发环境'),
      message: t(
        'electron.ui.connection',
        '连接配置已保存。请在开发终端停止并重新运行 pnpm dev:electron 或 pnpm start。',
      ),
    })
    return
  }
  requested = true
  app.quit()
}

export function cancelClientRestart(): void {
  requested = false
}

/** 返回 true 表示退出已交给开发宿主，否则由原生命周期继续退出。 */
export function completeClientRestart(): boolean {
  if (!requested) return false
  requested = false
  if (isDevelopmentRuntime) {
    app.exit(DEVELOPMENT_RESTART_EXIT_CODE)
    return true
  }
  app.relaunch()
  return false
}
