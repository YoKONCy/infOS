import { t as __t } from '../../../i18n/index'
import { ApiError } from '../../../api/errors'

/** 后端家的错误：显示文案由后端按语言给出，业务判断用 homeCode。 */
export function homeCode(cause: unknown): string | undefined {
  if (!(cause instanceof ApiError)) return undefined
  const value = (cause.data as { homeCode?: unknown } | undefined)?.homeCode
  return typeof value === 'string' ? value : undefined
}

export function homeErrorText(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  return __t('ui.desktop', '操作失败，请稍后重试')
}

/** 今天的只显示时分，其余显示月日和时分，完整时间放在 title 里。 */
export function formatTime(time: number): string {
  const date = new Date(time)
  const today = new Date().toDateString() === date.toDateString()
  return date.toLocaleString(undefined, {
    ...(today ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatFullTime(time: number): string {
  return new Date(time).toLocaleString()
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 活动与检查点的动作名（后端 action 是稳定标识，只在这里翻译）。 */
export function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    read: '读取',
    write: '修改',
    move: '移动',
    delete: '删除',
    undo: '撤回',
    restore: '恢复',
    declare: '声明范围',
    app: '操作应用',
    send: '发送消息',
    pay: '付款',
    settings: '改系统设置',
    terminal: '终端命令',
    confirmation: '问过你',
  }
  return labels[action] ? __t('ui.desktop', labels[action]) : action
}

export function resultLabel(result: string): string {
  const labels: Record<string, string> = {
    success: '成功',
    failed: '失败',
    waiting: '等待确认',
    conflict: '冲突',
  }
  return labels[result] ? __t('ui.desktop', labels[result]) : result
}

export function checkpointStateLabel(state: string): string {
  const labels: Record<string, string> = {
    pending: '未完成，需要核对',
    applied: '已生效',
    undone: '已撤回',
    expired: '备份已过期',
    failed: '未生效',
  }
  return labels[state] ? __t('ui.desktop', labels[state]) : state
}

/** 路径只显示文件名，完整路径放在 title 里。 */
export function baseName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).at(-1) ?? file
}
