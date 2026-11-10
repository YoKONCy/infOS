import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ContextRegion } from '@infos/shared'
import {
  ContextRegionRegistry,
  ContextRegionSelector,
} from '@infos/backend/services/context/contextRegionRuntime'

function region(
  input: Partial<ContextRegion> & { regionId: string; content: string },
): ContextRegion {
  return {
    providerId: 'test.provider',
    kind: 'custom',
    trust: 'derived',
    priority: 100,
    required: false,
    tokenEstimate: 10,
    contentHash: createHash('sha256').update(input.content).digest('hex'),
    delivery: 'system',
    sourceObjectRefs: [],
    provenance: {},
    ...input,
  }
}

describe('Context Region Runtime', () => {
  it('诊断清单不重复消耗已由必选渲染结果计费的预算', async () => {
    const selector = new ContextRegionSelector({
      tokenizerId: '字符计费',
      countTokens: (text) => text.length,
    })
    const result = await selector.compileAsync(
      [
        region({
          regionId: 'rendered',
          content: '完整提示词',
          required: true,
          delivery: 'manifest-only',
        }),
        region({
          regionId: 'diagnostic',
          content: '完整提示词',
          delivery: 'manifest-only',
          deduplicationKey: '诊断',
        }),
      ],
      5,
    )
    expect(result.usedTokens).toBe(5)
    expect(result.manifest.find((entry) => entry.regionId === 'diagnostic')).toMatchObject({
      selected: true,
      tokenEstimate: 0,
    })
  })
  it('应使用注入Tokenizer生成确定性Snapshot并精确执行预算', async () => {
    const tokenizer = { tokenizerId: 'test-v1', countTokens: (content: string) => content.length }
    const selector = new ContextRegionSelector(tokenizer)
    const input = [
      region({ regionId: 'a', content: '12345', tokenEstimate: 999, priority: 200 }),
      region({ regionId: 'b', content: '1234', tokenEstimate: 999, priority: 100 }),
    ]
    const first = await selector.compileAsync(input, 5)
    const second = await selector.compileAsync([...input].reverse(), 5)
    expect(first.usedTokens).toBe(5)
    expect(first.selected.map((item) => item.regionId)).toEqual(['a'])
    expect(first.snapshotId).toBe(second.snapshotId)
  })

  it('懒Region被预算淘汰时不应物化正文', async () => {
    const materialize = vi.fn(async () => '昂贵正文')
    const selector = new ContextRegionSelector({
      tokenizerId: 'test-v1',
      countTokens: (content) => content.length,
    })
    const result = await selector.compileAsync(
      [
        region({ regionId: 'required', content: '12345', required: true, tokenEstimate: 5 }),
        region({
          regionId: 'lazy',
          content: '',
          tokenEstimate: 10,
          materialize,
          priority: 10,
        }),
      ],
      5,
    )
    expect(materialize).not.toHaveBeenCalled()
    expect(result.manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ regionId: 'lazy', reason: 'budget_exceeded' }),
      ]),
    )
  })

  it('Registry缓存应按来源Generation失效并使用Copy-on-Write返回值', async () => {
    const registry = new ContextRegionRegistry()
    let generation = 1
    registry.register({
      providerId: 'cache',
      provide: () => [
        region({
          providerId: 'cache',
          regionId: 'same',
          content: `正文${generation}`,
          sourceGeneration: generation,
        }),
      ],
    })
    const request = {
      agentId: 'pero',
      threadId: 'current',
      channel: 'desktop',
      tokenBudget: 0,
      now: new Date().toISOString(),
    }
    const first = await registry.collect(request)
    first[0]!.content = '调用方修改'
    const second = await registry.collect(request)
    expect(second[0]!.content).toBe('正文1')
    generation = 2
    expect((await registry.collect(request))[0]!.content).toBe('正文2')
    expect(registry.invalidateProvider('cache')).toBeGreaterThan(0)
  })

  it('应按 required、priority 稳定选择并记录预算淘汰', () => {
    const selector = new ContextRegionSelector()
    const result = selector.compile(
      [
        region({ regionId: 'required', content: '规则', required: true, tokenEstimate: 20 }),
        region({ regionId: 'high', content: '高优先级', priority: 500, tokenEstimate: 15 }),
        region({ regionId: 'low', content: '低优先级', priority: 100, tokenEstimate: 15 }),
      ],
      35,
    )
    expect(result.selected.map((item) => item.regionId)).toEqual(['required', 'high'])
    expect(result.usedTokens).toBe(35)
    expect(result.manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ regionId: 'low', selected: false, reason: 'budget_exceeded' }),
      ]),
    )
  })

  it('required 超出预算应 fail-closed，重复和过期 Region 应进入 Manifest', () => {
    const selector = new ContextRegionSelector()
    expect(() =>
      selector.compile(
        [region({ regionId: 'required', content: '规则', required: true, tokenEstimate: 21 })],
        20,
      ),
    ).toThrow('CONTEXT_REQUIRED_BUDGET_EXCEEDED')
    const digest = createHash('sha256').update('同内容').digest('hex')
    const result = selector.compile(
      [
        region({ regionId: 'first', content: '同内容', contentHash: digest, priority: 200 }),
        region({ regionId: 'duplicate', content: '同内容', contentHash: digest, priority: 100 }),
        region({
          regionId: 'expired',
          content: '过期',
          validUntil: new Date(0).toISOString(),
        }),
      ],
      0,
    )
    expect(result.manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ regionId: 'duplicate', reason: 'duplicate' }),
        expect.objectContaining({ regionId: 'expired', reason: 'expired' }),
      ]),
    )
  })

  it('Registry 应按 Provider ID 稳定收集且拒绝重复注册', async () => {
    const registry = new ContextRegionRegistry()
    registry.register({
      providerId: 'b',
      provide: () => [region({ regionId: 'b', content: 'B' })],
    })
    registry.register({
      providerId: 'a',
      provide: () => [region({ regionId: 'a', content: 'A' })],
    })
    expect(() => registry.register({ providerId: 'a', provide: () => [] })).toThrow(
      'CONTEXT_PROVIDER_DUPLICATE',
    )
    const regions = await registry.collect({
      agentId: 'pero',
      threadId: 'current',
      channel: 'desktop',
      tokenBudget: 0,
      now: new Date().toISOString(),
    })
    expect(regions.map((item) => item.regionId)).toEqual(['a', 'b'])
  })
})

