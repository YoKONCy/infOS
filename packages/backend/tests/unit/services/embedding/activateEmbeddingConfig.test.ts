import { describe, expect, it, vi } from 'vitest'
import { commitEmbeddingConfig } from '@infos/backend/services/embedding/activateEmbeddingConfig'

function fixture() {
  const saved = new Map<string, string>([
    ['embedding.model', 'old-model'],
    ['embedding.dimension', '1536'],
  ])
  let active = { model: 'old-model', dimension: 1536 }
  let registryDimension = 1536
  const context = {
    configRepo: {
      get: async (key: string) => saved.get(key),
      replaceMany: async (items: ReadonlyArray<readonly [string, string | undefined]>) => {
        for (const [key, value] of items) {
          if (value === undefined) saved.delete(key)
          else saved.set(key, value)
        }
      },
    },
    embeddingService: { getConfig: () => active },
    storeRegistry: { getDimension: () => registryDimension },
    reloadEmbeddingConfig: vi.fn(async () => {
      active = {
        model: saved.get('embedding.model')!,
        dimension: Number(saved.get('embedding.dimension')),
      }
      registryDimension = active.dimension
    }),
  }
  return { context, saved }
}
const candidate: Array<readonly [string, string]> = [
  ['embedding.model', 'new-model'],
  ['embedding.dimension', '3072'],
  ['embedding.apiBase', 'https://embedding.example/v1'],
]

describe('Embedding 配置激活的一致性', () => {
  it('成功后持久配置、运行时和索引目标都为3072维', async () => {
    const { context, saved } = fixture()
    await commitEmbeddingConfig(context as never, candidate, {
      model: 'new-model',
      dimension: 3072,
    })
    expect(saved.get('embedding.dimension')).toBe('3072')
    expect(context.embeddingService.getConfig()).toEqual({ model: 'new-model', dimension: 3072 })
    expect(context.storeRegistry.getDimension()).toBe(3072)
  })

  it('切换中途失败时恢复旧模型、维度及原先缺失的键', async () => {
    const { context, saved } = fixture()
    const apply = context.reloadEmbeddingConfig.getMockImplementation()!
    context.reloadEmbeddingConfig.mockImplementationOnce(async () => {
      await apply()
      throw new Error('模拟索引句柄切换失败')
    })
    await expect(
      commitEmbeddingConfig(context as never, candidate, { model: 'new-model', dimension: 3072 }),
    ).rejects.toThrow('模拟索引句柄切换失败')
    expect(saved.get('embedding.model')).toBe('old-model')
    expect(saved.get('embedding.dimension')).toBe('1536')
    expect(saved.has('embedding.apiBase')).toBe(false)
    expect(context.embeddingService.getConfig()).toEqual({ model: 'old-model', dimension: 1536 })
    expect(context.storeRegistry.getDimension()).toBe(1536)
  })

  it('重载未报错但实际未切换时仍拒绝成功并恢复配置', async () => {
    const { context, saved } = fixture()
    context.reloadEmbeddingConfig.mockImplementationOnce(async () => {})
    await expect(
      commitEmbeddingConfig(context as never, candidate, { model: 'new-model', dimension: 3072 }),
    ).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    expect(saved.get('embedding.dimension')).toBe('1536')
    expect(context.storeRegistry.getDimension()).toBe(1536)
  })
})
