import { NapcatAdapter } from '@infos/social/adapters/napcat'
import { describe, expect, it, vi } from 'vitest'
import { SocialAppRuntime } from '@infos/social/runtime'
import { SocialBridge } from '@infos/social/runtime/socialBridge'
import {
  normalizeSocialSchedulerConfig,
  normalizeSocialGroupPolicies,
  socialGroupPolicyKey,
} from '@infos/shared'

function fixture(fail = false) {
  const runtime = new SocialAppRuntime()
  const values = new Map<string, string>()
  const bridge = {
    updateSchedulerConfig: vi.fn(),
    updateGroupPolicies: vi.fn(),
    createMessagingProvider: vi.fn(() => null),
  }
  Object.assign(runtime, {
    ctx: {
      configRepo: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: string) => {
          if (fail) throw new Error('模拟保存失败')
          values.set(key, value)
        },
      },
    },
    socialBridge: bridge,
    adapters: [new NapcatAdapter({ defaultAgentId: 'pero' })],
  })
  return {
    runtime: runtime as unknown as {
      updateModeConfig(
        config:
          | Record<string, unknown>
          | ((current: Record<string, unknown>) => Record<string, unknown>),
      ): Promise<Record<string, unknown>>
      onConfigChanged(keys: string[]): Promise<void>
    },
    bridge,
    values,
  }
}

describe('群状态机配置持久化闭环', () => {
  it('同时保存两个群的覆盖时串行合并，不用旧快照覆盖另一群', async () => {
    const { runtime, values } = fixture()
    const first = socialGroupPolicyKey('pero', '123456789', '111111111')
    const second = socialGroupPolicyKey('pero', '123456789', '222222222')
    await Promise.all(
      [first, second].map((key) =>
        runtime.updateModeConfig((current) => ({
          groupPolicies: {
            ...(current.groupPolicies as object),
            [key]: { reviewIntervalSeconds: 60 },
          },
        })),
      ),
    )
    expect(JSON.parse(values.get('social')!).mode.groupPolicies).toEqual({
      [first]: { reviewIntervalSeconds: 60 },
      [second]: { reviewIntervalSeconds: 60 },
    })
  })
  it('持久化后实际调度策略可读回，重启加载继续按账号和群隔离，重置后继承默认值', async () => {
    const { runtime, values } = fixture()
    const bridge = new SocialBridge({ socialMessageRepo: {} } as never)
    Object.assign(runtime, { socialBridge: bridge })
    const key = socialGroupPolicyKey('pero', '123456789', '987654321')
    await runtime.updateModeConfig({
      nightSilenceEnabled: false,
      reviewIntervalSeconds: 60,
      groupPolicies: { [key]: { minMessagesForReview: 20 } },
    })
    expect(bridge.getGroupState('pero', '123456789', '987654321').policy).toMatchObject({
      minMessagesForReview: 20,
      reviewIntervalSeconds: 60,
    })
    expect(bridge.getGroupState('pero', '234567890', '987654321').policy.minMessagesForReview).toBe(
      3,
    )
    const restarted = fixture()
    const restartedBridge = new SocialBridge({ socialMessageRepo: {} } as never)
    Object.assign(restarted.runtime, { socialBridge: restartedBridge })
    restarted.values.set('social', values.get('social')!)
    await restarted.runtime.onConfigChanged(['social'])
    expect(restartedBridge.getGroupState('pero', '123456789', '987654321').policy).toEqual(
      bridge.getGroupState('pero', '123456789', '987654321').policy,
    )
    await restarted.runtime.updateModeConfig({ groupPolicies: {} })
    expect(
      restartedBridge.getGroupState('pero', '123456789', '987654321').policy.minMessagesForReview,
    ).toBe(3)
  })
  it('设置归一化、持久化与调度器生效值一致，群覆盖不影响默认策略', async () => {
    const { runtime, bridge, values } = fixture()
    const key = socialGroupPolicyKey('pero', '123456789', '987654321')
    await runtime.updateModeConfig({ groupPolicies: { [key]: { minMessagesForReview: 20 } } })
    const result = await runtime.updateModeConfig({
      reviewIntervalSeconds: 1,
      minMessagesForReview: 100,
    })
    const stored = JSON.parse(values.get('social')!).mode
    expect(result).toEqual(stored)
    expect(result).toMatchObject({
      reviewIntervalSeconds: 30,
      minMessagesForReview: 20,
      groupPolicies: { [key]: { minMessagesForReview: 20 } },
    })
    expect(bridge.updateSchedulerConfig).toHaveBeenLastCalledWith(stored)
    expect(bridge.updateGroupPolicies).toHaveBeenLastCalledWith(stored.groupPolicies)
  })

  it('保存失败时不提前修改调度器', async () => {
    const { runtime, bridge } = fixture(true)
    await expect(runtime.updateModeConfig({ proactiveGroupEnabled: false })).rejects.toThrow(
      '模拟保存失败',
    )
    expect(bridge.updateSchedulerConfig).not.toHaveBeenCalled()
    expect(bridge.updateGroupPolicies).not.toHaveBeenCalled()
  })

  it('外部保存模式配置时，即使主人没变化也立即同步运行时', async () => {
    const { runtime, bridge, values } = fixture()
    values.set(
      'social',
      JSON.stringify({ mode: { minMessagesForReview: 20, reviewIntervalSeconds: 60 } }),
    )
    await runtime.onConfigChanged(['social'])
    expect(bridge.updateSchedulerConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        minMessagesForReview: 20,
        reviewIntervalSeconds: 60,
      }),
    )
  })

  it('非法数值回退，群覆盖只包含显式字段以继续继承默认策略', () => {
    expect(
      normalizeSocialSchedulerConfig({ minMessagesForReview: Number.NaN }).minMessagesForReview,
    ).toBe(3)
    const key = socialGroupPolicyKey('pero', '123456789', '987654321')
    expect(
      normalizeSocialGroupPolicies({ [key]: { minMessagesForReview: 20, unknown: true } }),
    ).toEqual({ [key]: { minMessagesForReview: 20 } })
  })
})
