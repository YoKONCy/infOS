import { describe, expect, it } from 'vitest'
import { applyReferenceUses, videoStartField } from '../src/creativeInputs'
import { applyCanvasOperations, type StudioDocument } from '../src/canvasDocument'

describe('参考图用途与已确认草稿修改', () => {
  it('用途跟随实际输入位置，保留原始提示词和图片顺序', () => {
    const inputs = { prompt: '雨后的街角', images: [{ assetId: 'scene' }, { assetId: 'person' }] }
    const result = applyReferenceUses({ properties: { prompt: { type: 'string' } } }, inputs, [
      { field: 'images', assetId: 'person', purpose: 'subject' },
      { field: 'images', assetId: 'removed', purpose: 'style' },
    ])
    expect(result.prompt).toBe(
      '雨后的街角\n\n【本次参考图用途】\nimages 第 2 张参考图：主体身份：参考主体外观与身份，不照搬背景、服装或构图。',
    )
    expect(result.images).toEqual([{ assetId: 'scene' }, { assetId: 'person' }])
    expect(inputs.prompt).toBe('雨后的街角')
  })
  it('没有显式标注时原样传递', () => {
    const inputs = { prompt: '原文', images: [{ assetId: 'image' }] }
    expect(applyReferenceUses({ properties: { prompt: { type: 'string' } } }, inputs)).toBe(inputs)
  })
  it('不能把普通图片列表猜成起始帧能力', () => {
    expect(videoStartField({ properties: { images: { type: 'array' } } })).toBeUndefined()
    expect(
      videoStartField({
        properties: { images: { type: 'array' } },
        'x-pictoria-video': { startFrameField: 'images' },
      }),
    ).toBe('images')
  })
  it('按顺序合并新建草稿与后续修改，失败时不改写原文档', () => {
    const document: StudioDocument = { id: 'canvas', title: '画布', items: [], edges: [] }
    const result = applyCanvasOperations(document, [
      {
        type: 'draft',
        id: 'draft',
        stepId: 'edit',
        inputs: { prompt: '原描述', size: 512 },
        x: 10,
        y: 20,
      },
      { type: 'update_draft', id: 'draft', inputs: { prompt: '选图中的侧光' } },
    ])
    expect(result.document.items[0]?.content.inputs).toEqual({ prompt: '选图中的侧光', size: 512 })
    expect(document.items).toEqual([])
    expect(() =>
      applyCanvasOperations(result.document, [
        { type: 'update_draft', id: 'draft', inputs: { prompt: '不应落盘' } },
        { type: 'update_draft', id: 'missing', inputs: { prompt: '失败' } },
      ]),
    ).toThrow('CANVAS_NODE_MISSING')
    expect(result.document.items[0]?.content.inputs?.prompt).toBe('选图中的侧光')
  })
  it('修改草稿移除旧字段连线，之后显式建立的新连线和历史来源仍保留', () => {
    const document: StudioDocument = {
      id: 'canvas',
      title: '画布',
      items: [
        { id: 'source', x: 0, y: 0, content: { kind: 'asset', width: 300, height: 200 } },
        {
          id: 'draft',
          x: 350,
          y: 0,
          content: { kind: 'draft', width: 300, height: 200, inputs: {} },
        },
      ],
      edges: [
        { id: 'old', source: 'source', target: 'draft', field: 'images' },
        { id: 'history', source: 'source', target: 'draft', field: 'images', historical: true },
      ],
    }
    const result = applyCanvasOperations(document, [
      { type: 'update_draft', id: 'draft', inputs: { images: [] } },
      { type: 'connect', id: 'new', source: 'source', target: 'draft', field: 'images' },
    ])
    expect(result.document.edges).toEqual([
      { id: 'history', source: 'source', target: 'draft', field: 'images', historical: true },
      { id: 'new', source: 'source', target: 'draft', field: 'images' },
    ])
    expect(document.edges?.map((edge) => edge.id)).toEqual(['old', 'history'])
  })
})
