import type {
  NativeReasoningSurfaceProps,
  SurfaceNode,
  ThinkingSurfaceProps,
  ToolCallSurfaceProps,
  ToolResultSurfaceProps,
} from '@infos/shared'
import type { ToolCallView } from '../components/tools/toolCallView'
import type { MarkdownRenderBlock } from './markdownSegmentation'

export type ConversationRenderItem =
  | {
      type: 'node'
      id: string
      node: SurfaceNode
      toolResult?: ToolResultSurfaceProps
      children?: ToolCallView[]
    }
  | { type: 'markdown-block'; id: string; block: MarkdownRenderBlock }

export interface ExecutionStep {
  kind: 'thinking' | 'reasoning' | 'tool'
  name?: string
  hasChildren?: boolean
  state: 'running' | 'error' | 'ok'
}

export interface ExecutionSummaryMeta {
  toolCount: number
  thoughtCount: number
  failureCount: number
  totalDurationMs: number
  nitCount: number
  hasDiff: boolean
  diffInsertions: number
  diffDeletions: number
  reminderHint: string
  steps: ExecutionStep[]
}

export interface ExecutionGroup extends ExecutionSummaryMeta {
  id: string
  items: Array<{ item: ConversationRenderItem; index: number }>
}

const executionKinds = new Set<SurfaceNode['kind']>([
  'tool-call',
  'tool-result',
  'native-reasoning',
  'thinking',
  'model-retry',
  'status',
  'progress',
])

