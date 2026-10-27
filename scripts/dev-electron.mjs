import { t as __t } from './i18n.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import electronEnvironment from './electron-environment.cjs'

const { electronProcessEnvironment } = electronEnvironment

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronRequire = createRequire(path.join(root, 'electron/package.json'))
const runFile = promisify(execFile)

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** 只处理项目独立副本，不修改 pnpm 共享的 Electron 可执行文件。 */
async function prepareWindowsRuntime(sourceOverride) {
  const sourceExe = path.resolve(sourceOverride || electronRequire('electron'))
  const sourceInfo = await fs.stat(sourceExe)
  const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  // Windows 通知按 EXE 的 ProductName 命名开始菜单链接，不能与正式版共用。
  const developmentProductName = `${packageInfo.productName} [dev]`
  const icon = path.join(root, 'public/system-icons/pero.ico')
  const iconDigest = createHash('sha256')
    .update(await fs.readFile(icon))
    .digest('hex')
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        revision: 3,
        root,
        sourceExe,
        size: sourceInfo.size,
        modified: sourceInfo.mtimeMs,
        name: developmentProductName,
        version: packageInfo.version,
        iconDigest,
      }),
    )
    .digest('hex')
    .slice(0, 24)
  const cache = path.join(process.env.LOCALAPPDATA || tmpdir(), 'infOS', 'electron-development')
  const target = path.join(cache, fingerprint)
  // 改名后 Electron 的 app.isPackaged 会误报，主进程统一结合 process.defaultApp 识别开发启动。
  const executableName = 'PeroperoChat.exe'
  const executable = path.join(target, executableName)
  const ready = async () => {
    if (!(await exists(executable)) || !(await exists(path.join(target, 'icudtl.dat'))))
      return false
    try {
      const identity = JSON.parse(await fs.readFile(path.join(target, 'identity.json'), 'utf8'))
      return identity.fingerprint === fingerprint
    } catch {
      return false
    }
  }
  if (await ready()) return executable

  console.log(__t('scripts.dev-electron', '[桌面启动] 正在准备应用名称与 Pero 系统图标……'))
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
  const { getRceditBundle } = builderRequire('app-builder-lib/out/toolsets/windows.js')
  // 复用 electron-builder 带校验的官方工具下载与缓存，不额外引入资源编辑依赖。
  const editor = await getRceditBundle('1.1.0')
  await fs.mkdir(cache, { recursive: true })
  const staging = await fs.mkdtemp(path.join(cache, `${fingerprint}-preparing-`))
  try {
    await fs.cp(path.dirname(sourceExe), staging, { recursive: true })
    const stagedExe = path.join(staging, executableName)
    const copiedExe = path.join(staging, path.basename(sourceExe))
    if (copiedExe !== stagedExe) await fs.rename(copiedExe, stagedExe)
    await runFile(
      process.arch === 'ia32' ? editor.x86 : editor.x64,
      [
        stagedExe,
        '--set-icon',
        icon,
        '--set-version-string',
        'FileDescription',
        packageInfo.productName,
        '--set-version-string',
        'ProductName',
        developmentProductName,
        '--set-version-string',
        'InternalName',
        'PeroperoChatDevelopment',
        '--set-version-string',
        'OriginalFilename',
        executableName,
        '--set-version-string',
        'ProductVersion',
        packageInfo.version,
      ],
      { windowsHide: true },
    )
    await fs.writeFile(path.join(staging, 'identity.json'), JSON.stringify({ fingerprint }))
    try {
      await fs.rename(staging, target)
    } catch (error) {
      // 两个启动器同时准备时，复用另一方已完整写好的运行时。
      if (!(await ready())) throw error
    }
    return executable
  } finally {
    // staging 必定来自指定缓存目录，且只清理本次创建的临时副本。
    const relative = path.relative(cache, staging)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      await fs.rm(staging, { recursive: true, force: true })
    }
  }
}

async function main() {
  // Electron 在主进程代码执行前读取 NODE_OPTIONS，必须在派生前清理。
  const env = electronProcessEnvironment(process.env)
  if (process.platform === 'win32') {
    // 环境继承的 Electron 路径也必须使用独立的品牌副本，不能绕过图标与名称处理。
    env.ELECTRON_EXEC_PATH = await prepareWindowsRuntime(env.ELECTRON_EXEC_PATH)
  }
  const vitePackage = require.resolve('electron-vite/package.json')
  const cli = path.join(path.dirname(vitePackage), 'bin/electron-vite.js')
  const args = [cli, 'dev', '--config', 'electron.vite.config.ts', ...process.argv.slice(2)]
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  child.once('error', (error) => {
    console.error(__t('scripts.dev-electron', '[桌面启动] 启动失败：{0}', [error.message]))
    process.exitCode = 1
  })
  child.once('exit', (code) => {
    process.exitCode = code ?? 1
  })
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (stopping || !child.pid || child.exitCode !== null) return
      stopping = true
      if (process.platform === 'win32') {
        execFile(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => {},
        )
      } else child.kill(signal)
    })
  }
}

main().catch((error) => {
  console.error(__t('scripts.dev-electron', '[桌面启动] 应用身份准备失败：{0}', [error.message]))
  process.exitCode = 1
})
