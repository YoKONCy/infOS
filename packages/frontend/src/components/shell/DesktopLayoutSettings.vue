<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * 外观设置 → 桌面面板「恢复默认布局」
 *
 * 合回全部桌面面板并清除保存的位置（仅 Electron）。仍有未保存修改的面板保持打开。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 1
 */
import { ref } from 'vue'
import { useDetachedPanels } from '../../composables/shell/useDetachedPanels'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { PButton, PDialog, PixelIcon } from '../pixel'

const shell = useDetachedPanels()
const confirmOpen = ref(false)
const busy = ref(false)

async function reset(): Promise<void> {
  confirmOpen.value = false
  busy.value = true
  // 只在操作时取用通知仓库，设置页在未启用外壳时不依赖它。
  const notify = useNotificationStore()
  try {
    const remaining = await shell.reset()
    if (remaining > 0)
      notify.toast(
        __t('ui.desktop-shell', '已恢复默认布局；{0} 个面板有未保存的修改，保持打开', [remaining]),
        'info',
      )
    else notify.toast(__t('ui.desktop-shell', '已恢复默认布局'), 'success')
  } catch (cause) {
    notify.toast(
      __t('ui.desktop-shell', '面板操作失败：{0}', [
        cause instanceof Error ? cause.message : String(cause),
      ]),
      'error',
    )
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="shell.enabled" class="desktop-layout flex flex-col gap-1.5">
    <label class="text-xs font-bold text-slate-500">
      {{ __t('ui.desktop-shell', '桌面面板') }}
    </label>
    <div class="desktop-layout__row">
      <span class="desktop-layout__summary text-[11px]">
        {{ __t('ui.desktop-shell', '已摘出 {0} 个页面', [shell.panels.value.length]) }}
      </span>
      <PButton size="sm" variant="secondary" :disabled="busy" @click="confirmOpen = true">
        <PixelIcon name="refresh" size="xs" />
        {{ __t('ui.desktop-shell', '恢复默认布局') }}
      </PButton>
    </div>
    <p class="text-[10px] text-slate-400">
      {{
        __t(
          'ui.desktop-shell',
          '在左侧导航右键页面可「摘出到桌面」。恢复默认布局会合回全部面板并清除保存的位置。',
        )
      }}
    </p>

    <PDialog
      v-model="confirmOpen"
      :title="__t('ui.desktop-shell', '恢复默认布局')"
      :message="__t('ui.desktop-shell', '合回全部桌面面板并清除保存的位置？')"
      :confirm-text="__t('ui.desktop-shell', '恢复')"
      @confirm="reset"
    />
  </div>
</template>

<style scoped>
.desktop-layout__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.desktop-layout__summary {
  color: var(--ui-text-secondary);
}
</style>
