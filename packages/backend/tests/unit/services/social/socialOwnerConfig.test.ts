import { NapcatAdapter } from '@infos/social/adapters/napcat'
import { describe, expect, it, vi } from 'vitest'
import { SocialAppRuntime } from '@infos/social/runtime'

describe('社交主人配置即时更新', () => {
  it('保存新主人时更新适配器并取消持有旧身份的会话，取消绑定同样生效', async () => {
    const runtime = new SocialAppRuntime()
    let ownerQq: string | undefined = '123456'
    const adapter = new NapcatAdapter({ defaultAgentId: 'pero', ownerQq: '654321' })
    const setOwnerQq = vi.spyOn(adapter, 'setOwnerQq')
    const closeSessionsExcept = vi.fn()
    Object.assign(runtime, {
      ctx: {
        configRepo: { get: vi.fn(async () => JSON.stringify({ ownerQq })) },
        logger: { info: vi.fn() },
      },
      adapters: [adapter],
      socialBridge: { closeSessionsExcept, createMessagingProvider: vi.fn(() => null) },
    })
    await runtime.onConfigChanged(['social'])
    expect(setOwnerQq).toHaveBeenLastCalledWith('123456')
    expect(closeSessionsExcept).toHaveBeenCalledOnce()
    expect(closeSessionsExcept.mock.calls[0]![0]({ platform: 'qq' })).toBe(false)
    await runtime.onConfigChanged(['social'])
    expect(closeSessionsExcept).toHaveBeenCalledOnce()
    ownerQq = undefined
    await runtime.onConfigChanged(['social'])
    expect(setOwnerQq).toHaveBeenLastCalledWith(undefined)
    expect(closeSessionsExcept).toHaveBeenCalledTimes(2)
  })
})
