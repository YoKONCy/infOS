const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const catalogs = [
  ['installer', require('../build/installer/messages.cjs')],
  ['uninstaller', require('../build/installer/uninstall-messages.cjs')],
]
const exec = promisify(execFile)
const root = path.resolve(__dirname, '..')
const destination = path.join(root, 'build/installer/generated')

/** 标准版打包钩子：编译宿主所需的 x86 Unicode 原生展示插件，不改变 NSIS 引擎。 */
let preparation
module.exports = function prepareInstaller(context) {
  return require('./electron-security-before-pack.cjs')(context).then(() =>
    prepareForTarget(context),
  )
}
function prepareForTarget(context) {
  if (context.electronPlatformName !== 'win32') return
  if (context.targets && !context.targets.some((target) => target.name === 'nsis')) return
  return (preparation ??= prepare())
}
async function prepare() {
  const { t } = await import('./i18n.mjs')
  await fs.mkdir(destination, { recursive: true })
  const strings = []
  for (const [locale, languageId] of [
    ['zh-CN', 2052],
    ['zh-TW', 1028],
    ['en-US', 1033],
  ]) {
    for (const [module, messages] of catalogs) {
      const resource = path.join(
        root,
        'packages/shared/src/i18n/locales',
        locale,
        `electron/ui/${module}.json`,
      )
      const catalog = JSON.parse(await fs.readFile(resource, 'utf8'))
      for (const [identifier, source] of Object.entries(messages)) {
        if (typeof catalog[source] !== 'string')
          throw new Error(
            t('scripts.installer', '安装器缺少译文：{0}', [`${locale}/${module}: ${source}`]),
          )
        const value = catalog[source]
          .replaceAll('$', '$$')
          .replaceAll('"', '$\\"')
          .replaceAll('\r', '')
          .replaceAll('\n', '$\\r$\\n')
        strings.push(`LangString ${identifier} ${languageId} "${value}"`)
      }
    }
  }
  await fs.writeFile(
    path.join(destination, 'messages.nsh'),
    '\uFEFF' + strings.join('\n') + '\n',
    'utf8',
  )
  for (const file of ['pero.png', 'brand.png'])
    await fs.access(path.join(root, 'build/installer/assets', file))
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe',
  )
  let installation = ''
  try {
    const { stdout } = await exec(
      vswhere,
      [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ],
      { windowsHide: true },
    )
    installation = stdout.trim()
  } catch {
    throw new Error(t('scripts.installer', '自定义安装器需要 Visual Studio C++ x86 构建工具。'))
  }
  if (!installation)
    throw new Error(t('scripts.installer', '自定义安装器需要 Visual Studio C++ x86 构建工具。'))
  const developer = path.join(installation, 'Common7/Tools/VsDevCmd.bat')
  await fs.access(developer)
  const quote = (value) => `"${value}"`
  const source = path.join(root, 'build/installer/InfosSetup.cpp')
  const definitions = path.join(root, 'build/installer/InfosSetup.def')
  const dll = path.join(destination, 'InfosSetup.dll')
  const command = [
    '@echo off',
    'chcp 65001 >nul',
    `call ${quote(developer)} -no_logo -arch=x86 -host_arch=${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
    'if errorlevel 1 exit /b %errorlevel%',
    `cl /nologo /LD /std:c++17 /W4 /O2 /MT /utf-8 /DUNICODE /D_UNICODE ${quote(source)} /Fo${quote(path.join(destination, 'InfosSetup.obj'))} /link /OUT:${quote(dll)} /DEF:${quote(definitions)} user32.lib gdi32.lib comctl32.lib uxtheme.lib gdiplus.lib msimg32.lib shell32.lib ole32.lib dwmapi.lib`,
    'exit /b %errorlevel%',
  ].join('\r\n')
  const script = path.join(destination, 'compile.cmd')
  await fs.writeFile(script, command, 'utf8')
  try {
    await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${script}""`], {
      cwd: destination,
      windowsHide: true,
      windowsVerbatimArguments: true,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(
      t('scripts.installer', '安装器展示插件编译失败：{0}', [
        error.stdout || error.stderr || error.message,
      ]),
    )
  }
  const binary = await fs.readFile(dll)
  const pe = binary.readUInt32LE(0x3c)
  if (binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x14c)
    throw new Error(t('scripts.installer', '安装器展示插件必须是 x86 DLL。'))
}
