import { ref, watch, type Ref } from 'vue'
import { useThreadStore } from '../../stores'

/**
 * useUnseenMessages — 「回到最新消息」按钮的新消息提示点。
 *
 * 上翻期间末尾出现新消息时亮起；回到底部或切换会话即清除。
 */
export function useUnseenMessages(
  messages: Readonly<Ref<readonly { id: string }[]>>,
  isAtBottom: Readonly<Ref<boolean>>,
): Ref<boolean> {
  const threadStore = useThreadStore()
  const hasUnseenMessages = ref(false)
  watch(
    [
      () => {
        const last = messages.value[messages.value.length - 1]
        // 占位被真实回复接替时 ID 会变，按渲染 key 判断才不会误亮「有新消息」
        return last ? threadStore.renderKey(last.id) : undefined
      },
      () => threadStore.threadId,
    ],
    ([lastId, thread], [previousId, previousThread]) => {
      if (thread !== previousThread) hasUnseenMessages.value = false
      else if (lastId && previousId && lastId !== previousId && !isAtBottom.value)
        hasUnseenMessages.value = true
    },
  )
  watch(isAtBottom, (bottom) => {
    if (bottom) hasUnseenMessages.value = false
  })
  return hasUnseenMessages
}
