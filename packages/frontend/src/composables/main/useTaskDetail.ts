import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { backgroundTasksApi, type BackgroundTaskInfo } from '../../api/modules/backgroundTasksApi'
import { t } from '../../i18n'

/** 详情独立刷新；关闭、切换任务和页面卸载都会使旧请求失效。 */
export function useTaskDetail() {
  const task = shallowRef<BackgroundTaskInfo | null>(null)
  const error = ref('')
  const loading = ref(false)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let selectedId: string | null = null

  async function load(id: string): Promise<boolean> {
    const request = ++generation
    clearTimeout(timer)
    loading.value = true
    try {
      const response = await backgroundTasksApi.detail(id)
      if (request !== generation) return false
      if (!response.data) throw new Error(t('ui.taskCenter', '任务暂时无法打开'))
      if (!task.value || (response.data.revision ?? 0) >= (task.value.revision ?? 0))
        task.value = response.data
      error.value = ''
      return true
    } catch (reason) {
      if (request === generation)
        error.value =
          reason instanceof Error ? reason.message : t('ui.taskCenter', '任务暂时无法打开')
      return false
    } finally {
      if (request === generation) {
        loading.value = false
        if (selectedId === id && task.value) timer = setTimeout(() => void load(id), 5000)
      }
    }
  }

  function close(): void {
    generation++
    selectedId = null
    clearTimeout(timer)
    task.value = null
    loading.value = false
    error.value = ''
  }
  function open(value: string | BackgroundTaskInfo): Promise<boolean> {
    const id = typeof value === 'string' ? value : value.id
    if (selectedId !== id) close()
    selectedId = id
    if (
      typeof value !== 'string' &&
      (!task.value || (value.revision ?? 0) >= (task.value.revision ?? 0))
    )
      task.value = value
    return load(id)
  }
  function refresh(): Promise<boolean> {
    return selectedId ? load(selectedId) : Promise.resolve(false)
  }
  onBeforeUnmount(close)
  return { task, loading, error, open, close, refresh }
}
