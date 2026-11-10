<script setup lang="ts">
/**
 * ExpressionMarksPanel — 表达调教管理页，放在「提示词」页的分区里。
 *
 * 列出某个角色所有的标记和批注，可按类型筛选、查看原消息片段、修改和删除；
 * 顶部显示当前规则版本和对味、人机的数量。这里只做人工管理，没有任何自动判断。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { t as __t, getDisplayLocale } from '../../i18n/index'
import { expressionApi, isExpressionApiMissing } from '../../api/modules/expressionApi'
import { threadsApi } from '../../api/modules/threadsApi'
import { threadDisplayName } from '../../utils/threadPresentation'
import { useAgentStore } from '../../stores/useAgentStore'
import { useNotificationStore } from '../../stores/useNotificationStore'
import { PButton, PSelect } from '../pixel'
import MotionList from '../motion/MotionList.vue'
import MotionSkeleton from '../motion/MotionSkeleton.vue'
import ExpressionNoteEditor from './ExpressionNoteEditor.vue'
import { snippetAround } from './expressionQuoteMatch'
import { forgetMark, syncMark } from './useExpressionMarks'
import type { ExpressionMark, ExpressionMarkKind, ExpressionStatus } from './expressionTypes'
import './expression.css'

const PAGE_SIZE = 20

/** 放在表达调教里时由外面选角色；单独用时自己选。 */
const props = defineProps<{ agentId?: string }>()

const agentStore = useAgentStore()
const notify = useNotificationStore()

const agentId = ref(props.agentId ?? agentStore.activeAgentId)
const kind = ref<'' | ExpressionMarkKind>('')
const learning = ref<'' | NonNullable<ExpressionMark['learning']>['state']>('')
const page = ref(1)
const items = ref<ExpressionMark[]>([])
const total = ref(0)
const status = ref<ExpressionStatus | null>(null)
const loading = ref(false)
const failed = ref(false)
const missing = ref(false)
const busyId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const confirmingId = ref<string | null>(null)

interface SnippetState {
  open: boolean
  loading: boolean
  content: string | null
}
const snippets = reactive(new Map<string, SnippetState>())

const agentOptions = computed(() => {
  const options = agentStore.agents.map((agent) => ({
    label: agent.name || agent.id,
    value: agent.id,
  }))
  return options.some((option) => option.value === agentId.value)
    ? options
    : [{ label: agentId.value, value: agentId.value }, ...options]
})
const kindOptions = computed(() => [
  { label: __t('ui.chat', '全部类型'), value: '' },
  { label: __t('ui.chat', '对味'), value: 'good' },
  { label: __t('ui.chat', '人机'), value: 'robotic' },
])
const learningOptions = computed(() => [
  { label: __t('ui.chat', '全部结果'), value: '' },
  { label: __t('ui.chat', '已学到'), value: 'learned' },
  { label: __t('ui.chat', '这次没学'), value: 'skipped' },
  { label: __t('ui.chat', '没学成'), value: 'failed' },
  { label: __t('ui.chat', '正在学'), value: 'pending' },
  { label: __t('ui.chat', '还没学'), value: 'none' },
])
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

let sequence = 0
async function load(): Promise<void> {
  const request = ++sequence
  loading.value = true
  failed.value = false
  const agent = agentId.value
  try {
    const [marks, state] = await Promise.all([
      expressionApi.listMarks({
        agentId: agent,
        kind: kind.value || undefined,
        learning: learning.value || undefined,
        page: page.value,
        pageSize: PAGE_SIZE,
      }),
      expressionApi.getStatus(agent),
    ])
    if (request !== sequence) return
    missing.value = false
    items.value = marks.data?.items ?? []
    total.value = marks.data?.total ?? 0
    status.value = state.data ?? null
    // 删到这一页空了就退回上一页。
    if (!items.value.length && total.value > 0 && page.value > 1) {
      page.value = pageCount.value
      void load()
    }
  } catch (error) {
    if (request !== sequence) return
    missing.value = isExpressionApiMissing(error)
    failed.value = !missing.value
    items.value = []
    total.value = 0
    status.value = null
  } finally {
    if (request === sequence) loading.value = false
  }
}
function changeFilter(): void {
  editingId.value = null
  confirmingId.value = null
  if (page.value !== 1) page.value = 1
  else void load()
}
watch(
  () => props.agentId,
  (next) => {
    if (next) agentId.value = next
  },
)
watch([agentId, kind, learning], changeFilter)
watch(page, () => void load())
onMounted(async () => {
  if (!agentStore.agents.length) await agentStore.fetchAgents().catch(() => undefined)
  void load()
})

