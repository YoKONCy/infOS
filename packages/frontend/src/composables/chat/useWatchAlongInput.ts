import { onDeactivated, onScopeDispose, watch, type Ref } from 'vue'
import { invoke, isElectron } from '../../utils/ipcAdapter'
import { useEventListener } from '../useEventListener'
import { useInterval } from '../useInterval'

type Target = { agentId: string; threadId: string; channel?: string }

/** 敲完键这么久还没再敲，就不算在打字。 */
const TYPING_MS = 6000

/**
 * 告诉宿主用户正在输入，五秒续期；只发送会话身份与布尔值，不发送文字。
 * 光标停在输入框里不算：发完一句话光标还在，要是也算，她就一直被打断、一直不能开口。
 */
export function useWatchAlongInput(
  element: Ref<HTMLTextAreaElement | null>,
  target: () => Target,
): void {
  let previous: Target | undefined
  let active = false
  let typedAt = -Infinity
  const send = (value: Target, next: boolean) => {
    if (isElectron() && value.agentId && value.threadId && value.channel !== 'group')
      void invoke('desktop-home:input-activity', {
        agentId: value.agentId,
        threadId: value.threadId,
        active: next,
      }).catch(() => {})
  }
  const stop = () => {
    if (previous && active) send(previous, false)
    active = false
    previous = undefined
  }
  const sync = (heartbeat = false) => {
    const current = target()
    if (
      previous &&
      (previous.agentId !== current.agentId || previous.threadId !== current.threadId)
    )
      stop()
    const next =
      document.hasFocus() &&
      !document.hidden &&
      document.activeElement === element.value &&
      Date.now() - typedAt < TYPING_MS
    if (next !== active || (next && heartbeat)) send(current, next)
    active = next
    previous = { ...current }
  }
  useEventListener(element, 'input', () => {
    typedAt = Date.now()
    sync()
  })
  useEventListener(element, 'focus', () => sync())
  useEventListener(element, 'blur', () => sync())
  useEventListener(window, 'focus', () => sync())
  useEventListener(window, 'blur', stop)
  useEventListener(document, 'visibilitychange', () => sync())
  watch(
    () => JSON.stringify(target()),
    () => sync(),
  )
  useInterval(() => sync(true), 5000)
  onDeactivated(stop)
  onScopeDispose(stop)
}
