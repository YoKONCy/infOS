<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * MemoriesTab — 核心记忆 Tab
 *
 * 档案工作台布局：统计头 + 过滤工作台 + (列表|图谱) × 常驻详情检查器。
 * 数据全部走后端 archiveQuery / graphSnapshot，前端不做全量拉取。
 */
import { computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import type { EventNote } from '@infos/shared'
import { MEMORY_BACKGROUND_ENABLED_KEY } from '@infos/shared'
import { PixelIcon, PButton, PCard, PDialog } from '../../pixel'
import { useConfigSwitch } from '../../../composables/dashboard/useConfigSwitch'
import { useDashboardContext } from '../../../composables/dashboard'
import { useMemoryArchive } from '../../../composables/dashboard/useMemoryArchive'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import { useAgentStore } from '../../../stores/useAgentStore'
import { memoryApi } from '../../../api/modules/memoryApi'
import MemoryFilterBar from '../memories/MemoryFilterBar.vue'
import MemoryList from '../memories/MemoryList.vue'
import MemoryInspector from '../memories/MemoryInspector.vue'
import MemoryGraphView from '../memories/MemoryGraphView.vue'
import PrivacyCleanupPanel from '../PrivacyCleanupPanel.vue'
import RagConfigPage from '../memories/RagConfigPage.vue'
import ArchiveEntryEditor from '../memories/ArchiveEntryEditor.vue'
import type { ArchiveEditSaved, ArchiveEditTarget } from '../../../lib/archiveEntryEdit'

const ctx = useDashboardContext()
const {
  enabled: memoryBackgroundEnabled,
  ready: memorySwitchReady,
  saving: memorySwitchSaving,
  setEnabled: setMemoryBackgroundEnabled,
} = useConfigSwitch(MEMORY_BACKGROUND_ENABLED_KEY, '后台记忆')
const notif = useNotificationStore()
const agentStore = useAgentStore()
const showingRagConfig = ref(false)
let ragTrigger: HTMLElement | null = null

function openRagConfig(event: MouseEvent): void {
  ragTrigger = event.currentTarget as HTMLElement
  showingRagConfig.value = true
}

async function closeRagConfig(): Promise<void> {
  showingRagConfig.value = false
  await nextTick()
  ragTrigger?.focus()
}

const view = ref<'list' | 'graph'>('list')
const archiveTarget = ref<EventNote | null>(null)
const archiveSaving = ref(false)
const deleteTarget = ref<EventNote | null>(null)
const deleteSource = ref(false)
const deleting = ref(false)
const checkedIds = ref<string[]>([])
const batchAction = ref<'archive' | 'restore' | 'delete' | null>(null)
const batchSaving = ref(false)
const editTarget = ref<ArchiveEditTarget | null>(null)

async function onEntryEdited(result: ArchiveEditSaved): Promise<void> {
  const old = editTarget.value
  const selectedBeforeSave = old?.kind === 'memory' && archive.selectedId.value === old.note.id
  editTarget.value = null
  notif.toast(__t('ui.archive-edit', '修改已保存，旧版本已保留。'), 'success')
  await loadArchive()
  if (view.value === 'graph') await loadGraph()
  else archive.graph.value = { nodes: [], edges: [], truncated: false }
  if (
    result.kind === 'memory' &&
    selectedBeforeSave &&
    archive.selectedId.value === (old?.kind === 'memory' ? old.note.id : null)
  )
    await archive.selectNote(result.note)
}

const archive = useMemoryArchive(
  () => ctx.activeAgentId.value || 'pero',
  () => agentStore.enabledAgents.map((agent) => agent.id),
)
const agentOptions = computed(() => [
  {
    get label() {
      return __t('ui.settings', '全部角色')
    },
    value: 'all',
  },
  ...agentStore.enabledAgents.map((agent) => ({ label: agent.name || agent.id, value: agent.id })),
])

const graphIncludeArchived = computed(() => archive.status.value !== 'active')
watch(
  () => archive.items.value,
  () => {
    checkedIds.value = []
  },
)
function toggleChecked(id: string): void {
  checkedIds.value = checkedIds.value.includes(id)
    ? checkedIds.value.filter((value) => value !== id)
    : [...checkedIds.value, id]
}
async function confirmBatch(): Promise<void> {
  if (!batchAction.value || batchSaving.value) return
  batchSaving.value = true
  try {
    await memoryApi.batch([...checkedIds.value], batchAction.value, deleteSource.value)
    batchAction.value = null
    archive.selected.value = null
    archive.selectedId.value = null
    await loadArchive()
    if (view.value === 'graph') await loadGraph()
  } catch (error) {
    notif.toast((error as Error).message, 'error')
    batchAction.value = null
    archive.selectedId.value = null
    await loadArchive()
    if (view.value === 'graph') await loadGraph()
  } finally {
    batchSaving.value = false
  }
}

async function loadArchive(): Promise<void> {
  try {
    await archive.fetchArchive()
  } catch (error) {
    notif.toast(__t('ui.settings', '记忆档案加载失败：') + (error as Error).message, 'error')
  }
}

async function loadGraph(): Promise<void> {
  await archive.fetchGraph(graphIncludeArchived.value)
}

/** 搜索防抖 */
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => archive.searchQuery.value,
  () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(loadArchive, 300)
  },
)