async function run(id: string, action: () => Promise<void>): Promise<void> {
  busyId.value = id
  try {
    await action()
  } catch (error) {
    notify.toast(error instanceof Error ? error.message : __t('ui.chat', '保存失败'), 'error')
  } finally {
    busyId.value = null
  }
}
function save(mark: ExpressionMark, value: { kind: ExpressionMarkKind; note: string }) {
  return run(mark.id, async () => {
    const response = await expressionApi.updateMark(mark.id, value)
    if (!response.data) throw new Error(__t('ui.chat', '保存失败'))
    syncMark(response.data)
    editingId.value = null
    await load()
  })
}
function remove(mark: ExpressionMark) {
  if (confirmingId.value !== mark.id) {
    confirmingId.value = mark.id
    return
  }
  return run(mark.id, async () => {
    await expressionApi.deleteMark(mark.id)
    forgetMark(mark)
    confirmingId.value = null
    editingId.value = null
    snippets.delete(mark.id)
    await load()
  })
}
function relearn(mark: ExpressionMark) {
  return run(mark.id, async () => {
    await expressionApi.relearnMark(mark.id)
    await load()
  })
}
function learningLabel(mark: ExpressionMark): string {
  const learning = mark.learning
  if (learning?.state === 'learned')
    return __t('ui.chat', '已学到：{0}', [learning.ruleText ?? ''])
  if (learning?.state === 'pending') return __t('ui.chat', '正在学')
  if (learning?.state === 'skipped') return __t('ui.chat', '这次没学')
  if (learning?.state === 'failed') return __t('ui.chat', '没学成')
  return __t('ui.chat', '还没学')
}

/** 原消息按需读取：只取这一条，不拉整段会话。 */
async function toggleSnippet(mark: ExpressionMark): Promise<void> {
  const current = snippets.get(mark.id)
  if (current) {
    current.open = !current.open
    return
  }
  const state = reactive<SnippetState>({ open: true, loading: true, content: null })
  snippets.set(mark.id, state)
  try {
    const response = await threadsApi.getProjection(mark.threadId, {
      beforeCursor: String(Number(mark.messageId) + 1),
      pageSize: 1,
    })
    state.content =
      response.data?.messages.find((message) => message.messageId === String(mark.messageId))
        ?.content ?? null
  } catch {
    state.content = null
  } finally {
    state.loading = false
  }
}
const snippetOf = (mark: ExpressionMark, content: string) => snippetAround(content, mark.quote)
const formatTime = (value: number) => new Date(value).toLocaleString(getDisplayLocale())
const kindLabel = (value: ExpressionMarkKind) =>
  value === 'good' ? __t('ui.chat', '对味') : __t('ui.chat', '人机')
</script>

