<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watchEffect } from 'vue'
import { t as __t } from '../../../i18n/index'
import { isElectron } from '../../../utils/ipcAdapter'
import {
  confirmTabLeave,
  useMainNav,
  type ScheduleSubTab,
} from '../../../composables/main/useMainNav'
import { redirectTabRequest, useDetachedPanels } from '../../../composables/shell/useDetachedPanels'
import NavDetachMenu from '../../shell/NavDetachMenu.vue'
import MainTabLoading from '../MainTabLoading.vue'
import { PixelIcon } from '../../pixel'

/**
 * ScheduleHubTab — 日程聚合工作台
 *
 * 统一承载「任务中心」与「桌面卡片（仅 Electron）」，非激活视图即时卸载。
 */
defineOptions({ name: 'ScheduleHubTab' })

const TasksTab = defineAsyncComponent({
  loader: () => import('../../dashboard/tabs/TasksTab.vue'),
  loadingComponent: MainTabLoading,
  delay: 80,
  suspensible: false,
})

const CardsTab = defineAsyncComponent({
  loader: () => import('../../shell/cards/CardsTab.vue'),
  loadingComponent: MainTabLoading,
  delay: 80,
  suspensible: false,
})

const desktop = isElectron()
const { scheduleSubTab } = useMainNav()
const shell = useDetachedPanels()
const detachMenu = ref<InstanceType<typeof NavDetachMenu> | null>(null)

watchEffect(() => {
  if (!desktop && scheduleSubTab.value === 'cards') {
    scheduleSubTab.value = 'tasks'
  }
})

const tabs = computed<
  Array<{ id: ScheduleSubTab; label: string; icon: string; detachPageId: string }>
>(() => [
  {
    id: 'tasks',
    label: __t('ui.navigation', '任务中心'),
    icon: 'bell',
    detachPageId: 'tasks',
  },
  ...(desktop
    ? [
        {
          id: 'cards' as const,
          label: __t('ui.navigation', '桌面卡片'),
          icon: 'layout',
          detachPageId: 'cards',
        },
      ]
    : []),
])

async function selectSubTab(tabId: ScheduleSubTab, detachPageId: string): Promise<void> {
  if (redirectTabRequest(detachPageId)) return
  if (scheduleSubTab.value === tabId) return
  if (!(await confirmTabLeave())) return
  scheduleSubTab.value = tabId
}
</script>

<template>
  <div class="hub-workspace">
    <header v-if="tabs.length > 1" class="hub-header">
      <div class="hub-brand">
        <PixelIcon name="calendar" size="sm" class="hub-brand-icon" />
        <h1 class="hub-brand-title">{{ __t('ui.navigation', '日程') }}</h1>
      </div>

      <nav class="hub-tabs" :aria-label="__t('ui.navigation', '日程分区')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="hub-tab-btn"
          :class="{ 'is-active': scheduleSubTab === tab.id }"
          :aria-current="scheduleSubTab === tab.id ? 'page' : undefined"
          :data-onboarding-nav="tab.detachPageId"
          @click="selectSubTab(tab.id, tab.detachPageId)"
          @contextmenu="detachMenu?.open($event, tab.detachPageId)"
        >
          <PixelIcon :name="tab.icon" size="xs" />
          <span>{{ tab.label }}</span>
          <PixelIcon
            v-if="shell.isDetached(tab.detachPageId)"
            name="external-link"
            size="xs"
            class="hub-tab-detached"
            :title="__t('ui.desktop-shell', '已摘出到桌面')"
          />
        </button>
      </nav>
    </header>

    <div class="hub-stage settings-scrollbar">
      <TasksTab v-if="scheduleSubTab === 'tasks'" />
      <CardsTab v-else-if="desktop && scheduleSubTab === 'cards'" />
    </div>

    <NavDetachMenu ref="detachMenu" />
  </div>
</template>

<style scoped src="./hub-workspace.css"></style>
