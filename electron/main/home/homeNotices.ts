/**
 * @file 「家」通知的装配：订阅实时事件，维护确认队列与活动提示，驱动右下角通知窗口与顶部「她在操作」标记。
 * @platform ELECTRON
 */

import { logger } from '../utils/logger'
import { t as __t } from '../utils/i18n'
import type { HomeChoice } from '../../../packages/shared/src/home'
import { onHomeEvent } from './homeEvents'
import { homeApi } from './homeApi'
import { ConfirmationQueue } from './homeConfirmations'
import { ActivityBoard } from './homeActivityBoard'
import { windowManager } from '../windows/manager'
import { desktopTabs } from '../windows/desktopTabs'
import { activityNotice, confirmationNotice, type HomeNotice } from './homeNoticeView'
import { HomeNoticeWindow, type HomeNoticeAction } from './homeNoticeWindow'
import { homeOperatingBar } from './homeOperatingBar'

let render = () => {}

export const homeConfirmations = new ConfirmationQueue({
  api: homeApi,
  now: Date.now,
  changed: () => render(),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

export const homeActivities = new ActivityBoard({
  api: homeApi,
  now: Date.now,
  changed: () => render(),
})

/** 确认请求排在上面（需要你回答），活动提示在下面。 */
function notices(): HomeNotice[] {
  return [
    ...homeConfirmations.list().map(confirmationNotice),
    ...homeActivities
      .list()
      .map((toast) => activityNotice(toast, homeActivities.undoable(toast).length > 0)),
  ]
}

function handle(action: HomeNoticeAction): void {
  const id = typeof action.id === 'string' ? action.id : ''
  if (action.kind === 'choose' && id)
    void homeConfirmations
      .choose(id, action.choice as HomeChoice, action.confirm === true)
      .catch(() => undefined)
  else if (action.kind === 'back' && id) homeConfirmations.back(id)
  else if (action.kind === 'toggle' && id) homeActivities.toggle(id)
  else if (action.kind === 'dismiss' && id) homeActivities.dismiss(id)
  else if (action.kind === 'undo' && id) void homeActivities.undo(id)
  else if (action.kind === 'hover') homeActivities.hover(action.hovered === true)
  else if (action.kind === 'open') {
    // 完整记录在设置页「桌面与家」里。
    windowManager.createDashboardWindow()
    desktopTabs.openHome('user_settings')
  }
}

const window = new HomeNoticeWindow(notices, handle)
let unsubscribe: Array<() => void> = []
let sweeper: ReturnType<typeof setInterval> | undefined

function refetch(): void {
  void homeConfirmations
    .refresh()
    .catch((error: unknown) =>
      logger.warn(
        'HomeNotices',
        __t('electron.logs.home', '读取待确认请求失败：{0}', [String(error)]),
      ),
    )
}

export function startHomeNotices(): void {
  if (unsubscribe.length) return
  render = () => window.refresh()
  unsubscribe = [
    onHomeEvent('confirmation', (data) => homeConfirmations.upsert(data)),
    onHomeEvent('activity', (data) => homeActivities.add(data)),
    // 事件流有界：重连后重新拉取待确认请求，不把 SSE 当历史。
    onHomeEvent('reconnected', refetch),
  ]
  sweeper = setInterval(() => homeActivities.sweep(), 1000)
  sweeper.unref?.()
  // 事件流由 index.ts 统一启动和停止（卡片也在用），这里只订阅。
  refetch()
  // 「她在操作」标记与一键停止。
  homeOperatingBar.start()
}

export function stopHomeNotices(): void {
  for (const off of unsubscribe) off()
  unsubscribe = []
  homeOperatingBar.stop()
  clearInterval(sweeper)
  homeConfirmations.clear()
  homeActivities.clear()
  render = () => {}
  window.dispose()
}
