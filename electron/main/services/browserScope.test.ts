import { describe, expect, it } from 'vitest'
import { browserInvocationScope, assertBrowserTargetScope } from './browserScope'

describe('浏览器账号与会话归属', () => {
  const account = { principalId: 'pero', profileId: 'qq:account', sessionId: 'private:owner' }
  it('同一账号的不同会话复用登录态，但分别持有活动页面', () => {
    const first = browserInvocationScope(account, 'pero')
    const second = browserInvocationScope({ ...account, sessionId: 'group:123' }, 'pero')
    expect(first.partition).toBe(second.partition)
    expect(first.key).not.toBe(second.key)
    expect(() => assertBrowserTargetScope(first.key, second.key)).toThrow('WEB_TARGET_SCOPE_DENIED')
  })
  it('不同平台账号与人格分别隔离登录态，拒绝伪造信封身份', () => {
    const first = browserInvocationScope(account, 'pero')
    expect(
      browserInvocationScope({ ...account, profileId: 'telegram:account' }, 'pero').partition,
    ).not.toBe(first.partition)
    expect(() => browserInvocationScope(account, 'nana')).toThrow('WEB_SCOPE_INVALID')
    expect(browserInvocationScope(undefined, 'pero').partition).toBe('persist:infos-browser')
    expect(() => assertBrowserTargetScope(first.key, 'legacy')).toThrow('WEB_TARGET_SCOPE_DENIED')
  })
})
