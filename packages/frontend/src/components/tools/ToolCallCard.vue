<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * ToolCallCard.vue — 界面组件
 *
 * 负责组织该界面的响应式状态、用户交互与领域数据展示。
 * 副作用在组件生命周期内建立并清理，避免跨页面残留监听器或异步状态。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ToolArchetypeSignature from './ToolArchetypeSignature.vue'
import ToolTechnicalDrawer from './ToolTechnicalDrawer.vue'
import {
  resolveToolDisplay,
  toolDisplayColor,
  toolDisplayColorSoft,
  toolDisplayIcon,
  toolDisplayLabel,
} from '../../composables/tools/useToolDisplay'
import type { AgentToolDisplay } from '../../api/modules/agentApi'
import { getToolStyleRenderer } from './toolRenderers'
import { resolveToolSignature } from './toolSignatures'
import { parseToolSearchResult, toolSearchSummary } from '../../lib/toolSearchResult'
import type { ToolCallView } from './toolCallView'
import { IMAGE_PREVIEW_TOOLS, imagePreviewsFromToolResult } from '@infos/shared'
import { useFileMutationPreview } from '../../composables/tools/useFileMutationPreview'
import ToolCardEdit from './renderers/ToolCardEdit.vue'
import ToolCardImage from './renderers/ToolCardImage.vue'
import { toolTaskTarget } from './toolTaskTarget'
import { requestTaskNavigation } from '../../composables/main/useTaskNavigation'

interface Props {
  tool: ToolCallView
  children?: ToolCallView[]
  nested?: boolean
  expanded?: boolean | null
  active?: boolean
  chainStart?: boolean
  chainEnd?: boolean
}
const props = withDefaults(defineProps<Props>(), {
  expanded: null,
  active: true,
  chainStart: true,
  chainEnd: true,
  children: () => [],
  nested: false,
})
const emit = defineEmits<{ 'update:expanded': [value: boolean] }>()
const taskId = computed(() => toolTaskTarget(props.tool))
async function openTask(event?: Event): Promise<void> {
  event?.preventDefault()
  event?.stopPropagation()
  if (!taskId.value) return
  requestTaskNavigation(taskId.value)
  const { useMainNav } = await import('../../composables/main/useMainNav')
  await useMainNav().setTab('tasks')
}
const imageTool = computed(
  () =>
    IMAGE_PREVIEW_TOOLS.some((name) => name === props.tool.name) &&
    (props.tool.name !== 'automation_execute' ||
      imagePreviewsFromToolResult(props.tool.name, props.tool.result).length > 0),
)
const display = ref<AgentToolDisplay>()
const detailsRef = ref<HTMLDetailsElement>()
const internalExpanded = ref(!props.nested && props.tool.result === undefined)
const drawerOpen = ref(false)
const userLocked = ref(false)
let collapseTimer: number | undefined

onMounted(syncOpen)
watch(
  () => props.tool.name,
  async (name, _previous, onCleanup) => {
    let active = true
    onCleanup(() => {
      active = false
    })
    display.value = undefined
    const metadata = await resolveToolDisplay(name)
    if (active) display.value = metadata
  },
  { immediate: true },
)
onBeforeUnmount(() => window.clearTimeout(collapseTimer))

