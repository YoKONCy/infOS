import { onMounted, onUnmounted, ref } from 'vue'
import {
  socialApi,
  type SocialConnection,
  type SocialManagementSnapshot,
} from '../../api/modules/socialApi'
import { t } from '../../i18n'

/** 仅复用请求与生命周期；登录方式、权限说明和表单由各平台独立实现。 */
export function usePlatformAccounts(
  connection: () => SocialConnection | undefined,
  changed: () => void,
) {
  const snapshot = ref<SocialManagementSnapshot>({ accounts: [] })
  const busy = ref(false)
  const loading = ref(true)
  const error = ref('')
  let alive = true
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let polling: AbortController | undefined
  const lifetime = new AbortController()
  function apply(next: SocialManagementSnapshot) {
    const old = snapshot.value
    snapshot.value = next
    if (
      JSON.stringify(old.accounts) !== JSON.stringify(next.accounts) ||
      old.ownerId !== next.ownerId
    )
      changed()
  }
  function schedule() {
    clearTimeout(timer)
    if (alive && connection()) timer = setTimeout(() => void poll(), 2000)
  }
  async function poll() {
    const target = connection()
    if (!alive || busy.value || !target) {
      loading.value = false
      return
    }
    const current = generation
    const controller = new AbortController()
    polling = controller
    const signal = AbortSignal.any([controller.signal, lifetime.signal])
    try {
      const login = snapshot.value.login
      const response =
        login && ['wait', 'scaned', 'scaned_but_redirect'].includes(login.status)
          ? await socialApi.manageConnection(target.id, 'login_poll', { loginId: login.id }, signal)
          : await socialApi.getConnectionManagement(target.id, signal)
      if (alive && current === generation && response.data) {
        apply(response.data)
        error.value = ''
      }
    } catch (cause) {
      if (alive && current === generation && !signal.aborted)
        error.value = cause instanceof Error ? cause.message : t('ui.social', '连接操作失败')
    } finally {
      if (alive && current === generation) {
        loading.value = false
        schedule()
      }
      if (polling === controller) polling = undefined
    }
  }
  async function action(name: string, input: Record<string, unknown> = {}): Promise<boolean> {
    const target = connection()
    if (!alive || busy.value || !target) return false
    busy.value = true
    error.value = ''
    generation++
    clearTimeout(timer)
    polling?.abort()
    try {
      const response = await socialApi.manageConnection(target.id, name, input, lifetime.signal)
      if (!alive) return false
      if (response.data) apply(response.data)
      return true
    } catch (cause) {
      if (alive)
        error.value = cause instanceof Error ? cause.message : t('ui.social', '连接操作失败')
      return false
    } finally {
      busy.value = false
      loading.value = false
      schedule()
    }
  }
  onMounted(() => void poll())
  onUnmounted(() => {
    alive = false
    generation++
    clearTimeout(timer)
    polling?.abort()
    lifetime.abort()
    snapshot.value = { accounts: [] }
  })
  return { snapshot, busy, loading, error, action }
}
