import { onMounted, onUnmounted, ref } from 'vue'
import type { DesktopControlSettings, DesktopControlState } from '@infos/shared'
import { invoke, isElectron, listen } from '../utils/ipcAdapter'

export function useDesktopControl() {
  const state = ref<DesktopControlState>({
    phase: 'idle',
    epoch: 0,
    stopShortcut: 'Control+Alt+Escape',
  })
  const settings = ref<DesktopControlSettings>({
    enabled: true,
    stopShortcut: 'Control+Alt+Escape',
  })
  const error = ref('')
  let disposed = false
  let remove: (() => void) | undefined
  async function control(action: 'pause' | 'resume') {
    try {
      state.value = (await invoke(`desktop-control:${action}`)) as DesktopControlState
      error.value = ''
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '桌面控制暂时不可用'
      return false
    }
  }
  async function update(patch: Partial<DesktopControlSettings>) {
    try {
      settings.value = (await invoke('desktop-control:update', patch)) as DesktopControlSettings
      error.value = ''
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '桌面设置保存失败'
    }
  }
  onMounted(async () => {
    if (!isElectron()) return
    try {
      const off = await listen('desktop-control:changed', (payload) => {
        if (disposed) return
        const next = payload as DesktopControlState
        state.value = next
        // 别的卡片改了总开关时，主进程广播里带着 enabled，这里跟着更新
        if (typeof next.enabled === 'boolean')
          settings.value = { ...settings.value, enabled: next.enabled, stopShortcut: next.stopShortcut }
      })
      if (disposed) {
        off()
        return
      }
      remove = off
      const snapshot = (await invoke('desktop-control:get')) as {
        state: DesktopControlState
        settings: DesktopControlSettings
      }
      if (!disposed) {
        state.value = snapshot.state
        settings.value = snapshot.settings
      }
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : '桌面状态读取失败'
    }
  })
  onUnmounted(() => {
    disposed = true
    remove?.()
  })
  return { state, settings, error, control, update, supported: isElectron() }
}
