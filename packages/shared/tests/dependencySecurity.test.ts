import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { evaluateAudit, verifyBackport } = require('../../../scripts/dependency-security.cjs')
const backports = require('../../../scripts/security-backports.json')
const report = (advisory: Record<string, unknown>) => ({
  metadata: { vulnerabilities: {} },
  advisories: { test: advisory },
})
const advisory = {
  module_name: 'http-cache-semantics',
  severity: 'high',
  url: 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp',
  findings: [{ version: '4.2.0' }],
}
describe('依赖回补审计边界', () => {
  it('实际补丁、清单和锁文件一致时才识别本地回补', () => {
    expect(backports.every(verifyBackport)).toBe(true)
    expect(evaluateAudit(report(advisory)).patched).toHaveLength(1)
  })
  it('补丁不存在、损坏或未锁定时继续阻止高危漏洞', () => {
    expect(evaluateAudit(report(advisory), () => false).blocked).toHaveLength(1)
  })
  it('同包的新公告或混入未回补版本不能复用旧证明', () => {
    expect(
      evaluateAudit(report({ ...advisory, url: 'https://github.com/advisories/GHSA-new-new-new' }))
        .blocked,
    ).toHaveLength(1)
    expect(
      evaluateAudit(report({ ...advisory, findings: [{ version: '4.2.0' }, { version: '4.1.0' }] }))
        .blocked,
    ).toHaveLength(1)
  })
  it('审计服务错误与缺失报告不能被当成零漏洞', () => {
    expect(() => evaluateAudit({ error: { code: 'REGISTRY_UNAVAILABLE' } })).toThrow()
    expect(() => evaluateAudit({})).toThrow()
    expect(() =>
      evaluateAudit({ metadata: { vulnerabilities: { high: 1 } }, advisories: {} }),
    ).toThrow()
    expect(() => evaluateAudit(report({ ...advisory, severity: 'unknown' }))).toThrow()
  })
})
