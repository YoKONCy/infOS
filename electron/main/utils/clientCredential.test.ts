import { describe, expect, it, vi } from 'vitest'
import { LocalClientCredentialCache } from './clientCredential'

const firstToken = 'a'.repeat(64)
const nextToken = 'b'.repeat(64)

describe('本机客户端凭据读取', () => {
  it('短暂文件占用保留最近有效凭据，超过五秒后不再复用', () => {
    let now = 0
    const read = vi.fn(() => JSON.stringify({ localToken: firstToken }))
    const cache = new LocalClientCredentialCache(read, () => now)
    expect(cache.get()).toBe(firstToken)
    read.mockImplementation(() => {
      throw Object.assign(new Error('文件暂被占用'), { code: 'EPERM' })
    })
    now = 1100
    expect(cache.get()).toBe(firstToken)
    now = 5001
    expect(cache.get()).toBe('')
  })

  it('强制刷新立即读取新凭据，不受普通读取缓存影响', () => {
    let stored = firstToken
    const cache = new LocalClientCredentialCache(
      () => JSON.stringify({ localToken: stored }),
      () => 0,
    )
    expect(cache.get()).toBe(firstToken)
    stored = nextToken
    expect(cache.get(true)).toBe(nextToken)
  })

  it.each(['删除', '损坏'])('凭据文件%s时清除缓存，不能沿用旧身份', (failure) => {
    const read = vi.fn(() => JSON.stringify({ localToken: firstToken }))
    const cache = new LocalClientCredentialCache(read)
    expect(cache.get()).toBe(firstToken)
    read.mockImplementation(() => {
      if (failure === '删除') throw Object.assign(new Error('文件不存在'), { code: 'ENOENT' })
      return '{'
    })
    expect(cache.get(true)).toBe('')
  })
})