/** 除搜索外的全部过滤 + 分页变化 → 立即重载 */
watch(
  () => [
    archive.agent.value,
    archive.channel.value,
    archive.status.value,
    archive.mode.value,
    archive.importanceMin.value,
    archive.importanceMax.value,
    archive.tones.value,
    archive.participants.value,
    archive.places.value,
    archive.objects.value,
    archive.topics.value,
    archive.eventAtFrom.value,
    archive.eventAtTo.value,
    archive.createdAtFrom.value,
    archive.createdAtTo.value,
    archive.sort.value,
    archive.order.value,
    archive.page.value,
  ],
  loadArchive,
)

/** 角色或全局刷新 → 列表与图谱一起重置 */
watch(
  () => [ctx.activeAgentId.value, ctx.refreshKey.value],
  () => {
    archive.clearFilters()
    archive.page.value = 1
    void loadArchive()
    if (view.value === 'graph') void loadGraph()
  },
)

watch(
  () => [archive.agent.value, archive.status.value],
  () => {
    if (view.value === 'graph') void loadGraph()
  },
)

watch(view, (next) => {
  if (next === 'graph' && !archive.graph.value.nodes.length) void loadGraph()
})

function handleConversationCompleted(): void {
  void loadArchive()
  if (view.value === 'graph') void loadGraph()
}

onMounted(() => {
  void loadArchive()
  window.addEventListener('infos:conversation-completed', handleConversationCompleted)
})

onUnmounted(() => {
  window.removeEventListener('infos:conversation-completed', handleConversationCompleted)
})

function onSelectNote(note: EventNote): void {
  void archive.selectNote(note)
}

async function confirmArchive(): Promise<void> {
  const target = archiveTarget.value
  if (!target || archiveSaving.value) return
  archiveSaving.value = true
  try {
    await memoryApi.archiveNote(target.id)
    archiveTarget.value = null
    archive.selected.value = null
    archive.selectedId.value = null
    await loadArchive()
    if (view.value === 'graph') await loadGraph()
    notif.toast(__t('ui.settings', '记忆已归档'), 'success')
  } catch (error) {
    notif.toast(__t('ui.settings', '归档失败：') + (error as Error).message, 'error')
  } finally {
    archiveSaving.value = false
  }
}

async function restoreNote(note: EventNote): Promise<void> {
  try {
    await memoryApi.restoreNote(note.id)
    archive.selected.value = null
    archive.selectedId.value = null
    await loadArchive()
    if (view.value === 'graph') await loadGraph()
    notif.toast(__t('ui.settings', '记忆已恢复'), 'success')
  } catch (error) {
    notif.toast((error as Error).message, 'error')
  }
}
async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value || deleting.value) return
  deleting.value = true
  try {
    await memoryApi.deleteNote(deleteTarget.value.id, deleteSource.value)
    deleteTarget.value = null
    archive.selected.value = null
    archive.selectedId.value = null
    await loadArchive()
    if (view.value === 'graph') await loadGraph()
    notif.toast(__t('ui.settings', '记忆已永久删除'), 'success')
  } catch (error) {
    notif.toast((error as Error).message, 'error')
    deleteTarget.value = null
    archive.selectedId.value = null
    await loadArchive()
    if (view.value === 'graph') await loadGraph()
  } finally {
    deleting.value = false
  }
}
function openDelete(note: EventNote): void {
  deleteSource.value = false
  deleteTarget.value = note
}
function setSection(status: 'active' | 'archived'): void {
  archive.selected.value = null
  archive.selectedId.value = null
  archive.clearFilters()
  archive.status.value = status
  view.value = 'list'
}

