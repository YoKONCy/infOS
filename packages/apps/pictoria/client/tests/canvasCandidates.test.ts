import { describe, expect, it } from 'vitest'
import { canvasCandidates } from '../src/services/canvasCandidates'
import type { CanvasItem } from '../src/types'
const run: CanvasItem = {
  id: 'run',
  x: 0,
  y: 0,
  content: {
    kind: 'run',
    version: 1,
    width: 300,
    height: 180,
    primaryAssetId: 'removed-asset',
    outputIds: ['asset-a', 'asset-b'],
  },
}
const a: CanvasItem = {
  id: 'a',
  x: 0,
  y: 300,
  content: {
    kind: 'asset',
    version: 1,
    width: 300,
    height: 200,
    assetId: 'asset-a',
    mimeType: 'image/png',
  },
}
const b: CanvasItem = {
  id: 'b',
  x: 350,
  y: 300,
  content: {
    kind: 'asset',
    version: 1,
    width: 300,
    height: 200,
    assetId: 'asset-b',
    mimeType: 'image/png',
  },
}
describe('画布候选图归属', () => {
  it('旧画布没有显式候选字段时从任务输出恢复，已删除的主图回退到实际素材', () => {
    const groups = canvasCandidates([run, a, b])
    expect(groups.get('run')?.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(groups.get('a')?.primary?.id).toBe('a')
    expect(groups.get('b')?.parent.id).toBe('run')
  })
  it('删除任务卡片后素材独立展示，不指向失效的候选组', () => {
    expect(
      canvasCandidates([{ ...a, content: { ...a.content, candidateGroupId: 'missing-run' } }]).size,
    ).toBe(0)
  })
})
