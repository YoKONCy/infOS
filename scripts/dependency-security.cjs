const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const backports = require('./security-backports.json')
const root = path.resolve(__dirname, '..')

/** 精确核验本地回补，不能以包名或严重程度通配忽略漏洞。 */
function verifyBackport(entry) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const yaml = createRequire(path.join(root, 'packages/backend/package.json'))('yaml')
    const lock = yaml.parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'))
    const key = `${entry.module}@${entry.version}`
    return (
      manifest.pnpm.patchedDependencies[key] === entry.patch &&
      lock.patchedDependencies[key]?.path === entry.patch &&
      Boolean(lock.patchedDependencies[key]?.hash) &&
      createHash('sha256')
        .update(fs.readFileSync(path.join(root, entry.patch)))
        .digest('hex') === entry.sha256 &&
      fs.existsSync(path.join(root, entry.test))
    )
  } catch {
    return false
  }
}

function evaluateAudit(report, verify = verifyBackport) {
  if (report.error || !report.metadata?.vulnerabilities || !report.advisories) {
    throw new Error('INVALID_DEPENDENCY_AUDIT_REPORT')
  }
  const blocked = []
  const patched = []
  const advisories = Object.values(report.advisories)
  if (
    !advisories.length &&
    Object.values(report.metadata.vulnerabilities).some((count) => Number(count) > 0)
  ) {
    throw new Error('INCOMPLETE_DEPENDENCY_AUDIT_REPORT')
  }
  for (const advisory of advisories) {
    if (
      typeof advisory.module_name !== 'string' ||
      !Array.isArray(advisory.findings) ||
      !advisory.findings.length ||
      !['info', 'low', 'moderate', 'high', 'critical'].includes(advisory.severity)
    ) {
      throw new Error('INVALID_DEPENDENCY_ADVISORY')
    }
    const identifier = /\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(advisory.url || '')?.[1]
    const entry = backports.find(
      (candidate) => candidate.advisory === identifier && candidate.module === advisory.module_name,
    )
    if (
      entry &&
      advisory.findings?.length &&
      advisory.findings.every((finding) => finding.version === entry.version) &&
      verify(entry)
    ) {
      patched.push(entry)
    } else if (['high', 'critical'].includes(advisory.severity)) {
      blocked.push(advisory)
    }
  }
  return { blocked, patched }
}

async function main() {
  const { t } = await import('./i18n.mjs')
  const cli = process.env.npm_execpath
  if (!cli || !fs.existsSync(cli)) throw new Error('RUN_WITH_PNPM_SECURITY_AUDIT')
  const directory = path.join(root, 'TEMP/security-audit')
  fs.mkdirSync(directory, { recursive: true })
  const audit = spawnSync(
    process.execPath,
    [cli, 'audit', '--registry=https://registry.npmjs.org', '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  fs.writeFileSync(path.join(directory, 'raw.json'), audit.stdout || '')
  if (audit.error || ![0, 1].includes(audit.status))
    throw audit.error || new Error('DEPENDENCY_AUDIT_COMMAND_FAILED')
  const result = evaluateAudit(JSON.parse(audit.stdout))
  fs.writeFileSync(path.join(directory, 'evaluation.json'), JSON.stringify(result, null, 2))
  if (result.patched.length) {
    // 补丁测试不通过时不能将本地回补计为已覆盖；不运行构建或完整测试套件。
    const tests = [...new Set(result.patched.map((entry) => entry.test))]
    const test = spawnSync(
      process.execPath,
      [cli, 'exec', 'vitest', 'run', ...tests, '--maxWorkers=2'],
      {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
        timeout: 120_000,
      },
    )
    if (test.error || test.status !== 0)
      throw test.error || new Error('SECURITY_BACKPORT_REGRESSION_FAILED')
    console.log(
      t('scripts.security', '原始审计报告已保留；{0} 项公告已核验精确补丁及回归测试。', [
        result.patched.length,
      ]),
    )
  }
  for (const issue of result.blocked)
    console.error(
      t('scripts.security', '未修复依赖漏洞：{0}，等级：{1}，公告：{2}', [
        issue.module_name,
        issue.severity,
        issue.url,
      ]),
    )
  if (result.blocked.length) throw new Error('UNPATCHED_HIGH_OR_CRITICAL_DEPENDENCIES')
  console.log(t('scripts.security', '依赖安全检查通过；原始扫描结果与本地回补记录分开保存。'))
}

module.exports = { evaluateAudit, verifyBackport }
if (require.main === module)
  main().catch(async (error) => {
    const { t } = await import('./i18n.mjs')
    console.error(t('scripts.security', '依赖安全检查失败：{0}', [error.message]))
    process.exitCode = 1
  })
