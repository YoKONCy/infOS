<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * 外观设置 → 启动（阶段 5，仅 Electron 主应用）
 *
 * - 登录 Windows 时启动 infOS 客户端（只有打包后的客户端可设置）。
 * - 启动客户端时同时启动后端：后端从源码运行时，选择一个启动程序（如「只启动后端.bat」），
 *   客户端启动时若本机后端未运行就打开它并等待就绪。路径只能经主进程的文件对话框选择，角色无法修改。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 5
 */
import { computed, onMounted, ref } from 'vue'
import { invoke, isElectron, isToastOverlay } from '../../utils/ipcAdapter'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { PButton, PSwitch } from '../pixel'

interface StartupState {
  loginItemSupported: boolean
  openAtLogin: boolean
  backendLauncher: { enabled: boolean; path: string; name: string; exists: boolean }
  remote: boolean
}

const enabled = isElectron() && !isToastOverlay() && window.electron?.embedded !== true
const state = ref<StartupState | null>(null)
const busy = ref(false)

const launcherMissing = computed(
  () => !!state.value?.backendLauncher.path && !state.value.backendLauncher.exists,
)

async function call(channel: string, value?: unknown): Promise<void> {
  busy.value = true
  try {
    state.value = (await invoke(channel, value)) as StartupState
  } catch (cause) {
    useNotificationStore().toast(
      __t('ui.desktop-shell', '启动设置失败：{0}', [
        cause instanceof Error ? cause.message : String(cause),
      ]),
      'error',
    )
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  if (enabled) void call('desktop-startup:get')
})
</script>

<template>
  <div v-if="enabled && state" class="desktop-startup flex flex-col gap-1.5">
    <label class="text-xs font-bold text-slate-500">
      {{ __t('ui.desktop-shell', '启动') }}
    </label>
    <div class="desktop-startup__row">
      <span class="text-[11px]">
        {{ __t('ui.desktop-shell', '登录 Windows 时启动 infOS 客户端') }}
      </span>
      <PSwitch
        :model-value="state.openAtLogin"
        :disabled="busy || !state.loginItemSupported"
        @update:model-value="call('desktop-startup:set-open-at-login', $event)"
      />
    </div>
    <p v-if="!state.loginItemSupported" class="text-[10px] text-slate-400">
      {{ __t('ui.desktop-shell', '只有打包后的客户端可以设置开机启动。') }}
    </p>

    <div class="desktop-startup__row">
      <span class="text-[11px]">
        {{ __t('ui.desktop-shell', '启动客户端时同时启动后端') }}
      </span>
      <PSwitch
        :model-value="state.backendLauncher.enabled"
        :disabled="busy || !state.backendLauncher.path"
        @update:model-value="call('desktop-startup:set-launcher-enabled', $event)"
      />
    </div>
    <div class="desktop-startup__row">
      <span class="desktop-startup__path text-[11px]" :title="state.backendLauncher.path">
        {{
          state.backendLauncher.path
            ? launcherMissing
              ? __t('ui.desktop-shell', '文件不存在：{0}', [state.backendLauncher.path])
              : state.backendLauncher.path
            : __t('ui.desktop-shell', '未选择启动程序')
        }}
      </span>
      <div class="flex gap-1.5">
        <PButton
          size="sm"
          variant="secondary"
          :disabled="busy"
          @click="call('desktop-startup:pick-launcher')"
        >
          {{ __t('ui.desktop-shell', '选择启动程序') }}
        </PButton>
        <PButton
          v-if="state.backendLauncher.path"
          size="sm"
          variant="ghost"
          :disabled="busy"
          @click="call('desktop-startup:clear-launcher')"
        >
          {{ __t('ui.desktop-shell', '清除') }}
        </PButton>
      </div>
    </div>
    <p class="text-[10px] text-slate-400">
      {{
        state.remote
          ? __t('ui.desktop-shell', '当前连接的是远程服务器，不会启动本机后端。')
          : __t(
              'ui.desktop-shell',
              '客户端启动时如果本机后端没有运行，会打开所选程序（例如「只启动后端.bat」）并等待后端就绪。只能在这里由你本人选择，角色无法修改。',
            )
      }}
    </p>
  </div>
</template>

<style scoped>
.desktop-startup__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.desktop-startup__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-secondary);
}
</style>
