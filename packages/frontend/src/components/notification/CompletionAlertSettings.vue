<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { onMounted, onActivated, onBeforeUnmount, ref } from 'vue'
import { DEFAULT_COMPLETION_ALERT_SETTINGS, type CompletionAlertSettings } from '@infos/shared'
import { invoke, isElectron, listen } from '../../utils/ipcAdapter'
import { PCard, PButton, PSwitch, PixelIcon } from '../pixel'
import { useSystemSettingsPage } from '../../composables/ui/useSystemSettingsPage'
const page = useSystemSettingsPage()

const supported = isElectron()
const settings = ref({ ...DEFAULT_COMPLETION_ALERT_SETTINGS, windowsNotificationsSupported: false })
const loaded = ref(false)
const saving = ref(false)
const previewing = ref(false)
const error = ref('')
let disposed = false
let request = 0
let removeListener: (() => void) | undefined

function apply(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const result = value as CompletionAlertSettings & { windowsNotificationsSupported: boolean }
  if (
    typeof result.soundEnabled === 'boolean' &&
    typeof result.windowsNotificationsEnabled === 'boolean'
  ) {
    settings.value = {
      ...result,
      windowsNotificationsSupported: result.windowsNotificationsSupported === true,
    }
    loaded.value = true
  }
}

async function load(): Promise<void> {
  if (!supported || saving.value) return
  const version = ++request
  try {
    const result = await invoke('completion-alerts:get')
    if (!disposed && request === version) {
      apply(result)
      error.value = ''
    }
  } catch (cause) {
    if (!disposed && request === version)
      error.value = cause instanceof Error ? cause.message : '读取完成提醒设置失败'
  }
}

async function persistUpdate(patch: Partial<CompletionAlertSettings>): Promise<void> {
  if (saving.value || !loaded.value) return
  saving.value = true
  ++request
  error.value = ''
  try {
    apply(await invoke('completion-alerts:update', patch))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存完成提醒设置失败'
  } finally {
    saving.value = false
  }
}

async function update(patch: Partial<CompletionAlertSettings>): Promise<void> {
  if (!loaded.value || saving.value || page?.disabled.value) return
  if (page)
    await page.save(
      async () => {
        await persistUpdate(patch)
        if (error.value) throw new Error(error.value)
      },
      `completion-alerts:${Object.keys(patch).sort().join(',')}`,
    )
  else await persistUpdate(patch)
}

async function preview(): Promise<void> {
  if (!settings.value.soundEnabled || previewing.value) return
  previewing.value = true
  try {
    await invoke('completion-alerts:preview')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '提示音试听失败'
  } finally {
    previewing.value = false
  }
}

onMounted(() => {
  void load()
  if (supported)
    void listen('completion-alerts:changed', (value) => {
      ++request
      if (!disposed) apply(value)
    })
      .then((remove) => {
        if (disposed) remove()
        else removeListener = remove
      })
      .catch((cause) => {
        if (!disposed) error.value = cause instanceof Error ? cause.message : '订阅完成提醒设置失败'
      })
})
onActivated(() => {
  void load()
})
onBeforeUnmount(() => {
  disposed = true
  ++request
  removeListener?.()
})
</script>

<template>
  <PCard v-if="supported" pixel padding="lg">
    <h3 class="completion-settings__title">
      <PixelIcon name="volume" size="sm" />
      {{ __t('ui.notification', '完成提醒') }}
    </h3>
    <div class="completion-settings__row">
      <div>
        <strong>{{ __t('ui.notification', '完成提示音') }}</strong>
        <p>{{ __t('ui.notification', '整轮对话或后台任务完成时，轻轻响一声。') }}</p>
      </div>
      <div class="completion-settings__actions">
        <PButton
          variant="ghost"
          size="sm"
          :disabled="!loaded || saving || previewing || !settings.soundEnabled"
          @click="preview"
        >
          {{ __t('ui.notification', '试听') }}
        </PButton>
        <PSwitch
          :model-value="settings.soundEnabled"
          :disabled="!loaded || saving || page?.disabled.value"
          :aria-label="__t('ui.notification', '完成提示音')"
          @update:model-value="update({ soundEnabled: $event })"
        />
      </div>
    </div>
    <div class="completion-settings__row">
      <div>
        <strong>{{ __t('ui.notification', 'Windows 完成通知') }}</strong>
        <p>{{ __t('ui.notification', '应用不在前台且桌宠隐藏时通知。') }}</p>
      </div>
      <PSwitch
        :model-value="settings.windowsNotificationsEnabled"
        :disabled="
          !loaded || saving || page?.disabled.value || !settings.windowsNotificationsSupported
        "
        :aria-label="__t('ui.notification', 'Windows 完成通知')"
        @update:model-value="update({ windowsNotificationsEnabled: $event })"
      />
    </div>
    <p class="completion-settings__hint">
      {{ __t('ui.notification', '仅对此设备生效；系统通知无提示音。') }}
    </p>
    <p v-if="loaded && !settings.windowsNotificationsSupported" class="completion-settings__hint">
      {{ __t('ui.notification', '当前系统不支持 Windows 通知。') }}
    </p>
    <p v-if="error" class="completion-settings__error" role="alert">{{ error }}</p>
  </PCard>
</template>

<style scoped>
.completion-settings__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 18px;
  color: var(--ui-text-primary);
  font-family: var(--font-pixel);
  font-size: 14px;
}
.completion-settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-top: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-primary);
}
.completion-settings__row strong {
  font-size: 12px;
}
.completion-settings__row p {
  margin: 5px 0 0;
  color: var(--ui-text-secondary);
  font-size: 11px;
  line-height: 1.6;
}
.completion-settings__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.completion-settings__hint {
  margin: 10px 0 0;
  color: var(--ui-text-tertiary);
  font-size: 10px;
  line-height: 1.6;
}
.completion-settings__error {
  margin-top: 10px;
  color: var(--ui-text-error, #e56d83);
  font-size: 11px;
}
</style>