const statBadges = computed(() => [
  {
    label:
      archive.status.value === 'archived' ? __t('ui.settings', '归档') : __t('ui.settings', '有效'),
    value:
      archive.status.value === 'archived'
        ? archive.stats.value.archived
        : archive.stats.value.active,
    tone: 'sky',
  },
  {
    get label() {
      return __t('ui.settings', '平均重要度')
    },
    value: archive.stats.value.averageImportance,
    tone: 'violet',
  },
  {
    get label() {
      return __t('ui.settings', '主题')
    },
    value: archive.stats.value.topicCount,
    tone: 'emerald',
  },
])
</script>

<template>
  <div class="memories-shell">
    <RagConfigPage v-if="showingRagConfig" @back="closeRagConfig" />
    <!-- 返回时保留档案筛选、选中项和滚动位置。 -->
    <div v-show="!showingRagConfig" class="memories-page">
      <!-- 档案头 -->
      <header class="archive-head">
        <div class="archive-title-wrap">
          <h2 class="archive-title font-pixel">
            <PixelIcon name="brain" size="md" class="archive-title-icon" />
            {{ __t('ui.settings', '核心记忆') }}
          </h2>
          <p class="archive-subtitle">
            {{ __t('ui.settings', '长期记忆档案 · LONG-TERM MEMORY ARCHIVE') }}
          </p>
        </div>

        <div class="archive-stats">
          <div
            v-for="badge in statBadges"
            :key="badge.label"
            :class="['stat-badge', `stat-${badge.tone}`]"
          >
            <span class="stat-value font-pixel">{{ badge.value }}</span>
            <span class="stat-label">{{ badge.label }}</span>
          </div>
        </div>

        <div class="archive-view-switch">
          <PButton
            size="sm"
            :variant="view === 'list' ? 'primary' : 'ghost'"
            @click="view = 'list'"
          >
            <PixelIcon name="list" size="xs" />
            {{ __t('ui.settings', '档案列表') }}
          </PButton>
          <PButton
            size="sm"
            :variant="view === 'graph' ? 'primary' : 'ghost'"
            @click="view = 'graph'"
          >
            <PixelIcon name="link" size="xs" />
            {{ __t('ui.settings', '关系图谱') }}
          </PButton>
        </div>
      </header>

      <nav
        class="archive-view-switch archive-toolbar"
        :aria-label="__t('ui.settings', '记忆分类与设置')"
      >
        <PButton
          size="sm"
          :variant="archive.status.value === 'active' ? 'primary' : 'ghost'"
          @click="setSection('active')"
        >
          {{ __t('ui.settings', '记忆') }}
        </PButton>
        <PButton
          size="sm"
          :variant="archive.status.value === 'archived' ? 'primary' : 'ghost'"
          @click="setSection('archived')"
        >
          {{ __t('ui.settings', '归档') }}
        </PButton>
        <button
          type="button"
          role="switch"
          class="memory-background-toggle"
          :aria-checked="memoryBackgroundEnabled"
          :aria-busy="memorySwitchSaving"
          :disabled="!memorySwitchReady || memorySwitchSaving"
          :title="__t('ui.settings', '自动整理记忆与日记')"
          @click="setMemoryBackgroundEnabled(!memoryBackgroundEnabled)"
        >
          <span class="memory-background-indicator" aria-hidden="true" />
          {{ __t('ui.settings', '后台记忆') }}
          <span class="memory-background-state" aria-hidden="true">
            {{
              memorySwitchSaving
                ? __t('ui.settings', '保存中')
                : memoryBackgroundEnabled
                  ? __t('ui.settings', '开')
                  : __t('ui.settings', '关')
            }}
          </span>
        </button>
        <PButton size="sm" variant="secondary" class="memory-rag-entry" @click="openRagConfig">
          <PixelIcon name="settings" size="xs" />
          {{ __t('ui.rag', 'RAG 配置') }}
        </PButton>
      </nav>
      <PrivacyCleanupPanel />
      <div v-if="view === 'list' && archive.items.value.length" class="archive-view-switch">
        <PButton
          size="sm"
          variant="ghost"
          @click="
            checkedIds =
              checkedIds.length === archive.items.value.length
                ? []
                : archive.items.value.map((note) => note.id)
          "
        >
          {{ __t('ui.settings', '选择本页') }}
        </PButton>
        <span v-if="checkedIds.length">
          {{ __t('ui.settings', '已选') }} {{ checkedIds.length }} {{ __t('ui.settings', '条') }}
        </span>
        <PButton
          v-if="checkedIds.length"
          size="sm"
          variant="ghost"
          @click="batchAction = archive.status.value === 'archived' ? 'restore' : 'archive'"
        >
          {{
            archive.status.value === 'archived'
              ? __t('ui.settings', '恢复')
              : __t('ui.settings', '归档')
          }}
        </PButton>
        <PButton
          v-if="checkedIds.length"
          size="sm"
          variant="danger"
          @click="
            () => {
              deleteSource = false
              batchAction = 'delete'
            }
          "
        >
          {{ __t('ui.settings', '永久删除') }}
        </PButton>
      </div>

      <!-- 过滤工作台 -->
      <PCard pixel padding="sm" overflow-visible class="archive-filter-card">
        <MemoryFilterBar
          v-model:search-query="archive.searchQuery.value"
          v-model:agent="archive.agent.value"
          v-model:channel="archive.channel.value"
          v-model:status="archive.status.value"
          v-model:mode="archive.mode.value"
          v-model:importance-min="archive.importanceMin.value"
          v-model:importance-max="archive.importanceMax.value"
          v-model:tones="archive.tones.value"
          v-model:participants="archive.participants.value"
          v-model:places="archive.places.value"
          v-model:objects="archive.objects.value"
          v-model:topics="archive.topics.value"
          v-model:event-at-from="archive.eventAtFrom.value"
          v-model:event-at-to="archive.eventAtTo.value"
          v-model:created-at-from="archive.createdAtFrom.value"
          v-model:created-at-to="archive.createdAtTo.value"
          v-model:sort="archive.sort.value"
          v-model:order="archive.order.value"
          :facets="archive.facets.value"
          :agent-options="agentOptions"
          :chips="archive.chips.value"
          :total="archive.total.value"
          :is-loading="archive.isLoading.value"
          @refresh="loadArchive"
          @clear="setSection(archive.status.value === 'archived' ? 'archived' : 'active')"
        />
      </PCard>

      <!-- 主区域：左内容 + 右检查器 -->
      <div class="archive-main">
        <div class="archive-content">
          <MemoryList
            v-if="view === 'list'"
            :items="archive.items.value"
            :selected-id="archive.selectedId.value"
            :is-loading="archive.isLoading.value"
            :page="archive.page.value"
            :page-count="archive.pageCount.value"
            :page-size="archive.pageSize.value"
            :total="archive.total.value"
            :checked-ids="checkedIds"
            @toggle="toggleChecked"
            @select="onSelectNote"
            @restore="restoreNote"
            @page="archive.goToPage"
          />
          <MemoryGraphView
            v-else
            :nodes="archive.graph.value.nodes"
            :edges="archive.graph.value.edges"
            :selected-id="archive.selectedId.value"
            :loading="archive.graphLoading.value"
            :error="archive.graphError.value"
            :truncated="archive.graph.value.truncated"
            @select="onSelectNote"
          />
        </div>

        <aside class="archive-inspector">
          <MemoryInspector
            :selected="archive.selected.value"
            :detail-loading="archive.detailLoading.value"
            :detail-error="archive.detailError.value"
            :source="archive.source.value"
            :source-loading="archive.sourceLoading.value"
            :source-error="archive.sourceError.value"
            @load-source="archive.loadSource"
            @archive="archiveTarget = $event"
            @restore="restoreNote"
            @delete="openDelete"
            @edit="editTarget = { kind: 'memory', note: $event }"
            @select="onSelectNote"
          />
        </aside>
      </div>

      <ArchiveEntryEditor
        v-if="editTarget"
        :target="editTarget"
        @close="editTarget = null"
        @saved="onEntryEdited"
      />
      <PDialog
        :model-value="Boolean(archiveTarget)"
        :title="__t('ui.settings', '归档这条记忆？')"
        :message="__t('ui.settings', '归档后仅在归档页可见，退出自动召回。')"
        :confirm-text="__t('ui.settings', '归档')"
        confirm-variant="danger"
        :loading="archiveSaving"
        :auto-close="false"
        @update:model-value="!$event && (archiveTarget = null)"
        @confirm="confirmArchive"
      />
      <PDialog
        :model-value="Boolean(deleteTarget)"
        :title="__t('ui.settings', '永久删除记忆？')"
        :message="__t('ui.settings', '将删除记忆及关联日记，无法恢复。')"
        :confirm-text="__t('ui.settings', '永久删除')"
        confirm-variant="danger"
        :loading="deleting"
        :auto-close="false"
        @update:model-value="!$event && (deleteTarget = null)"
        @confirm="confirmDelete"
      >
        <label class="flex items-center gap-2 text-ui-text-secondary">
          <input v-model="deleteSource" type="checkbox" />
          {{ __t('ui.settings', '同时删除来源对话') }}
        </label>
      </PDialog>
      <PDialog
        :model-value="Boolean(batchAction)"
        :title="
          batchAction === 'delete'
            ? __t('ui.settings', '永久删除所选记忆？')
            : batchAction === 'restore'
              ? __t('ui.settings', '恢复所选记忆？')
              : __t('ui.settings', '归档所选记忆？')
        "
        :message="
          batchAction === 'delete'
            ? __t('ui.settings', '将删除记忆及关联日记，无法恢复。')
            : __t('ui.settings', '将处理当前选中的记忆。')
        "
        :confirm-variant="batchAction === 'delete' ? 'danger' : 'primary'"
        :loading="batchSaving"
        :auto-close="false"
        @update:model-value="!$event && (batchAction = null)"
        @confirm="confirmBatch"
      >
        <label v-if="batchAction === 'delete'" class="flex items-center gap-2">
          <input v-model="deleteSource" type="checkbox" />
          {{ __t('ui.settings', '同时删除来源对话') }}
        </label>
      </PDialog>
    </div>
  </div>
