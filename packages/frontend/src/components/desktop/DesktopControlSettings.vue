<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { onBeforeUnmount, onDeactivated, ref } from 'vue'
import { useDesktopControl } from '../../composables/useDesktopControl'
import { invoke } from '../../utils/ipcAdapter'
import { recordPetShortcut } from '../../utils/petShortcuts'
import { PCard, PSwitch, PButton, PixelIcon } from '../pixel'
import DesktopControlStatus from './DesktopControlStatus.vue'
import { useSystemSettingsPage } from '../../composables/ui/useSystemSettingsPage'
import type { DesktopControlSettings } from '@infos/shared'
const { settings, error, update, supported } = useDesktopControl()
const page = useSystemSettingsPage()
async function savePatch(patch: Partial<DesktopControlSettings>): Promise<void> {
  const persist = async () => {
    await update(patch)
    if (error.value) throw new Error(error.value)
  }
  if (page) await page.save(persist, `desktop-control:${Object.keys(patch).sort().join(',')}`)
  else await persist().catch(() => undefined)
}
const capturing = ref(false)
const captureError = ref('')
let version = 0
async function endCapture() {
  capturing.value = false
  version++
  await invoke('desktop-control:capture', false).catch(() => {})
}
async function beginCapture() {
  const current = ++version
  try {
    await invoke('desktop-control:capture', true)
    if (current !== version) {
      await endCapture()
      return
    }
    capturing.value = true
    captureError.value = ''
  } catch (cause) {
    captureError.value = cause instanceof Error ? cause.message : '快捷键录入失败'
  }
}
async function capture(event: KeyboardEvent) {
  if (!capturing.value) return
  event.preventDefault()
  event.stopPropagation()
  if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    await endCapture()
    return
  }
  if (event.repeat || event.isComposing) return
  const binding = recordPetShortcut(event, false)
  if (!binding) {
    captureError.value = '请按下一个按键或组合键'
    return
  }
  await endCapture()
  await savePatch({ stopShortcut: binding })
}
onBeforeUnmount(() => {
  void endCapture()
})
onDeactivated(() => {
  void endCapture()
})
</script>

<template>
  <PCard v-if="supported" pixel padding="lg" overflow-visible>
    <h3 class="desktop-settings-title">
      <PixelIcon name="monitor" size="sm" />
      {{ __t('ui.desktop', '桌面操作') }}
    </h3>
    <div class="desktop-settings-row">
      <div>
        <strong>{{ __t('ui.desktop', '允许桌面操作') }}</strong>
        <p>{{ __t('ui.desktop', '用户操作鼠标键盘时暂停，继续后重新观察界面。') }}</p>
      </div>
      <PSwitch
        :model-value="settings.enabled"
        :disabled="page?.disabled.value"
        @update:model-value="savePatch({ enabled: $event })"
      />
    </div>
    <div class="desktop-settings-row">
      <label>{{ __t('ui.desktop', '停止快捷键') }}</label>
      <PButton
        variant="ghost"
        :disabled="page?.disabled.value"
        @click="beginCapture"
        @keydown="capture"
        @blur="endCapture"
      >
        {{ capturing ? __t('ui.desktop', '按下快捷键…') : settings.stopShortcut }}
      </PButton>
    </div>
    <p v-if="error || captureError" role="alert">{{ error || captureError }}</p>
    <DesktopControlStatus />
  </PCard>
</template>

<style scoped>
.desktop-settings-title {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 20px;
  font-family: var(--font-pixel);
  color: var(--ui-text-primary);
}
.desktop-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 16px;
  flex-wrap: wrap;
  color: var(--ui-text-primary);
}
.desktop-settings-row p {
  margin-top: 6px;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
</style>
