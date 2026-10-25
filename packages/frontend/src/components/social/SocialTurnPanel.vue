<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { getSocialTurnKind, type SocialTurnListItem } from '@infos/shared'
import { translateDiagnostic } from '@infos/shared/i18n'
import '@infos/shared/i18n/catalogs/socialTasks'
import { getDisplayLocale, t } from '../../i18n/index'
import { socialApi } from '../../api/modules/socialApi'
import { PButton, PCard, PixelIcon } from '../pixel'

const props = defineProps<{ agentId: string; history?: boolean; tasksOnly?: boolean }>()
const emit = defineEmits<{
  'attention-change': [value: boolean]
  'history-change': [value: boolean]
}>()
const records = ref<SocialTurnListItem[]>([])
const error = ref('')
const loading = ref(false)
const busy = ref('')
const archived = ref(false)
const page = ref(1)
const now = ref(Date.now())
const pageSize = 6
let timer: ReturnType<typeof setTimeout> | undefined
let active = true
let request = 0
const tr = (source: string, parameters: readonly unknown[] = []) =>
  t('ui.social-tasks', source, parameters)
const labels = computed(() => ({
  running: tr('进行中'),
  retrying: tr('等待重试'),
  waiting: tr('等待唤醒'),
  completed: tr('已完成'),
  failed: tr('失败'),
  cancelled: tr('已取消'),
  delivery_unknown: tr('结果待确认'),
}))
const outcomes = computed(() => ({
  reply: tr('已回复'),
  pass: tr('本轮未回复'),
  wait: tr('等待新消息'),
  defer: tr('延后处理'),
  orchestration: tr('编排已提交'),
}))
const toolStatuses = computed(() => ({
  completed: tr('已完成'),
  error: tr('失败'),
  unknown: tr('结果待确认'),
  blocked: tr('已阻止'),
}))
function isActive(record: SocialTurnListItem): boolean {
  return ['running', 'retrying', 'waiting'].includes(record.status)
}
function isArchived(record: SocialTurnListItem): boolean {
  return (
    !isActive(record) &&
    Boolean(
      record.acknowledgedAt ||
      (record.displayExpiresAt && Date.parse(record.displayExpiresAt) <= now.value),
    )
  )
}
// 任务中心只显示明确委派的任务；聊天中的工具调用、失败和等待都不能改变回合分类。
const scopedRecords = computed(() =>
  records.value.filter((record) => !props.tasksOnly || getSocialTurnKind(record) === 'task'),
)
const terminal = computed(() => scopedRecords.value.filter((record) => !isActive(record)))
const unread = computed(() => terminal.value.filter((record) => !isArchived(record)))
const archiveCount = computed(() => terminal.value.filter(isArchived).length)
const items = computed(() =>
  scopedRecords.value
    .filter((record) =>
      props.history
        ? !isActive(record) && isArchived(record) === archived.value
        : isActive(record) || (!isArchived(record) && needsAttention(record)),
    )
    .sort(
      (a, b) =>
        Number(isActive(b)) - Number(isActive(a)) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    ),
)
const pages = computed(() => Math.max(1, Math.ceil(items.value.length / pageSize)))
const currentPage = computed(() => Math.min(page.value, pages.value))
const visibleItems = computed(() =>
  items.value.slice((currentPage.value - 1) * pageSize, currentPage.value * pageSize),
)
function loopBlocked(record: SocialTurnListItem): boolean {
  return /社交互聊|机器人互聊|连续无人介入|旧社交计划的互聊预算/.test(record.error ?? '')
}
function needsAttention(record: SocialTurnListItem): boolean {
  return (
    ['failed', 'delivery_unknown'].includes(record.status) ||
    loopBlocked(record) ||
    Boolean(record.orchestrationSummary?.stepsFailed || record.orchestrationSummary?.stepsUncertain)
  )
}
function date(value: string | number): string {
  return new Date(value).toLocaleString(getDisplayLocale(), { hour12: false })
}
function diagnostic(value: string): string {
  return translateDiagnostic(value, getDisplayLocale())
}
function title(record: SocialTurnListItem): string {
  return (
    record.sourcePreview?.content.trim() ||
    (record.sourcePreview ? tr('附件消息') : tr('原消息已清理或不可用'))
  )
}
function result(record: SocialTurnListItem): string {
  const summary = record.orchestrationSummary
  if (summary) return tr('完成 {0} 步 · 发送 {1} 条', [summary.stepsCompleted, summary.sends])
  return record.outcome ? outcomes.value[record.outcome] : labels.value[record.status]
}
async function act(key: string, action: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  const agentId = props.agentId
  busy.value = key
  try {
    await action()
    if (agentId === props.agentId) await load()
  } catch (cause) {
    if (agentId === props.agentId) {
      error.value = cause instanceof Error ? cause.message : tr('操作失败，请重试')
      // 批量操作可能部分成功，重新读取持久状态。
      await load(false)
    }
  } finally {
    busy.value = ''
  }
}
function acknowledgeAll(): void {
  const ids = unread.value.map((record) => record.id)
  void act('all', () => socialApi.acknowledgeTurns(props.agentId, ids))
}
function allowConversation(record: SocialTurnListItem): void {
  void act(record.id, async () => {
    await socialApi.allowLimitedConversation(
      record.accountId,
      record.channelType,
      record.channelId,
      record.platform,
    )
    await socialApi.acknowledgeTurn(record.id)
  })
}
watch(items, (value) => emit('attention-change', value.length > 0), { immediate: true })
watch(terminal, (value) => emit('history-change', value.length > 0), { immediate: true })
watch(archived, () => {
  page.value = 1
})
async function load(clearError = true): Promise<void> {
  if (timer) clearTimeout(timer)
  const sequence = ++request
  let delay = 5000
  if (!active || !props.agentId) return
  loading.value = true
  try {
    const response = await socialApi.turns(props.agentId, props.tasksOnly ? 'task' : undefined)
    if (!active || sequence !== request) return
    records.value = response.data ?? []
    now.value = Date.now()
    if (clearError) error.value = ''
  } catch (cause) {
    const code = (cause as { code?: string }).code
    if (['NOT_FOUND', 'SERVICE_UNAVAILABLE', 'SERVICE_INITIALIZING'].includes(code ?? '')) {
      delay = 60_000
      if (active && sequence === request) {
        error.value = ''
        records.value = []
      }
    } else if (active && sequence === request)
      error.value = cause instanceof Error ? cause.message : tr('社交记录暂不可用')
  } finally {
    if (active && sequence === request) {
      loading.value = false
      timer = setTimeout(() => void load(), delay)
    }
  }
}
function stop(): void {
  active = false
  request++
  loading.value = false
  if (timer) clearTimeout(timer)
}
watch(
  () => [props.agentId, props.tasksOnly],
  () => {
    records.value = []
    error.value = ''
    page.value = 1
    archived.value = false
    void load()
  },
)
onMounted(load)
onActivated(() => {
  active = true
  void load()
})
onDeactivated(stop)
onBeforeUnmount(stop)
</script>

