import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const {
  evaluateAudit,
  verifyBackport,
  workspaceAuditArtifacts,
} = require('../../../scripts/dependency-security.cjs')
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
  const workspaceFilter = (
    packages = {},
    manifest = { name: 'infos-electron', private: true, version: '0.9.6' },
  ) => workspaceAuditArtifacts({ importers: { electron: {} }, packages }, () => manifest)
  const electronAdvisory = {
    module_name: 'electron',
    severity: 'critical',
    url: 'https://github.com/advisories/GHSA-test-test-test',
    findings: [{ version: '0.9.6', paths: [] }],
  }
  it('以私有工作区清单和锁文件核对没有依赖路径的应用版本误报', () => {
    const result = evaluateAudit(
      report(electronAdvisory),
      () => false,
      workspaceFilter({ 'electron@44.9.3': {} }),
    )
    expect(result.blocked).toHaveLength(0)
    expect(result.workspaceArtifacts).toEqual([
      {
        module: 'electron',
        version: '0.9.6',
        importer: 'electron',
        name: 'infos-electron',
        url: electronAdvisory.url,
      },
    ])
  })
  it('真实同名同版本依赖不能被工作区误报规则排除', () => {
    expect(
      evaluateAudit(
        report(electronAdvisory),
        () => false,
        workspaceFilter({ 'electron@0.9.6': {} }),
      ).blocked,
    ).toHaveLength(1)
    expect(
      evaluateAudit(
        report(electronAdvisory),
        () => false,
        workspaceFilter({ 'electron@0.9.6(peer@1.0.0)': {} }),
      ).blocked,
    ).toHaveLength(1)
  })
  it('存在依赖路径或版本不同的公告仍然阻断', () => {
    for (const finding of [
      { version: '0.9.6', paths: ['infos-electron>electron'] },
      { version: '44.9.3', paths: [] },
      { version: '0.9.6' },
    ]) {
      expect(
        evaluateAudit(
          report({ ...electronAdvisory, findings: [finding] }),
          () => false,
          workspaceFilter(),
        ).blocked,
      ).toHaveLength(1)
    }
  })
  it('公开包和使用真实包名的工作区不能按路径误报处理', () => {
    for (const manifest of [
      { name: 'infos-electron', private: false, version: '0.9.6' },
      { name: 'electron', private: true, version: '0.9.6' },
    ]) {
      expect(
        evaluateAudit(report(electronAdvisory), () => false, workspaceFilter({}, manifest)).blocked,
      ).toHaveLength(1)
    }
  })
  it('混合公告仅移出已核验的工作区误报，真实依赖继续阻断', () => {
    const findings = [
      ...electronAdvisory.findings,
      { version: '44.9.3', paths: ['infos-electron>electron'] },
    ]
    const result = evaluateAudit(
      report({ ...electronAdvisory, findings }),
      () => false,
      workspaceFilter(),
    )
    expect(result.blocked[0].findings).toEqual([findings[1]])
    expect(result.workspaceArtifacts).toHaveLength(1)
  })
  it('缺少真实锁文件图时不能启用误报识别', () => {
    expect(() => workspaceAuditArtifacts({ importers: { electron: {} } }, () => ({}))).toThrow()
  })
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
