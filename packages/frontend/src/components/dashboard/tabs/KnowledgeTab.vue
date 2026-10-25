<script setup lang="ts">
import { getDisplayLocale } from '../../../i18n/index'

import { t as __t } from '../../../i18n/index'

import { computed, onMounted, ref, watch } from 'vue'
import type {
  FactArchiveObject,
  FactArchiveRecord,
  FactArchiveResult,
  KnowledgeDocumentList,
} from '@infos/shared'
import { PixelIcon, PButton, PDialog } from '../../pixel'
import { knowledgeApi } from '../../../api/modules/knowledgeApi'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import { logger } from '../../../lib/logger'

import DocumentKnowledgePane from '../../knowledge/DocumentKnowledgePane.vue'
import KnowledgeRecallControls from '../../knowledge/KnowledgeRecallControls.vue'
import PrivacyCleanupPanel from '../PrivacyCleanupPanel.vue'
import ArchiveEntryEditor from '../memories/ArchiveEntryEditor.vue'
import type { ArchiveEditTarget } from '../../../lib/archiveEntryEdit'

const documentStats = ref<KnowledgeDocumentList['stats']>({
  documentCount: 0,
  readyCount: 0,
  pendingCount: 0,
  partCount: 0,
  indexingCount: 0,
})
const section = ref<'facts' | 'documents'>('facts')
const notif = useNotificationStore()
const retractTarget = ref<FactArchiveRecord | null>(null)
const retracting = ref(false)
const factAction = ref<'retract' | 'delete' | 'restore'>('retract')
const editTarget = ref<ArchiveEditTarget | null>(null)
async function onFactEdited(): Promise<void> {
  editTarget.value = null
  historyOpen.value = true
  notif.toast(__t('ui.archive-edit', '修改已保存，旧版本已保留。'), 'success')
  await loadFacts()
}
function selectFactAction(fact: FactArchiveRecord, action: 'retract' | 'delete' | 'restore'): void {
  factAction.value = action
  retractTarget.value = fact
}
const loading = ref(false)
const error = ref('')
const query = ref('')
const EMPTY_ARCHIVE: FactArchiveResult = {
  items: [],
  total: 0,
  stats: { objectCount: 0, activeFactCount: 0, historicalFactCount: 0, retractedFactCount: 0 },
}
const archive = ref<FactArchiveResult>(EMPTY_ARCHIVE)
const selectedId = ref<string | null>(null)
const expandedFacts = ref(new Set<string>())
const historyOpen = ref(false)
let queryTimer: ReturnType<typeof setTimeout> | null = null

const selected = computed<FactArchiveObject | null>(
  () => archive.value.items.find((item) => item.objectId === selectedId.value) ?? null,
)

async function loadFacts(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const response = await knowledgeApi.facts(query.value)
    const data = response.data
    archive.value = data
      ? {
          ...data,
          items: (data.items ?? []).map((item) => ({
            ...item,
            aliases: item.aliases ?? [],
            activeFacts: item.activeFacts ?? [],
            historicalFacts: item.historicalFacts ?? [],
            retractedFacts: item.retractedFacts ?? [],
          })),
          stats: {
            ...EMPTY_ARCHIVE.stats,
            ...(data.stats ?? {}),
          },
        }
      : EMPTY_ARCHIVE
    if (!selected.value) selectedId.value = archive.value.items[0]?.objectId ?? null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '事实库读取失败'
    logger.error('KnowledgeTab', __t('logs.frontend.settings', '读取事实库失败'), cause)
  } finally {
    loading.value = false
  }
}

