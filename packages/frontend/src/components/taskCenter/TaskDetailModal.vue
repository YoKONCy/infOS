<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { MarkdownSurfaceProps } from '@infos/shared'
import { t as __t } from '../../i18n'
import type { CompositorSurface } from '../../stores'
import { useCompositorStore } from '../../stores'
import { PButton } from '../pixel'
import PDrawer from '../pixel/PDrawer.vue'
import PixelIcon from '../pixel/PixelIcon.vue'
import TaskStatusBadge from './TaskStatusBadge.vue'
import TaskLifecyclePanel from './TaskLifecyclePanel.vue'
import DesktopControlStatus from '../desktop/DesktopControlStatus.vue'
import BrowserObserver from '../chat/BrowserObserver.vue'
import ConversationSurface from '../compositor/ConversationSurface.vue'
import { backgroundTasksApi, type BackgroundTaskInfo } from '../../api/modules/backgroundTasksApi'
import { taskElapsed, taskOriginLabel, taskTime } from './taskPresentation'

const props = defineProps<{
  task: BackgroundTaskInfo | null
  avatarUrl?: string | null
  agentName?: string | null
  refreshError?: string
}>()
const emit = defineEmits<{ close: []; updated: []; openTask: [id: string] }>()
const compositor = useCompositorStore()
const view = ref<'overview' | 'activity' | 'runtime'>('overview')
const projectionError = ref('')
const projectionLoading = ref(false)
const projectionRetry = ref(0)
const related = ref<BackgroundTaskInfo[]>([])
const relatedError = ref(false)
const now = ref(Date.now())
const clock = setInterval(() => {
  now.value = Date.now()
}, 1000)
const progress = computed(() => Math.min(100, Math.max(0, props.task?.progress ?? 0)))
const surfaces = computed(() =>
  [...compositor.surfaces.values()].filter(
    (surface) => surface.scopeId === `background-task:${props.task?.id}`,
  ),
)
function selectSurfaces(
  predicate: (node: CompositorSurface['nodes'][number], surface: CompositorSurface) => boolean,
): CompositorSurface[] {
  return surfaces.value
    .map((surface) => ({
      ...surface,
      nodes: surface.nodes.filter((node) => predicate(node, surface)),
    }))
    .filter((surface) => surface.nodes.length > 0)
}
const interactionSurfaces = computed(() =>
  selectSurfaces((node) => ['input', 'approval'].includes(node.kind)),
)
const resultSurfaces = computed(() =>
  selectSurfaces((node) => node.nodeId === `background-task:${props.task?.id}:result`).map(
    (surface) => ({
      ...surface,
      nodes: surface.nodes.map((node) => ({
        ...node,
        props: {
          ...node.props,
          source: props.task?.result ?? (node.props as MarkdownSurfaceProps).source,
        },
      })),
    }),
  ),
)
const contentSurfaces = computed(() =>
  selectSurfaces((node, surface) => {
    if (surface.surfaceId !== `background-task:${props.task?.id}`) return false
    return (
      !['input', 'approval'].includes(node.kind) &&
      !['summary', 'status', 'progress', 'result', 'error'].some(
        (suffix) => node.nodeId === `${surface.surfaceId}:${suffix}`,
      )
    )
  }),
)
const activitySurfaces = computed(() =>
  selectSurfaces(
    (node, surface) =>
      surface.surfaceId !== `background-task:${props.task?.id}` &&
      !['input', 'approval'].includes(node.kind),
  ),
)
const needsAttention = computed(
  () => props.task && ['waiting_input', 'blocked', 'paused', 'failed'].includes(props.task.status),
)
const usage = computed(() => props.task?.execution?.usage ?? props.task?.lifecycle?.usage)
const tokens = computed(() => props.task?.execution?.usage)
function moveTab(event: KeyboardEvent): void {
  const tabs = ['overview', 'activity', 'runtime'] as const
  const index = tabs.indexOf(view.value)
  const next =
    event.key === 'ArrowRight'
      ? (index + 1) % 3
      : event.key === 'ArrowLeft'
        ? (index + 2) % 3
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? 2
            : -1
  if (next < 0) return
  event.preventDefault()
  view.value = tabs[next]!
  document.getElementById(`task-${view.value}-tab`)?.focus()
}
const sourceThread = computed(() => {
  const source = props.task?.metadata?.originThreadId
  return typeof source === 'string' ? source : props.task?.targetThreadId
})
const waitLabel = computed(() => {
  const labels: Record<string, string> = {
    scheduler_capacity: __t('ui.taskCenter', '等待系统执行容量'),
    class_capacity: __t('ui.taskCenter', '等待同类任务容量'),
    resource_locked: __t('ui.taskCenter', '等待Agent资源释放'),
    backpressure: __t('ui.taskCenter', '系统负载保护'),
    io: __t('ui.taskCenter', '等待I/O'),
    approval: __t('ui.taskCenter', '等待批准'),
    paused: __t('ui.taskCenter', '已暂停'),
  }
  const reason = props.task?.execution?.waitReason
  return reason ? (labels[reason] ?? reason) : ''
})

