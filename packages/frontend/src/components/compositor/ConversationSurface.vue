<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * ConversationSurface.vue — 界面组件
 *
 * 负责组织该界面的响应式状态、用户交互与领域数据展示。
 * 副作用在组件生命周期内建立并清理，避免跨页面残留监听器或异步状态。
 */
import { computed, inject, shallowRef, ref, watch } from 'vue'
import { resourceFromToolResult } from '@infos/shared'
import type {
  AgentInputSubmission,
  ApprovalSurfaceProps,
  AttachmentSurfaceProps,
  BackgroundTaskProjectionSnapshot,
  ConversationProjectionSnapshot,
  InputSurfaceProps,
  MarkdownSurfaceProps,
  ModelRetrySurfaceProps,
  NativeReasoningSurfaceProps,
  ProgressSurfaceProps,
  ProgrammableIslandSurfaceProps,
  StatusSurfaceProps,
  SurfaceNode,
  ThinkingSurfaceProps,
  ToolCallSurfaceProps,
  ToolResultSurfaceProps,
} from '@infos/shared'
import type { CompositorSurface } from '../../stores'
import { StreamMarkdownSegmenter } from '../../compositor/markdownSegmentation'
import {
  groupExecutionItems,
  type ConversationRenderItem as RenderItem,
} from '../../compositor/executionGroups'
import ExecutionProcess from './ExecutionProcess.vue'
import StreamMarkdown from './StreamMarkdown.vue'
import type { ApprovalDecision, ApprovalRequest } from '../../api/modules/approvalsApi'
import { ApprovalCard } from '../approval'
import AgentInputCard from '../agent/AgentInputCard.vue'
import { clearAgentInputDraft } from '../agent/agentInputDraft'
import { surfacesApi } from '../../api/modules/surfacesApi'
import { useCompositorStore } from '../../stores'
import { useGateway } from '../../composables/gateway/useGateway'
import PixelIcon from '../pixel/PixelIcon.vue'
import ChatRichText from '../chat/ChatRichText.vue'
import RunPulse from '../chat/RunPulse.vue'
import ModelRetryRecord from '../chat/ModelRetryRecord.vue'
import ToolCallCard from '../tools/ToolCallCard.vue'
import { toolCallView, type ToolCallView } from '../tools/toolCallView'
import MermaidSurfaceNode from './MermaidSurfaceNode.vue'
import ProgrammableSurfaceNode from './ProgrammableSurfaceNode.vue'
import ResourceCard from '../resources/ResourceCard.vue'

interface Props {
  surface: CompositorSurface
  displayMode?: 'all' | 'content' | 'images'
}

const props = withDefaults(defineProps<Props>(), {
  displayMode: 'all',
})
const compositor = useCompositorStore()
const { withInputSeatFor } = useGateway()
const inputMessage = ref('')
const submittingNodeId = ref<string | null>(null)
const inputErrors = ref<Record<string, string>>({})
const reasoningOpen = ref<Record<string, boolean>>({})
const reasoningPhases = new Map<string, 'preview' | 'committed'>()
const mainVisible = inject('infos:main-surface-visible', shallowRef(true))
const segmenters = new Map<string, StreamMarkdownSegmenter>()
const resourceCache = new WeakMap<
  SurfaceNode,
  {
    result?: ToolResultSurfaceProps
    resource: ReturnType<typeof resourceFromToolResult>
  }
>()
let previousItems: RenderItem[] = []

function toolResource(node: SurfaceNode, result?: ToolResultSurfaceProps) {
  const cached = resourceCache.get(node)
  if (cached && cached.result === result) return cached.resource
  const resource = !result?.isError
    ? resourceFromToolResult(toolProps(node).name, result?.result)
    : null
  resourceCache.set(node, { result, resource })
  return resource
}

watch(
  [() => props.surface.state, () => props.surface.nodes],
  () => {
    const next = { ...reasoningOpen.value }
    const live = new Set<string>()
    let changed = false
    for (const node of props.surface.nodes) {
      if (node.kind !== 'native-reasoning') continue
      live.add(node.nodeId)
      const phase =
        props.surface.state === 'open' && reasoningProps(node).phase !== 'committed'
          ? 'preview'
          : 'committed'
      if (reasoningPhases.get(node.nodeId) === phase) continue
      reasoningPhases.set(node.nodeId, phase)
      next[node.nodeId] = phase === 'preview'
      changed = true
    }
    for (const id of reasoningPhases.keys())
      if (!live.has(id)) {
        reasoningPhases.delete(id)
        delete next[id]
        changed = true
      }
    if (changed) reasoningOpen.value = next
  },
  { immediate: true },
)