function safeParseObject(raw?: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** 从编辑/写入工具结果或参数草稿中提取轻量行数统计，用于外层胶囊徽标 */
function collectDiffMetrics(
  toolName: string,
  argsRaw: string,
  resultRaw: string | undefined,
  isError: boolean,
  target: ExecutionSummaryMeta,
): void {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return
  if (isError) return
  const res = safeParseObject(resultRaw)
  if (typeof res.insertions === 'number' || typeof res.deletions === 'number') {
    const ins = typeof res.insertions === 'number' && res.insertions > 0 ? Math.trunc(res.insertions) : 0
    const del = typeof res.deletions === 'number' && res.deletions > 0 ? Math.trunc(res.deletions) : 0
    target.hasDiff = true
    target.diffInsertions += ins
    target.diffDeletions += del
    return
  }
  const args = safeParseObject(argsRaw)
  const newText =
    typeof args.new_text === 'string'
      ? args.new_text
      : typeof args.content === 'string'
        ? args.content
        : undefined
  const oldText = typeof args.old_text === 'string' ? args.old_text : undefined
  if (newText !== undefined) {
    target.hasDiff = true
    target.diffInsertions += newText ? newText.split(/\r?\n/).length : 0
    if (oldText) target.diffDeletions += oldText.split(/\r?\n/).length
  }
}

/** 从提醒类工具参数中提取首个紧凑时间标签（如 09:30 或 +15m） */
function collectReminderHint(toolName: string, argsRaw: string, target: ExecutionSummaryMeta): void {
  if (target.reminderHint) return
  if (toolName !== 'set_reminder' && toolName !== 'schedule_follow_up') return
  const args = safeParseObject(argsRaw)
  const rawTime = args.time ?? args.TriggerTime
  if (typeof rawTime === 'string' && rawTime.trim()) {
    const trimmed = rawTime.trim()
    const hhmm = trimmed.match(/(\d{1,2}:\d{2})/)
    target.reminderHint = hhmm?.[1] ?? (trimmed.length > 10 ? `${trimmed.slice(0, 10)}…` : trimmed)
    return
  }
  if (typeof args.delay_minutes === 'number' && Number.isFinite(args.delay_minutes)) {
    target.reminderHint = `+${Math.trunc(args.delay_minutes)}m`
  } else if (typeof args.delay_minutes === 'string' && args.delay_minutes.trim()) {
    target.reminderHint = `+${args.delay_minutes.trim()}m`
  }
}

function createEmptyMeta(): ExecutionSummaryMeta {
  return {
    toolCount: 0,
    thoughtCount: 0,
    failureCount: 0,
    totalDurationMs: 0,
    nitCount: 0,
    hasDiff: false,
    diffInsertions: 0,
    diffDeletions: 0,
    reminderHint: '',
    steps: [],
  }
}

/** 正文划分连续执行段；审批、提问、附件与错误等独立内容始终留在段外。 */
export function groupExecutionItems(
  items: readonly ConversationRenderItem[],
  ended: boolean,
): ExecutionGroup[] {
  const groups: ExecutionGroup[] = []
  let current: ExecutionGroup | undefined
  for (const [index, item] of items.entries()) {
    const execution = item.type === 'node' && executionKinds.has(item.node.kind)
    if (!execution || !current) {
      current = {
        id: item.id,
        items: [],
        ...createEmptyMeta(),
      }
      groups.push(current)
    }
    current.items.push({ item, index })
    if (item.type === 'node' && item.node.kind === 'thinking') {
      const thinking = item.node.props as Partial<ThinkingSurfaceProps>
      current.thoughtCount++
      if (typeof thinking.durationMs === 'number') current.totalDurationMs += thinking.durationMs
      current.steps.push({
        kind: 'thinking',
        state: !ended && thinking.phase === 'preview' ? 'running' : 'ok',
      })
    } else if (item.type === 'node' && item.node.kind === 'native-reasoning') {
      const reasoning = item.node.props as Partial<NativeReasoningSurfaceProps>
      current.thoughtCount++
      if (typeof reasoning.durationMs === 'number') current.totalDurationMs += reasoning.durationMs
      current.steps.push({
        kind: 'reasoning',
        state: !ended && reasoning.phase !== 'committed' ? 'running' : 'ok',
      })
    } else if (item.type === 'node' && item.node.kind === 'tool-call') {
      const call = item.node.props as ToolCallSurfaceProps
      const parentFailed = Boolean(
        item.toolResult?.isError || call.state === 'failed' || (ended && !item.toolResult),
      )
      const childList = item.children ?? []
      current.toolCount += 1 + childList.length
      if (parentFailed) current.failureCount++
      current.failureCount += childList.filter((child) => child.isError || child.interrupted).length
      if (typeof item.toolResult?.durationMs === 'number') {
        current.totalDurationMs += item.toolResult.durationMs
      }
      if (call.name === 'run_script') {
        current.nitCount += Math.max(1, childList.length)
      }
      collectDiffMetrics(
        call.name,
        call.args || call.argsPreview || '',
        item.toolResult?.result,
        parentFailed,
        current,
      )
      collectReminderHint(call.name, call.args || call.argsPreview || '', current)

      if (childList.length) {
        current.steps.push({
          kind: 'tool',
          name: call.name,
          hasChildren: true,
          state: parentFailed ? 'error' : !item.toolResult ? 'running' : 'ok',
        })
        for (const child of childList) {
          const childFailed = Boolean(
            child.isError || child.interrupted || (ended && child.result === undefined),
          )
          collectDiffMetrics(child.name, child.args, child.result, childFailed, current)
          collectReminderHint(child.name, child.args, current)
          current.steps.push({
            kind: 'tool',
            name: child.name,
            state: childFailed ? 'error' : child.result === undefined ? 'running' : 'ok',
          })
        }
      } else {
        current.steps.push({
          kind: 'tool',
          name: call.name,
          hasChildren: false,
          state: parentFailed ? 'error' : !item.toolResult ? 'running' : 'ok',
        })
      }
    }
    if (!execution) current = undefined
  }
  return groups
}

/**
 * 汇总整张 Surface 的隐藏执行过程元数据（供主会话 processCollapsed 外层折叠胶囊使用）
 */
export function summarizeSurfaceProcess(
  nodes: readonly SurfaceNode[],
  ended: boolean,
): ExecutionSummaryMeta {
  const meta = createEmptyMeta()
  const toolResults = new Map<string, ToolResultSurfaceProps>()
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      const res = node.props as ToolResultSurfaceProps
      toolResults.set(res.callId, res)
    }
  }
  const nitParentIds = new Set<string>()
  const childCountByParent = new Map<string, number>()
  for (const node of nodes) {
    if (node.kind === 'tool-call') {
      const call = node.props as ToolCallSurfaceProps
      if (call.name === 'run_script') nitParentIds.add(call.callId)
    }
  }
  for (const node of nodes) {
    if (node.kind !== 'tool-call') continue
    const call = node.props as ToolCallSurfaceProps
    if (call.parentCallId && call.parentCallId !== call.callId && nitParentIds.has(call.parentCallId)) {
      childCountByParent.set(call.parentCallId, (childCountByParent.get(call.parentCallId) ?? 0) + 1)
    }
  }

  for (const node of nodes) {
    if (node.kind === 'thinking') {
      const thinking = node.props as Partial<ThinkingSurfaceProps>
      meta.thoughtCount++
      if (typeof thinking.durationMs === 'number') meta.totalDurationMs += thinking.durationMs
      meta.steps.push({
        kind: 'thinking',
        state: !ended && thinking.phase === 'preview' ? 'running' : 'ok',
      })
    } else if (node.kind === 'native-reasoning') {
      const reasoning = node.props as Partial<NativeReasoningSurfaceProps>
      meta.thoughtCount++
      if (typeof reasoning.durationMs === 'number') meta.totalDurationMs += reasoning.durationMs
      meta.steps.push({
        kind: 'reasoning',
        state: !ended && reasoning.phase !== 'committed' ? 'running' : 'ok',
      })
    } else if (node.kind === 'tool-call') {
      const call = node.props as ToolCallSurfaceProps
      const res = toolResults.get(call.callId)
      const isNested = Boolean(
        call.parentCallId && call.parentCallId !== call.callId && nitParentIds.has(call.parentCallId),
      )
      const failed = Boolean(res?.isError || call.state === 'failed' || (ended && !res))
      meta.toolCount++
      if (failed) meta.failureCount++
      if (!isNested && typeof res?.durationMs === 'number') {
        meta.totalDurationMs += res.durationMs
      }
      const childCount = childCountByParent.get(call.callId) ?? 0
      if (call.name === 'run_script') {
        meta.nitCount += Math.max(1, childCount)
      }
      collectDiffMetrics(call.name, call.args || call.argsPreview || '', res?.result, failed, meta)
      collectReminderHint(call.name, call.args || call.argsPreview || '', meta)
      meta.steps.push({
        kind: 'tool',
        name: call.name,
        hasChildren: childCount > 0,
        state: failed ? 'error' : !res ? 'running' : 'ok',
      })
    }
  }
  return meta
}
