import { t as __t } from '../../i18n/index'
import { watch } from 'vue'
import { useNotificationStore, useThreadStore } from '../../stores'
import { logger } from '../../lib/logger'
import { usePerception } from '../usePerception'

/**
 * useProactiveMessageHandler — 主动消息（含陪看）到达时的处理。
 *
 * 当前会话的消息刷新进消息流；她正在回话时先记下，回完再刷新。
 * 聊天窗看不到时，陪看消息改用通知层显示。返回值交给 Gateway 的 proactive_message 订阅。
 */
export function useProactiveMessageHandler(): (payload: Record<string, unknown>) => void {
  const threadStore = useThreadStore()
  const notifyStore = useNotificationStore()
  let refreshWhenIdle = false
  function refreshProactive(): void {
    void threadStore
      .refreshCurrentThread()
      .catch((error) =>
        logger.warn(
          'MainView',
          __t('logs.frontend.navigation', '主动消息已保存，刷新会话失败'),
          error,
        ),
      )
  }
  // 她正在回话时到的陪看消息，回完再刷新，否则要等下一次才看得到。
  watch(
    () => threadStore.isGenerating,
    (generating) => {
      if (generating || !refreshWhenIdle) return
      refreshWhenIdle = false
      refreshProactive()
    },
  )
  const { state: perceptionState } = usePerception()
  return (payload) => {
    // 聊天窗被盖住或在别的会话时看不到，没配语音就等于没说，用通知层显示。
    const elsewhere =
      payload.threadId !== threadStore.threadId || payload.agentId !== threadStore.agentId
    if (
      payload.mode === 'companion' &&
      typeof payload.content === 'string' &&
      (elsewhere || document.hidden || perceptionState.value?.chatHidden)
    )
      notifyStore.toast(payload.content.slice(0, 160), 'info')
    if (elsewhere) return
    if (threadStore.isGenerating) refreshWhenIdle = true
    else refreshProactive()
  }
}
