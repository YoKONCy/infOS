<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { t as __t } from '../../../i18n/index'
import { confirmTabLeave, useMainNav, type MemorySubTab } from '../../../composables/main/useMainNav'
import { redirectTabRequest, useDetachedPanels } from '../../../composables/shell/useDetachedPanels'
import NavDetachMenu from '../../shell/NavDetachMenu.vue'
import MainTabLoading from '../MainTabLoading.vue'
import { PixelIcon } from '../../pixel'
import MemoriesTab from '../../dashboard/tabs/MemoriesTab.vue'

/**
 * MemoryHubTab — 记忆馆聚合工作台
 *
 * 统一承载「核心记忆」「知识库」「对话日志」，
 * 默认首屏子页同步引入避免二次异步瀑布流，其他分区按需加载。
 */
defineOptions({ name: 'MemoryHubTab' })

const KnowledgeTab = defineAsyncComponent({
  loader: () => import('../../dashboard/tabs/KnowledgeTab.vue'),
  loadingComponent: MainTabLoading,
  delay: 80,
  suspensible: false,
})

const LogsTab = defineAsyncComponent({
  loader: () => import('../../dashboard/tabs/LogsTab.vue'),
  loadingComponent: MainTabLoading,
  delay: 80,
  suspensible: false,
})

const { memorySubTab } = useMainNav()
const shell = useDetachedPanels()
const detachMenu = ref<InstanceType<typeof NavDetachMenu> | null>(null)

const tabs = computed<Array<{ id: MemorySubTab; label: string; icon: string; detachPageId: string }>>(
  () => [
    {
      id: 'memories',
      label: __t('ui.navigation', '核心记忆'),
      icon: 'brain',
      detachPageId: 'memories',
    },
    {
      id: 'knowledge',
      label: __t('ui.navigation', '知识库'),
      icon: 'database',
      detachPageId: 'knowledge',
    },
    {
      id: 'logs',
      label: __t('ui.navigation', '对话日志'),
      icon: 'chat',
      detachPageId: 'logs',
    },
  ],
)

async function selectSubTab(tabId: MemorySubTab, detachPageId: string): Promise<void> {
  if (redirectTabRequest(detachPageId)) return
  if (memorySubTab.value === tabId) return
  if (!(await confirmTabLeave())) return
  memorySubTab.value = tabId
}
</script>

<template>
  <div class="hub-workspace">
    <header class="hub-header">
      <div class="hub-brand">
        <PixelIcon name="brain" size="sm" class="hub-brand-icon" />
        <h1 class="hub-brand-title">{{ __t('ui.navigation', '记忆馆') }}</h1>
      </div>

      <nav class="hub-tabs" :aria-label="__t('ui.navigation', '记忆馆分区')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="hub-tab-btn"
          :class="{ 'is-active': memorySubTab === tab.id }"
          :aria-current="memorySubTab === tab.id ? 'page' : undefined"
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

    <div
      class="hub-stage settings-scrollbar"
      :class="{ 'hub-stage--full': memorySubTab === 'logs' }"
    >
      <MemoriesTab v-if="memorySubTab === 'memories'" />
      <KnowledgeTab v-else-if="memorySubTab === 'knowledge'" />
      <LogsTab v-else-if="memorySubTab === 'logs'" />
    </div>

    <NavDetachMenu ref="detachMenu" />
  </div>
</template>

<style scoped src="./hub-workspace.css"></style>
