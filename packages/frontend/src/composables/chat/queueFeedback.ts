import { t as __t } from '../../i18n/index'
/** 队列只展示可操作的简短提示，原始异常保留在日志中。 */
export function queueErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/附件过多/.test(message)) return __t('ui.chat', '输入栏附件已满')
  if (/附件/.test(message)) return __t('ui.chat', '附件暂不可用，请检查')
  if (/已发送|执行器|交接|已开始/.test(message)) return __t('ui.chat', '消息已开始执行')
  if (/上限|最多|队列已满/.test(message)) return __t('ui.chat', '队列已满')
  if (/不存在|已处理/.test(message)) return __t('ui.chat', '消息已移出队列')
  if (/CONFLICT|版本|顺序|客户端|更新|状态已变化/i.test(message))
    return __t('ui.chat', '队列已更新，请重试')
  if (/fetch|network|网络|连接|timeout|超时/i.test(message))
    return __t('ui.chat', '连接异常，请稍后重试')
  return __t('ui.chat', '队列操作失败，请重试')
}

export function queueNotice(
  paused: boolean,
  unavailable: boolean,
  reason = '',
  hasPending = true,
):
  | {
      icon: string
      text: string
      animation?: string
    }
  | undefined {
  if (unavailable)
    return {
      icon: 'refresh',
      get text() {
        return __t('ui.chat', '连接中断，正在重连')
      },
      animation: 'spin',
    }
  if (!paused) return undefined
  if (/失败|错误|异常/.test(reason))
    return {
      icon: 'alert',
      get text() {
        return __t('ui.chat', '发送失败，队列已暂停')
      },
    }
  if (/历史/.test(reason))
    return {
      icon: 'info',
      get text() {
        return hasPending
          ? __t('ui.chat', '历史已更新，请核对待发消息')
          : __t('ui.chat', '对话历史已更新，队列已暂停')
      },
    }
  if (/重启/.test(reason))
    return {
      icon: 'info',
      get text() {
        return __t('ui.chat', '队列已保留，等待发送')
      },
    }
  return {
    icon: 'info',
    get text() {
      return __t('ui.chat', '队列已暂停')
    },
  }
}
