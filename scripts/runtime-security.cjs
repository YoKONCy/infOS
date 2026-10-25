const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')
const policy = require('./runtime-security-policy.json')
const root = path.resolve(__dirname, '..')

/** 只接受正式稳定版本；未知主版本必须先审阅安全公告。 */
function meetsMinimum(version, minimums) {
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version || '')
  if (!parsed || !minimums[parsed[1]]) return false
  const actual = parsed.slice(1).map(Number)
  const minimum = minimums[parsed[1]].split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

function runtimeIssues(versions, expectedElectron) {
  const issues = []
  if (!meetsMinimum(versions.node, policy.nodeMinimums)) {
    issues.push({ code: 'UNSAFE_NODE_RUNTIME', detail: versions.node || 'unknown' })
  }
  if (expectedElectron) {
    if (versions.electron !== expectedElectron) {
      issues.push({
        code: 'ELECTRON_VERSION_MISMATCH',
        detail: `${versions.electron}/${expectedElectron}`,
      })
    }
    if (!meetsMinimum(versions.electron, policy.electronMinimums)) {
      issues.push({ code: 'UNSUPPORTED_ELECTRON_RUNTIME', detail: versions.electron || 'unknown' })
    }
  }
  return issues
}

/** 清除可注入 Node 代码的继承选项，只探测指定可执行文件的内嵌运行时。 */
function probeElectron(executable) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase()))
      delete environment[key]
  }
  environment.ELECTRON_RUN_AS_NODE = '1'
  const result = execFileSync(
    executable,
    ['-e', 'process.stdout.write(JSON.stringify(process.versions))'],
    {
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    },
  )
  return JSON.parse(result.trim())
}

function configuredElectron() {
  return JSON.parse(fs.readFileSync(path.join(root, 'electron/package.json'), 'utf8'))
    .devDependencies.electron
}

function configurationIssues() {
  const issues = []
  const electron = configuredElectron()
  const base = fs.readFileSync(path.join(root, 'electron-builder.base.yml'), 'utf8')
  const yaml = createRequire(path.join(root, 'packages/backend/package.json'))('yaml')
  const configuration = yaml.parse(base)
  const configured = configuration.electronVersion
  if (configured !== electron || !meetsMinimum(electron, policy.electronMinimums)) {
    issues.push({ code: 'ELECTRON_CONFIGURATION_MISMATCH', detail: `${electron}/${configured}` })
  }
  // 读取真实锁文件解析结果，不能只检查声明中的宽松版本范围。
  if (
    configuration.beforePack !== 'scripts/electron-security-before-pack.cjs' ||
    configuration.afterPack !== 'scripts/electron-after-pack.cjs'
  ) {
    issues.push({ code: 'ELECTRON_SECURITY_HOOK_MISMATCH', detail: 'electron-builder.base.yml' })
  }
  const lock = yaml.parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'))
  const locked = lock.importers.electron.devDependencies.electron
  if (locked.specifier !== electron || locked.version !== electron) {
    issues.push({
      code: 'ELECTRON_LOCKFILE_MISMATCH',
      detail: `${locked.specifier}/${locked.version}`,
    })
  }
  const node = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim()
  if (!meetsMinimum(node, policy.nodeMinimums))
    issues.push({ code: 'UNSAFE_CI_NODE', detail: node })
  for (const file of ['docker/Dockerfile.backend', 'docker/Dockerfile.frontend']) {
    const images = [
      ...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/^FROM node:([^\s]+)(?:\s|$)/gm),
    ]
    if (!images.length || images.some(([, tag]) => !tag.startsWith(`${node}-`))) {
      issues.push({ code: 'UNSAFE_DOCKER_NODE', detail: file })
    }
  }
  return issues
}

async function main() {
  const { t } = await import('./i18n.mjs')
  const arguments_ = process.argv.slice(2)
  if (!arguments_.length) throw new Error('RUNTIME_SECURITY_CHECK_MODE_REQUIRED')
  const flags = new Set(['--configuration', '--node', '--electron-installed', '--electron-binary'])
  for (let index = 0; index < arguments_.length; index++) {
    if (!flags.has(arguments_[index])) throw new Error('UNKNOWN_RUNTIME_SECURITY_CHECK_MODE')
    if (arguments_[index] === '--electron-binary') index++
  }
  const issues = []
  if (arguments_.includes('--configuration')) issues.push(...configurationIssues())
  if (arguments_.includes('--node')) issues.push(...runtimeIssues(process.versions))
  if (arguments_.includes('--electron-installed')) {
    const electronRequire = createRequire(path.join(root, 'electron/package.json'))
    issues.push(...runtimeIssues(probeElectron(electronRequire('electron')), configuredElectron()))
  }
  if (arguments_.includes('--electron-binary')) {
    const executable = arguments_[arguments_.indexOf('--electron-binary') + 1]
    if (!executable || executable.startsWith('--')) throw new Error('ELECTRON_BINARY_PATH_REQUIRED')
    issues.push(...runtimeIssues(probeElectron(path.resolve(executable)), configuredElectron()))
  }
  if (issues.length) {
    for (const issue of issues)
      console.error(
        t('scripts.security', '运行时安全检查失败：{0}（{1}）', [issue.code, issue.detail]),
      )
    console.error(
      t('scripts.security', '必须更新到包含安全补丁的运行时；不允许使用版本豁免绕过发布检查。'),
    )
    process.exitCode = 1
  } else {
    console.log(t('scripts.security', '运行时安全检查通过。'))
  }
}

module.exports = {
  meetsMinimum,
  runtimeIssues,
  configurationIssues,
  probeElectron,
  configuredElectron,
}
if (require.main === module)
  main().catch(async (error) => {
    const { t } = await import('./i18n.mjs')
    console.error(t('scripts.security', '运行时安全检查无法完成：{0}', [error.message]))
    process.exitCode = 1
  })