function toggleFact(id: string): void {
  const next = new Set(expandedFacts.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedFacts.value = next
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(getDisplayLocale(), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
}

function confidenceLabel(value?: number): string {
  if (value === undefined) return __t('ui.settings', '未标注')
  return `${Math.round(value <= 1 ? value * 100 : value)}%`
}

function replacementFor(fact: FactArchiveRecord): FactArchiveRecord | undefined {
  return selected.value?.activeFacts.find((item) => item.id === fact.supersededBy)
}

async function confirmRetract(): Promise<void> {
  const target = retractTarget.value
  if (!target || retracting.value) return
  retracting.value = true
  const action = factAction.value
  try {
    if (action === 'delete') await knowledgeApi.deleteFact(target.id)
    else if (action === 'restore') await knowledgeApi.restoreFact(target.id)
    else await knowledgeApi.retractFact(target.id)
    retractTarget.value = null
    await loadFacts()
    notif.toast(
      action === 'restore'
        ? __t('ui.archive-edit', '事实已还原')
        : action === 'delete'
          ? __t('ui.settings', '事实已永久删除')
          : __t('ui.settings', '事实已撤回'),
      'success',
    )
  } catch (cause) {
    notif.toast(__t('ui.archive-edit', '事实操作失败：{0}', [(cause as Error).message]), 'error')
    retractTarget.value = null
    await loadFacts()
  } finally {
    retracting.value = false
  }
}

watch(query, () => {
  if (queryTimer) clearTimeout(queryTimer)
  queryTimer = setTimeout(() => void loadFacts(), 260)
})

watch(selectedId, () => {
  expandedFacts.value = new Set()
  historyOpen.value = false
})

onMounted(loadFacts)
</script>

<template>
  <div class="knowledge-page">
    <PrivacyCleanupPanel />
    <header class="knowledge-head">
      <div>
        <h2 class="font-pixel">
          <PixelIcon name="database" size="md" />
          {{ __t('ui.settings', '知识库') }}
        </h2>
        <p>{{ __t('ui.settings', '共享事实与外部资料 · SHARED KNOWLEDGE ARCHIVE') }}</p>
      </div>
      <div v-if="section === 'facts'" class="knowledge-stats">
        <span>
          <b class="font-pixel">{{ archive.stats.objectCount }}</b>
          {{ __t('ui.settings', '事实对象') }}
        </span>
        <span>
          <b class="font-pixel">{{ archive.stats.activeFactCount }}</b>
          {{ __t('ui.settings', '有效事实') }}
        </span>
        <span>
          <b class="font-pixel">{{ archive.stats.historicalFactCount }}</b>
          {{ __t('ui.settings', '历史事实') }}
        </span>
        <span>
          <b class="font-pixel">{{ archive.stats.retractedFactCount }}</b>
          {{ __t('ui.settings', '已撤回') }}
        </span>
      </div>
      <div v-else class="knowledge-stats">
        <span>
          <b class="font-pixel">{{ documentStats.documentCount }}</b>
          {{ __t('ui.settings', '资料') }}
        </span>
        <span>
          <b class="font-pixel">{{ documentStats.readyCount }}</b>
          {{ __t('ui.settings', '可检索') }}
        </span>
        <span>
          <b class="font-pixel">{{ documentStats.pendingCount }}</b>
          {{ __t('ui.settings', '整理中') }}
        </span>
        <span>
          <b class="font-pixel">{{ documentStats.partCount }}</b>
          {{ __t('ui.settings', '内容部分') }}
        </span>
      </div>
    </header>

    <nav class="section-tabs" :aria-label="__t('ui.settings', '知识库分类')">
      <button :class="{ active: section === 'facts' }" @click="section = 'facts'">
        <PixelIcon name="database" size="sm" />
        {{ __t('ui.settings', '事实库') }}
        <small>{{ archive.stats.activeFactCount }}</small>
      </button>
      <button :class="{ active: section === 'documents' }" @click="section = 'documents'">
        <PixelIcon name="file" size="sm" />
        {{ __t('ui.settings', '文档知识库') }}
        <small>{{ documentStats.documentCount }}</small>
      </button>
    </nav>

    <KnowledgeRecallControls :kind="section" />

    <section v-if="section === 'facts'" class="facts-workbench">
      <aside class="object-panel">
        <label class="search-box">
          <PixelIcon name="search" size="sm" />
          <input v-model="query" :placeholder="__t('ui.settings', '搜索对象、别名或事实内容……')" />
        </label>

        <div v-if="loading" class="panel-state">
          <PixelIcon name="refresh" size="md" animation="spin" />
          {{ __t('ui.settings', '正在翻阅事实档案…') }}
        </div>
        <div v-else-if="error" class="panel-state error-state">
          <PixelIcon name="alert" size="md" />
          {{ error }}
          <PButton size="sm" @click="loadFacts">{{ __t('ui.settings', '重新加载') }}</PButton>
        </div>
        <div v-else-if="!archive.items.length" class="panel-state">
          <PixelIcon name="database" size="lg" />
          <b>
            {{
              query ? __t('ui.settings', '没有找到相关事实') : __t('ui.settings', '事实库还是空的')
            }}
          </b>
          <span>
            {{
              query
                ? __t('ui.settings', '换个名称、别名或关键词试试')
                : __t('ui.settings', 'Agent 会在对话与任务中逐渐整理共同事实')
            }}
          </span>
        </div>
        <div v-else class="object-list">
          <button
            v-for="item in archive.items"
            :key="item.objectId"
            :class="{ active: selectedId === item.objectId }"
            @click="selectedId = item.objectId"
          >
            <span>
              <b>{{ item.standardName }}</b>
              <small>{{ item.activeFacts.length }} {{ __t('ui.settings', '条') }}</small>
            </span>
            <em>{{ item.aliases.slice(0, 2).join(' · ') || __t('ui.settings', '暂无别名') }}</em>
          </button>
        </div>
      </aside>

      <main class="fact-inspector">
        <div v-if="!selected" class="inspector-empty">
          <PixelIcon name="database" size="xl" />
          <b>{{ __t('ui.settings', '选择一个事实对象') }}</b>
          <span>{{ __t('ui.settings', '查看它当前成立的事实、别名和历史变化') }}</span>
        </div>
        <template v-else>
          <header class="object-head">
            <span class="object-mark" aria-hidden="true">◇</span>
            <div>
              <h3>{{ selected.standardName }}</h3>
              <p>
                {{ __t('ui.settings', '事实对象 ·') }} {{ selected.activeFacts.length }}
                {{ __t('ui.settings', '条有效事实') }}
              </p>
            </div>
          </header>

          <section v-if="selected.aliases.length" class="alias-section">
            <h4>{{ __t('ui.settings', '别名') }}</h4>
            <div>
              <span v-for="alias in selected.aliases" :key="alias">{{ alias }}</span>
            </div>
          </section>

          <section class="fact-section">
            <h4>
              <PixelIcon name="sparkle" size="xs" />
              {{ __t('ui.settings', '当前事实') }}
            </h4>
            <div v-if="!selected.activeFacts.length" class="inline-empty">
              {{ __t('ui.settings', '该对象目前没有有效事实') }}
            </div>
            <article v-for="fact in selected.activeFacts" :key="fact.id" class="fact-card">
              <p>{{ fact.statement }}</p>
              <footer class="fact-footer">
                <span class="fact-source">
                  {{ fact.source || __t('ui.settings', '来源未标注') }} ·
                  {{ formatDate(fact.observedAt) }}
                </span>
                <div class="fact-actions" role="group" :aria-label="__t('ui.settings', '事实操作')">
                  <PButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    @click="editTarget = { kind: 'fact', fact }"
                  >
                    {{ __t('ui.archive-edit', '编辑事实') }}
                  </PButton>
                  <PButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    :aria-expanded="expandedFacts.has(fact.id)"
                    @click="toggleFact(fact.id)"
                  >
                    {{
                      expandedFacts.has(fact.id)
                        ? __t('ui.settings', '收起')
                        : __t('ui.settings', '详情')
                    }}
                  </PButton>
                  <PButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    :title="__t('ui.settings', '撤回事实')"
                    @click="selectFactAction(fact, 'retract')"
                  >
                    {{ __t('ui.settings', '撤回') }}
                  </PButton>
                  <PButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    class="fact-action--danger"
                    :title="__t('ui.settings', '永久删除事实')"
                    @click="selectFactAction(fact, 'delete')"
                  >
                    <PixelIcon name="trash" size="xs" />
                    {{ __t('ui.settings', '永久删除') }}
                  </PButton>
                </div>
              </footer>
              <dl v-if="expandedFacts.has(fact.id)">
                <div>
                  <dt>{{ __t('ui.settings', '来源') }}</dt>
                  <dd>{{ fact.source || __t('ui.settings', '未标注') }}</dd>
                </div>
                <div>
                  <dt>{{ __t('ui.settings', '观察时间') }}</dt>
                  <dd>{{ formatDate(fact.observedAt) }}</dd>
                </div>
                <div>
                  <dt>{{ __t('ui.settings', '记录时间') }}</dt>
                  <dd>{{ formatDate(fact.createdAt) }}</dd>
                </div>
                <div>
                  <dt>{{ __t('ui.settings', '置信度') }}</dt>
                  <dd>{{ confidenceLabel(fact.confidence) }}</dd>
                </div>
              </dl>
            </article>
          </section>

          <section v-if="selected.historicalFacts.length" class="history-section">
            <button class="history-toggle" @click="historyOpen = !historyOpen">
              <PixelIcon name="chevron-down" size="xs" :class="{ open: historyOpen }" />
              {{ __t('ui.settings', '历史事实') }} {{ selected.historicalFacts.length }}
            </button>
            <div v-if="historyOpen" class="history-list">
              <article v-for="fact in selected.historicalFacts" :key="fact.id" class="history-card">
                <span>{{ __t('ui.settings', '已被取代') }}</span>
                <p>{{ fact.statement }}</p>
                <time>{{ formatDate(fact.observedAt) }}</time>
                <PButton size="sm" variant="danger" @click="selectFactAction(fact, 'delete')">
                  {{ __t('ui.settings', '永久删除') }}
                </PButton>
                <template v-if="replacementFor(fact)">
                  <i>{{ __t('ui.settings', '↓ 被以下事实取代') }}</i>
                  <strong>{{ replacementFor(fact)?.statement }}</strong>
                </template>
              </article>
            </div>
          </section>

          <section v-if="selected.retractedFacts.length" class="history-section">
            <button class="history-toggle" @click="historyOpen = !historyOpen">
              <PixelIcon name="chevron-down" size="xs" :class="{ open: historyOpen }" />
              {{ __t('ui.settings', '已撤回') }} {{ selected.retractedFacts.length }}
            </button>
            <div v-if="historyOpen" class="history-list">
              <article v-for="fact in selected.retractedFacts" :key="fact.id" class="history-card">
                <span>{{ __t('ui.settings', '已撤回') }}</span>
                <p>{{ fact.statement }}</p>
                <time>{{ formatDate(fact.observedAt) }}</time>
                <div class="history-actions">
                  <PButton
                    v-if="!fact.supersededBy"
                    size="sm"
                    variant="secondary"
                    @click="selectFactAction(fact, 'restore')"
                  >
                    <PixelIcon name="refresh" size="xs" />
                    {{ __t('ui.archive-edit', '还原') }}
                  </PButton>
                  <PButton size="sm" variant="danger" @click="selectFactAction(fact, 'delete')">
                    {{ __t('ui.settings', '永久删除') }}
                  </PButton>
                </div>
              </article>
            </div>
          </section>
        </template>
      </main>
    </section>

    <DocumentKnowledgePane v-else @stats="documentStats = $event" />

    <ArchiveEntryEditor
      v-if="editTarget"
      :target="editTarget"
      @close="editTarget = null"
      @saved="onFactEdited"
    />
    <PDialog
      :model-value="Boolean(retractTarget)"
      :title="
        factAction === 'restore'
          ? __t('ui.archive-edit', '还原事实？')
          : factAction === 'delete'
            ? __t('ui.settings', '永久删除事实？')
            : __t('ui.settings', '撤回事实？')
      "
      :message="
        factAction === 'restore'
          ? __t('ui.archive-edit', '重新纳入有效事实，保留原始来源与时间。')
          : factAction === 'delete'
            ? __t('ui.settings', '将永久删除，无法恢复。')
            : __t('ui.settings', '退出有效事实，保留历史记录。')
      "
      :confirm-text="
        factAction === 'restore'
          ? __t('ui.archive-edit', '还原')
          : factAction === 'delete'
            ? __t('ui.settings', '永久删除')
            : __t('ui.settings', '撤回')
      "
      :confirm-variant="factAction === 'restore' ? 'primary' : 'danger'"
      :loading="retracting"
      :auto-close="false"
      @update:model-value="!$event && (retractTarget = null)"
      @confirm="confirmRetract"
    />
  </div>
</template>

<script lang="ts">
export default { name: 'KnowledgeTab' }
</script>

<style scoped>
.knowledge-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 14px;
  padding: 24px;
  color: var(--ui-text-primary);
  overflow: hidden;
}
.knowledge-head {
  display: flex;
  align-items: center;
  gap: 20px;
  flex: none;
}
.knowledge-head h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 22px;
}
.knowledge-head h2 :deep(.pixel-icon) {
  color: var(--ui-accent-emerald, #10b981);
}
.knowledge-head p {
  margin: 4px 0 0;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--ui-text-tertiary);
}
.knowledge-stats {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.knowledge-stats span {
  display: flex;
  min-width: 72px;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 7px 10px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
  font-size: 9px;
  color: var(--ui-text-tertiary);
}
.knowledge-stats b {
  font-size: 15px;
  color: var(--ui-accent-emerald, #10b981);
}
.section-tabs {
  display: flex;
  gap: 8px;
  flex: none;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.section-tabs button {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 13px;
  border: 0;
  border-bottom: 3px solid transparent;
  background: none;
  color: var(--ui-text-secondary);
  font-weight: 700;
  cursor: pointer;
}
.section-tabs button.active {
  border-bottom-color: var(--ui-accent-emerald, #10b981);
  color: var(--ui-accent-emerald, #10b981);
}
.section-tabs small {
  padding: 2px 6px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
  font-size: 8px;
}
.facts-workbench {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(260px, 36%) minmax(0, 1fr);
  gap: 12px;
}
.object-panel,
.fact-inspector {
  min-height: 0;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface);
  box-shadow: var(--ui-shadow-sm);
}
.object-panel {
  display: flex;
  flex-direction: column;
  padding: 12px;
}
.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
}
.search-box input {
  width: 100%;
  border: 0;
  outline: 0;
  background: none;
  color: var(--ui-text-primary);
}
.object-list {
  display: grid;
  gap: 7px;
  margin-top: 10px;
  overflow: auto;
  padding: 2px;
}
.object-list button {
  display: grid;
  gap: 5px;
  padding: 10px;
  border: 1px solid var(--ui-border-subtle);
  border-left: 3px solid transparent;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-primary);
  text-align: left;
  cursor: pointer;
}
.object-list button:hover,
.object-list button.active {
  border-color: color-mix(in srgb, var(--ui-accent-emerald, #10b981) 52%, var(--ui-border-default));
  border-left-color: var(--ui-accent-emerald, #10b981);
  background: color-mix(in srgb, var(--ui-accent-emerald, #10b981) 8%, var(--ui-bg-elevated));
}
.object-list span {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.object-list small,
.object-list em {
  color: var(--ui-text-tertiary);
  font-size: 10px;
  font-style: normal;
}
.panel-state,
.inspector-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 28px;
  color: var(--ui-text-tertiary);
  text-align: center;
}
.error-state {
  color: var(--ui-danger, #ef5b72);
}
.fact-inspector {
  overflow: auto;
  padding: 20px;
}
.object-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px dashed var(--ui-border-default);
}
.object-mark {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  background: color-mix(in srgb, var(--ui-accent-emerald, #10b981) 14%, var(--ui-bg-elevated));
  color: var(--ui-accent-emerald, #10b981);
  font-size: 22px;
  transform: rotate(45deg);
}
.object-head h3 {
  margin: 0;
  font-size: 20px;
}
.object-head p {
  margin: 3px 0 0;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.alias-section,
.fact-section,
.history-section {
  margin-top: 18px;
}
.alias-section h4,
.fact-section h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 9px;
  font-size: 12px;
}
.alias-section div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.alias-section span {
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-sky) 35%, var(--ui-border-default));
  background: color-mix(in srgb, var(--ui-accent-sky) 8%, var(--ui-bg-elevated));
  font-size: 10px;
}
.fact-card {
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--ui-border-subtle);
  border-left: 3px solid var(--ui-accent-emerald, #10b981);
  background: var(--ui-bg-elevated);
}
.fact-card > p {
  margin: 0;
  line-height: 1.55;
}
.fact-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  margin-top: 12px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.fact-source {
  flex: 1 1 220px;
  min-width: 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.fact-actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  max-width: 100%;
  gap: 6px;
  margin-left: auto;
  padding: 0 3px 3px 0;
}
.fact-actions :deep(.p-btn) {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 4px 9px;
  font-size: 11px;
  white-space: nowrap;
}
.fact-actions .fact-action--danger {
  --ui-focus-color: var(--ui-danger);
  color: var(--ui-danger);
  border-color: color-mix(in srgb, var(--ui-danger) 35%, var(--ui-border-default));
  background: var(--ui-danger-soft);
}
.fact-actions .fact-action--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-danger) 18%, var(--ui-bg-surface));
}
.fact-card dl {
  display: grid;
  gap: 5px;
  margin: 10px 0 0;
  padding-top: 9px;
  border-top: 1px dashed var(--ui-border-default);
  font-size: 10px;
}
.fact-card dl div {
  display: grid;
  grid-template-columns: 70px 1fr;
}
.fact-card dt {
  color: var(--ui-text-tertiary);
}
.fact-card dd {
  margin: 0;
}
.inline-empty {
  padding: 16px;
  border: 1px dashed var(--ui-border-default);
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.history-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-secondary);
  cursor: pointer;
}
.history-toggle :deep(.pixel-icon) {
  transition: transform 0.18s;
}
.history-toggle :deep(.pixel-icon.open) {
  transform: rotate(180deg);
}
.history-list {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}
.history-card {
  display: grid;
  gap: 7px;
  padding: 11px;
  border: 1px solid var(--ui-border-subtle);
  background: color-mix(in srgb, var(--ui-text-muted) 5%, var(--ui-bg-elevated));
  color: var(--ui-text-secondary);
}
.history-card > span {
  width: max-content;
  padding: 2px 6px;
  background: var(--ui-bg-muted);
  color: var(--ui-text-tertiary);
  font-size: 8px;
}
.history-card p {
  margin: 0;
}
.history-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.history-card time {
  color: var(--ui-text-tertiary);
  font-size: 9px;
}
.history-card i {
  color: var(--ui-text-tertiary);
  font-size: 9px;
  font-style: normal;
}
.history-card strong {
  font-size: 11px;
  color: var(--ui-accent-emerald, #10b981);
}
@media (max-width: 800px) {
  .knowledge-page {
    padding: 14px;
  }
  .knowledge-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .knowledge-stats {
    margin-left: 0;
  }
  .facts-workbench {
    grid-template-columns: 1fr;
  }
  .object-panel {
    max-height: 42%;
  }
  .fact-inspector {
    min-height: 280px;
  }
}
</style>