<template>
  <PCard
    v-if="items.length || error || (history && terminal.length)"
    pixel
    padding="sm"
    class="social-turns"
  >
    <header class="social-turns__header">
      <div class="social-turns__heading">
        <PixelIcon name="chat" size="sm" />
        <strong>{{ tasksOnly ? tr('社交任务') : tr('社交回合') }}</strong>
        <span>{{ items.length }}</span>
      </div>
      <div class="social-turns__actions">
        <PButton
          v-if="history && !archived && unread.length"
          size="sm"
          variant="ghost"
          :disabled="Boolean(busy)"
          :loading="busy === 'all'"
          @click="acknowledgeAll"
        >
          <PixelIcon name="check" size="xs" />
          {{ tr('全部已阅') }}
        </PButton>
        <PButton size="sm" variant="ghost" :loading="loading" @click="load()">
          <PixelIcon v-if="!loading" name="refresh" size="xs" />
          {{ tr('刷新') }}
        </PButton>
      </div>
    </header>
    <div v-if="history" class="social-turns__toolbar">
      <div class="social-turns__filters">
        <button
          type="button"
          :class="{ selected: !archived }"
          :aria-pressed="!archived"
          @click="archived = false"
        >
          {{ tr('待阅 {0}', [unread.length]) }}
        </button>
        <button
          type="button"
          :class="{ selected: archived }"
          :aria-pressed="archived"
          @click="archived = true"
        >
          <PixelIcon name="archive" size="xs" />
          {{ tr('已归档 {0}', [archiveCount]) }}
        </button>
      </div>
      <small>{{ tr('完成记录 24 小时后收起，异常记录保留 7 天；已阅立即归档。') }}</small>
    </div>
    <p v-if="error" role="alert" class="social-turns__error">
      <PixelIcon name="alert" size="sm" />
      {{ diagnostic(error) }}
    </p>
    <p v-if="!items.length" class="social-turns__empty">
      <PixelIcon name="check" size="sm" />
      {{
        archived
          ? tr('暂无归档记录')
          : tasksOnly
            ? tr('暂无待阅的社交任务')
            : tr('暂无待阅的社交回合')
      }}
    </p>
    <article
      v-for="record in visibleItems"
      :key="record.id"
      class="social-turn"
      :class="{ 'social-turn--warning': needsAttention(record) }"
    >
      <details>
        <summary>
          <span class="social-turn__icon">
            <PixelIcon :name="record.channelType === 'group' ? 'users' : 'chat'" size="sm" />
          </span>
          <span class="social-turn__copy">
            <span class="social-turn__meta">
              <strong>
                {{
                  record.sourcePreview?.senderName ||
                  (record.channelType === 'group' ? tr('群聊') : tr('私聊'))
                }}
              </strong>
              <span>
                {{ record.channelType === 'group' ? tr('群聊') : tr('私聊') }} ·
                {{ record.channelId }}
              </span>
              <time>{{ date(record.updatedAt) }}</time>
            </span>
            <span class="social-turn__preview">{{ title(record) }}</span>
            <span class="social-turn__result">
              {{ result(record) }}
              <template v-if="record.orchestrationSummary?.stepsFailed">
                · {{ tr('失败 {0} 步', [record.orchestrationSummary.stepsFailed]) }}
              </template>
              <template v-if="record.orchestrationSummary?.stepsUncertain">
                · {{ tr('待确认 {0} 步', [record.orchestrationSummary.stepsUncertain]) }}
              </template>
            </span>
          </span>
          <span class="social-turn__state">
            <i :class="{ active: isActive(record) }" />
            {{ labels[record.status] }}
            <PixelIcon name="chevron-down" size="xs" />
          </span>
        </summary>
        <div class="social-turn__detail">
          <div>
            <b>{{ tr('触发消息') }}</b>
            <p>{{ record.sourcePreview?.content || title(record) }}</p>
            <small>{{ tr('本批 {0} 条消息', [record.sourceCount]) }}</small>
          </div>
          <div>
            <b>{{ tr('执行结果') }}</b>
            <p>{{ result(record) }}</p>
            <p v-if="record.error" class="social-turns__error">{{ diagnostic(record.error) }}</p>
            <p v-if="isActive(record) && record.orchestrationSummary?.wakeAt">
              {{ tr('预计唤醒：{0}', [date(record.orchestrationSummary.wakeAt)]) }}
            </p>
            <p v-if="isActive(record)">{{ tr('处理期限：{0}', [date(record.deadline)]) }}</p>
          </div>
          <div v-if="record.generationSummary">
            <b>{{ tr('调用记录') }}</b>
            <p>
              {{
                tr('模型 {0} 轮 · 工具 {1} 次', [
                  record.generationSummary.modelResponses,
                  record.generationSummary.toolCalls,
                ])
              }}
            </p>
            <ul v-if="record.generationSummary.tools.length" class="social-turn__tools">
              <li v-for="(tool, index) in record.generationSummary.tools" :key="index">
                <code>
                  {{ tool.name }}
                  <template v-if="tool.action">/ {{ tool.action }}</template>
                </code>
                <span>{{ toolStatuses[tool.status] }} · {{ tool.durationMs }} ms</span>
              </li>
            </ul>
          </div>
          <footer>
            <code>{{ record.id }}</code>
            <small>
              {{
                record.acknowledgedAt
                  ? tr('已阅于 {0}', [date(record.acknowledgedAt)])
                  : record.displayExpiresAt
                    ? tr('自动归档：{0}', [date(record.displayExpiresAt)])
                    : ''
              }}
            </small>
          </footer>
        </div>
      </details>
      <div class="social-turn__controls">
        <PButton
          v-if="loopBlocked(record) && !isArchived(record)"
          size="sm"
          variant="ghost"
          :disabled="Boolean(busy)"
          @click="allowConversation(record)"
        >
          {{ tr('有限开放') }}
        </PButton>
        <PButton
          v-if="isActive(record)"
          size="sm"
          variant="ghost"
          :disabled="Boolean(busy)"
          :loading="busy === record.id"
          @click="act(record.id, () => socialApi.cancelTurn(record.id))"
        >
          <PixelIcon name="close" size="xs" />
          {{ tr('取消') }}
        </PButton>
        <PButton
          v-else-if="!record.acknowledgedAt"
          size="sm"
          variant="ghost"
          :disabled="Boolean(busy)"
          :loading="busy === record.id"
          @click="act(record.id, () => socialApi.acknowledgeTurn(record.id))"
        >
          <PixelIcon name="check" size="xs" />
          {{ tr('标为已阅') }}
        </PButton>
        <span v-else class="social-turn__read">
          <PixelIcon name="check" size="xs" />
          {{ tr('已阅') }}
        </span>
      </div>
    </article>
    <footer v-if="pages > 1" class="social-turns__pagination">
      <PButton
        size="sm"
        variant="ghost"
        :disabled="currentPage === 1"
        :aria-label="tr('上一页')"
        @click="page = currentPage - 1"
      >
        <PixelIcon name="chevron-left" size="xs" />
      </PButton>
      <small>{{ tr('第 {0} / {1} 页', [currentPage, pages]) }}</small>
      <PButton
        size="sm"
        variant="ghost"
        :disabled="currentPage === pages"
        :aria-label="tr('下一页')"
        @click="page = currentPage + 1"
      >
        <PixelIcon name="chevron-right" size="xs" />
      </PButton>
    </footer>
    <small v-if="history" class="social-turns__footnote">
      {{ tr('显示最近 100 条完成记录；归档不删除聊天记录。') }}
    </small>
  </PCard>