const state = computed<'running' | 'error' | 'ok'>(() =>
  props.tool.interrupted
    ? 'error'
    : props.tool.result === undefined
      ? 'running'
      : props.tool.isError
        ? 'error'
        : 'ok',
)
const signature = computed(() =>
  resolveToolSignature(props.tool.name, display.value?.signature as never),
)
const renderer = computed(() => getToolStyleRenderer(display.value?.style))
const fileMutation = computed(() => ['write_file', 'edit_file'].includes(props.tool.name))
const filePreview = useFileMutationPreview(
  () => ({ ...props.tool, toolName: props.tool.name }),
  () => fileMutation.value && props.active,
)
const fileStatsHint = computed(() => {
  const preview = filePreview.value
  const phase = preview.committed
    ? __t('ui.tools', '已写入')
    : state.value === 'error'
      ? __t('ui.tools', '未写入的预览')
      : __t('ui.tools', '变更预览')
  return __t('ui.tools', '{0} · 新增 {1} 行，删除 {2}', [
    phase,
    preview.insertions,
    preview.baselineUnknown ? __t('ui.tools', '行数待确认') : `${preview.deletions} 行`,
  ])
})
const label = computed(() => toolDisplayLabel(props.tool.name, display.value))
const icon = computed(() => toolDisplayIcon(display.value))
const argsObj = computed<Record<string, unknown>>(() => {
  if (fileMutation.value) return filePreview.value.args
  try {
    return JSON.parse(props.tool.args) as Record<string, unknown>
  } catch {
    return {}
  }
})
const draftSummary = computed(() => {
  if (!props.tool.assembling) return ''
  const safeFields = [
    'file_path',
    'dir_path',
    'path',
    'query',
    'url',
    'command',
    'target',
    'selector',
    'room_name',
  ]
  for (const field of safeFields) {
    const match = props.tool.args.match(new RegExp(`"${field}"\\s*:\\s*"([^"\\n]{1,160})`))
    if (match?.[1]) return `${field.replaceAll('_', ' ')} · ${match[1]}`
  }
  const agentIds = props.tool.args.match(/"agent_ids"\s*:\s*\[([^\]]*)/)
  if (agentIds?.[1]) {
    const ids = [...agentIds[1].matchAll(/"([^"\n]+)"/g)].map((match) => match[1])
    if (ids.length) return __t('ui.tools', '成员 · {0}', [ids.join(' → ')])
  }
  return ''
})
const summary = computed(() => {
  if (props.children.length) {
    const names = props.children.map((tool) => toolDisplayLabel(tool.name)).join(' → ')
    const finished = props.children.filter(
      (tool) => tool.result !== undefined || tool.interrupted,
    ).length
    return __t('ui.tools', '{0} · {1}/{2} 已结束', [names, finished, props.children.length])
  }
  if (
    state.value === 'ok' &&
    ['search_files', 'glob_files', 'code_search'].includes(props.tool.name)
  ) {
    const result = parseToolSearchResult(props.tool.result)
    if (result) return toolSearchSummary(result)
  }
  if (state.value === 'running' && ['write_file', 'edit_file'].includes(props.tool.name)) {
    const path = String(argsObj.value.file_path ?? argsObj.value.path ?? '').trim()
    const action = props.tool.assembling
      ? __t('ui.tools', '正在生成修改')
      : __t('ui.tools', '正在写入')
    return path ? `${action} · ${path}` : action
  }
  for (const field of signature.value.summaryFields) {
    const value = argsObj.value[field]
    if (Array.isArray(value) && value.length) return value.join(' → ')
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  if (state.value === 'running') {
    if (draftSummary.value) return draftSummary.value
    return props.tool.assembling
      ? __t('ui.tools', '正在组装参数 · {0}字符', [props.tool.receivedChars ?? 0])
      : __t('ui.tools', '动作正在进行')
  }
  if (state.value === 'error') return __t('ui.tools', '动作未能完成')
  return __t('ui.tools', '动作已完成')
})
const durationText = computed(() => {
  const ms = props.tool.durationMs
  return ms === undefined ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
})
const accentVars = computed(() => ({
  '--ta-accent': toolDisplayColor(display.value),
  '--ta-accent-soft': toolDisplayColorSoft(display.value),
}))
const open = computed(() =>
  typeof props.expanded === 'boolean' ? props.expanded : internalExpanded.value,
)

function syncOpen(): void {
  if (detailsRef.value && detailsRef.value.open !== open.value) detailsRef.value.open = open.value
}
function setOpen(value: boolean, user = false): void {
  internalExpanded.value = value
  if (user) userLocked.value = value
  emit('update:expanded', value)
  nextTick(syncOpen)
}
function handleSummaryClick(): void {
  if (taskId.value) {
    void openTask()
    return
  }
  window.clearTimeout(collapseTimer)
  setOpen(!open.value, true)
}
function keepImageOpen(): void {
  window.clearTimeout(collapseTimer)
  setOpen(true, true)
}
function openDrawer(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
  drawerOpen.value = true
  setOpen(true, true)
}

watch(() => props.expanded, syncOpen)
watch(
  () => props.tool.result,
  (result, previous) => {
    window.clearTimeout(collapseTimer)
    if (result === undefined) {
      userLocked.value = false
      setOpen(!props.nested)
      return
    }
    if (previous === undefined && !userLocked.value && !drawerOpen.value) {
      collapseTimer = window.setTimeout(() => setOpen(false), signature.value.collapseDelayMs)
    }
  },
)
watch(drawerOpen, (value) => {
  if (!value && props.tool.result !== undefined) {
    userLocked.value = false
    collapseTimer = window.setTimeout(() => setOpen(false), 180)
  }
})
</script>

<template>
  <details
    ref="detailsRef"
    class="ta-node"
    :class="[
      `ta-${signature.archetype}`,
      `ta-${signature.variant}`,
      `ta-state-${state}`,
      { 'is-open': open, 'is-nested': nested, 'chain-start': chainStart, 'chain-end': chainEnd },
    ]"
    :open="open"
    :data-chain="signature.chain"
    :style="accentVars"
  >
    <summary
      class="ta-summary"
      :class="{ 'has-task': taskId }"
      :aria-label="taskId ? __t('ui.tools', '在任务中心查看任务') : undefined"
      @click.prevent="handleSummaryClick"
    >
      <ToolArchetypeSignature
        :signature="signature"
        :icon="icon"
        :label="label"
        :summary="summary"
        :state="state"
      />
      <span class="ta-copy">
        <strong>
          {{ label }}
          <span v-if="children.length" class="ta-nit-badge">NIT · {{ children.length }}</span>
          <span
            v-if="fileMutation && filePreview.available"
            class="ta-diff-stats"
            :class="{ 'is-preview': !filePreview.committed }"
            :title="fileStatsHint"
            :aria-label="fileStatsHint"
          >
            <span class="is-add">+{{ filePreview.insertions }}</span>
            <span class="is-remove">
              −{{ filePreview.baselineUnknown ? '?' : filePreview.deletions }}
            </span>
          </span>
        </strong>
        <small :title="summary">{{ summary }}</small>
      </span>
      <span class="ta-progress" aria-hidden="true"><i /></span>
      <span class="ta-meta">
        <button v-if="taskId" class="ta-task-link" type="button" @click="openTask">
          {{ __t('ui.tools', '查看任务') }}
          <span aria-hidden="true">↗</span>
        </button>
        <span
          class="ta-state-dot"
          :title="
            state === 'running'
              ? __t('ui.tools', '进行中')
              : state === 'error'
                ? __t('ui.tools', '未完成')
                : __t('ui.tools', '已完成')
          "
          :aria-label="
            state === 'running'
              ? __t('ui.tools', '进行中')
              : state === 'error'
                ? __t('ui.tools', '未完成')
                : __t('ui.tools', '已完成')
          "
        >
          <span class="ta-state-text">
            {{
              state === 'running'
                ? __t('ui.tools', '进行中')
                : state === 'error'
                  ? __t('ui.tools', '未完成')
                  : __t('ui.tools', '已完成')
            }}
          </span>
        </span>
        <time v-if="durationText">{{ durationText }}</time>
        <button
          class="ta-data-port"
          type="button"
          :title="__t('ui.tools', '查看技术详情')"
          @click="openDrawer"
        >
          {{ __t('ui.tools', '详情') }}
        </button>
      </span>
    </summary>
    <div class="ta-result-stage">
      <p
        v-if="tool.automaticApproval"
        class="ta-approval-note"
        :title="tool.automaticApproval.modelId"
      >
        {{ __t('ui.tools', '自动审批员 ·') }}
        {{
          tool.automaticApproval.decision === 'allow'
            ? __t('ui.tools', '通过')
            : __t('ui.tools', '拒绝')
        }}{{ tool.automaticApproval.errorCode ? __t('ui.tools', '（审批异常）') : '' }}
        <span>{{ tool.automaticApproval.reason }}</span>
      </p>
      <div
        v-if="children.length"
        class="ta-nested-tools"
        :aria-label="__t('ui.tools', 'NIT 内部工具调用')"
      >
        <ToolCallCard
          v-for="(child, index) in children"
          :key="child.callId ?? index"
          :tool="child"
          :active="open && active"
          :chain-start="index === 0"
          :chain-end="index === children.length - 1"
          nested
        />
        <pre v-if="tool.isError && tool.result" class="ta-nit-error">{{ tool.result }}</pre>
      </div>
      <template v-else-if="fileMutation">
        <ToolCardEdit
          v-if="open"
          :args="tool.args"
          :result="tool.result"
          :is-error="tool.isError"
          :assembling="tool.assembling"
          :interrupted="tool.interrupted"
          :file-baseline="tool.fileBaseline"
          :preview-truncated="tool.previewTruncated"
          :active="open && active"
          :tool-name="tool.name"
          :preview="filePreview"
        />
      </template>
      <ToolCardImage
        v-else-if="imageTool"
        :tool-name="tool.name"
        :result="tool.result"
        :is-error="tool.isError"
        :active="open && active !== false"
        @interact="keepImageOpen"
      />
      <component
        :is="renderer"
        v-else
        :args="tool.args"
        :result="tool.result"
        :is-error="tool.isError"
      />
    </div>
    <Teleport to="body">
      <ToolTechnicalDrawer
        v-if="drawerOpen"
        :name="tool.name"
        :args="tool.args"
        :result="tool.result"
        :is-error="tool.isError"
        :duration-ms="tool.durationMs"
        @close="drawerOpen = false"
      />
    </Teleport>
  </details>
