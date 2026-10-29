import { describe, expect, it, vi, afterEach } from 'vitest'
import { SocialActivityStore } from '@infos/social/runtime/socialActivityStore'

const scope = { platform: 'qq', agentId: 'pero', accountId: 'account-1', channelId: 'group-1' }
afterEach(() => vi.useRealTimers())

describe('群聊参与节奏持久化', () => {
  it('重启保留冷却截止时间和连续次数，同一完成回合不会重复累加', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T04:00:00Z'))
    const values = new Map<string, string>()
    const config = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: string) => {
        values.set(key, value)
      },
    }
    const store = new SocialActivityStore(config)
    await store.complete(scope, { type: 'pass' }, 'turn-1')
    const until = Date.now() + 600_000
    const restarted = new SocialActivityStore(config)
    await restarted.load()
    await restarted.complete(scope, { type: 'pass' }, 'turn-1')
    expect(restarted.get(scope)).toMatchObject({
      mode: 'normal',
      passCount: 1,
      reviewNotBefore: until,
    })
    await restarted.complete(scope, { type: 'pass' }, 'turn-2')
    expect(restarted.get(scope)).toMatchObject({
      passCount: 2,
      reviewNotBefore: Date.now() + 1_200_000,
    })
    await restarted.setMode(scope, 'normal')
    await restarted.complete(scope, { type: 'pass' }, 'turn-2')
    expect(restarted.get(scope)).toMatchObject({ mode: 'normal', passCount: 0, reviewNotBefore: 0 })
    await restarted.setMode(scope, 'mention_only')
    const low = new SocialActivityStore(config)
    await low.load()
    expect(low.get(scope)).toMatchObject({ mode: 'mention_only', passCount: 0 })
    await low.wake(scope)
    await low.complete(scope, { type: 'reply' }, 'mention-turn')
    expect(low.get(scope)).toMatchObject({ mode: 'mention_only', passCount: 0 })
  })

  it('并发保存不同群不会相互覆盖，账号、平台和角色同名也分别隔离', async () => {
    const values = new Map<string, string>()
    const config = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: string) => {
        values.set(key, value)
      },
    }
    const store = new SocialActivityStore(config)
    const scopes = [
      scope,
      { ...scope, channelId: 'group-2' },
      { ...scope, platform: 'discord' },
      { ...scope, accountId: 'account-2' },
      { ...scope, agentId: 'penora' },
    ]
    await Promise.all(scopes.map((item) => store.complete(item, { type: 'pass' })))
    const restarted = new SocialActivityStore(config)
    await restarted.load()
    await restarted.setMode(scope, 'mention_only')
    expect(restarted.get(scope).mode).toBe('mention_only')
    for (const item of scopes.slice(1))
      expect(restarted.get(item)).toMatchObject({ mode: 'normal', passCount: 1 })
  })

  it('保存失败不发布虚假的恢复状态，后续保存仍可继续', async () => {
    const set = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('模拟磁盘写入失败'))
      .mockResolvedValue(undefined)
    const store = new SocialActivityStore({ get: async () => undefined, set })
    await store.setMode(scope, 'mention_only')
    await expect(store.setMode(scope, 'normal')).rejects.toThrow('模拟磁盘写入失败')
    expect(store.get(scope).mode).toBe('mention_only')
    await store.setMode(scope, 'normal')
    expect(store.get(scope).mode).toBe('normal')
  })
})