</template>

<style scoped>
.social-turns {
  color: var(--ui-text-primary);
}
.social-turns__header,
.social-turns__heading,
.social-turns__actions,
.social-turns__filters,
.social-turns__pagination,
.social-turn__controls,
.social-turn__state,
.social-turn__meta,
.social-turn__read {
  display: flex;
  align-items: center;
  gap: 8px;
}
.social-turns__header {
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.social-turns__heading > .pixel-icon {
  color: var(--ui-accent-sky);
}
.social-turns__heading > span {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
  font-size: 11px;
}
.social-turns__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 12px 0;
}
.social-turns__filters {
  gap: 2px;
  padding: 3px;
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border-default);
  border-radius: 6px;
}
.social-turns__filters button {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.social-turns__filters button.selected {
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
}
.social-turn {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 8px;
  border: 1px solid var(--ui-border-default);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-bg-elevated) 60%, transparent);
  overflow: hidden;
}
.social-turn:hover {
  border-color: var(--ui-accent-purple);
}
.social-turn--warning {
  border-left: 3px solid var(--ui-warning);
}
.social-turn details {
  flex: 1;
  min-width: 0;
}
.social-turn summary {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  cursor: pointer;
  list-style: none;
}
.social-turn summary::-webkit-details-marker {
  display: none;
}
.social-turn summary:focus-visible,
.social-turns__filters button:focus-visible {
  outline: 2px solid var(--ui-accent-purple);
  outline-offset: -2px;
}
.social-turn__icon {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
}
.social-turn__copy {
  flex: 1;
  min-width: 0;
}
.social-turn__meta {
  flex-wrap: wrap;
  gap: 3px 10px;
  font-size: 11px;
  color: var(--ui-text-tertiary);
}
.social-turn__meta strong {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-primary);
  font-size: 12px;
}
.social-turn__preview {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  margin: 5px 0;
  line-height: 1.55;
  font-size: 13px;
}
.social-turn__result {
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.social-turn__state {
  flex-shrink: 0;
  color: var(--ui-text-secondary);
  font-size: 11px;
  padding-top: 2px;
}
.social-turn__state i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ui-text-tertiary);
}
.social-turn__state i.active {
  background: var(--ui-accent-sky);
}
.social-turn--warning .social-turn__state {
  color: var(--ui-warning);
}
.social-turn details[open] .social-turn__state > .pixel-icon {
  transform: rotate(180deg);
}
.social-turn__state > .pixel-icon {
  transition: transform 160ms ease;
}
.social-turn__controls {
  flex-shrink: 0;
  padding: 9px 10px 9px 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 190px;
}
.social-turn__read {
  color: var(--ui-text-tertiary);
  font-size: 12px;
  padding: 5px;
}
.social-turn__detail {
  display: grid;
  gap: 14px;
  margin: 0 12px 12px 52px;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border-default);
  font-size: 12px;
}
.social-turn__detail b {
  font-size: 11px;
  color: var(--ui-text-tertiary);
  font-weight: 500;
}
.social-turn__detail p {
  margin: 5px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.65;
}
.social-turn__tools {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 200px;
  overflow: auto;
}
.social-turn__tools li {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  border-bottom: 1px solid var(--ui-border-default);
  padding: 5px 0;
}
.social-turn__tools code {
  overflow-wrap: anywhere;
}
.social-turn__tools span,
.social-turns small {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.social-turn__detail footer {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
  overflow-wrap: anywhere;
}
.social-turns__error,
.social-turns__empty {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  overflow-wrap: anywhere;
  margin: 12px 0;
}
.social-turns__error {
  color: var(--ui-danger);
}
.social-turns__empty {
  padding: 12px 0;
  color: var(--ui-text-secondary);
}
.social-turns__pagination {
  justify-content: flex-end;
  margin-top: 10px;
}
.social-turns__footnote {
  display: block;
  margin-top: 10px;
}
@media (max-width: 760px) {
  .social-turn {
    flex-wrap: wrap;
    gap: 0;
  }
  .social-turn details {
    flex-basis: 100%;
  }
  .social-turn summary {
    gap: 8px;
    padding: 10px;
    flex-wrap: wrap;
  }
  .social-turn__copy {
    flex-basis: calc(100% - 42px);
  }
  .social-turn__state {
    margin-left: 38px;
  }
  .social-turn__detail {
    margin-left: 10px;
  }
  .social-turn__controls {
    margin-left: auto;
    padding: 0 10px 8px;
    max-width: none;
  }
  .social-turns__toolbar {
    align-items: flex-start;
  }
}
@media (prefers-reduced-motion: reduce) {
  .social-turn__state > .pixel-icon {
    transition: none;
  }
}
</style>
