const path = require('node:path')
const {
  configuredElectron,
  probeElectron,
  runtimeIssues,
  reportRuntimeWarnings,
} = require('./runtime-security.cjs')

module.exports = async function checkPackagedElectron(context, executablePath) {
  if (context.electronPlatformName !== 'win32') throw new Error('UNREVIEWED_ELECTRON_TARGET')
  const filename = context.packager.appInfo.productFilename
  const executable =
    executablePath ||
    path.join(context.appOutDir, filename.endsWith('.exe') ? filename : `${filename}.exe`)
  const versions = probeElectron(executable)
  const issues = runtimeIssues(versions, configuredElectron())
  await reportRuntimeWarnings(versions, configuredElectron())
  if (issues.length) {
    const { t } = await import('./i18n.mjs')
    throw new Error(
      t('scripts.security', '运行时安全检查失败：{0}（{1}）', [
        'PACKAGED_RUNTIME_REJECTED',
        JSON.stringify(issues),
      ]),
    )
  }
}
