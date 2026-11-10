<script setup lang="ts">
/**
 * 外观设置 → 自定义主题
 *
 * 选择、导入（ZIP）、删除和刷新自定义主题。主题文件放在数据目录的 themes 文件夹，
 * 选择按设备保存，与深色 / 浅色切换一致。
 */
import { computed, onMounted, ref } from 'vue'
import { t as __t } from '../../i18n/index'
import { ApiError } from '../../api/errors'
import { themeApi } from '../../api/modules/themeApi'
import { useCustomTheme } from '../../composables/ui/useCustomTheme'
import { useNotificationStore } from '../../stores'
import { PButton, PDialog, PSelect, PixelIcon } from '../pixel'

const notif = useNotificationStore()
const customTheme = useCustomTheme()
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const pendingReplace = ref<File | null>(null)
const removeOpen = ref(false)

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const current = computed(() =>
  customTheme.themes.value.find((theme) => theme.id === customTheme.selected.value),
)
/** 已选择但列表里没有：文件夹被删除或改名。 */
const missing = computed(() => Boolean(customTheme.selected.value) && !current.value && !busy.value)
const options = computed(() => [
  { label: __t('ui.settings', '不使用（infOS 默认外观）'), value: '' },
  ...customTheme.themes.value.map((theme) => ({ label: theme.name, value: theme.id })),
  ...(missing.value
    ? [
        {
          label: __t('ui.settings', '{0}（未找到）', [customTheme.selected.value]),
          value: customTheme.selected.value,
          disabled: true,
        },
      ]
    : []),
])
const folder = computed(() => customTheme.folder.value || 'themes')
const modeLabel = computed(() =>
  current.value?.mode === 'dark'
    ? __t('ui.settings', '深色')
    : current.value?.mode === 'light'
      ? __t('ui.settings', '浅色')
      : '',
)

async function refresh(notify = false): Promise<void> {
  busy.value = true
  try {
    await customTheme.refresh()
    await customTheme.apply(customTheme.selected.value)
    if (notify) notif.toast(__t('ui.settings', '主题列表已刷新'), 'success')
  } catch (cause) {
    notif.toast(__t('ui.settings', '读取主题失败：{0}', [errorText(cause)]), 'error')
  } finally {
    busy.value = false
  }
}

async function choose(value: string | number): Promise<void> {
  await customTheme.select(String(value))
  if (customTheme.loadError.value)
    notif.toast(__t('ui.settings', '主题载入失败：{0}', [customTheme.loadError.value]), 'error')
}

async function importFile(file: File, replace: boolean): Promise<void> {
  busy.value = true
  try {
    const theme = (await themeApi.import(file, replace)).data
    await customTheme.refresh()
    // 覆盖的是正在使用的主题时，立即载入新版本。
    if (theme && theme.id === customTheme.selected.value) await customTheme.apply(theme.id)
    notif.toast(__t('ui.settings', '已导入主题「{0}」', [theme?.name ?? file.name]), 'success')
  } catch (cause) {
    if (!replace && cause instanceof ApiError && cause.code === 'ALREADY_EXISTS') {
      pendingReplace.value = file
      return
    }
    notif.toast(__t('ui.settings', '导入主题失败：{0}', [errorText(cause)]), 'error')
  } finally {
    busy.value = false
  }
}

function onFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void importFile(file, false)
}

function confirmReplace(): void {
  const file = pendingReplace.value
  pendingReplace.value = null
  if (file) void importFile(file, true)
}

async function removeCurrent(): Promise<void> {
  const theme = current.value
  removeOpen.value = false
  if (!theme) return
  busy.value = true
  try {
    await themeApi.remove(theme.id)
    await customTheme.select('')
    await customTheme.refresh()
    notif.toast(__t('ui.settings', '已删除主题「{0}」', [theme.name]), 'success')
  } catch (cause) {
    notif.toast(__t('ui.settings', '删除主题失败：{0}', [errorText(cause)]), 'error')
  } finally {
    busy.value = false
  }
}

onMounted(() => void refresh())
</script>

<template>
  <div class="custom-theme flex flex-col gap-1.5">
    <label class="text-xs font-bold text-slate-500">{{ __t('ui.settings', '自定义主题') }}</label>
    <div class="custom-theme__row">
      <PSelect
        class="custom-theme__select"
        :model-value="customTheme.selected.value"
        :options="options"
        :disabled="busy"
        @update:model-value="choose"
      />
      <input
        ref="fileInput"
        class="hidden"
        type="file"
        accept=".zip,application/zip"
        @change="onFile"
      />
      <PButton size="sm" variant="secondary" :disabled="busy" @click="fileInput?.click()">
        <PixelIcon name="file" size="xs" />
        {{ __t('ui.settings', '导入主题') }}
      </PButton>
      <PButton size="sm" variant="ghost" :disabled="busy" @click="refresh(true)">
        <PixelIcon name="refresh" size="xs" />
        {{ __t('ui.settings', '刷新') }}
      </PButton>
      <PButton v-if="current" size="sm" variant="ghost" :disabled="busy" @click="removeOpen = true">
        {{ __t('ui.settings', '删除') }}
      </PButton>
    </div>
    <p v-if="current" class="text-[10px] text-slate-400">
      {{
        [
          current.author && __t('ui.settings', '作者：{0}', [current.author]),
          current.version && `v${current.version}`,
          modeLabel && __t('ui.settings', '适用于{0}模式', [modeLabel]),
          current.description,
        ]
          .filter(Boolean)
          .join(' · ')
      }}
    </p>
    <p v-if="customTheme.loadError.value" class="custom-theme__error text-[10px]" role="alert">
      {{ __t('ui.settings', '主题载入失败：{0}', [customTheme.loadError.value]) }}
    </p>
    <p class="text-[10px] text-slate-400">
      {{
        __t(
          'ui.settings',
          '把主题文件夹放进 {0} 后点「刷新」，或直接导入 ZIP。主题只改变外观，不运行脚本。',
          [folder],
        )
      }}
    </p>

    <PDialog
      :model-value="Boolean(pendingReplace)"
      :title="__t('ui.settings', '覆盖同名主题？')"
      :message="__t('ui.settings', '已经有同名主题，导入会替换原来的文件。')"
      :confirm-text="__t('ui.settings', '覆盖')"
      @update:model-value="(open: boolean) => !open && (pendingReplace = null)"
      @confirm="confirmReplace"
      @cancel="pendingReplace = null"
    />
    <PDialog
      v-model="removeOpen"
      :title="__t('ui.settings', '删除主题')"
      :message="
        __t('ui.settings', '删除「{0}」？主题文件夹会被移除，无法撤销。', [current?.name ?? ''])
      "
      :confirm-text="__t('ui.settings', '删除')"
      confirm-variant="danger"
      @confirm="removeCurrent"
    />
  </div>
</template>

<style scoped>
.custom-theme__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.custom-theme__select {
  flex: 1 1 200px;
  min-width: 0;
}
.custom-theme__error {
  color: var(--ui-danger);
}
</style>