function formatDuration(value?: number): string {
  if (value === undefined) return '—'
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`
}

const renderItems = computed<RenderItem[]>(() => {
  if (props.surface.suspended || !mainVisible.value) return previousItems
  const items: RenderItem[] = []
  const toolResults = new Map<string, ToolResultSurfaceProps>()
  for (const node of props.surface.nodes) {
    if (node.kind === 'tool-result') {
      const result = resultProps(node)
      toolResults.set(result.callId, result)
    }
  }
  const parentCalls = new Map(
    props.surface.nodes
      .filter((node) => node.kind === 'tool-call' && toolProps(node).name === 'run_script')
      .map((node) => [toolProps(node).callId, node]),
  )
  const nestedNodes = new Set<string>()
  const children = new Map<string, ToolCallView[]>()
  for (const node of props.surface.nodes) {
    if (node.kind !== 'tool-call') continue
    const call = toolProps(node)
    if (
      !call.parentCallId ||
      call.parentCallId === call.callId ||
      !parentCalls.has(call.parentCallId)
    )
      continue
    nestedNodes.add(node.nodeId)
    const list = children.get(call.parentCallId) ?? []
    list.push(toolCallView(call, toolResults.get(call.callId), props.surface.state !== 'open'))
    children.set(call.parentCallId, list)
  }
  for (const node of props.surface.nodes) {
    if (nestedNodes.has(node.nodeId)) continue
    if (node.kind !== 'markdown') {
      items.push({
        type: 'node',
        id: node.nodeId,
        node,
        toolResult: node.kind === 'tool-call' ? toolResults.get(toolProps(node).callId) : undefined,
        children: node.kind === 'tool-call' ? children.get(toolProps(node).callId) : undefined,
      })
      continue
    }
    const markdown = node.props as MarkdownSurfaceProps
    let segmenter = segmenters.get(node.nodeId)
    if (!segmenter) {
      segmenter = new StreamMarkdownSegmenter(node.nodeId)
      segmenters.set(node.nodeId, segmenter)
    }
    for (const block of segmenter.update(markdown.source, markdown.phase === 'committed')) {
      if (!block.source.trim()) continue
      items.push({ type: 'markdown-block', id: block.id, block })
    }
  }
  const liveNodes = new Set(props.surface.nodes.map((node) => node.nodeId))
  for (const id of segmenters.keys())
    if (!liveNodes.has(id as SurfaceNode['nodeId'])) segmenters.delete(id)
  if (props.displayMode === 'content') {
    return (previousItems = items.filter(
      (item) =>
        item.type !== 'node' ||
        item.node.kind !== 'attachment' ||
        attachmentProps(item.node).kind !== 'image',
    ))
  }
  return (previousItems = items)
})

const executionGroups = computed(() =>
  groupExecutionItems(renderItems.value, props.surface.state !== 'open'),
)

function toolChain(node: SurfaceNode): string {
  const name = toolProps(node).name
  if (name.startsWith('browser_')) return 'browser'
  if (name.startsWith('terminal_')) return 'terminal'
  if (name.startsWith('stronghold_')) return 'stronghold'
  if (name.startsWith('social_')) return 'social'
  if (
    [
      'read_file',
      'read_file_range',
      'write_file',
      'edit_file',
      'get_file_info',
      'list_directory',
      'glob_files',
    ].includes(name)
  )
    return 'files'
  if (['search_files', 'code_search'].includes(name)) return 'search'
  if (name.includes('reminder')) return 'time'
  return name
}

function toolChainEdge(index: number, direction: -1 | 1): SurfaceNode | undefined {
  const current = renderItems.value[index]
  if (current?.type !== 'node' || current.node.kind !== 'tool-call') return undefined
  for (
    let cursor = index + direction;
    cursor >= 0 && cursor < renderItems.value.length;
    cursor += direction
  ) {
    const adjacent = renderItems.value[cursor]
    if (adjacent?.type === 'node' && adjacent.node.kind === 'tool-result') continue
    if (adjacent?.type !== 'node' || adjacent.node.kind !== 'tool-call') return undefined
    return toolChain(current.node) === toolChain(adjacent.node) ? adjacent.node : undefined
  }
  return undefined
}

function thinkingProps(node: SurfaceNode): ThinkingSurfaceProps {
  return node.props as ThinkingSurfaceProps
}

function reasoningProps(node: SurfaceNode): NativeReasoningSurfaceProps {
  return node.props as NativeReasoningSurfaceProps
}

function toolProps(node: SurfaceNode): ToolCallSurfaceProps {
  return node.props as ToolCallSurfaceProps
}

function resultProps(node: SurfaceNode): ToolResultSurfaceProps {
  return node.props as ToolResultSurfaceProps
}

function statusProps(node: SurfaceNode): StatusSurfaceProps {
  return node.props as StatusSurfaceProps
}

const pendingInteraction = computed(() => {
  if (props.surface.state !== 'open' || props.surface.suspended) return undefined
  for (const surface of [props.surface, ...compositor.surfaces.values()]) {
    if (
      surface.threadId !== props.surface.threadId ||
      surface.principalId !== props.surface.principalId ||
      surface.state === 'disposed'
    )
      continue
    const interaction = surface.nodes.find(
      (node) => node.kind === 'approval' || node.kind === 'input',
    )
    if (interaction) return interaction.kind
  }
  return undefined
})

function runState(status: StatusSurfaceProps): StatusSurfaceProps['state'] {
  if (
    pendingInteraction.value &&
    ['thinking', 'assembling', 'calling', 'generating', 'running'].includes(status.state)
  )
    return 'waiting_input'
  return status.state
}

function runLabel(status: StatusSurfaceProps): string | undefined {
  if (runState(status) === 'waiting_input' && pendingInteraction.value)
    return pendingInteraction.value === 'approval'
      ? __t('ui.compositor', '正在等待你的确认……')
      : __t('ui.compositor', '正在等待你的回答……')
  if (status.state === 'calling' && /自动审批/.test(status.message ?? '')) return status.message
  // 活动阶段使用统一状态文案，避免旧服务端的阶段描述覆盖真实状态。
  return ['thinking', 'assembling', 'calling', 'generating'].includes(status.state)
    ? undefined
    : status.message
}

function runLive(status: StatusSurfaceProps): boolean {
  return (
    props.surface.state === 'open' &&
    !props.surface.suspended &&
    ![
      'paused',
      'waiting_input',
      'waiting',
      'blocked',
      'completed',
      'failed',
      'tool_failed',
      'cancelled',
    ].includes(runState(status))
  )
}

function pulseState(state: StatusSurfaceProps['state']) {
  if (state === 'assembling') return 'assembling' as const
  if (state === 'calling') return 'calling' as const
  if (state === 'generating' || state === 'running') return 'generating' as const
  if (state === 'paused') return 'paused' as const
  if (state === 'cancelled') return 'cancelled' as const
  if (state === 'waiting_input' || state === 'waiting') return 'waiting' as const
  if (state === 'blocked') return 'paused' as const
  if (state === 'completed') return 'completed' as const
  if (state === 'failed' || state === 'tool_failed') return 'failed' as const
  return 'thinking' as const
}

function pulseDuration(props: StatusSurfaceProps): number | undefined {
  return props.totalDurationMs ?? props.outputDurationMs
}

function attachmentProps(node: SurfaceNode): AttachmentSurfaceProps {
  return node.props as AttachmentSurfaceProps
}

function progressProps(node: SurfaceNode): ProgressSurfaceProps {
  return node.props as ProgressSurfaceProps
}

function inputProps(node: SurfaceNode): InputSurfaceProps {
  return node.props as InputSurfaceProps
}

function installProjection(
  projection: ConversationProjectionSnapshot | BackgroundTaskProjectionSnapshot,
): void {
  if ('taskId' in projection) {
    compositor.replaceScope(`background-task:${projection.taskId}`, projection.surfaces)
  } else {
    compositor.replaceSnapshot(projection)
  }
}

function approvalRequest(node: SurfaceNode): ApprovalRequest {
  const value = node.props as ApprovalSurfaceProps
  return {
    id: value.approvalId,
    agentId: value.principalId,
    channel: 'desktop',
    sessionId: value.threadId ?? props.surface.threadId,
    threadId: value.threadId ?? props.surface.threadId,
    toolName: value.toolName,
    argsSummary: value.summary,
    reason: value.title,
    riskLevel: value.riskLevel,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
}

async function resolveApproval(
  node: SurfaceNode,
  decision: ApprovalDecision,
  message?: string,
): Promise<void> {
  if (submittingNodeId.value) return
  delete inputErrors.value[node.nodeId]
  const value = node.props as ApprovalSurfaceProps
  submittingNodeId.value = node.nodeId
  try {
    const response = await withInputSeatFor(
      value.principalId || props.surface.principalId,
      (seat) =>
        surfacesApi.submitInput({
          surfaceId: props.surface.surfaceId,
          nodeId: node.nodeId,
          generation: props.surface.generation,
          seat,
          action: 'approval.resolve',
          payload: {
            approvalId: value.approvalId,
            principalId: value.principalId,
            decision,
            message,
          },
        }),
    )
    const projection = response.data?.projection
    if (projection) installProjection(projection)
  } catch (error) {
    inputErrors.value[node.nodeId] = error instanceof Error ? error.message : '提交失败，请重试'
  } finally {
    submittingNodeId.value = null
  }
}

async function submitAgentInput(node: SurfaceNode, payload: AgentInputSubmission): Promise<void> {
  if (submittingNodeId.value) return
  const value = inputProps(node)
  delete inputErrors.value[node.nodeId]
  submittingNodeId.value = node.nodeId
  try {
    const response = await withInputSeatFor(
      value.principalId || props.surface.principalId,
      (seat) =>
        surfacesApi.submitInput({
          surfaceId: props.surface.surfaceId,
          nodeId: node.nodeId,
          generation: props.surface.generation,
          seat,
          action: 'agent-input.resolve',
          payload: { inputId: value.inputId, principalId: value.principalId, ...payload },
        }),
    )
    const projection = response.data?.projection
    clearAgentInputDraft(value.inputId)
    if (projection) installProjection(projection)
  } catch (error) {
    inputErrors.value[node.nodeId] =
      error instanceof Error ? error.message : '提交失败，回答已保留，请重试'
  } finally {
    submittingNodeId.value = null
  }
}

async function submitInput(node: SurfaceNode, decision: string): Promise<void> {
  if (submittingNodeId.value) return
  const value = inputProps(node)
  delete inputErrors.value[node.nodeId]
  submittingNodeId.value = node.nodeId
  try {
    const response = await withInputSeatFor(
      value.principalId || props.surface.principalId,
      (seat) =>
        surfacesApi.submitInput({
          surfaceId: props.surface.surfaceId,
          nodeId: node.nodeId,
          generation: props.surface.generation,
          seat,
          action: 'background-task.submit-input',
          payload: {
            taskId: value.inputId,
            decision,
            message: inputMessage.value.trim() || undefined,
          },
        }),
    )
    const projection = response.data?.projection as BackgroundTaskProjectionSnapshot | undefined
    if (projection) installProjection(projection)
    inputMessage.value = ''
  } catch (error) {
    inputErrors.value[node.nodeId] = error instanceof Error ? error.message : '提交失败，请重试'
  } finally {
    submittingNodeId.value = null
  }
}

function programmableProps(node: SurfaceNode): ProgrammableIslandSurfaceProps {
  return node.props as ProgrammableIslandSurfaceProps
}

function handleProgrammableInput(payload: { action: string; value?: unknown }): void {
  // 可编程Surface输入只上抛给受控Host Adapter，不直接访问业务API。
  void payload
}

function errorMessage(node: SurfaceNode): string {
  return (node.props as { message: string }).message
}
</script>

<template>
  <div class="conversation-surface" :data-surface-id="surface.surfaceId">
    <ExecutionProcess
      v-for="group in executionGroups"
      :key="group.id"
      v-slot="{ expanded }"
      :enabled="group.toolCount > 0"
      :ended="surface.state !== 'open'"
      :tool-count="group.toolCount"
      :failure-count="group.failureCount"
    >
      <template v-for="{ item, index: itemIndex } in group.items" :key="item.id">
        <div
          v-if="item.type === 'markdown-block'"
          class="surface-markdown-block"
          :class="{ 'surface-markdown-block--stable': item.block.stable }"
        >
          <MermaidSurfaceNode
            v-if="item.block.kind === 'mermaid'"
            :source="item.block.source"
            :active="!surface.suspended"
          />
          <ChatRichText
            v-else
            :content="item.block.source"
            :agent-id="surface.principalId"
            :thread-id="surface.threadId"
            :active="!surface.suspended"
            :cache="item.block.stable"
            :stable="item.block.stable"
          />
        </div>
        <template v-else>
          <ModelRetryRecord
            v-if="item.node.kind === 'model-retry'"
            :record="item.node.props as ModelRetrySurfaceProps"
            :active="expanded && surface.state === 'open' && !surface.suspended && mainVisible"
          />
          <details v-else-if="item.node.kind === 'thinking'" class="surface-thinking" open>
            <summary>
              <span class="surface-thinking__spark" aria-hidden="true" />
              <strong>{{ __t('ui.compositor', '碎碎念') }}</strong>
              <span class="surface-thinking__meta">
                {{
                  thinkingProps(item.node).phase === 'preview'
                    ? __t('ui.compositor', '正在冒泡')
                    : __t('ui.compositor', '暂告一段')
                }}
              </span>
              <time v-if="thinkingProps(item.node).durationMs !== undefined">
                {{ formatDuration(thinkingProps(item.node).durationMs) }}
              </time>
              <PixelIcon name="chevron-down" size="xs" />
            </summary>
            <div class="surface-thinking__body">
              <p v-if="thinkingProps(item.node).phase === 'preview'" class="surface-thinking__live">
                {{ thinkingProps(item.node).source }}
                <i class="surface-thinking__cursor" />
              </p>
              <ChatRichText
                v-else
                :content="thinkingProps(item.node).source"
                :active="expanded && !surface.suspended"
                :web-preview="false"
              />
            </div>
          </details>
          <details
            v-else-if="item.node.kind === 'native-reasoning'"
            class="surface-native-reasoning"
            :open="reasoningOpen[item.node.nodeId]"
            @toggle="
              reasoningOpen[item.node.nodeId] = ($event.currentTarget as HTMLDetailsElement).open
            "
          >
            <summary>
              <span class="surface-native-reasoning__cube" aria-hidden="true" />
              <strong>{{ __t('ui.compositor', '思考过程') }}</strong>
              <span class="surface-native-reasoning__meta">
                {{
                  reasoningProps(item.node).mode === 'stream'
                    ? __t('ui.compositor', '流式')
                    : __t('ui.compositor', '非流式')
                }}
                <template v-if="reasoningProps(item.node).turn">
                  {{ __t('ui.compositor', '· 第') }} {{ reasoningProps(item.node).turn }}
                  {{ __t('ui.compositor', '轮') }}
                </template>
              </span>
              <time v-if="reasoningProps(item.node).durationMs !== undefined">
                {{ formatDuration(reasoningProps(item.node).durationMs) }}
              </time>
              <PixelIcon name="chevron-down" size="xs" />
            </summary>
            <div class="surface-native-reasoning__body">
              <StreamMarkdown
                v-if="reasoningOpen[item.node.nodeId]"
                :source="reasoningProps(item.node).source"
                :node-id="item.node.nodeId"
                :committed="
                  reasoningProps(item.node).phase === 'committed' || surface.state !== 'open'
                "
                :active="expanded && !surface.suspended"
              />
            </div>
          </details>
          <ResourceCard
            v-else-if="item.node.kind === 'tool-call' && toolResource(item.node, item.toolResult)"
            :resource="toolResource(item.node, item.toolResult)!"
            :active="expanded && !surface.suspended && mainVisible"
          />
          <ToolCallCard
            v-else-if="item.node.kind === 'tool-call'"
            :active="expanded && !surface.suspended && mainVisible"
            :chain-start="!toolChainEdge(itemIndex, -1)"
            :chain-end="!toolChainEdge(itemIndex, 1)"
            :children="item.children"
            :tool="toolCallView(toolProps(item.node), item.toolResult, surface.state !== 'open')"
          />
          <div v-else-if="item.node.kind === 'tool-result'" class="surface-tool-result">
            {{ resultProps(item.node).result }}
          </div>
          <RunPulse
            v-else-if="item.node.kind === 'status'"
            :state="pulseState(runState(statusProps(item.node)))"
            :label="runLabel(statusProps(item.node))"
            :elapsed-ms="pulseDuration(statusProps(item.node))"
            :live="expanded && runLive(statusProps(item.node))"
            class="surface-run-pulse"
          />
          <div v-else-if="item.node.kind === 'progress'" class="surface-progress">
            <span>{{ progressProps(item.node).stage || __t('ui.compositor', '任务进度') }}</span>
            <div class="surface-progress__track">
              <i :style="{ width: `${progressProps(item.node).value ?? 0}%` }" />
            </div>
            <strong v-if="progressProps(item.node).value != null">
              {{ progressProps(item.node).value }}%
            </strong>
          </div>
          <AgentInputCard
            v-else-if="
              item.node.kind === 'input' && inputProps(item.node).inputKind === 'agent_question'
            "
            :key="inputProps(item.node).inputId"
            :request="inputProps(item.node)"
            :error="inputErrors[item.node.nodeId]"
            :loading="submittingNodeId === item.node.nodeId"
            @answer="(payload) => submitAgentInput(item.node, payload)"
          />
          <div v-else-if="item.node.kind === 'input'" class="surface-input">
            <strong>{{ inputProps(item.node).title }}</strong>
            <p>{{ inputProps(item.node).question }}</p>
            <textarea
              v-model="inputMessage"
              rows="2"
              maxlength="2000"
              :placeholder="__t('ui.compositor', '附言（可选）')"
            />
            <p v-if="inputErrors[item.node.nodeId]" role="alert">
              {{ inputErrors[item.node.nodeId] }}
            </p>
            <div>
              <button
                v-for="action in inputProps(item.node).actions"
                :key="action.id"
                type="button"
                :class="`surface-input__${action.tone ?? 'neutral'}`"
                :disabled="submittingNodeId === item.node.nodeId"
                @click="submitInput(item.node, action.id)"
              >
                {{ action.label }}
              </button>
            </div>
          </div>
          <ResourceCard
            v-else-if="item.node.kind === 'attachment'"
            :resource="attachmentProps(item.node)"
            :active="!surface.suspended && mainVisible"
          />
          <ApprovalCard
            v-else-if="item.node.kind === 'approval'"
            :request="approvalRequest(item.node)"
            :error="inputErrors[item.node.nodeId]"
            :loading="submittingNodeId === item.node.nodeId"
            compact
            @resolve="(decision, message) => resolveApproval(item.node, decision, message)"
          />
          <ProgrammableSurfaceNode
            v-else-if="item.node.kind === 'programmable-island'"
            :descriptor="programmableProps(item.node)"
            :active="!surface.suspended"
            @input="handleProgrammableInput"
          />
          <div v-else-if="item.node.kind === 'error'" class="surface-error">
            {{ errorMessage(item.node) }}
          </div>
        </template>
      </template>
    </ExecutionProcess>
    <span v-if="surface.state === 'open'" class="msg-streaming-cursor" />
  </div>
</template>

<style scoped>
.msg-streaming-cursor {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin: 2px 0 2px 4px;
  border-radius: 2px;
  background: var(--ui-accent-sky);
  box-shadow: 0 2px 7px color-mix(in srgb, var(--ui-accent-sky) 35%, transparent);
  animation: surface-cursor-hop 0.9s cubic-bezier(0.45, 0, 0.2, 1) infinite;
}
@keyframes surface-cursor-hop {
  0%,
  100% {
    transform: translateY(1px) rotate(0deg) scale(1, 0.8);
  }
  50% {
    transform: translateY(-4px) rotate(90deg) scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .msg-streaming-cursor,
  .surface-thinking__spark,
  .surface-thinking__cursor {
    animation: none;
    opacity: 0.7;
  }
}
.conversation-surface {
  min-width: 0;
}
.surface-markdown-block {
  display: flow-root;
  margin-block: 0.85em;
}
/* 流式稳定段有独立容器，标题的跨容器间距也要显式保留。 */
.surface-markdown-block:has(> .chat-rich-text > :is(h1, h2, h3, h4, h5, h6):first-child) {
  margin-block-start: 1.55em;
}
.surface-markdown-block:first-child,
.surface-markdown-block:has(
    > .chat-rich-text > :is(h1, h2, h3, h4, h5, h6):first-child
  ):first-child {
  margin-block-start: 0;
}
.surface-markdown-block:last-child {
  margin-block-end: 0;
}
.surface-thinking {
  position: relative;
  width: fit-content;
  max-width: min(96%, 640px);
  margin: 8px 4px 10px 2px;
  overflow: visible;
  border: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 12px;
  filter: drop-shadow(2px 3px 0 color-mix(in srgb, var(--ui-accent-purple) 18%, transparent));
}
.surface-thinking[open] {
  width: min(100%, 60rem);
  max-width: 100%;
  filter: none;
}
.surface-thinking:not([open]) summary {
  grid-template-columns: 12px auto minmax(0, auto) auto 14px;
}
.surface-thinking summary {
  position: relative;
  z-index: 1;
  display: grid;
  min-width: 176px;
  min-height: 34px;
  grid-template-columns: 18px auto auto 1fr 14px;
  align-items: center;
  gap: 7px;
  padding: 0 12px 0 10px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-pink) 40%, var(--ui-border-default));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--ui-text-inverse) 8%, transparent) 0 24%,
      transparent 24%
    ),
    color-mix(in srgb, var(--ui-accent-pink-soft) 48%, var(--ui-bg-elevated));
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--ui-text-inverse) 13%, transparent),
    inset 0 -2px 0 color-mix(in srgb, var(--ui-accent-purple) 15%, transparent);
  clip-path: polygon(
    0 7px,
    7px 7px,
    7px 0,
    calc(100% - 13px) 0,
    calc(100% - 13px) 4px,
    100% 4px,
    100% calc(100% - 7px),
    calc(100% - 7px) calc(100% - 7px),
    calc(100% - 7px) 100%,
    13px 100%,
    13px calc(100% - 4px),
    0 calc(100% - 4px)
  );
  color: var(--ui-text-primary);
  cursor: pointer;
  list-style: none;
  user-select: none;
  transform-origin: 24px 50%;
  transition:
    transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1),
    filter 0.18s ease,
    background-color 0.18s ease;
}
.surface-thinking:not([open]) summary::after {
  position: absolute;
  right: 12px;
  bottom: -4px;
  width: 18px;
  height: 5px;
  background: var(--ui-accent-purple);
  clip-path: polygon(0 0, 100% 0, 75% 100%, 25% 100%);
  content: '';
  opacity: 0.72;
}
.surface-thinking:not([open]) summary:hover {
  background-color: color-mix(in srgb, var(--ui-accent-pink-soft) 66%, var(--ui-bg-elevated));
  filter: brightness(1.08);
  transform: translateY(-2px) rotate(-0.7deg) scale(1.015);
}
.surface-thinking:not([open]) summary:hover .surface-thinking__spark {
  animation-duration: 0.45s;
  transform: rotate(225deg) scale(1.12);
}
.surface-thinking summary:active {
  transform: translateY(1px) scale(0.985);
}
.surface-thinking[open] summary {
  clip-path: polygon(
    0 7px,
    7px 7px,
    7px 0,
    calc(100% - 10px) 0,
    calc(100% - 10px) 5px,
    100% 5px,
    100% 100%,
    0 100%
  );
}
.surface-thinking summary::-webkit-details-marker {
  display: none;
}
.surface-thinking summary strong {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-shadow: 0 1px 0 color-mix(in srgb, var(--ui-text-inverse) 10%, transparent);
}
.surface-thinking__spark {
  width: 7px;
  height: 7px;
  background: var(--ui-accent-pink);
  box-shadow:
    5px -4px 0 -2px var(--ui-accent-purple),
    -3px 5px 0 -2px var(--ui-accent-sky);
  transform: rotate(45deg);
  animation: thinking-spark 1.1s steps(2, end) infinite;
}
.surface-thinking__meta {
  color: var(--ui-accent-pink);
  font-family: var(--font-mono), monospace;
  font-size: 8px;
}
.surface-thinking time {
  color: var(--ui-text-muted);
  font-family: var(--font-mono), monospace;
  font-size: 9px;
  text-align: right;
}
.surface-thinking summary :deep(.pixel-icon) {
  color: var(--ui-text-muted);
  transition: transform 0.12s steps(2, end);
}
.surface-thinking[open] summary :deep(.pixel-icon) {
  transform: rotate(180deg);
}
.surface-thinking__body {
  position: relative;
  width: 100%;
  margin: -1px 0 0;
  padding: 11px 13px 11px 17px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-pink) 30%, var(--ui-border-default));
  border-top-style: dashed;
  background:
    repeating-linear-gradient(
      90deg,
      transparent 0 9px,
      color-mix(in srgb, var(--ui-accent-pink) 6%, transparent) 9px 10px
    ),
    color-mix(in srgb, var(--ui-accent-pink-soft) 34%, var(--ui-bg-elevated));
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--ui-accent-purple) 12%, transparent);
  clip-path: polygon(
    0 0,
    100% 0,
    100% calc(100% - 9px),
    calc(100% - 9px) calc(100% - 9px),
    calc(100% - 9px) 100%,
    8px 100%,
    8px calc(100% - 5px),
    0 calc(100% - 5px)
  );
  color: var(--ui-text-secondary);
  font-size: 11px;
  line-height: 1.85;
}
.surface-thinking__live {
  min-height: 1.85em;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.surface-thinking__body::before {
  position: absolute;
  top: 9px;
  bottom: 9px;
  left: 3px;
  width: 2px;
  background: repeating-linear-gradient(
    to bottom,
    var(--ui-accent-pink) 0 4px,
    transparent 4px 7px
  );
  content: '';
  opacity: 0.68;
}
.surface-thinking__cursor {
  display: inline-block;
  width: 5px;
  height: 9px;
  margin-left: 4px;
  background: var(--ui-accent-pink);
  animation: thinking-cursor 0.7s steps(1, end) infinite;
  vertical-align: -1px;
}
@keyframes thinking-spark {
  50% {
    opacity: 0.55;
    transform: rotate(135deg) scale(0.82);
  }
}
@keyframes thinking-cursor {
  50% {
    opacity: 0;
  }
}

.surface-native-reasoning {
  width: fit-content;
  max-width: 100%;
  margin: 10px 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 24%, var(--ui-border-default));
  border-radius: 10px;
  background: color-mix(in srgb, var(--ui-accent-purple-soft) 52%, var(--ui-bg-elevated));
  color: var(--ui-text-secondary);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--ui-accent-purple) 8%, transparent);
  font-size: 12px;
}
.surface-native-reasoning[open] {
  width: min(100%, 60rem);
}
.surface-native-reasoning:not([open]) summary {
  grid-template-columns: 12px auto minmax(0, auto) auto 14px;
}
.surface-native-reasoning__meta,
.surface-thinking__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.surface-native-reasoning summary {
  display: grid;
  min-height: 34px;
  grid-template-columns: 18px auto auto 1fr 14px;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  color: var(--ui-text-primary);
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.surface-native-reasoning summary::-webkit-details-marker {
  display: none;
}
.surface-native-reasoning summary strong {
  font-size: 12px;
  font-weight: 750;
}
.surface-native-reasoning__cube {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: var(--ui-accent-purple);
  box-shadow: inset -2px -2px 0 color-mix(in srgb, var(--ui-accent-purple) 56%, #000);
  transform: rotate(45deg);
}
.surface-native-reasoning__meta {
  color: var(--ui-text-muted);
  font-size: 10px;
}
.surface-native-reasoning time {
  color: var(--ui-text-muted);
  font-family: var(--font-mono), monospace;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.surface-native-reasoning summary :deep(.pixel-icon) {
  color: var(--ui-text-muted);
  transition: transform 0.2s ease;
}
.surface-native-reasoning[open] summary :deep(.pixel-icon) {
  transform: rotate(180deg);
}
.surface-native-reasoning__body {
  position: relative;
  margin: 0 10px 10px;
  padding: 10px 12px 10px 15px;
  border-top: 1px solid color-mix(in srgb, var(--ui-accent-purple) 18%, var(--ui-border-default));
  color: var(--ui-text-secondary);
  line-height: 1.85;
}
.surface-native-reasoning__body::before {
  position: absolute;
  top: 10px;
  bottom: 10px;
  left: 3px;
  width: 2px;
  border-radius: 999px;
  background: linear-gradient(var(--ui-accent-purple), var(--ui-accent-sky));
  content: '';
  opacity: 0.55;
}
.surface-run-pulse {
  margin: 6px 0;
}
.surface-error {
  color: var(--color-danger);
  padding: 6px 0;
}
.surface-tool-result {
  display: none;
}
.surface-progress {
  display: grid;
  grid-template-columns: minmax(90px, auto) 1fr auto;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 12px;
}
.surface-progress__track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--color-border);
}
.surface-progress__track i {
  display: block;
  height: 100%;
  background: var(--color-primary);
}
.surface-input {
  display: grid;
  gap: 8px;
  margin: 10px 0;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
.surface-input p {
  margin: 0;
}
.surface-input textarea {
  width: 100%;
  resize: vertical;
}
.surface-input > div {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.surface-input__primary {
  color: white;
  background: var(--color-primary);
}
.surface-input__danger {
  color: var(--color-danger);
}
.surface-image {
  position: relative;
  display: block;
  width: min(100%, 360px);
  margin: 9px 0;
  padding: 6px;
  overflow: visible;
  appearance: none;
  background:
    linear-gradient(var(--ui-bg-surface), var(--ui-bg-surface)) padding-box,
    linear-gradient(135deg, var(--ui-accent-sky), var(--ui-accent-purple), var(--ui-accent-primary))
      border-box;
  border: 2px solid transparent;
  border-radius: 16px 7px 16px 7px;
  box-shadow:
    0 9px 24px color-mix(in srgb, var(--ui-accent-purple) 16%, transparent),
    4px 4px 0 color-mix(in srgb, var(--ui-accent-sky) 20%, transparent);
  cursor: zoom-in;
  transform: rotate(-0.35deg);
  transition:
    transform 180ms var(--ui-ease-out),
    box-shadow 180ms var(--ui-ease-out);
}
.surface-image::after {
  content: '';
  position: absolute;
  right: 13px;
  bottom: -5px;
  width: 28px;
  height: 10px;
  background: color-mix(in srgb, var(--ui-accent-primary) 36%, transparent);
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary) 45%, transparent);
  transform: rotate(-5deg);
  opacity: 0.8;
}
.surface-image:hover {
  transform: translateY(-3px) rotate(0deg) scale(1.012);
  box-shadow:
    0 14px 30px color-mix(in srgb, var(--ui-accent-purple) 23%, transparent),
    5px 5px 0 color-mix(in srgb, var(--ui-accent-sky) 24%, transparent);
}
.surface-image img {
  display: block;
  width: 100%;
  max-height: 340px;
  object-fit: contain;
  background: color-mix(in srgb, var(--ui-bg-canvas) 86%, transparent);
  border-radius: 11px 4px 11px 4px;
}
.surface-image__shine {
  position: absolute;
  inset: 6px;
  overflow: hidden;
  border-radius: 11px 4px 11px 4px;
  pointer-events: none;
}
.surface-image__shine::after {
  content: '';
  position: absolute;
  top: -40%;
  left: -55%;
  width: 34%;
  height: 180%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.32), transparent);
  transform: rotate(18deg);
  transition: left 480ms ease;
}
.surface-image:hover .surface-image__shine::after {
  left: 125%;
}
.surface-image__spark {
  position: absolute;
  z-index: 2;
  color: var(--ui-accent-primary);
  font-family: var(--font-pixel);
  text-shadow: 0 2px 8px color-mix(in srgb, var(--ui-accent-primary) 45%, transparent);
  pointer-events: none;
  animation: surface-image-spark 2.4s ease-in-out infinite;
}
.surface-image__spark--one {
  top: -12px;
  right: 18px;
  font-size: 17px;
}
.surface-image__spark--two {
  right: -8px;
  bottom: 28px;
  color: var(--ui-accent-sky);
  font-size: 12px;
  animation-delay: -1.1s;
}
@keyframes surface-image-spark {
  50% {
    opacity: 0.52;
    transform: translateY(-3px) rotate(18deg) scale(0.8);
  }
}
.surface-image-preview {
  position: fixed;
  z-index: 10000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 48px;
  background: color-mix(in srgb, #100c1c 82%, transparent);
  backdrop-filter: blur(10px);
}
.surface-image-preview > img {
  display: block;
  max-width: min(92vw, 1400px);
  max-height: 88vh;
  object-fit: contain;
  border: 5px solid var(--ui-bg-elevated);
  border-radius: 18px 7px 18px 7px;
  box-shadow:
    0 24px 80px rgba(0, 0, 0, 0.48),
    6px 6px 0 color-mix(in srgb, var(--ui-accent-purple) 50%, transparent);
}
.surface-image-preview > button {
  position: fixed;
  z-index: 1;
  top: 22px;
  right: 24px;
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 52%, transparent);
  border-radius: 12px 5px 12px 5px;
  background: color-mix(in srgb, var(--ui-bg-elevated) 92%, transparent);
  color: var(--ui-text-primary);
  cursor: pointer;
}
@media (max-width: 720px) {
  .surface-native-reasoning {
    width: 100%;
  }
  .conversation-surface--images {
    max-width: 92vw;
    flex-wrap: wrap;
  }
  .conversation-surface--images .surface-image {
    width: min(44vw, 190px);
    flex-basis: min(44vw, 190px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .surface-image__spark,
  .surface-image__shine::after {
    animation: none;
    transition: none;
  }
}
[data-theme='dark'] .surface-image {
  background:
    linear-gradient(
        color-mix(in srgb, var(--ui-bg-surface) 90%, #171224),
        color-mix(in srgb, var(--ui-bg-surface) 90%, #171224)
      )
      padding-box,
    linear-gradient(135deg, var(--ui-accent-sky), var(--ui-accent-purple), var(--ui-accent-primary))
      border-box;
}
.surface-attachment {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
.surface-attachment img {
  width: 72px;
  max-height: 72px;
  object-fit: cover;
  border-radius: 6px;
}
.surface-attachment div {
  display: grid;
  gap: 3px;
}
.surface-attachment span {
  color: var(--color-text-secondary);
  font-size: 12px;
}
</style>
