import { t as __t } from '../utils/i18n'
import path from 'node:path'
import { app, Notification } from 'electron'
import { paths } from '../utils/env'
import { logger } from '../utils/logger'
import { windowManager } from '../windows/manager'
import { desktopTabs } from '../windows/desktopTabs'
import { CompletionAlertController } from './completionAlertController'
import { playCompletionTone, stopCompletionTone } from './completionTone'
import { isApplicationFocused } from './notificationVisibility'
import type { CompletionAlert } from '@infos/shared'

function openResult(alert: CompletionAlert): void {
  try {
    const win = windowManager.createDashboardWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    desktopTabs.openHome(alert.kind === 'task' ? 'tasks' : 'chat', {
      agentId: alert.agentId,
      threadId: alert.threadId,
      messageId: alert.messageId,
      taskId: alert.taskId,
    })
  } catch (error) {
    logger.warn(__t('electron.logs.completionAlerts', '完成通知结果跳转失败'), String(error))
  }
}

export const completionAlerts = new CompletionAlertController(
  path.join(paths.userData, 'completion-alerts.json'),
  path.join(paths.userData, 'completion-alerts-seen.json'),
  {
    applicationFocused: isApplicationFocused,
    petVisible: () => windowManager.getPetWindowState().visible,
    playSound: playCompletionTone,
    stopSound: stopCompletionTone,
    windowsNotificationsSupported: () =>
      process.platform === 'win32' && app.isReady() && Notification.isSupported(),
    showNotification: (alert) => {
      const notification = new Notification({
        title: __t('electron.ui.completionAlerts', '{0} 完成了任务', [alert.agentName]),
        body: alert.title,
        silent: true,
      })
      notification.on('click', () => openResult(alert))
      notification.on('failed', (_event, error) =>
        logger.warn(
          __t('electron.logs.completionAlerts', 'Windows 完成通知发送失败'),
          String(error),
        ),
      )
      notification.show()
    },
    warn: (message, error) => logger.warn(message, String(error)),
  },
)
