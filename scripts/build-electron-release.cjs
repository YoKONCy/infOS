const path = require('node:path')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

/** 仅重试 Windows 资源编辑的短暂文件锁；真实构建错误立即回传。 */
async function buildWithResourceRetry(runAttempt, wait = delay, report = console.warn) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await runAttempt()
    if (result.code === 0) return 0
    const resourceLocked =
      /rcedit/i.test(result.output) && /Unable to (?:commit changes|load file)/i.test(result.output)
    if (!resourceLocked || attempt === 3) return result.code
    report(`Windows 图标或版本资源暂时无法写入，等待文件锁释放后重试（${attempt}/3）`)
    await wait(10_000)
  }
}

async function main() {
  const edition = process.argv[2]
  if (!['standard', 'portable', 'steam'].includes(edition)) {
    throw new Error('请指定有效发行版：standard、portable 或 steam')
  }
  const root = path.resolve(__dirname, '..')
  // 核验稳定 Electron 及其实际内嵌 Node，不能用构建机的 Node 版本代替。
  const {
    configurationIssues,
    configuredElectron,
    probeElectron,
    runtimeIssues,
    reportRuntimeWarnings,
  } = require('./runtime-security.cjs')
  const { createRequire } = require('node:module')
  const electronRequire = createRequire(path.join(root, 'electron/package.json'))
  const versions = probeElectron(electronRequire('electron'))
  const issues = [...configurationIssues(), ...runtimeIssues(versions, configuredElectron())]
  await reportRuntimeWarnings(versions, configuredElectron())
  if (issues.length) {
    const { t } = await import('./i18n.mjs')
    throw new Error(
      t('scripts.security', '运行时安全检查失败：{0}（{1}）', [
        'ELECTRON_RELEASE_REJECTED',
        JSON.stringify(issues),
      ]),
    )
  }
  return buildWithResourceRetry(
    () =>
      new Promise((resolve, reject) => {
        let output = ''
        const child = spawn(
          process.execPath,
          [
            require.resolve('electron-builder/cli.js'),
            '--config',
            `electron-builder.${edition}.yml`,
            '--publish',
            'never',
          ],
          {
            cwd: root,
            env: { ...process.env, INFOS_EDITION: edition },
            windowsHide: true,
            stdio: ['inherit', 'pipe', 'pipe'],
          },
        )
        for (const [source, destination] of [
          [child.stdout, process.stdout],
          [child.stderr, process.stderr],
        ]) {
          source.on('data', (chunk) => {
            destination.write(chunk)
            output = (output + chunk.toString()).slice(-65_536)
          })
        }
        child.once('error', reject)
        child.once('close', (code) => resolve({ code: code ?? 1, output }))
      }),
  )
}

module.exports = { buildWithResourceRetry }

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error('Windows 发行构建失败：', error)
      process.exitCode = 1
    },
  )
}
