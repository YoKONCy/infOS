import type { AppContext } from '../../container'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'

/** 候选配置已通过真实向量校验后，整体保存并切换；失败则恢复配置和运行时。 */
export async function commitEmbeddingConfig(
  ctx: Pick<
    AppContext,
    'configRepo' | 'embeddingService' | 'storeRegistry' | 'reloadEmbeddingConfig'
  >,
  items: Array<readonly [string, string]>,
  expected: { model: string; dimension: number },
): Promise<void> {
  const original = ctx.embeddingService.getConfig()
  const previous = await Promise.all(
    items.map(async ([key]) => [key, await ctx.configRepo.get(key)] as const),
  )
  const previousValues = new Map(previous)
  await ctx.configRepo.replaceMany(items)
  try {
    await ctx.reloadEmbeddingConfig()
    const active = ctx.embeddingService.getConfig()
    if (
      active.dimension !== expected.dimension ||
      active.model !== expected.model ||
      ctx.storeRegistry.getDimension() !== expected.dimension
    )
      throw new AppError('CONFIG_ERROR', {
        message: t('server.index-maintenance', '向量配置未完整生效，请重新保存并激活配置'),
      })
  } catch (error) {
    try {
      await ctx.configRepo.replaceMany(previous)
      await ctx.reloadEmbeddingConfig()
      const restored = ctx.embeddingService.getConfig()
      const restoredDimension = Number(
        previousValues.get('embedding.dimension') ?? original.dimension,
      )
      if (
        restored.model !== (previousValues.get('embedding.model') ?? original.model) ||
        restored.dimension !== restoredDimension ||
        ctx.storeRegistry.getDimension() !== restoredDimension
      )
        throw new AppError('CONFIG_ERROR', {
          message: t('server.index-maintenance', '向量配置未完整生效，请重新保存并激活配置'),
        })
    } catch (rollbackError) {
      throw new AppError('CONFIG_ERROR', {
        message: t('server.index-maintenance', '向量配置切换及恢复失败，请检查服务日志后重新激活'),
        cause: new AggregateError([error, rollbackError]),
      })
    }
    throw error
  }
}