</template>

<script lang="ts">
import { ref } from 'vue'
export default { name: 'MemoriesTab' }
</script>

<style scoped>
.memories-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.memory-rag-entry {
  margin-left: auto;
}

.memories-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 24px;
  gap: 14px;
  overflow: hidden;
  color: var(--ui-text-primary);
}

/* ── 头部 ── */
.archive-head {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-shrink: 0;
}

.archive-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.archive-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 22px;
  font-weight: 900;
  color: var(--ui-text-primary);
}

.archive-title-icon {
  color: var(--ui-accent-purple, #8b5cf6);
}

.archive-subtitle {
  margin: 0 0 0 2px;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--ui-text-tertiary);
}

.archive-stats {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.stat-badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 64px;
  padding: 6px 10px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
}

.stat-value {
  font-size: 15px;
  font-weight: 700;
}

.stat-label {
  font-size: 9px;
  color: var(--ui-text-tertiary);
}

.stat-sky .stat-value {
  color: #0284c7;
}
.stat-slate .stat-value {
  color: #64748b;
}
.stat-violet .stat-value {
  color: #7c3aed;
}
.stat-emerald .stat-value {
  color: #059669;
}

.archive-view-switch {
  display: flex;
  gap: 6px;
}

.archive-toolbar {
  align-items: center;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.memory-background-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  height: 30px;
  margin-left: 10px;
  padding: 0 10px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 160ms ease,
    background-color 160ms ease;
}

