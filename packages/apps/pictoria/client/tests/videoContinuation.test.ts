// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  continuationParameters,
  continuationReferences,
  tailFrameTimes,
  videoAncestors,
} from '../src/services/videoContinuation'
import type { CanvasItem, Step } from '../src/types'

describe('接续时间与片段来源', () => {
  it('尾部候选位于可定位范围内，短视频也不会定位到结束点之外', () => {
    const times = tailFrameTimes(8)
    expect(times.every((time) => time >= 0 && time < 8)).toBe(true)
    expect(times.at(-1)).toBeCloseTo(7.999, 6)
    expect(tailFrameTimes(0.0005)).toEqual([0])
    expect(() => tailFrameTimes(Infinity)).toThrow('VIDEO_DURATION_INVALID')
    expect(() => tailFrameTimes(0)).toThrow('VIDEO_DURATION_INVALID')
  })
  it('序列沿固定素材来源追溯，其他生成分支不混入当前序列', () => {
    const item = (id: string, assetId: string, previous?: string): CanvasItem => ({
      id,
      x: 0,
      y: 0,
      content: {
        version: 1,
        kind: 'asset',
        width: 300,
        height: 200,
        assetId,
        mimeType: 'video/mp4',
        ...(previous
          ? {
              continuation: {
                version: 1 as const,
                source: { assetId: previous },
                sourceItemId: previous,
                sourceName: previous,
                sourceTime: 3.2,
                sourceDuration: 4,
                frame: { assetId: `frame-${id}` },
              },
            }
          : {}),
      },
    })
    const first = item('first', 'video-a'),
      second = item('second', 'video-b', 'video-a'),
      alternative = item('alternative', 'video-c', 'video-a'),
      third = item('third', 'video-d', 'video-b')
    expect(
      videoAncestors([first, second, alternative, third], third).map((entry) => entry.id),
    ).toEqual(['first', 'second', 'third'])
  })
  it('同一字段只沿用已标注的辅助图片，不带入旧起始帧、构图图或未标注图片', () => {
    const asset = { type: 'object', properties: { assetId: { type: 'string' } } }
    const step: Step = {
      id: 'video',
      name: '视频',
      revision: 1,
      available: true,
      usageDescription: '',
      inputSchema: {
        type: 'object',
        'x-pictoria-video': { startFrameField: 'start' },
        properties: {
          start: asset,
          references: { type: 'array', items: asset },
        },
      },
    }
    const result = continuationReferences(
      step,
      {
        start: { assetId: 'old-start' },
        references: [
          { assetId: 'unused' },
          { assetId: 'subject' },
          { assetId: 'layout' },
          { assetId: 'style' },
        ],
      },
      [
        { field: 'start', assetId: 'old-start', purpose: 'subject' },
        { field: 'references', assetId: 'style', purpose: 'style' },
        { field: 'references', assetId: 'layout', purpose: 'composition' },
        { field: 'references', assetId: 'subject', purpose: 'subject' },
        { field: 'references', assetId: 'missing', purpose: 'style' },
      ],
    )
    expect(result).toEqual({
      inputs: { references: [{ assetId: 'subject' }, { assetId: 'style' }] },
      uses: [
        { field: 'references', assetId: 'subject', purpose: 'subject' },
        { field: 'references', assetId: 'style', purpose: 'style' },
      ],
    })
  })
  it('只继承兼容的标量参数，范围外的值使用目标步骤默认值', () => {
    const step: Step = {
      id: 'video',
      name: '视频',
      revision: 1,
      available: true,
      usageDescription: '',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          duration: { type: 'integer', minimum: 2, maximum: 8, default: 4 },
          ratio: { type: 'string', enum: ['16:9', '9:16'], default: '16:9' },
          sound: { type: 'boolean', default: false },
          internal: { type: 'object' },
        },
      },
    }
    expect(
      continuationParameters(step, {
        prompt: '旧提示词',
        duration: 15,
        ratio: '9:16',
        sound: true,
        internal: { old: true },
      }),
    ).toEqual({ duration: 4, ratio: '9:16', sound: true })
  })
})
