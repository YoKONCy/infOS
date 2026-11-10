<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * 外观设置 → 桌面卡片（仅 Electron 主应用）
 *
 * 卡片的完整管理在独立的「卡片」页（侧边栏、托盘菜单、桌宠菜单都能进），这里只留一个入口，
 * 方便习惯从设置里找卡片的用户。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 卡片页
 */
import { isElectron, isToastOverlay } from '../../utils/ipcAdapter'
import { useMainNav } from '../../composables/main/useMainNav'
import { PButton } from '../pixel'

const enabled = isElectron() && !isToastOverlay() && window.electron?.embedded !== true
const { setTab } = useMainNav()
</script>

<template>
  <div v-if="enabled" class="desktop-cards">
    <div>
      <label class="text-xs font-bold text-slate-500">
        {{ __t('ui.desktop-shell', '桌面卡片') }}
      </label>
      <p class="text-[10px] text-slate-400">
        {{
          __t('ui.desktop-shell', '打开、收藏、改名、删除和找回最近关闭的卡片，都在「卡片」页。')
        }}
      </p>
    </div>
    <PButton size="sm" variant="secondary" @click="setTab('cards')">
      {{ __t('ui.desktop-shell', '打开卡片页') }}
    </PButton>
  </div>
</template>

<style scoped>
.desktop-cards {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>
