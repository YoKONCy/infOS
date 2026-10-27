import { onUnmounted, watch, type Ref } from 'vue'
import { useGateway } from '../gateway/useGateway'
import { useAchievementStore } from '../../stores/useAchievementStore'

/** 推送只提示刷新，服务端快照才是达成事实；定时与重连读取补偿离线事件。 */
export function useAchievements(authenticated: Ref<boolean>): void {
  const store = useAchievementStore()
  const gateway = useGateway()
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  const refresh = async () => {
    if (
      disposed ||
      !authenticated.value ||
      window.electron?.embedded ||
      window.electron?.toastOverlay
    )
      return
    await store.refresh()
    if (!disposed && authenticated.value) await store.notifyEarned()
  }
  const refreshSoon = () => {
    void refresh()
  }
  gateway.onPush('conversation_reply_ready', refreshSoon)
  const stopConnected = watch(gateway.isConnected, (connected) => {
    if (connected) refreshSoon()
  })
  const stopAuthenticated = watch(
    authenticated,
    (active) => {
      if (timer) clearInterval(timer)
      timer = undefined
      store.reset()
      if (!active) return
      refreshSoon()
      timer = setInterval(refreshSoon, 60_000)
    },
    { immediate: true },
  )
  window.addEventListener('focus', refreshSoon)
  onUnmounted(() => {
    disposed = true
    if (timer) clearInterval(timer)
    stopConnected()
    stopAuthenticated()
    gateway.offPush('conversation_reply_ready', refreshSoon)
    window.removeEventListener('focus', refreshSoon)
    store.reset()
  })
}