watch(
  () => props.task?.id,
  () => {
    view.value = 'overview'
    related.value = []
  },
)
watch(
  () => [props.task?.id, props.task?.updatedAt, projectionRetry.value] as const,
  async ([taskId], previous, onCleanup) => {
    let active = true
    onCleanup(() => {
      active = false
    })
    if (previous?.[0] && previous[0] !== taskId)
      compositor.disposeScope(`background-task:${previous[0]}`)
    if (!taskId) return
    projectionError.value = ''
    projectionLoading.value = true
    try {
      const response = await backgroundTasksApi.projection(taskId)
      if (active && response.data)
        compositor.replaceScope(`background-task:${taskId}`, response.data.surfaces)
    } catch (error) {
      if (active)
        projectionError.value =
          error instanceof Error ? error.message : __t('ui.taskCenter', '任务内容暂时无法读取')
    } finally {
      if (active) projectionLoading.value = false
    }
  },
  { immediate: true },
)
watch(
  () => [props.task?.id, props.task?.updatedAt, projectionRetry.value] as const,
  async ([id], _previous, onCleanup) => {
    let active = true
    onCleanup(() => {
      active = false
    })
    if (!id || props.task?.category === 'resident') return
    relatedError.value = false
    try {
      const response = await backgroundTasksApi.list({ parentTaskId: id, pageSize: 100 })
      if (active) related.value = response.data?.items ?? []
    } catch {
      if (active) relatedError.value = true
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  clearInterval(clock)
  if (props.task) compositor.disposeScope(`background-task:${props.task.id}`)
})
</script>

<template>
  <PDrawer v-if="task" :title="__t('ui.taskCenter', '任务详情')" @close="emit('close')">
    <BrowserObserver
      :agent-id="task.agentId"
      :thread-id="task.threadId"
      :agent-name="agentName || task.agentId"
      embedded
    />
    <div class="task-detail">
      <header class="detail-hero">
        <div class="detail-eyebrow">
          <span>{{ taskOriginLabel(task) }}</span>
          <TaskStatusBadge :status="task.status" />
        </div>
        <h2>{{ task.title }}</h2>
        <div class="detail-owner">
          <img v-if="avatarUrl" :src="avatarUrl" alt="" />
          <PixelIcon v-else name="bot" size="sm" />
          <strong>{{ agentName ?? task.agentId }}</strong>
          <span>{{ __t('ui.taskCenter', '创建于 {0}', [taskTime(task.createdAt)]) }}</span>
        </div>
        <div
          v-if="task.currentStage || waitLabel || task.progress != null"
          class="detail-stage"
          :class="{ 'needs-attention': needsAttention }"
        >
          <span class="detail-stage__dot" aria-hidden="true" />
          <span>{{ waitLabel || task.currentStage }}</span>
          <b v-if="task.progress != null">{{ progress }}%</b>
        </div>
        <div
          v-if="task.progress != null"
          class="detail-progress"
          role="progressbar"
          :aria-label="__t('ui.taskCenter', '任务进度')"
          :aria-valuenow="progress"
          :aria-valuemin="0"
          :aria-valuemax="100"
        >
          <i :style="{ width: `${progress}%` }" />
        </div>
        <div class="detail-metrics">
          <div>
            <span>{{ __t('ui.taskCenter', '累计耗时') }}</span>
            <strong>{{ taskElapsed(task, now) }}</strong>
          </div>
          <div>
            <span>{{ __t('ui.taskCenter', '工具调用') }}</span>
            <strong>{{ task.toolCallCount }}</strong>
          </div>
          <div>
            <span>{{ __t('ui.taskCenter', '模型调用') }}</span>
            <strong>{{ usage?.llmCalls ?? '—' }}</strong>
          </div>
        </div>
      </header>
      <div class="detail-tabs" role="tablist" :aria-label="__t('ui.taskCenter', '任务详情')">
        <button
          v-for="tab in ['overview', 'activity', 'runtime'] as const"
          :id="`task-${tab}-tab`"
          :key="tab"
          type="button"
          role="tab"
          :tabindex="view === tab ? 0 : -1"
          :aria-selected="view === tab"
          :aria-controls="`task-${tab}-panel`"
          @keydown="moveTab"
          @click="view = tab"
        >
          {{
            tab === 'overview'
              ? __t('ui.taskCenter', '概览')
              : tab === 'activity'
                ? __t('ui.taskCenter', '执行记录')
                : __t('ui.taskCenter', '运行信息')
          }}
          <span v-if="tab === 'activity' && activitySurfaces.length" class="tab-count">
            {{ activitySurfaces.length }}
          </span>
        </button>
      </div>
      <div class="detail-content">
        <div v-if="refreshError" class="detail-alert" role="alert">
          <span>{{ refreshError }}</span>
          <PButton variant="ghost" size="sm" @click="emit('updated')">
            {{ __t('ui.taskCenter', '重试') }}
          </PButton>
        </div>
        <DesktopControlStatus :task-id="task.id" />
        <div v-if="projectionError" class="detail-alert" role="alert">
          <span>{{ projectionError }}</span>
          <PButton variant="ghost" size="sm" @click="projectionRetry++">
            {{ __t('ui.taskCenter', '重试') }}
          </PButton>
        </div>
        <p v-if="projectionLoading && !surfaces.length" class="detail-muted" role="status">
          {{ __t('ui.taskCenter', '正在读取任务内容…') }}
        </p>
        <!-- 待答与批准保持可见，切换详情页签也不隐藏待处理事项。 -->
        <section v-if="interactionSurfaces.length" class="detail-interactions">
          <h3>
            <PixelIcon name="bell" size="xs" />
            {{ __t('ui.taskCenter', '需要你处理') }}
          </h3>
          <ConversationSurface
            v-for="surface in interactionSurfaces"
            :key="surface.surfaceId"
            :surface="surface"
          />
        </section>
        <div
          v-show="view === 'overview'"
          id="task-overview-panel"
          role="tabpanel"
          aria-labelledby="task-overview-tab"
          class="detail-panel"
        >
          <section
            v-if="task.result || resultSurfaces.length"
            class="detail-section detail-result"
            :class="{ 'is-final': task.status === 'completed' }"
          >
            <h3>
              <PixelIcon name="check" size="xs" />
              {{ __t('ui.taskCenter', '任务结果') }}
            </h3>
            <ConversationSurface
              v-for="surface in resultSurfaces"
              :key="surface.surfaceId"
              :surface="surface"
            />
            <p v-if="!resultSurfaces.length" class="detail-prose">{{ task.result }}</p>
          </section>
          <section v-if="task.errorMessage" class="detail-alert detail-error">
            <PixelIcon name="alert" size="sm" />
            <p>{{ task.errorMessage }}</p>
          </section>
          <section class="detail-section">
            <h3>
              <PixelIcon name="book" size="xs" />
              {{ __t('ui.taskCenter', '任务目标') }}
            </h3>
            <p class="detail-prose">{{ task.instruction }}</p>
            <p v-if="typeof task.metadata?.reason === 'string'" class="detail-muted">
              {{ task.metadata.reason }}
            </p>
          </section>
          <section
            v-if="task.parentTaskId || related.length || relatedError"
            class="detail-section"
          >
            <h3>
              <PixelIcon name="network" size="xs" />
              {{ __t('ui.taskCenter', '关联任务') }}
            </h3>
            <button
              v-if="task.parentTaskId"
              class="detail-related"
              type="button"
              @click="emit('openTask', task.parentTaskId)"
            >
              <span>{{ __t('ui.taskCenter', '查看父任务') }}</span>
              <span aria-hidden="true">↗</span>
            </button>
            <button
              v-for="child in related"
              :key="child.id"
              class="detail-related"
              type="button"
              @click="emit('openTask', child.id)"
            >
              <span>{{ child.title }}</span>
              <TaskStatusBadge :status="child.status" />
              <span aria-hidden="true">↗</span>
            </button>
            <p v-if="relatedError" class="detail-muted">
              {{ __t('ui.taskCenter', '关联任务暂时无法读取') }}
              <button class="detail-text-button" @click="projectionRetry++">
                {{ __t('ui.taskCenter', '重试') }}
              </button>
            </p>
          </section>
          <ConversationSurface
            v-for="surface in contentSurfaces"
            :key="surface.surfaceId"
            :surface="surface"
          />
          <section class="detail-section">
            <h3>
              <PixelIcon name="list" size="xs" />
              {{ __t('ui.taskCenter', '计划与交付') }}
            </h3>
            <p v-if="task.category === 'resident'" class="detail-muted">
              {{ __t('ui.taskCenter', '系统常驻状态随服务自动维护，无需手动恢复或派发。') }}
            </p>
            <TaskLifecyclePanel v-else :task="task" @updated="emit('updated')" />
          </section>
        </div>
        <div
          v-show="view === 'activity'"
          id="task-activity-panel"
          role="tabpanel"
          aria-labelledby="task-activity-tab"
          class="detail-panel"
        >
          <p class="detail-muted">
            {{ __t('ui.taskCenter', '按执行顺序查看思考、工具调用与反馈。') }}
          </p>
          <ConversationSurface
            v-for="surface in activitySurfaces"
            :key="surface.surfaceId"
            :surface="surface"
          />
          <div v-if="!activitySurfaces.length && !projectionLoading" class="detail-empty">
            <PixelIcon name="terminal" size="md" />
            <p>{{ __t('ui.taskCenter', '暂无执行记录') }}</p>
          </div>
        </div>
        <div
          v-show="view === 'runtime'"
          id="task-runtime-panel"
          role="tabpanel"
          aria-labelledby="task-runtime-tab"
          class="detail-panel"
        >
          <section class="detail-section">
            <h3>{{ __t('ui.taskCenter', '时间') }}</h3>
            <dl class="detail-facts">
              <div>
                <dt>{{ __t('ui.taskCenter', '创建') }}</dt>
                <dd>{{ taskTime(task.createdAt) }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.taskCenter', '开始') }}</dt>
                <dd>{{ taskTime(task.startedAt) }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.taskCenter', '结束') }}</dt>
                <dd>{{ taskTime(task.completedAt) }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.taskCenter', '更新') }}</dt>
                <dd>{{ taskTime(task.updatedAt) }}</dd>
              </div>
              <div v-if="task.lifecycle?.deadline">
                <dt>{{ __t('ui.taskCenter', '截止时间') }}</dt>
                <dd>{{ taskTime(task.lifecycle.deadline) }}</dd>
              </div>
            </dl>
          </section>
          <section class="detail-section">
            <h3>{{ __t('ui.taskCenter', '执行统计') }}</h3>
            <dl class="detail-facts">
              <div>
                <dt>{{ __t('ui.taskCenter', '触发来源') }}</dt>
                <dd>{{ taskOriginLabel(task) }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.taskCenter', '优先级') }}</dt>
                <dd>{{ task.priority }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.taskCenter', 'Token输入 / 输出') }}</dt>
                <dd>{{ tokens?.inputTokens ?? '—' }} / {{ tokens?.outputTokens ?? '—' }}</dd>
              </div>
              <div v-if="task.lifecycle">
                <dt>{{ __t('ui.taskCenter', '执行段数 / 上限') }}</dt>
                <dd>{{ task.lifecycle.segments }} / {{ task.lifecycle.maxSegments }}</dd>
              </div>
              <div v-if="task.lifecycle">
                <dt>{{ __t('ui.taskCenter', '模型调用 / 上限') }}</dt>
                <dd>{{ usage?.llmCalls ?? 0 }} / {{ task.lifecycle.maxLlmCalls }}</dd>
              </div>
              <div v-if="task.lifecycle">
                <dt>{{ __t('ui.taskCenter', '工具调用 / 上限') }}</dt>
                <dd>{{ task.toolCallCount }} / {{ task.lifecycle.maxToolCalls }}</dd>
              </div>
            </dl>
          </section>
          <details class="detail-section detail-technical">
            <summary>{{ __t('ui.taskCenter', '技术标识') }}</summary>
            <dl class="detail-facts">
              <div>
                <dt>Task ID</dt>
                <dd>{{ task.id }}</dd>
              </div>
              <div>
                <dt>Thread ID</dt>
                <dd>{{ task.threadId }}</dd>
              </div>
              <div v-if="sourceThread">
                <dt>{{ __t('ui.taskCenter', '来源会话') }}</dt>
                <dd>{{ sourceThread }}</dd>
              </div>
              <div v-if="task.execution">
                <dt>Execution ID</dt>
                <dd>{{ task.execution.descriptor.executionId }}</dd>
              </div>
            </dl>
          </details>
        </div>
      </div>
    </div>
  </PDrawer>
</template>

<style scoped>
.task-detail {
  color: var(--ui-text-primary);
  font-family: var(--ui-font-sans);
  font-size: 13px;
  line-height: 1.65;
}
.detail-hero {
  padding: 26px 28px 0;
}
.detail-eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
  font-family: var(--ui-font-pixel);
}
h2 {
  margin: 12px 0;
  font-size: 22px;
  line-height: 1.5;
  letter-spacing: -0.025em;
  overflow-wrap: anywhere;
}
.detail-owner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.detail-owner img {
  width: 22px;
  height: 22px;
  border-radius: var(--ui-radius-xs);
  object-fit: cover;
}
.detail-owner strong {
  color: var(--ui-text-secondary);
  font-weight: 500;
}
.detail-stage {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 20px;
  color: var(--ui-accent-sky);
  font-size: 12px;
}
.detail-stage > span:nth-child(2) {
  flex: 1;
  overflow-wrap: anywhere;
}
.detail-stage__dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  background: currentColor;
}
.needs-attention {
  color: var(--ui-warning);
}
.detail-progress {
  height: 3px;
  margin-top: 10px;
  background: var(--ui-bg-hover);
  overflow: hidden;
}
.detail-progress i {
  display: block;
  height: 100%;
  background: var(--ui-accent-sky);
  transition: width 200ms;
}
.detail-metrics {
  display: grid;
  grid-template-columns: 1.5fr 1fr 1fr;
  gap: 14px;
  margin-top: 20px;
  padding: 16px 0;
  border-top: 1px solid var(--ui-border-subtle);
}
.detail-metrics div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.detail-metrics span {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.detail-metrics strong {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  font-size: 14px;
}
.detail-tabs {
  position: sticky;
  top: 0;
  display: flex;
  padding-inline: 28px;
  gap: 24px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface);
  z-index: 2;
}
.detail-tabs button {
  cursor: pointer;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--ui-text-tertiary);
  padding: 12px 0;
  font: 12px var(--ui-font-pixel);
}
.detail-tabs button[aria-selected='true'] {
  color: var(--ui-accent-sky);
  border-bottom-color: var(--ui-accent-sky);
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 3px;
}
.tab-count {
  margin-left: 4px;
  font: 10px var(--ui-font-mono);
}
.detail-content {
  padding: 24px 28px 36px;
}
.detail-panel {
  display: grid;
  gap: 24px;
  min-width: 0;
}
.detail-section {
  display: grid;
  gap: 12px;
  min-width: 0;
}
h3 {
  display: flex;
  gap: 7px;
  align-items: center;
  margin: 0;
  color: var(--ui-text-secondary);
  font: 12px var(--ui-font-pixel);
}
.detail-prose {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
  line-height: 1.85;
}
.detail-result {
  padding: 18px;
  border: 1px solid var(--ui-border-subtle);
  border-top: 2px solid var(--ui-accent-sky);
  background: var(--ui-bg-surface-soft);
  border-radius: var(--ui-radius-xs);
}
.detail-result.is-final {
  border-top-color: var(--ui-success);
}
.detail-result :deep(.surface-node--markdown) {
  margin: 0;
}
.detail-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  margin-bottom: 16px;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  border-radius: var(--ui-radius-xs);
  overflow-wrap: anywhere;
}
.detail-alert p {
  margin: 0;
  white-space: pre-wrap;
}
.detail-alert > span {
  flex: 1;
}
.detail-error {
  margin-bottom: 0;
}
.detail-muted {
  margin: 0;
  color: var(--ui-text-tertiary);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.detail-interactions {
  display: grid;
  gap: 14px;
  padding-bottom: 24px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.detail-interactions h3 {
  color: var(--ui-warning);
}
.detail-related {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 12px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-xs);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
  font: inherit;
  cursor: pointer;
}
.detail-related > span:first-child {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.detail-related > span:last-child {
  color: var(--ui-accent-sky);
}
.detail-related:hover {
  border-color: var(--ui-accent-sky);
}
.detail-text-button {
  border: 0;
  background: transparent;
  color: var(--ui-accent-sky);
  cursor: pointer;
}
.detail-facts {
  margin: 0;
  display: grid;
  gap: 0;
}
.detail-facts > div {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(0, 1.2fr);
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.detail-facts dt {
  color: var(--ui-text-tertiary);
  font-size: 12px;
}
.detail-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.detail-technical summary {
  cursor: pointer;
  color: var(--ui-text-tertiary);
  padding-bottom: 12px;
  font-size: 12px;
}
.detail-technical dd {
  font: 11px var(--ui-font-mono);
}
.detail-empty {
  display: grid;
  justify-items: center;
  padding: 48px 20px;
  color: var(--ui-text-tertiary);
}
@media (max-width: 640px) {
  .detail-hero {
    padding: 22px 18px 0;
  }
  .detail-tabs {
    padding-inline: 18px;
    gap: 20px;
  }
  .detail-content {
    padding: 20px 18px 28px;
  }
  h2 {
    font-size: 19px;
  }
  .detail-metrics {
    gap: 8px;
  }
  .detail-metrics strong {
    font-size: 12px;
  }
}
</style>
