import type { CanvasEdge, CanvasItem } from '../types'
import type { Binding, WorkflowDraft, WorkflowNode, WorkflowNote } from '../workflowTypes'
import { clipboardScope } from './transport'

export type NodeClipboard = { version: 1; scope: string; owner: string; source: string } & (
  | { kind: 'canvas'; items: CanvasItem[]; edges: CanvasEdge[] }
  | {
      kind: 'workflow'
      nodes: WorkflowNode[]
      notes: WorkflowNote[]
      routes: WorkflowDraft['routes']
    }
)
export const clipboardMime = 'application/x-pictoria-nodes'
const prefix = 'PICTORIA_NODES_V1\n'
export const clipboardContext = (owner: string, source: string) => ({
  version: 1 as const,
  scope: clipboardScope,
  owner,
  source,
})
export const cloneNodes = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export function encodeNodes(value: NodeClipboard) {
  const text = prefix + JSON.stringify(value)
  if (text.length > 8 * 1024 * 1024) throw new Error('选中内容过大，请分批复制')
  return text
}
const object = (value: unknown): value is Record<string, any> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const point = (value: Record<string, any>) =>
  [value.x, value.y].every(
    (number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1e7,
  )
function binding(value: unknown, depth = 0): value is Binding {
  if (!object(value) || depth > 24) return false
  if ('array' in value)
    return (
      Array.isArray(value.array) &&
      value.array.length <= 256 &&
      value.array.every((item) => binding(item, depth + 1))
    )
  if ('select' in value) return binding(value.select, depth + 1) && Array.isArray(value.path)
  return (
    'literal' in value ||
    typeof value.input === 'string' ||
    (typeof value.node === 'string' && typeof value.output === 'string')
  )
}
export function decodeNodes(text: string): NodeClipboard | undefined {
  if (!text.startsWith(prefix)) return undefined
  if (text.length > 8 * 1024 * 1024) throw new Error('剪贴板内容过大')
  const value = JSON.parse(text.slice(prefix.length))
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let entries = 0
  while (pending.length) {
    const next = pending.pop()!
    if (++entries > 100000 || next.depth > 40) throw new Error('节点内容过于复杂，请分批复制')
    if (next.value && typeof next.value === 'object')
      for (const item of Object.values(next.value))
        pending.push({ value: item, depth: next.depth + 1 })
  }
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.scope !== 'string' ||
    typeof value.owner !== 'string' ||
    typeof value.source !== 'string'
  )
    throw new Error('节点剪贴板格式无效')
  let ids: string[]
  if (value.kind === 'canvas') {
    if (
      !Array.isArray(value.items) ||
      value.items.length > 2000 ||
      !value.items.every(
        (item) =>
          object(item) &&
          typeof item.id === 'string' &&
          point(item) &&
          object(item.content) &&
          ['text', 'asset', 'run', 'draft', 'group'].includes(item.content.kind) &&
          [item.content.width, item.content.height].every(
            (size) =>
              Number.isFinite(size) &&
              size > 0 &&
              size <= (item.content.kind === 'group' ? 100000 : 4000),
          ),
      )
    )
      throw new Error('画布节点格式无效')
    if (
      !Array.isArray(value.edges) ||
      value.edges.length > 8000 ||
      !value.edges.every(
        (edge) =>
          object(edge) &&
          ['source', 'target', 'field'].every((key) => typeof edge[key] === 'string'),
      )
    )
      throw new Error('画布连线格式无效')
    ids = value.items.map((item) => item.id)
  } else if (value.kind === 'workflow') {
    if (
      !Array.isArray(value.nodes) ||
      value.nodes.length > 64 ||
      !value.nodes.every(
        (node) =>
          object(node) &&
          typeof node.id === 'string' &&
          point(node) &&
          object(node.inputs) &&
          Object.values(node.inputs).every((value) => binding(value)),
      )
    )
      throw new Error('工作流节点格式无效')
    if (
      !Array.isArray(value.notes) ||
      value.notes.length > 128 ||
      !value.notes.every(
        (note) =>
          object(note) &&
          typeof note.id === 'string' &&
          point(note) &&
          typeof note.text === 'string' &&
          typeof note.title === 'string',
      ) ||
      !object(value.routes)
    )
      throw new Error('备注格式无效')
    ids = [...value.nodes.map((node) => node.id), ...value.notes.map((note) => `__note:${note.id}`)]
  } else throw new Error('不支持的节点类型')
  if (new Set(ids).size !== ids.length || ids.some((id) => !id || id.length > 200))
    throw new Error('节点 ID 无效')
  return value as NodeClipboard
}
export function assertClipboardOwner(value: NodeClipboard, owner: string) {
  if (value.owner !== owner || value.scope !== clipboardScope)
    throw new Error('请在同一后台、同一创作归属下粘贴节点')
}
