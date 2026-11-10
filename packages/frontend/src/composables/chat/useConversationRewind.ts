import { t as __t } from '../../i18n/index'
import { ref } from 'vue'
import { chatApi, type RewindPreview, type RewindResult } from '../../api/modules/chatApi'
import { useNotificationStore } from '../../stores'

export interface RewindRequest {
  threadId: string
  messageId?: number
  wholeThread?: boolean
  title?: string
  autoConfirmWithoutFiles?: boolean
  preserveInputAttachments?: boolean
  restoreFiles?: boolean
  beforeConfirm?: () => void | Promise<void>
  onSuccess?: (result: RewindResult) => void | Promise<void>
}

/**
 * 全局一致的对话 rewind 控制器。
 * 各页面只提供目标与成功回调，统一执行预检、确认和回滚。
 */
export function useConversationRewind() {
  const notifications = useNotificationStore()
  const visible = ref(false)
  const loading = ref(false)
  const preview = ref<RewindPreview | null>(null)
  const request = ref<RewindRequest | null>(null)

  async function open(next: RewindRequest): Promise<void> {
    loading.value = true
    request.value = next
    let automatic = false
    try {
      const response = await chatApi.previewRewind(next.threadId, {
        messageId: next.messageId,
        wholeThread: next.wholeThread,
        preserveInputAttachments: next.preserveInputAttachments,
        restoreFiles: next.restoreFiles,
      })
      if (!response.data) throw new Error('回滚预检未返回数据')
      preview.value = response.data
      automatic =
        next.autoConfirmWithoutFiles === true &&
        response.data.files.length === 0 &&
        response.data.pairCount <= 1
      visible.value = !automatic
    } finally {
      loading.value = false
    }
    if (automatic) await confirm()
  }

  async function confirm(): Promise<RewindResult | null> {
    const current = request.value
    if (!current || loading.value) return null
    const action = current.wholeThread ? '删除' : '回滚'
    loading.value = true
    let completed = false
    try {
      await current.beforeConfirm?.()
      const before = new CustomEvent('infos:before-workspace-rewind', {
        cancelable: true,
        detail: {
          threadId: current.threadId,
          agentId: preview.value?.agentId,
          files: preview.value?.files ?? [],
        },
      })
      if (!current.wholeThread && !window.dispatchEvent(before)) return null
      const response = await chatApi.rewind(current.threadId, {
        messageId: current.messageId,
        wholeThread: current.wholeThread,
        preserveInputAttachments: current.preserveInputAttachments,
        restoreFiles: current.restoreFiles,
      })
      if (!response.data) throw new Error(`${action}未返回结果`)
      completed = true
      visible.value = false
      preview.value = null
      request.value = null
      try {
        await current.onSuccess?.(response.data)
      } finally {
        if (!current.wholeThread)
          window.dispatchEvent(
            new CustomEvent('infos:workspace-rewound', {
              detail: {
                threadId: current.threadId,
                agentId: response.data.preview.agentId,
                files: response.data.preview.files,
              },
            }),
          )
      }
      return response.data
    } catch (cause) {
      notifications.toast(
        completed
          ? __t('ui.chat', '{0}已完成，界面同步失败，请刷新页面', [action])
          : cause instanceof Error
            ? cause.message
            : __t('ui.chat', '{0}失败，请稍后重试', [action]),
        { type: 'error' },
      )
      return null
    } finally {
      loading.value = false
    }
  }

  return { visible, loading, preview, request, open, confirm }
}