</template>

<style scoped>
.ta-task-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
  border-radius: var(--ui-radius-xs);
  padding: 4px 7px;
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.ta-task-link:hover {
  background: var(--ui-bg-hover);
}
.ta-task-link:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 2px;
}
.has-task .ta-copy small {
  color: var(--ui-text-secondary);
}
.ta-approval-note {
  margin: 0 0 8px;
  padding: 6px 10px;
  border-left: 2px solid var(--ui-accent-sky);
  color: var(--ui-text-secondary);
  font-size: 11px;
  line-height: 1.5;
  background: var(--ui-bg-surface-soft);
}
.ta-approval-note span {
  margin-left: 8px;
  color: var(--ui-text-tertiary);
}
</style>

<style scoped>
.ta-node {
  --ta-face: color-mix(in srgb, var(--ui-bg-elevated) 94%, var(--ta-accent-soft));
  --ta-face-raised: color-mix(in srgb, var(--ui-bg-surface) 82%, var(--ta-accent-soft));
  --ta-edge: color-mix(in srgb, var(--ta-accent) 42%, var(--ui-border-default));
  --ta-highlight: color-mix(in srgb, var(--ui-text-inverse) 28%, transparent);
  --ta-shadow: color-mix(in srgb, var(--ta-accent) 18%, transparent);
  position: relative;
  width: fit-content;
  min-width: min(100%, 290px);
  max-width: min(100%, 48rem);
  color: var(--ui-text-primary);
}
.ta-node[open] {
  width: min(100%, 60rem);
  max-width: 100%;
}
.ta-node.is-nested {
  max-width: 100%;
}
.ta-nested-tools {
  container-type: inline-size;
  display: grid;
  justify-items: start;
  gap: 5px;
  min-width: 0;
  padding: 8px 10px;
}
.ta-nit-badge {
  color: var(--ta-accent);
  font:
    600 9px var(--font-mono),
    monospace;
  white-space: nowrap;
}
.ta-nit-error {
  max-width: 100%;
  margin: 4px 0;
  color: var(--ui-danger);
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ta-node::before {
  position: absolute;
  top: -7px;
  bottom: calc(100% - 4px);
  left: 19px;
  width: 2px;
  background: repeating-linear-gradient(to bottom, var(--ta-accent) 0 3px, transparent 3px 5px);
  content: '';
  opacity: 0.45;
}
.ta-node.chain-start::before {
  display: none;
}
.ta-summary {
  position: relative;
  display: grid;
  min-height: 39px;
  grid-template-columns: 40px minmax(0, 1fr) 48px auto;
  align-items: center;
  gap: 7px;
  padding: 3px 5px 3px 1px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.ta-summary::-webkit-details-marker {
  display: none;
}
.ta-summary::after {
  position: absolute;
  right: 2px;
  bottom: 1px;
  left: 42px;
  height: 1px;
  background: linear-gradient(90deg, var(--ta-edge), transparent 72%);
  content: '';
  opacity: 0.42;
}
.ta-summary:hover .ta-data-port,
.ta-summary:focus-visible .ta-data-port {
  opacity: 1;
  transform: translateX(0);
}
.ta-copy {
  display: grid;
  min-width: 0;
  max-width: 54ch;
  gap: 1px;
}
.ta-copy strong {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  column-gap: 10px;
  row-gap: 3px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.02em;
}
.ta-diff-stats {
  display: inline-flex;
  gap: 7px;
  font-family: var(--font-mono), monospace;
  font-size: 10px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ta-diff-stats .is-add {
  color: var(--ui-success);
}
.ta-diff-stats .is-remove {
  color: var(--ui-danger);
}
.ta-diff-stats.is-preview {
  opacity: 0.82;
}
.ta-copy small {
  overflow: hidden;
  color: var(--ui-text-muted);
  font:
    8px var(--font-mono),
    monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ta-progress {
  position: relative;
  height: 3px;
  overflow: hidden;
  background: color-mix(in srgb, var(--ta-edge) 30%, transparent);
}
.ta-progress i {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--ta-accent);
  transform-origin: left;
}
.ta-state-running .ta-progress i {
  animation: ta-progress 1.15s ease-in-out infinite;
}
.ta-state-ok .ta-progress i {
  transform: scaleX(1);
}
.ta-state-error .ta-progress i {
  background: var(--ui-danger);
  clip-path: polygon(0 0, 18% 0, 22% 100%, 42% 100%, 46% 0, 67% 0, 72% 100%, 100% 100%, 100% 0);
}
.ta-meta {
  display: grid;
  grid-template-columns: 7px minmax(30px, auto) 44px;
  align-items: center;
  gap: 7px;
  min-width: 95px;
}
.ta-summary time {
  grid-column: 2;
  color: var(--ui-text-muted);
  font:
    8px var(--font-mono),
    monospace;
  text-align: right;
  white-space: nowrap;
}
.ta-state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ta-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ta-accent) 18%, transparent);
}
.ta-state-text {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.ta-state-running .ta-state-dot {
  animation: ta-state-pulse 1.15s ease-in-out infinite;
}
.ta-state-error .ta-state-dot {
  background: var(--ui-danger);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-danger) 18%, transparent);
}
.ta-data-port {
  grid-column: 3;
  width: 44px;
  height: 24px;
  border: 1px solid var(--ta-edge);
  border-radius: 4px;
  background: var(--ta-face-raised);
  box-shadow: 2px 2px 0 var(--ta-shadow);
  color: var(--ta-accent);
  font-size: 9px;
  font-weight: 800;
  cursor: pointer;
  opacity: 0.72;
  transform: none;
  transition:
    opacity 120ms ease,
    background 120ms ease,
    box-shadow 120ms ease;
}
.ta-data-port:hover,
.ta-data-port:focus-visible {
  opacity: 1;
  background: var(--ta-face);
  box-shadow: 3px 3px 0 var(--ta-shadow);
  outline: none;
}
.ta-result-stage {
  margin: 2px 0 7px 41px;
  overflow: hidden;
  border-left: 1px dashed var(--ta-edge);
  background: var(--ta-face);
  box-shadow: 2px 2px 0 var(--ta-shadow);
  clip-path: polygon(
    0 0,
    100% 0,
    100% calc(100% - 6px),
    calc(100% - 6px) calc(100% - 6px),
    calc(100% - 6px) 100%,
    0 100%
  );
}
.ta-node:not([open]) .ta-result-stage {
  display: none;
}
.ta-state-error {
  --ta-edge: color-mix(in srgb, var(--ui-danger) 52%, var(--ui-border-default));
}
.ta-state-error .ta-summary {
  transform: rotate(-0.25deg);
}
.ta-system-module .ta-summary::after {
  background: linear-gradient(90deg, var(--ta-accent), transparent 45%);
}
.ta-stronghold-scene .ta-summary::after {
  background: repeating-linear-gradient(90deg, var(--ta-accent) 0 8px, transparent 8px 12px);
}
.ta-terminal-tape .ta-summary::after {
  height: 2px;
  background: repeating-linear-gradient(90deg, var(--ta-edge) 0 3px, transparent 3px 6px);
}
.ta-search-radar .ta-summary::after {
  background: radial-gradient(circle, var(--ta-accent) 0 1px, transparent 2px) 0 0 / 7px 3px;
}
.ta-time-ticket .ta-summary::after {
  background: repeating-linear-gradient(90deg, var(--ta-edge) 0 5px, transparent 5px 8px);
}
@keyframes ta-progress {
  0% {
    transform: translateX(-100%) scaleX(0.32);
  }
  55% {
    transform: translateX(15%) scaleX(0.55);
  }
  100% {
    transform: translateX(100%) scaleX(0.2);
  }
}
@keyframes ta-state-pulse {
  50% {
    opacity: 0.45;
    transform: scale(0.72);
  }
}
@media (max-width: 700px) {
  .ta-summary {
    grid-template-columns: 40px minmax(0, 1fr) auto;
  }
  .ta-progress {
    display: none;
  }
  .ta-meta {
    grid-template-columns: 7px auto 40px;
    gap: 5px;
    min-width: 86px;
  }
  .ta-data-port {
    width: 40px;
  }
}

@container (max-width: 440px) {
  .ta-summary {
    grid-template-columns: 32px minmax(0, 1fr) auto;
    gap: 5px;
  }
  .ta-progress {
    display: none;
  }
  .ta-meta {
    gap: 5px;
    min-width: 86px;
  }
  .ta-copy strong {
    font-size: 11px;
    column-gap: 6px;
  }
  .ta-result-stage {
    margin-left: 18px;
  }
  .ta-nested-tools {
    padding: 6px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ta-node *,
  .ta-node *::before,
  .ta-node *::after {
    animation: none !important;
    transition: none !important;
  }
}
</style>
