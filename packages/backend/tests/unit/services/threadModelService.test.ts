import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDrizzleConnection, closeDrizzleConnection } from '../../../src/database'
import { ThreadRepository } from '../../../src/repositories/thread.repo'
import { ModelRepository } from '../../../src/repositories/model.repo'
import { ConfigRepository } from '../../../src/repositories/config.repo'
import { ModelRoleResolver } from '../../../src/services/llm/modelRoles'
import { ThreadModelService } from '../../../src/services/thread/threadModelService'

let connection: ReturnType<typeof createDrizzleConnection>
let threads: ThreadRepository
let models: ModelRepository
let config: ConfigRepository
let roles: ModelRoleResolver
let service: ThreadModelService
let mainId: number
let otherId: number

beforeEach(async () => {
  connection = createDrizzleConnection(':memory:')
  const db = connection
  threads = new ThreadRepository(db)
  models = new ModelRepository(db)
  config = new ConfigRepository(db)
  roles = new ModelRoleResolver(config, models)
  service = new ThreadModelService(threads, models, roles)
  mainId = (
    await models.create({
      name: '主用',
      provider: 'openai',
      modelId: 'gpt-test',
      apiKey: '私密密钥',
      reasoningEffort: 'medium',
      contextWindowTokens: 32000,
    })
  ).id
  otherId = (
    await models.create({
      name: '视觉',
      provider: 'gemini',
      modelId: '[渠道]gemini-4-argon',
      apiKey: '另一密钥',
      reasoningEffort: 'low',
      enableVision: true,
    })
  ).id
  await config.set('model.main', String(mainId))
  await config.set('model.agent.pero', String(otherId))
  await threads.createThread({ id: 'a', agentId: 'pero', channel: 'desktop' })
  await threads.createThread({ id: 'b', agentId: 'pero', channel: 'desktop' })
})
afterEach(() => closeDrizzleConnection(connection))

describe('会话模型和思考强度', () => {
  it('音频能力从所选卡片手动声明读取，不根据 Gemini 模型名称开启', async () => {
    await service.update('a', { modelConfigId: otherId, reasoningEffort: null })
    expect((await service.settings('a')).effective.nativeAudioAvailable).toBe(false)
    await models.update(otherId, { enableAudioInput: true })
    expect((await service.settings('a')).effective.nativeAudioAvailable).toBe(true)
    await models.update(mainId, { enableAudioInput: true })
    await service.update('a', { modelConfigId: mainId, reasoningEffort: null })
    expect((await service.settings('a')).effective).toMatchObject({
      enableAudioInput: true,
      nativeAudioAvailable: false,
    })
  })
  it('未配置时跟随全局主模型，配置后隔离会话且不修改模型卡片', async () => {
    expect(await service.resolve('a', 'pero')).toMatchObject({
      configId: mainId,
      reasoningEffort: 'medium',
    })
    await service.update('a', { modelConfigId: otherId, reasoningEffort: 'max' })
    expect(await service.resolve('a', 'pero')).toMatchObject({
      configId: otherId,
      reasoningEffort: 'high',
      enableVision: true,
    })
    expect(await service.resolve('b', 'pero')).toMatchObject({
      configId: mainId,
      reasoningEffort: 'medium',
    })
    expect((await models.findById(otherId))?.reasoningEffort).toBe('low')
    expect(await new ThreadModelService(threads, models, roles).settings('a')).toMatchObject({
      modelConfigId: otherId,
      reasoningEffort: 'high',
    })
  })

  it('恢复默认保留跟随语义，并使用主模型和卡片的后续修改', async () => {
    await service.update('a', { modelConfigId: null, reasoningEffort: null })
    await config.set('model.main', String(otherId))
    expect(await service.resolve('a', 'pero')).toMatchObject({
      configId: otherId,
      reasoningEffort: 'low',
    })
    await models.update(otherId, { reasoningEffort: 'medium' })
    expect(await service.resolve('a', 'pero')).toMatchObject({ reasoningEffort: 'medium' })
  })

  it('返回列表不泄露密钥或地址，删除已选卡片后自动恢复默认', async () => {
    await service.update('a', { modelConfigId: otherId, reasoningEffort: 'low' })
    const settings = await service.settings('a')
    expect(settings.effective.enableVision).toBe(true)
    expect(settings.models.every((model) => !('apiKey' in model) && !('apiBase' in model))).toBe(
      true,
    )
    await models.deleteById(otherId)
    expect(await service.settings('a')).toMatchObject({
      modelConfigId: null,
      effective: { modelId: 'gpt-test' },
    })
    expect(await service.resolve('a', 'pero')).toMatchObject({
      configId: mainId,
      reasoningEffort: 'low',
    })
  })

  it('拒绝失效卡片，后台和明确委派模型保留原有选择', async () => {
    await expect(
      service.update('a', { modelConfigId: 99999, reasoningEffort: null }),
    ).rejects.toThrow('模型卡片已删除')
    expect((await threads.getThread('a'))?.modelConfigId).toBeNull()
    await threads.createThread({
      id: 'task',
      agentId: 'pero',
      channel: 'desktop',
      purpose: 'background_task',
    })
    await expect(
      service.update('task', { modelConfigId: mainId, reasoningEffort: null }),
    ).rejects.toThrow('仅支持普通聊天')
    expect(await service.resolve('task', 'pero')).toMatchObject({ configId: otherId })
    expect(await service.resolve('a', 'pero', otherId)).toMatchObject({
      configId: otherId,
      reasoningEffort: 'low',
    })
  })

  it('会话强度覆盖回退模型，但按各模型能力校正且不改写卡片', async () => {
    await config.set(`model.fallbacks.${mainId}`, JSON.stringify([otherId]))
    await service.update('a', { modelConfigId: mainId, reasoningEffort: 'max' })
    const resolved = await service.resolve('a', 'pero')
    expect(resolved?.reasoningEffort).toBe('max')
    expect(resolved?.fallbackModels?.[0]).toMatchObject({
      configId: otherId,
      reasoningEffort: 'high',
    })
    expect((await models.findById(mainId))?.reasoningEffort).toBe('medium')
  })
})
