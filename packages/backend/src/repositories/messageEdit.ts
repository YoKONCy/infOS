/** 编辑正文时同步展示块，保留工具、思考及原始审计信息。 */
export function editedMessageMetadata(raw: string | null, content: string): string {
  let metadata: Record<string, unknown> = {}
  try {
    const value = JSON.parse(raw || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) metadata = value
  } catch {
    /* 损坏的元数据不能阻止正文保存。 */
  }
  if (Array.isArray(metadata.contentBlocks)) {
    let replaced = false
    const blocks = metadata.contentBlocks.flatMap((block: Record<string, unknown> | null) => {
      if (!block || typeof block !== 'object') return []
      if (block.kind !== 'narration') return [block]
      if (replaced) return []
      replaced = true
      return [{ ...block, content, phase: 'final' }]
    })
    if (!replaced) blocks.push({ blockId: 'edited-body', kind: 'narration', phase: 'final', turn: 0, content })
    metadata.contentBlocks = blocks.map((block, sequence) => ({ ...block, sequence }))
  }
  return JSON.stringify(metadata)
}
