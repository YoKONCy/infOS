import type { BackgroundTaskInfo } from '../../api/modules/backgroundTasksApi'
import { getDisplayLocale, t } from '../../i18n'

export function taskOriginLabel(task: BackgroundTaskInfo): string {
  if (task.parentTaskId) return t('ui.taskCenter', '子任务')
  if (task.lifecycle?.origin || task.metadata?.platform || task.metadata?.socialOrigin)
    return t('ui.taskCenter', '社交会话')
  if (task.metadata?.trigger === 'follow_up') return t('ui.taskCenter', '到期跟进')
  if (task.metadata?.trigger === 'agent_task') return t('ui.taskCenter', '定时计划')
  if (task.metadata?.trigger === 'accepted_suggestion') return t('ui.taskCenter', '你采纳的建议')
  if (task.metadata?.originThreadId || task.targetThreadId) return t('ui.taskCenter', '对话派发')
  return t('ui.taskCenter', '任务中心')
}

export function taskDate(value: string): Date {
  return new Date(value.replace(' ', 'T'))
}

export function taskTime(value?: string | null): string {
  if (!value) return '—'
  const date = taskDate(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(getDisplayLocale()) : '—'
}

export function taskElapsed(task: BackgroundTaskInfo, now = Date.now()): string {
  const ms =
    (task.completedAt ? taskDate(task.completedAt).getTime() : now) -
    taskDate(task.startedAt ?? task.createdAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds >= 3600)
    return t('ui.taskCenter', '{0} 小时 {1} 分', [
      Math.floor(seconds / 3600),
      Math.floor(seconds / 60) % 60,
    ])
  if (seconds >= 60)
    return t('ui.taskCenter', '{0} 分 {1} 秒', [Math.floor(seconds / 60), seconds % 60])
  return t('ui.taskCenter', '{0} 秒', [seconds])
}