<template>
  <section class="expr-panel" data-expression-panel>
    <header class="expr-panel__status">
      <div class="expr-panel__stat">
        <small>{{ __t('ui.chat', '规则版本') }}</small>
        <strong data-expression-rule>{{ status?.ruleVersion || '—' }}</strong>
      </div>
      <div class="expr-panel__stat">
        <small>✓ {{ __t('ui.chat', '对味') }}</small>
        <strong data-expression-count="good">{{ status?.counts.good ?? '—' }}</strong>
      </div>
      <div class="expr-panel__stat">
        <small>✗ {{ __t('ui.chat', '人机') }}</small>
        <strong data-expression-count="robotic">{{ status?.counts.robotic ?? '—' }}</strong>
      </div>
      <span v-if="status && !status.enabled" class="expr-panel__off">
        {{ __t('ui.chat', '表达层当前未启用，标记会保留但不会影响回复') }}
      </span>
    </header>

    <div class="expr-panel__filters">
      <PSelect
        v-if="!props.agentId"
        v-model="agentId"
        size="sm"
        :label="__t('ui.chat', '角色')"
        :options="agentOptions"
      />
      <PSelect v-model="kind" size="sm" :label="__t('ui.chat', '类型')" :options="kindOptions" />
      <PSelect
        v-model="learning"
        size="sm"
        :label="__t('ui.chat', '学习结果')"
        :options="learningOptions"
      />
    </div>

    <p v-if="missing" class="expr-panel__notice" role="status">
      {{ __t('ui.chat', '当前后端版本还不支持表达层，更新后端后这里才能使用。') }}
    </p>
    <div v-else-if="failed" class="expr-panel__notice" role="alert">
      {{ __t('ui.chat', '读取失败') }}
      <PButton size="sm" variant="ghost" @click="load">{{ __t('ui.chat', '重试') }}</PButton>
    </div>
    <MotionSkeleton v-else-if="loading && !items.length" variant="list" />
    <p v-else-if="!items.length" class="expr-panel__notice">
      {{
        kind || learning
          ? __t('ui.chat', '这个筛选下没有标记。')
          : __t('ui.chat', '还没有标记。在聊天气泡上点「对味」「人机」，或选中一句写批注。')
      }}
    </p>

    <MotionList v-if="items.length" tag="ul" class="expr-panel__list">
      <li v-for="mark in items" :key="mark.id" class="expr-item" :data-expression-item="mark.id">
        <ExpressionNoteEditor
          v-if="editingId === mark.id"
          :quote="mark.quote"
          :kind="mark.kind"
          :note="mark.note"
          :busy="busyId === mark.id"
          @save="save(mark, $event)"
          @cancel="editingId = null"
        />
        <template v-else>
          <div class="expr-item__head">
            <span class="expr-hand expr-item__sign">{{ mark.kind === 'good' ? '✓' : '✗' }}</span>
            <strong>{{ kindLabel(mark.kind) }}</strong>
            <span class="expr-item__meta">
              {{ formatTime(mark.createdAt) }}
              <template v-if="mark.ruleVersion">· {{ mark.ruleVersion }}</template>
            </span>
          </div>
          <p class="expr-item__meta">
            {{ __t('ui.chat', '来源会话 {0}', [threadDisplayName({ threadKind: mark.threadKind, title: mark.threadTitle || mark.threadId })]) }}
          </p>
          <p class="expr-item__quote">
            {{ mark.quote ? `「${mark.quote}」` : __t('ui.chat', '整条回复') }}
          </p>
          <p v-if="mark.note" class="expr-hand expr-item__note">{{ mark.note }}</p>
          <p class="expr-item__meta" data-expression-learning>
            {{ mark.sourceAvailable === false ? __t('ui.chat', '原文已更新或移除，批注已暂停使用。') : learningLabel(mark) }}
          </p>
          <p v-if="confirmingId === mark.id" class="expr-item__meta">
            {{ __t('ui.chat', '已学出的规则可在手册中单独管理。') }}
          </p>
          <div
            v-if="snippets.get(mark.id)?.open"
            class="expr-item__snippet"
            data-expression-snippet
          >
            <span v-if="snippets.get(mark.id)?.loading">{{ __t('ui.chat', '正在读取…') }}</span>
            <template v-else-if="snippets.get(mark.id)?.content != null">
              <span>{{ snippetOf(mark, snippets.get(mark.id)!.content!).before }}</span>
              <mark>{{ snippetOf(mark, snippets.get(mark.id)!.content!).match }}</mark>
              <span>{{ snippetOf(mark, snippets.get(mark.id)!.content!).after }}</span>
            </template>
            <span v-else>{{ __t('ui.chat', '原消息已不存在') }}</span>
          </div>
          <div class="expr-item__actions">
            <button type="button" data-expression-view @click="toggleSnippet(mark)">
              {{ __t('ui.chat', '原消息') }}
            </button>
            <button
              v-if="mark.learning?.state !== 'pending'"
              type="button"
              data-expression-relearn
              :disabled="busyId === mark.id || mark.sourceAvailable === false"
              @click="relearn(mark)"
            >
              {{ __t('ui.chat', '重新学') }}
            </button>
            <button type="button" data-expression-edit @click="editingId = mark.id">
              {{ __t('ui.chat', '修改') }}
            </button>
            <button
              type="button"
              class="is-danger"
              data-expression-delete
              :disabled="busyId === mark.id"
              @click="remove(mark)"
              @blur="confirmingId = null"
            >
              {{ confirmingId === mark.id ? __t('ui.chat', '确认删除') : __t('ui.chat', '删除') }}
            </button>
          </div>
        </template>
      </li>
    </MotionList>

    <nav v-if="pageCount > 1" class="expr-panel__pages" :aria-label="__t('ui.chat', '翻页')">
      <PButton size="sm" variant="ghost" :disabled="page <= 1" @click="page--">
        {{ __t('ui.chat', '上一页') }}
      </PButton>
      <span>{{ page }} / {{ pageCount }}</span>
      <PButton size="sm" variant="ghost" :disabled="page >= pageCount" @click="page++">
        {{ __t('ui.chat', '下一页') }}
      </PButton>
    </nav>
  </section>
