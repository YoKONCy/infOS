import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { HomeScope } from '@infos/shared'
import { apiClient, ApiError } from '../api'
import { t } from '../i18n'

/** 管理页使用既有认证通道；作用域改变后丢弃旧响应，防止串角色展示。 */
export function useHomeCollection<T>(scope: () => HomeScope | null, endpoint: 'shelf' | 'map') {
  const items = shallowRef<T[]>([])
  const pending = ref(0)
  const failure = shallowRef<{ code: string; message: string } | null>(null)
  const key = computed(() => JSON.stringify(scope()))
  let generation = 0
  let listRevision = 0
  const controllers = new Set<AbortController>()
  const error = computed(() => {
    if (!failure.value) return ''
    if (failure.value.code === 'HOME_PRIVATE')
      return t('home.map', '这条记录包含隐私信息，未保存。请移除凭据、联系方式或禁存词后重试。')
    return failure.value.message || t(`home.${endpoint}`, '操作失败，请重试。')
  })

  async function execute<R>(input: unknown): Promise<R | undefined> {
    const owner = scope()
    if (!owner) return
    const version = generation
    const controller = new AbortController()
    controllers.add(controller)
    pending.value++
    failure.value = null
    try {
      const result = await apiClient.request<R>(`/home/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({ scope: { ...owner }, input }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      })
      if (version === generation) return result.data
    } catch (reason) {
      if (version !== generation) return
      const detail = reason instanceof ApiError ? (reason.data as { homeCode?: string }) : undefined
      failure.value = {
        code: detail?.homeCode ?? '',
        message: reason instanceof ApiError ? reason.message : '',
      }
    } finally {
      controllers.delete(controller)
      pending.value--
    }
  }

  async function refresh(): Promise<void> {
    const revision = ++listRevision
    const result = await execute<T[]>({
      action: 'list',
      includeDeleted: true,
    })
    if (result && revision === listRevision) items.value = result
  }

  function invalidate(): void {
    generation++
    for (const controller of controllers) controller.abort()
    failure.value = null
    items.value = []
  }
  watch(
    key,
    () => {
      invalidate()
      void refresh()
    },
    { immediate: true },
  )
  onScopeDispose(invalidate)
  return { items, busy: computed(() => pending.value > 0), error, execute, refresh, key }
}
