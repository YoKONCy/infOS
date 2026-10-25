import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const rebuildRequire = createRequire(require.resolve('@electron/rebuild'))
const gotRequire = createRequire(rebuildRequire.resolve('got'))
const cacheRequire = createRequire(gotRequire.resolve('cacheable-request'))
const CachePolicy = cacheRequire('http-cache-semantics')
const request = { url: 'https://example.test/resource', method: 'GET', headers: {} }

describe('共享缓存隐私补丁', () => {
  it.each([
    { 'cache-control': 'private, max-age=3600' },
    { 'cache-control': 'no-store' },
    { 'cache-control': 'no-cache' },
    { 'set-cookie': 'session=unit-test-only', 'cache-control': 'max-age=3600' },
    { vary: '*', 'cache-control': 'max-age=3600' },
  ])('安全清零的缓存条目必须重新验证：%j', (headers) => {
    const original = new CachePolicy(request, { status: 200, headers }, { shared: true })
    const policy = CachePolicy.fromObject(original.toObject())
    const result = policy.evaluateRequest({
      ...request,
      headers: { 'cache-control': 'max-stale=999999999' },
    })
    expect(result.response).toBeUndefined()
    expect(result.revalidation.synchronous).toBe(true)
  })
  it('正常公开且仍新鲜的响应继续命中缓存', () => {
    const policy = new CachePolicy(
      request,
      { status: 200, headers: { 'cache-control': 'public, max-age=3600' } },
      { shared: true },
    )
    expect(policy.evaluateRequest(request).response).toBeDefined()
  })
})