</template>

<style scoped>
.expr-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding: 2px 2px 16px;
}
.expr-panel__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 24px;
  padding: 10px 14px;
  border: 1px solid var(--ui-border-subtle);
  border-left: 3px solid var(--expr-ink);
  background: var(--ui-bg-surface);
}
.expr-panel__stat {
  display: grid;
  gap: 2px;
}
.expr-panel__stat small {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.expr-panel__stat strong {
  color: var(--ui-text-primary);
  font: 700 15px/1.3 var(--ui-font-mono, monospace);
  font-variant-numeric: tabular-nums;
}
.expr-panel__off {
  flex-basis: 100%;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
.expr-panel__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.expr-panel__filters > * {
  flex: 0 1 200px;
  min-width: 140px;
}
.expr-panel__notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 18px 14px;
  border: 1px dashed var(--ui-border-default);
  background: var(--ui-bg-surface);
  color: var(--ui-text-secondary);
  font-size: 13px;
}
.expr-panel__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.expr-item {
  display: grid;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface);
}
.expr-item__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  color: var(--expr-ink);
  font-size: 12px;
}
.expr-item__sign {
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
}
.expr-item__meta {
  color: var(--ui-text-tertiary);
  font: 11px/1.4 var(--ui-font-sans);
}
.expr-item__quote,
.expr-item__note {
  margin: 0;
  overflow-wrap: anywhere;
}
.expr-item__quote {
  color: var(--ui-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}
.expr-item__note {
  color: var(--expr-ink);
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.expr-item__snippet {
  padding: 7px 10px;
  border-left: 2px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.expr-item__snippet mark {
  background: transparent;
  color: var(--ui-text-primary);
  text-decoration: underline wavy var(--expr-ink);
}
.expr-item__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.expr-item__actions button {
  min-height: 26px;
  padding: 2px 9px;
  border: 1px solid var(--ui-border-subtle);
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.expr-item__actions button:hover:not(:disabled) {
  border-color: var(--ui-accent-primary);
  color: var(--ui-text-primary);
}
.expr-item__actions button.is-danger:hover:not(:disabled) {
  border-color: var(--ui-danger);
  color: var(--ui-danger);
}
.expr-panel__pages {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
</style>
