<script setup lang="ts">
import { getDisplayLocale } from '../../i18n/index'

import { t as __t } from '../../i18n/index'

import { computed, inject, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type {
  TokenUsagePeriod,
  TokenUsagePurpose,
  TokenUsageStatistics,
  TokenUsageTotals,
  TokenUsageFilterOptions,
} from '@infos/shared'
import { PCard, PSelect, PixelIcon } from '../pixel'
import BrandIcon from '../brands/BrandIcon.vue'
import { resolveModelBrand } from '../../lib/modelBrands'
import { tokenUsageApi } from '../../api/modules/tokenUsageApi'
import { threadDisplayName } from '../../utils/threadPresentation'
import { useAgentStore } from '../../stores'

const agentStore = useAgentStore()
const surfaceVisible = inject<Ref<boolean>>('infos:main-surface-visible', ref(true))
const expanded = ref(false)
const period = ref<TokenUsagePeriod>('today')
const selectedAgent = ref('')
const selectedThread = ref('')
const selectedModel = ref('')
const filterOptions = ref<TokenUsageFilterOptions>({ threads: [], models: [] })
let filterRequest = 0
const threadBinding = computed({
  get: () => selectedThread.value,
  set: (value: string | number) => {
    selectedThread.value = String(value)
  },
})
const modelBinding = computed({
  get: () => selectedModel.value,
  set: (value: string | number) => {
    selectedModel.value = String(value)
  },
})
const threadOptions = computed(() => [
  {
    value: '',
    get label() {
      return __t('ui.usage', '全部会话')
    },
  },
  ...filterOptions.value.threads.map((thread) => ({
    value: thread.id,
    label: `${threadDisplayName(thread)} · ${thread.id}`,
  })),
])
const modelOptions = computed(() => [
  {
    value: '',
    get label() {
      return __t('ui.usage', '全部模型')
    },
  },
  ...filterOptions.value.models.map((model) => ({
    value: JSON.stringify([model.provider, model.modelId]),
    label: `${model.modelId} · ${model.provider}`,
  })),
])
const distribution = ref<'models' | 'purposes' | 'channels'>('models')
const today = ref<TokenUsageStatistics | null>(null)
const history = ref<TokenUsageStatistics | null>(null)
const loading = ref(false)
const error = ref('')
const timeZone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
let request: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
let localDay = ''
const periods: Array<{ value: TokenUsagePeriod; label: string }> = [
  {
    value: 'today',
    get label() {
      return __t('ui.usage', '今天')
    },
  },
  {
    value: '7d',
    get label() {
      return __t('ui.usage', '近 7 天')
    },
  },
  {
    value: '30d',
    get label() {
      return __t('ui.usage', '近 30 天')
    },
  },
]
const purposes: Record<TokenUsagePurpose, string> = {
  conversation: '日常对话',
  companion: '主动陪伴',
  task: '后台任务',
  memory: '记忆处理',
  knowledge: '知识库整理',
  vision: '图片转述',
  system: '系统调用',
}
const channels: Record<string, string> = {
  desktop: '主对话',
  group: '据点',
  social: '社交',
  unknown: '未标记通道',
}
const agentOptions = computed(() => [
  {
    value: '',
    get label() {
      return __t('ui.usage', '全部角色')
    },
  },
  ...agentStore.agents.map((agent) => ({ value: agent.id, label: agent.name })),
])
const agentBinding = computed({
  get: () => selectedAgent.value,
  set: (value: string | number) => {
    selectedAgent.value = String(value)
  },
})
const selectedAgentLabel = computed(
  () =>
    agentOptions.value.find((agent) => agent.value === selectedAgent.value)?.label ||
    selectedAgent.value,
)
const summaryCalls = computed(() =>
  today.value
    ? __t('ui.usage', '{0}{1}{2} 次调用', [
        selectedAgent.value ? `${selectedAgentLabel.value} · ` : '',
        selectedThread.value || selectedModel.value ? __t('ui.usage', '已筛选 · ') : '',
        today.value.totals.requests,
      ])
    : __t('ui.usage', '正在读取…'),
)
const detail = computed(() => (period.value === 'today' ? today.value : history.value))
const rows = computed(() => detail.value?.[distribution.value] ?? [])
const maxBucket = computed(() =>
  Math.max(1, ...(detail.value?.buckets.map((bucket) => bucket.totalTokens) ?? [])),
)
function cacheRate(totals?: TokenUsageTotals): number | null {
  if (!totals?.cacheReportedRequests) return null
  const input = totals.cacheHitTokens + totals.cacheMissTokens
  return input > 0 ? (totals.cacheHitTokens / input) * 100 : null
}
function cacheLabel(totals?: TokenUsageTotals): string {
  const rate = cacheRate(totals)
  if (rate !== null) return `${rate.toFixed(2)}%`
  return totals?.requests && !totals.cacheReportedRequests ? __t('ui.usage', '未上报') : '—'
}
function cacheTitle(totals?: TokenUsageTotals): string {
  if (!totals) return __t('ui.usage', '正在读取缓存统计')
  return (
    __t('ui.usage', '输入 Token 命中率；已上报 {0}/{1} 次。', [
      totals.cacheReportedRequests,
      totals.requests,
    ]) + __t('ui.usage', '缓存写入不计入命中。')
  )
}
function format(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 2,
  }).format(value)
}
function compact(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toLocaleString('en', { maximumFractionDigits: 2 })}M`
  if (value >= 1000) return `${(value / 1000).toLocaleString('en', { maximumFractionDigits: 1 })}K`
  return String(value)
}
function known(totals?: TokenUsageTotals, kind: 'input' | 'output' | 'total' = 'total'): boolean {
  return (
    !!totals &&
    (totals.requests === 0 ||
      (kind === 'input'
        ? totals.inputReportedRequests
        : kind === 'output'
          ? totals.outputReportedRequests
          : totals.reportedRequests) > 0)
  )
}
const summaryNumber = computed(() =>
  today.value
    ? known(today.value.totals)
      ? compact(today.value.totals.totalTokens)
      : '—'
    : loading.value
      ? '…'
      : '—',
)
function share(value: number, total: number): string {
  return `${total > 0 ? Math.min(100, (value / total) * 100) : 0}%`
}
function bucketTitle(bucket: TokenUsageTotals & { label: string }): string {
  return __t('ui.usage', '{0} · 输入 {1} · 输出 {2} · 总计 {3} · {4} 次调用{5} · 缓存命中 {6}', [
    bucket.label,
    bucket.inputTokens.toLocaleString(),
    bucket.outputTokens.toLocaleString(),
    bucket.totalTokens.toLocaleString(),
    bucket.requests,
    bucket.unreportedRequests ? ` · ${bucket.unreportedRequests} 次未上报` : '',
    cacheLabel(bucket),
  ])
}
function labelAt(index: number, count: number): boolean {
  return index === 0 || index === count - 1 || index % (count > 24 ? 5 : count > 7 ? 4 : 1) === 0
}
function recordedLabel(value: string): string {
  return new Date(value).toLocaleString(getDisplayLocale(), {
    timeZone: timeZone.value,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
async function refresh(): Promise<void> {
  if (!surfaceVisible.value || document.hidden) return
  const currentZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const currentDay = new Date().toLocaleDateString('en-CA', { timeZone: currentZone })
  if (timeZone.value !== currentZone || localDay !== currentDay) {
    timeZone.value = currentZone
    localDay = currentDay
    today.value = null
    history.value = null
  }
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  const agent = selectedAgent.value || undefined
  const requestedPeriod = period.value
  const needsHistory = expanded.value && requestedPeriod !== 'today'
  const [provider, modelId] = selectedModel.value
    ? (JSON.parse(selectedModel.value) as [string, string])
    : []
  const filters = { threadId: selectedThread.value || undefined, provider, modelId }
  const results = await Promise.allSettled([
    tokenUsageApi.statistics('today', timeZone.value, agent, controller.signal, filters),
    ...(needsHistory
      ? [
          tokenUsageApi.statistics(
            requestedPeriod,
            timeZone.value,
            agent,
            controller.signal,
            filters,
          ),
        ]
      : []),
  ])
  if (controller.signal.aborted) return
  const summary = results[0]!
  if (summary.status === 'fulfilled' && summary.value.data) today.value = summary.value.data
  else error.value = '用量暂时无法获取'
  const range = results[1]
  if (range?.status === 'fulfilled' && range.value.data) history.value = range.value.data
  else if (needsHistory) error.value = '统计暂时无法获取'
  loading.value = false
}
async function loadFilters(): Promise<void> {
  const sequence = ++filterRequest
  try {
    const response = await tokenUsageApi.filters(selectedAgent.value || undefined)
    if (sequence === filterRequest && response.data) filterOptions.value = response.data
  } catch {
    if (sequence === filterRequest) error.value = '筛选选项暂时无法获取'
  }
}
watch(selectedAgent, () => {
  selectedThread.value = ''
  selectedModel.value = ''
  filterOptions.value = { threads: [], models: [] }
  void loadFilters()
})
function refreshAll(): void {
  void loadFilters()
  void refresh()
}
watch([selectedAgent, selectedThread, selectedModel], () => {
  today.value = null
  history.value = null
  void refresh()
})
watch(period, () => {
  history.value = null
  void refresh()
})
watch(expanded, (value) => {
  if (value) void loadFilters()
  void refresh()
})
watch(surfaceVisible, (value) => {
  if (value) void refresh()
  else {
    request?.abort()
    loading.value = false
  }
})
function visibilityChanged(): void {
  if (!document.hidden) void refresh()
  else {
    request?.abort()
    loading.value = false
  }
}
onMounted(() => {
  void loadFilters()
  void refresh()
  timer = setInterval(() => {
    if (!loading.value) void refresh()
  }, 30_000)
  document.addEventListener('visibilitychange', visibilityChanged)
})
onUnmounted(() => {
  filterRequest++
  request?.abort()
  if (timer) clearInterval(timer)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <PCard
    pixel
    padding="md"
    class="token-usage-card"
    :aria-label="__t('ui.usage', '今日 Token 用量')"
    :aria-busy="loading"
  >
    <button
      class="usage-summary"
      type="button"
      :aria-expanded="expanded"
      aria-controls="overview-token-statistics"
      @click="expanded = !expanded"
    >
      <span class="usage-caption">
        <PixelIcon name="cpu" size="sm" />
        {{ __t('ui.usage', '今日 Token') }}
        <PixelIcon
          class="usage-chevron"
          :name="expanded ? 'chevron-up' : 'chevron-down'"
          size="xs"
        />
      </span>
      <span class="usage-main-number">
        {{ summaryNumber }}
        <small>Tokens</small>
      </span>
      <span class="usage-split">
        <span class="usage-input">
          {{ __t('ui.usage', '输入') }}
          <b>
            {{ today && known(today.totals, 'input') ? compact(today.totals.inputTokens) : '—' }}
          </b>
        </span>
        <span class="usage-output">
          {{ __t('ui.usage', '输出') }}
          <b>
            {{ today && known(today.totals, 'output') ? compact(today.totals.outputTokens) : '—' }}
          </b>
        </span>
      </span>
      <span
        class="usage-cache-summary"
        :class="{ 'is-reported': cacheRate(today?.totals) !== null }"
        :title="cacheTitle(today?.totals)"
      >
        <span>{{ __t('ui.usage', '缓存命中') }}</span>
        <b>{{ cacheLabel(today?.totals) }}</b>
      </span>
      <span class="usage-meter" aria-hidden="true">
        <i
          class="is-input"
          :style="{ width: share(today?.totals.inputTokens ?? 0, today?.totals.totalTokens ?? 0) }"
        />
        <i
          class="is-output"
          :style="{ width: share(today?.totals.outputTokens ?? 0, today?.totals.totalTokens ?? 0) }"
        />
      </span>
      <span class="usage-summary-footer">
        <span>{{ error || summaryCalls }}</span>
        <span v-if="today?.totals.unreportedRequests">
          {{ today.totals.unreportedRequests }} {{ __t('ui.usage', '次未上报') }}
        </span>
        <span v-else-if="today?.totals.incompleteRequests">{{ __t('ui.usage', '部分上报') }}</span>
        <span v-else>
          {{ expanded ? __t('ui.usage', '收起统计') : __t('ui.usage', '查看统计') }}
        </span>
      </span>
    </button>
  </PCard>
  <Transition name="usage-expand">
    <PCard
      v-if="expanded"
      id="overview-token-statistics"
      pixel
      padding="md"
      class="token-usage-details"
      :aria-label="__t('ui.usage', 'Token 用量统计')"
      :aria-busy="loading"
    >
      <header class="usage-detail-header">
        <h3>
          <PixelIcon name="chart" size="sm" />
          {{ __t('ui.usage', '用量统计') }}
        </h3>
        <div class="usage-range" role="group" :aria-label="__t('ui.usage', '统计时间范围')">
          <button
            v-for="item in periods"
            :key="item.value"
            type="button"
            :aria-pressed="period === item.value"
            @click="period = item.value"
          >
            {{ item.label }}
          </button>
        </div>
        <PSelect
          v-model="agentBinding"
          :options="agentOptions"
          size="sm"
          teleport
          class="usage-agent-filter"
          :aria-label="__t('ui.usage', '筛选角色')"
        />
        <PSelect
          v-model="threadBinding"
          :options="threadOptions"
          size="sm"
          teleport
          class="usage-scope-filter"
          :aria-label="__t('ui.usage', '筛选会话')"
        />
        <PSelect
          v-model="modelBinding"
          :options="modelOptions"
          size="sm"
          teleport
          class="usage-scope-filter"
          :aria-label="__t('ui.usage', '筛选模型')"
          :title="__t('ui.usage', '按服务商和模型 ID 统计')"
        />
        <button
          class="usage-icon-button"
          type="button"
          :disabled="loading"
          :aria-label="__t('ui.usage', '刷新用量')"
          @click="refreshAll"
        >
          <PixelIcon name="refresh" size="sm" :animation="loading ? 'spin' : ''" />
        </button>
        <button
          class="usage-icon-button"
          type="button"
          :aria-label="__t('ui.usage', '收起统计')"
          @click="expanded = false"
        >
          <PixelIcon name="close" size="sm" />
        </button>
      </header>
      <p v-if="error" class="usage-notice" role="status">
        {{ error }}
        <button type="button" @click="refreshAll">{{ __t('ui.usage', '重试') }}</button>
      </p>
      <template v-if="detail">
        <div class="usage-detail-metrics">
          <div>
            <span>{{ __t('ui.usage', '总 Token') }}</span>
            <strong>{{ known(detail.totals) ? format(detail.totals.totalTokens) : '—' }}</strong>
          </div>
          <div class="usage-input">
            <span>{{ __t('ui.usage', '输入') }}</span>
            <strong>
              {{ known(detail.totals, 'input') ? format(detail.totals.inputTokens) : '—' }}
            </strong>
          </div>
          <div class="usage-output">
            <span>{{ __t('ui.usage', '输出') }}</span>
            <strong>
              {{ known(detail.totals, 'output') ? format(detail.totals.outputTokens) : '—' }}
            </strong>
          </div>
          <div>
            <span>
              {{ __t('ui.usage', '调用')
              }}{{
                detail.totals.failedRequests
                  ? __t('ui.usage', ' · {0} 次未完成', [detail.totals.failedRequests])
                  : ''
              }}
            </span>
            <strong>
              {{ detail.totals.requests }}
              <small>{{ __t('ui.usage', '次') }}</small>
            </strong>
          </div>
        </div>
        <section class="usage-cache" :aria-label="__t('ui.usage', '缓存命中统计')">
          <div class="usage-chart-heading">
            <span>{{ __t('ui.usage', '缓存') }}</span>
            <span :title="cacheTitle(detail.totals)">
              {{ detail.totals.cacheReportedRequests }} / {{ detail.totals.requests }}
              {{ __t('ui.usage', '次已上报') }}
            </span>
          </div>
          <div class="usage-detail-metrics usage-cache-metrics">
            <div :class="{ 'usage-cache-accent': cacheRate(detail.totals) !== null }">
              <span>{{ __t('ui.usage', '命中率') }}</span>
              <strong :title="cacheTitle(detail.totals)">{{ cacheLabel(detail.totals) }}</strong>
            </div>
            <div>
              <span>{{ __t('ui.usage', '命中 Token') }}</span>
              <strong
                :title="
                  detail.totals.cacheReportedRequests
                    ? `${detail.totals.cacheHitTokens.toLocaleString()} Token`
                    : __t('ui.usage', '未上报缓存统计')
                "
              >
                {{
                  detail.totals.cacheReportedRequests ? format(detail.totals.cacheHitTokens) : '—'
                }}
              </strong>
            </div>
            <div>
              <span>{{ __t('ui.usage', '未命中 Token') }}</span>
              <strong
                :title="
                  detail.totals.cacheReportedRequests
                    ? `${detail.totals.cacheMissTokens.toLocaleString()} Token`
                    : __t('ui.usage', '未上报缓存统计')
                "
              >
                {{
                  detail.totals.cacheReportedRequests ? format(detail.totals.cacheMissTokens) : '—'
                }}
              </strong>
            </div>
            <div>
              <span>{{ __t('ui.usage', '命中调用') }}</span>
              <strong :title="cacheTitle(detail.totals)">
                {{ detail.totals.cacheReportedRequests ? detail.totals.cacheHitRequests : '—' }}
                <small>
                  / {{ detail.totals.cacheReportedRequests }} {{ __t('ui.usage', '次') }}
                </small>
              </strong>
            </div>
          </div>
          <div
            v-if="cacheRate(detail.totals) !== null"
            class="usage-cache-meter"
            role="meter"
            :aria-label="__t('ui.usage', '输入缓存命中率')"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="cacheRate(detail.totals) ?? 0"
            :aria-valuetext="cacheLabel(detail.totals)"
          >
            <i :style="{ width: `${cacheRate(detail.totals)}%` }" />
          </div>
          <p v-if="detail.totals.cachedWriteTokens" class="usage-cache-write">
            {{ __t('ui.usage', '缓存写入') }} {{ compact(detail.totals.cachedWriteTokens) }} Token
          </p>
        </section>
        <div class="usage-chart-heading">
          <span>{{ __t('ui.usage', '用量走势') }}</span>
          <span class="usage-chart-legend">
            <i class="is-input" />
            {{ __t('ui.usage', '输入') }}
            <i class="is-output" />
            {{ __t('ui.usage', '输出') }}
            <template
              v-if="
                detail.totals.totalTokens > detail.totals.inputTokens + detail.totals.outputTokens
              "
            >
              <i class="is-other" />
              {{ __t('ui.usage', '未细分') }}
            </template>
          </span>
        </div>
        <div class="usage-chart" role="list" :aria-label="__t('ui.usage', '按时间统计 Token 用量')">
          <div
            v-for="(bucket, index) in detail.buckets"
            :key="bucket.key"
            class="usage-chart-column"
            role="listitem"
          >
            <button
              type="button"
              class="usage-chart-bar"
              :title="bucketTitle(bucket)"
              :aria-label="bucketTitle(bucket)"
            >
              <span
                v-if="bucket.totalTokens > 0"
                class="usage-bar-stack"
                :style="{ height: share(bucket.totalTokens, maxBucket) }"
              >
                <i
                  v-if="bucket.totalTokens > bucket.inputTokens + bucket.outputTokens"
                  class="is-other"
                  :style="{
                    flexGrow: bucket.totalTokens - bucket.inputTokens - bucket.outputTokens,
                  }"
                />
                <i class="is-output" :style="{ flexGrow: bucket.outputTokens }" />
                <i class="is-input" :style="{ flexGrow: bucket.inputTokens }" />
              </span>
              <span v-else class="usage-bar-empty" />
            </button>
            <span class="usage-chart-label">
              {{ labelAt(index, detail.buckets.length) ? bucket.label : '' }}
            </span>
          </div>
        </div>
        <p v-if="!detail.totals.requests" class="usage-empty">
          {{ __t('ui.usage', '这段时间暂无用量记录') }}
        </p>
        <p
          v-else-if="detail.totals.unreportedRequests || detail.totals.incompleteRequests"
          class="usage-notice"
          role="status"
        >
          {{
            detail.totals.unreportedRequests
              ? __t('ui.usage', '{0} 次调用未上报用量', [detail.totals.unreportedRequests])
              : ''
          }}{{ detail.totals.unreportedRequests && detail.totals.incompleteRequests ? ' · ' : ''
          }}{{
            detail.totals.incompleteRequests
              ? __t('ui.usage', '{0} 次仅部分上报', [detail.totals.incompleteRequests])
              : ''
          }}{{ __t('ui.usage', '，统计可能不完整') }}
        </p>
        <div class="usage-distribution-heading">
          <div class="usage-range" role="group" :aria-label="__t('ui.usage', '用量分布')">
            <button
              type="button"
              :aria-pressed="distribution === 'models'"
              @click="distribution = 'models'"
            >
              {{ __t('ui.usage', '按模型') }}
            </button>
            <button
              type="button"
              :aria-pressed="distribution === 'purposes'"
              @click="distribution = 'purposes'"
            >
              {{ __t('ui.usage', '按用途') }}
            </button>
            <button
              type="button"
              :aria-pressed="distribution === 'channels'"
              @click="distribution = 'channels'"
            >
              {{ __t('ui.usage', '按通道') }}
            </button>
          </div>
        </div>
        <ul class="usage-distribution">
          <li v-for="row in rows" :key="row.key">
            <BrandIcon
              v-if="distribution === 'models'"
              :brand="resolveModelBrand(row.modelId)"
              framed
              size="sm"
            />
            <PixelIcon
              v-else
              :name="row.key === 'memory' ? 'brain' : row.key === 'knowledge' ? 'book' : 'cpu'"
              size="sm"
            />
            <div class="usage-row-body">
              <div class="usage-row-title">
                <strong>
                  {{
                    distribution === 'models'
                      ? row.modelId
                      : distribution === 'channels'
                        ? channels[row.key] || row.key
                        : purposes[row.key as TokenUsagePurpose] || __t('ui.usage', '系统调用')
                  }}
                </strong>
                <b>{{ known(row) ? compact(row.totalTokens) : '—' }}</b>
              </div>
              <div class="usage-row-meta">
                <span>
                  {{ distribution === 'models' ? row.provider : ''
                  }}{{ distribution === 'models' ? ' · ' : '' }}{{ row.requests }}
                  {{ __t('ui.usage', '次调用')
                  }}{{
                    row.unreportedRequests
                      ? __t('ui.usage', ' · {0} 次未上报', [row.unreportedRequests])
                      : ''
                  }}
                </span>
                <span>
                  {{
                    detail.totals.totalTokens
                      ? `${((row.totalTokens / detail.totals.totalTokens) * 100).toFixed(1)}%`
                      : '—'
                  }}
                </span>
              </div>
              <div
                class="usage-row-cache"
                :class="{ 'is-reported': cacheRate(row) !== null }"
                :title="cacheTitle(row)"
              >
                <span>{{ __t('ui.usage', '缓存命中') }} {{ cacheLabel(row) }}</span>
                <span v-if="row.cacheReportedRequests">
                  {{ compact(row.cacheHitTokens) }} Token · {{ row.cacheHitRequests }} /
                  {{ row.cacheReportedRequests }} {{ __t('ui.usage', '次') }}
                </span>
              </div>
              <span class="usage-row-meter" aria-hidden="true">
                <i :style="{ width: share(row.totalTokens, detail.totals.totalTokens) }" />
              </span>
            </div>
          </li>
        </ul>
        <footer class="usage-detail-footer">
          <span>{{ timeZone }} {{ __t('ui.usage', '· 每 30 秒更新') }}</span>
          <span v-if="detail.firstRecordedAt">
            {{ __t('ui.usage', '自') }} {{ recordedLabel(detail.firstRecordedAt) }}
            {{ __t('ui.usage', '起记录') }}
          </span>
          <span v-else>{{ __t('ui.usage', '从启用统计后开始记录') }}</span>
        </footer>
      </template>
      <p v-else-if="!error" class="usage-empty">{{ __t('ui.usage', '正在读取统计…') }}</p>
    </PCard>
  </Transition>
</template>

<style scoped src="./token-usage.css"></style>
