import type { SurfaceNode, ToolCallSurfaceProps, ToolResultSurfaceProps } from '@infos/shared'
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

export interface ExecutionGroup {
  id: string
  items: Array<{ item: ConversationRenderItem; index: number }>
  toolCount: number
  failureCount: number
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
      current = { id: item.id, items: [], toolCount: 0, failureCount: 0 }
      groups.push(current)
    }
    current.items.push({ item, index })
    if (item.type === 'node' && item.node.kind === 'tool-call') {
      const call = item.node.props as ToolCallSurfaceProps
      current.toolCount += 1 + (item.children?.length ?? 0)
      if (item.toolResult?.isError || call.state === 'failed' || (ended && !item.toolResult))
        current.failureCount++
      current.failureCount +=
        item.children?.filter((child) => child.isError || child.interrupted).length ?? 0
    }
    if (!execution) current = undefined
  }
  return groups
}
