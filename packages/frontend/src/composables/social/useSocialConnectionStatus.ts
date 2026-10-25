import { onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { socialApi, type AdapterStatus } from '../../api/modules/socialApi'
import { ApiError } from '../../api/errors'
import { t } from '../../i18n'

/** 只查询适配器连接状态；隐藏页暂停，慢请求串行，服务异常与未连接分别展示。 */
export function useSocialConnectionStatus(platform: () => string | undefined = () => undefined) {
  const adapters = ref<AdapterStatus[]>([])
  const connected = ref(false)
  const error = ref('')
  let active = false
  let generation = 0
  let loadingGeneration = -1
  let pending: Promise<boolean> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function refresh(): Promise<boolean> {
    if (loadingGeneration === generation && pending) return pending
    loadingGeneration = generation
    pending = readStatus(generation)
    return pending
  }

  async function readStatus(requestGeneration: number): Promise<boolean> {
    clearTimeout(timer)
    let fatal = false
    try {
      const response = await socialApi.getStatus()
      if (requestGeneration !== generation) return false
      adapters.value = response.data?.adapters ?? []
      const adapter = platform()
        ? adapters.value.find((item) => item.platform === platform())
        : adapters.value.length === 1
          ? adapters.value[0]
          : undefined
      connected.value = adapter?.connected ?? false
      error.value = adapter
        ? (adapter.error ?? '')
        : t('ui.social', '社交服务尚未就绪，请检查后端的社交应用启动日志')
      return !!adapter
    } catch (cause) {
      if (requestGeneration !== generation) return false
      connected.value = false
      error.value = t('ui.social', '无法连接社交服务，请检查服务是否启动')
      fatal =
        cause instanceof ApiError &&
        ['FORBIDDEN', 'UNAUTHORIZED', 'AUTH_REQUIRED'].includes(cause.code)
      return false
    } finally {
      if (loadingGeneration === requestGeneration) {
        loadingGeneration = -1
        pending = undefined
      }
      if (active && requestGeneration === generation && !fatal)
        timer = setTimeout(() => void refresh(), 5000)
    }
  }
  function start() {
    if (active) return
    active = true
    void refresh()
  }
  function stop() {
    active = false
    generation++
    clearTimeout(timer)
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onUnmounted(stop)
  return { adapters, connected, error, refresh }
}
