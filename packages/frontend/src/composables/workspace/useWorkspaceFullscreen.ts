import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/** 在原 DOM 上全屏，避免重新挂载文档或中断正在播放的媒体。 */
export function useWorkspaceFullscreen(target: Ref<HTMLElement | null>, active: Ref<boolean>) {
  const expanded = ref(false)
  const pending = ref(false)
  let disposed = false

  function changed() {
    expanded.value = !!target.value && document.fullscreenElement === target.value
  }
  async function exit() {
    if (target.value && document.fullscreenElement === target.value) {
      await document.exitFullscreen().catch(() => undefined)
    }
  }
  async function toggle(): Promise<boolean> {
    const element = target.value
    if (!element || pending.value || !active.value) return false
    pending.value = true
    try {
      if (document.fullscreenElement === element) await document.exitFullscreen()
      else await element.requestFullscreen()
      if (disposed || !active.value) await exit()
      changed()
      return true
    } catch {
      return false
    } finally {
      pending.value = false
    }
  }
  watch(active, (value) => {
    if (!value) void exit()
  })
  onMounted(() => document.addEventListener('fullscreenchange', changed))
  onBeforeUnmount(() => {
    disposed = true
    void exit()
    document.removeEventListener('fullscreenchange', changed)
  })
  return { expanded, pending, toggle }
}
