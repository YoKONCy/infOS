import { describe, expect, it } from 'vitest'
import { editedMessageMetadata } from '@infos/backend/repositories/messageEdit'

describe('消息编辑展示块', () => {
  it('新正文替换旧的多个正文块，同时保留思考、工具和审计元数据', () => {
    const thinking = { blockId: 'thinking', kind: 'thinking', content: '思考', sequence: 0 }
    const tool = { blockId: 'tool', kind: 'tool', callId: 'call', name: 'read_file', sequence: 2 }
    const result = JSON.parse(
      editedMessageMetadata(
        JSON.stringify({
          model: 'test',
          contentBlocks: [
            thinking,
            { blockId: 'text-1', kind: 'narration', content: '旧正文', sequence: 1 },
            tool,
            { blockId: 'text-2', kind: 'narration', content: '旧结尾', sequence: 3 },
          ],
        }),
        '新正文',
      ),
    )
    expect(result.model).toBe('test')
    expect(result.contentBlocks).toEqual([
      thinking,
      { blockId: 'text-1', kind: 'narration', content: '新正文', phase: 'final', sequence: 1 },
      tool,
    ])
  })
  it('只有工具块或元数据损坏时仍能保存并显示新正文', () => {
    const result = JSON.parse(editedMessageMetadata('{"contentBlocks":[]}', '新正文'))
    expect(result.contentBlocks[0]).toMatchObject({ kind: 'narration', content: '新正文' })
    expect(JSON.parse(editedMessageMetadata('损坏', '新正文'))).toEqual({})
  })
})
