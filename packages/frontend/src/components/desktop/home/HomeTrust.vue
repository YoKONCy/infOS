<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../../../i18n'
import type { HomeScope } from '@infos/shared'
import HomeGrants from './HomeGrants.vue'
import HomeChanges from './HomeChanges.vue'
import HomeActivities from './HomeActivities.vue'
import HomeRecycle from './HomeRecycle.vue'
import HomeDeleteTarget from './HomeDeleteTarget.vue'

// 「桌面与家」的信任部分：授权、这段对话改过的文件、活动记录、删除去向、回收区。
// 角色与对话由上方的 HomeScopePicker 选好后传进来。
defineProps<{ agentId: string; scope: HomeScope | null }>()
const activities = ref<InstanceType<typeof HomeActivities> | null>(null)
const view = ref('grants')
const views = computed(() => [
  { id: 'grants', label: t('ui.desktop', '授权') },
  { id: 'changes', label: t('ui.desktop', '文件改动') },
  { id: 'activities', label: t('ui.desktop', '活动记录') },
  { id: 'recycle', label: t('ui.desktop', '回收区') },
])
</script>

<template>
  <div class="home-trust">
    <nav class="home-record-tabs" :aria-label="t('ui.desktop', '授权与记录')">
      <button
        v-for="item in views"
        :key="item.id"
        type="button"
        :aria-pressed="view === item.id"
        :class="{ 'is-active': view === item.id }"
        @click="view = item.id"
      >{{ item.label }}</button>
    </nav>
    <div v-show="view === 'grants'"><HomeGrants :agent-id="agentId" /></div>
    <div v-show="view === 'changes'"><HomeChanges :scope="scope" @changed="activities?.refresh()" /></div>
    <div v-show="view === 'activities'"><HomeActivities ref="activities" :agent-id="agentId" /></div>
    <div v-show="view === 'recycle'" class="home-recycle-view">
      <HomeDeleteTarget />
      <HomeRecycle :agent-id="agentId" />
    </div>
  </div>
</template>

<style scoped>
.home-record-tabs {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  overflow-x: auto;
  border-bottom: 1px solid var(--ui-border-default);
}
.home-record-tabs button {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 4px 0;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  font: 11px/1.4 var(--ui-font-pixel);
  cursor: pointer;
}
.home-record-tabs button.is-active {
  border-bottom-color: var(--ui-accent-primary);
  color: var(--ui-accent-primary);
}
.home-record-tabs button:focus-visible {
  outline: 1px solid var(--ui-accent-primary);
  outline-offset: -1px;
}
.home-trust :deep(.home-panel) {
  margin-top: 0;
}
.home-recycle-view {
  display: grid;
  gap: 16px;
}
</style>
