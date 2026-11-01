import { descendants } from '../../../src/canvasDocument'
import type { AssistantSettings } from '../../../src/assistantSettings'
import type { Project, Step } from '../types'

interface ContextSnapshot {
  baseKey: string
  project: Project
  selected: string[]
  steps: Array<Pick<Step, 'id' | 'name' | 'revision' | 'inputSchema'>>
  imagesIncluded: boolean
  imageBindings?: Array<{ itemId: string; assetId: string; name?: string }>
  viewport?: Project['viewport']
}
export function buildAssistantPrompt(
  request: string,
  source: ContextSnapshot,
  messages: readonly { role: string; text: string }[],
  settings: AssistantSettings,
): string {
  const context = JSON.parse(JSON.stringify(source)) as ContextSnapshot
  // 创建栏不是提案操作目标，避免重复携带与画布节点无关的临时输入。
  delete context.project.creation
  if (settings.contextScope === 'selection') {
    const members = descendants(context.project, context.selected)
    if (!members.length) throw new Error('ASSISTANT_SELECTION_REQUIRED')
    const included = new Set(members.map((item) => item.id))
    context.project.items = context.project.items.filter((item) => included.has(item.id))
    context.project.edges = context.project.edges?.filter(
      (edge) => included.has(edge.source) && included.has(edge.target),
    )
  }
  const history = settings.historyMessages
    ? messages.slice(-settings.historyMessages).map(({ role, text }) => ({ role, text }))
    : []
  const encode = () => JSON.stringify({ request, context, history })
  let prompt = encode()
  // 优先保留本次请求与所选范围；历史只按整条消息缩减，不截断用户内容。
  while (prompt.length > settings.contextCharacters && history.length) {
    history.shift()
    prompt = encode()
  }
  if (prompt.length > settings.contextCharacters) throw new Error('ASSISTANT_CONTEXT_LIMIT')
  return prompt
}
