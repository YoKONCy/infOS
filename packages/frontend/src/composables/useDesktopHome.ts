import { onMounted, onUnmounted, ref } from 'vue'
import type { DesktopHomeSection, DesktopHomeSettings, DesktopHomeStatus } from '@infos/shared'
import { t as __t } from '../i18n/index'
import { invoke, isElectron, listen } from '../utils/ipcAdapter'

/**
 * 「桌面与家」的设置与实时状态（录音、陪看、耳朵模型下载）。
 * 只在桌面客户端里可用；数据都来自主进程的 desktop-home.json 与状态推送。
 */
export function useDesktopHome() {
  const settings = ref<DesktopHomeSettings | null>(null)
  const status = ref<DesktopHomeStatus | null>(null)
  const error = ref('')
  let disposed = false
  let remove: (() => void) | undefined

  const failure = (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback

  async function update<S extends DesktopHomeSection>(
    section: S,
    patch: Partial<DesktopHomeSettings[S]>,
  ) {
    try {
      settings.value = (await invoke('desktop-home:update', {
        section,
        patch,
      })) as DesktopHomeSettings
      error.value = ''
    } catch (cause) {
      error.value = failure(cause, __t('ui.desktop', '桌面设置保存失败'))
    }
  }

  async function model(action: 'download' | 'cancel' | 'remove') {
    try {
      status.value = (await invoke('desktop-home:model', action)) as DesktopHomeStatus
      error.value = ''
    } catch (cause) {
      error.value = failure(cause, __t('ui.desktop', '桌面设置保存失败'))
    }
  }

  async function stopListening() {
    try {
      status.value = (await invoke('desktop-home:stop-listening')) as DesktopHomeStatus
    } catch (cause) {
      error.value = failure(cause, __t('ui.desktop', '桌面状态读取失败'))
    }
  }

  onMounted(async () => {
    if (!isElectron()) return
    try {
      const off = await listen('desktop-home:status', (payload) => {
        if (!disposed) status.value = payload as DesktopHomeStatus
      })
      if (disposed) return off()
      remove = off
      const snapshot = (await invoke('desktop-home:get')) as {
        settings: DesktopHomeSettings
        status: DesktopHomeStatus
      }
      if (!disposed) {
        settings.value = snapshot.settings
        status.value = snapshot.status
      }
    } catch (cause) {
      if (!disposed) error.value = failure(cause, __t('ui.desktop', '桌面状态读取失败'))
    }
  })
  onUnmounted(() => {
    disposed = true
    remove?.()
  })
  return { settings, status, error, update, model, stopListening, supported: isElectron() }
}
