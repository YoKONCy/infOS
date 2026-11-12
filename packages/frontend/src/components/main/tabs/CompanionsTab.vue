<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { t as __t } from '../../../i18n/index'
import {
  confirmTabLeave,
  useMainNav,
  type CompanionsSubTab,
} from '../../../composables/main/useMainNav'
import { redirectTabRequest, useDetachedPanels } from '../../../composables/shell/useDetachedPanels'
import NavDetachMenu from '../../shell/NavDetachMenu.vue'
import MainTabLoading from '../MainTabLoading.vue'
import { PixelIcon } from '../../pixel'
import HomeScopePicker from '../../desktop/home/HomeScopePicker.vue'
import { useHomeScope } from '../../desktop/home/useHomeScope'
import HomeShelfPanel from '../../desktop/HomeShelfPanel.vue'
import HomeMapPanel from '../../desktop/HomeMapPanel.vue'
import OverviewTab from '../../dashboard/tabs/OverviewTab.vue'

/**
 * CompanionsTab — 伙伴聚合工作台
 *
 * 收拢「状态总览」「共享空间（置物架与地点地图）」「伙伴设定」，
 * 默认首屏子页同步引入避免双层异步闪烁，低频设定子页按需加载。
 */
defineOptions({ name: 'CompanionsTab' })

const AgentConfigTab = defineAsyncComponent({
  loader: () => import('../../dashboard/tabs/AgentConfigTab.vue'),
  loadingComponent: MainTabLoading,
  delay: 80,
  suspensible: false,
})

const { companionsSubTab } = useMainNav()
const shell = useDetachedPanels()
const detachMenu = ref<InstanceType<typeof NavDetachMenu> | null>(null)
const scope = useHomeScope()

const tabs = computed<
  Array<{ id: CompanionsSubTab; label: string; icon: string; detachPageId?: string }>
>(() => [
  {
    id: 'overview',
    label: __t('ui.navigation', '状态总览'),
    icon: 'desktop',
    detachPageId: 'overview',
  },
  {
    id: 'space',
    label: __t('ui.desktop', '共享空间'),
    icon: 'archive',
  },
  {
    id: 'agent_config',
    label: __t('ui.navigation', '伙伴设定'),
    icon: 'users',
    detachPageId: 'agent_config',
  },
])

async function selectSubTab(tabId: CompanionsSubTab, detachPageId?: string): Promise<void> {
  if (detachPageId && redirectTabRequest(detachPageId)) return
  if (companionsSubTab.value === tabId) return
  if (!(await confirmTabLeave())) return
  companionsSubTab.value = tabId
}
</script>

<template>
  <div class="hub-workspace">
    <header class="hub-header">
      <div class="hub-brand">
        <PixelIcon name="paw" size="sm" class="hub-brand-icon" />
        <h1 class="hub-brand-title">{{ __t('ui.navigation', '伙伴') }}</h1>
      </div>

      <nav class="hub-tabs" :aria-label="__t('ui.navigation', '伙伴分区')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="hub-tab-btn"
          :class="{ 'is-active': companionsSubTab === tab.id }"
          :aria-current="companionsSubTab === tab.id ? 'page' : undefined"
          :data-onboarding-nav="tab.detachPageId ?? tab.id"
          @click="selectSubTab(tab.id, tab.detachPageId)"
          @contextmenu="tab.detachPageId && detachMenu?.open($event, tab.detachPageId)"
        >
          <PixelIcon :name="tab.icon" size="xs" />
          <span>{{ tab.label }}</span>
          <PixelIcon
            v-if="tab.detachPageId && shell.isDetached(tab.detachPageId)"
            name="external-link"
            size="xs"
            class="hub-tab-detached"
            :title="__t('ui.desktop-shell', '已摘出到桌面')"
          />
        </button>
      </nav>
    </header>

    <div class="hub-stage settings-scrollbar">
      <OverviewTab v-if="companionsSubTab === 'overview'" />

      <div v-else-if="companionsSubTab === 'space'" class="companions-space-view">
        <header class="companions-space-head">
          <div class="companions-space-brand">
            <span class="companions-space-emblem" aria-hidden="true">
              <PixelIcon name="archive" size="md" />
            </span>
            <div class="companions-space-title-wrap">
              <h2>{{ __t('ui.desktop', '共享空间') }}</h2>
              <p>{{ __t('ui.desktop', '与伙伴交换文件与物品，管理记住的电脑地点。') }}</p>
            </div>
          </div>
        </header>
        <HomeScopePicker :state="scope" />
        <div class="companions-space-grid">
          <HomeShelfPanel :scope="scope.scope.value" />
          <HomeMapPanel :scope="scope.scope.value" />
        </div>
      </div>

      <AgentConfigTab v-else-if="companionsSubTab === 'agent_config'" />
    </div>

    <NavDetachMenu ref="detachMenu" />
  </div>
</template>

<style scoped src="./hub-workspace.css"></style>
<style scoped>
.companions-space-view {
  /* 硬朗哑光工程面板语义变量，供下级 ScopePicker / 置物架 / 地图统一继承 */
  --home-surface: #ffffff;
  --home-surface-soft: #f6f8fb;
  --home-inset-bg: #eef1f6;
  --home-border: rgba(15, 23, 42, 0.12);
  --home-border-strong: rgba(15, 23, 42, 0.22);
  --home-step-shadow: rgba(15, 23, 42, 0.06);
  --home-panel-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.88),
    2px 2px 0 var(--home-step-shadow);
  --home-key-bg: #ffffff;
  --home-key-hover: #f3f6fa;
  --home-key-border: rgba(15, 23, 42, 0.14);
  --home-key-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.92),
    2px 2px 0 var(--home-step-shadow);

  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1360px;
  margin: 0 auto;
  padding: 24px 32px 36px;
}

[data-theme='dark'] .companions-space-view {
  --home-surface: rgba(22, 25, 34, 0.94);
  --home-surface-soft: rgba(17, 20, 28, 0.92);
  --home-inset-bg: #0d1017;
  --home-border: rgba(255, 255, 255, 0.11);
  --home-border-strong: rgba(255, 255, 255, 0.22);
  --home-step-shadow: rgba(0, 0, 0, 0.44);
  --home-panel-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    2px 2px 0 var(--home-step-shadow);
  --home-key-bg: #181b24;
  --home-key-hover: #1f2431;
  --home-key-border: rgba(255, 255, 255, 0.12);
  --home-key-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    2px 2px 0 var(--home-step-shadow);
}

.companions-space-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.companions-space-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.companions-space-emblem {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 0;
  border: 1px solid var(--home-border);
  border-left: 2px solid var(--ui-accent-sky);
  background: var(--home-surface);
  color: var(--ui-accent-sky);
  box-shadow: var(--home-key-shadow);
}

.companions-space-title-wrap {
  min-width: 0;
}

.companions-space-head h2 {
  margin: 0;
  font-family: var(--ui-font-pixel);
  font-size: 20px;
  font-weight: 900;
  line-height: 1.2;
  color: var(--ui-text-primary);
}

.companions-space-head p {
  margin: 3px 0 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
}

.companions-space-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 16px;
}

.companions-space-grid :deep(.home-panel) {
  margin: 0;
}

@media (max-width: 1080px) {
  .companions-space-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .companions-space-view {
    padding: 16px 14px 28px;
  }
}
</style>
