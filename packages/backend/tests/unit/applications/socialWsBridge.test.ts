import { describe, expect, it, vi } from 'vitest'
import {
  registerSocialNapcatAdapter,
  getSocialNapcatAdapter,
  registerSocialTransport,
  getSocialTransport,
} from '../../../src/applications/socialWsBridge'
import { NapcatAdapter } from '@infos/social/adapters/napcat'

describe('社交传输注册与重连', () => {
  it('不同平台独立注册，多平台时拒绝隐式选择和重复注册', () => {
    const make = () => ({
      registerConnection: vi.fn(),
      unregisterConnection: vi.fn(),
      handleRawEvent: vi.fn(),
    })
    const first = make()
    const second = make()
    const releaseFirst = registerSocialTransport(first, 'first')
    const releaseSecond = registerSocialTransport(second, 'second')
    try {
      expect(getSocialTransport()).toBeNull()
      expect(getSocialTransport('first')).toBe(first)
      expect(getSocialTransport('second')).toBe(second)
      expect(() => registerSocialTransport(make(), 'first')).toThrow('SOCIAL_TRANSPORT_DUPLICATE')
      releaseFirst()
      expect(getSocialTransport()).toBe(second)
    } finally {
      releaseFirst()
      releaseSecond()
    }
  })
  it('旧运行实例的释放不能移除新实例', () => {
    const first = {
      registerConnection: vi.fn(),
      unregisterConnection: vi.fn(),
      handleRawEvent: vi.fn(),
    }
    const second = { ...first }
    const releaseFirst = registerSocialNapcatAdapter(first)
    const releaseSecond = registerSocialNapcatAdapter(second)
    releaseFirst()
    expect(getSocialNapcatAdapter()).toBe(second)
    releaseSecond()
    expect(getSocialNapcatAdapter()).toBeNull()
  })

  it.each(['10000001', undefined])(
    '连接 %s 被替换后，旧 close 事件不能清掉新连接',
    async (selfId) => {
      const adapter = new NapcatAdapter({ defaultAgentId: 'pero' })
      vi.spyOn(
        adapter as unknown as { fetchBotInfo(): Promise<void> },
        'fetchBotInfo',
      ).mockResolvedValue(undefined)
      const disconnected = vi.fn()
      adapter.on('disconnected', disconnected)
      const old = { send: vi.fn(), close: vi.fn(() => adapter.unregisterConnection(selfId, old)) }
      const current = { send: vi.fn(), close: vi.fn() }
      adapter.registerConnection(selfId, old)
      adapter.registerConnection(selfId, current)
      expect(old.close).toHaveBeenCalledOnce()
      adapter.unregisterConnection(selfId, old)
      expect(disconnected).not.toHaveBeenCalled()
      await adapter.disconnect()
      expect(current.close).toHaveBeenCalledOnce()
      expect(disconnected).toHaveBeenCalledOnce()
    },
  )
})