.memory-background-toggle[aria-checked='true'] {
  border-color: color-mix(in srgb, var(--ui-accent-sky) 45%, var(--ui-border-default));
}

.memory-background-toggle:hover:not(:disabled) {
  border-color: var(--ui-accent-sky);
  background: color-mix(in srgb, var(--ui-accent-sky) 8%, var(--ui-bg-elevated));
}

.memory-background-toggle:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 3px;
}

.memory-background-toggle:disabled {
  opacity: 0.55;
  cursor: default;
}

.memory-background-indicator {
  width: 8px;
  height: 8px;
  border: 1px solid var(--ui-text-tertiary);
  background: transparent;
}

.memory-background-toggle[aria-checked='true'] .memory-background-indicator {
  border-color: var(--ui-accent-sky);
  background: var(--ui-accent-sky);
}

.memory-background-state {
  min-width: 1em;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}

@media (prefers-reduced-motion: reduce) {
  .memory-background-toggle {
    transition: none;
  }
}

/* ── 过滤卡片 ── */
.archive-filter-card {
  position: relative;
  z-index: 100;
  flex-shrink: 0;
  overflow: visible;
}

.archive-filter-card :deep(.p-card-body) {
  overflow: visible;
}

/* ── 主区域 ── */
.archive-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 14px;
  flex: 1;
  min-height: 0;
}

.archive-content {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 14px;
  background: var(--ui-bg-primary);
  border: 1px solid var(--ui-border-default);
}

.archive-inspector {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 14px;
  background: var(--ui-bg-primary);
  border: 1px solid var(--ui-border-default);
  border-top: 3px solid var(--ui-accent-purple, #8b5cf6);
}

@media (max-width: 1100px) {
  .archive-main {
    grid-template-columns: 1fr;
  }
  .archive-inspector {
    max-height: 320px;
  }
}

@media (max-width: 760px) {
  .memories-page {
    padding: 14px;
  }
  .archive-head {
    flex-wrap: wrap;
  }
  .archive-stats {
    margin-left: 0;
  }
}
</style>
