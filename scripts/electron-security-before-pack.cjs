module.exports = async function checkElectronBeforePack() {
  const { execFileSync } = require('node:child_process')
  const path = require('node:path')
  execFileSync(
    process.execPath,
    [path.join(__dirname, 'runtime-security.cjs'), '--configuration', '--electron-installed'],
    {
      stdio: 'inherit',
      windowsHide: true,
    },
  )
}
