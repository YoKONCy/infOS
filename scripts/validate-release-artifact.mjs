import { t as __t } from './i18n.mjs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const [mode, artifactDirectory, evidenceDirectory] = process.argv.slice(2)
if (!['standard', 'portable'].includes(mode) || !artifactDirectory || !evidenceDirectory) {
  throw new Error(
    '用法: node scripts/validate-release-artifact.mjs <standard|portable> <产物目录> <证据目录>',
  )
}

const port = 9120
const runRoot = path.join(os.tmpdir(), `infos-acceptance-${mode}-${randomUUID()}`)
const appData = path.join(runRoot, 'AppData', 'Roaming')
const localAppData = path.join(runRoot, 'AppData', 'Local')
const installDirectory = path.join(runRoot, 'install')
const extractDirectory = path.join(runRoot, 'portable')
const processLogPath = path.join(evidenceDirectory, 'desktop-process.log')
const summaryPath = path.join(evidenceDirectory, 'acceptance-summary.json')

await Promise.all([
  fsp.mkdir(evidenceDirectory, { recursive: true }),
  fsp.mkdir(appData, { recursive: true }),
  fsp.mkdir(localAppData, { recursive: true }),
])

const summary = {
  mode,
  artifactDirectory: path.resolve(artifactDirectory),
  runRoot,
  executable: '',
  connectionProfile: '',
  healthReady: false,
  requiredLogsFound: false,
  portableDataFound: false,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  error: '',
}

let desktopChild = null
let uninstaller = null

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} 执行失败 (status=${result.status}): ${result.error?.message ?? output}`,
    )
  }
  return output
}

async function walk(directory) {
  const results = []
  let entries
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) results.push(...(await walk(absolute)))
    else results.push(absolute)
  }
  return results
}

async function findArtifact(extension, predicate) {
  const files = await walk(artifactDirectory)
  const matches = files.filter(
    (file) => path.extname(file).toLowerCase() === extension && predicate(path.basename(file)),
  )
  if (matches.length !== 1) {
    throw new Error(
      `预期找到一个 ${extension} 产物，实际找到 ${matches.length} 个: ${matches.join(', ')}`,
    )
  }
  return matches[0]
}

async function findDesktopExecutable(root, portable) {
  if (portable) {
    const markers = (await walk(root)).filter((file) => path.basename(file) === '.portable')
    if (markers.length !== 1) throw new Error(`便携包内 .portable 标记数量异常: ${markers.length}`)
    const directory = path.dirname(markers[0])
    const files = await fsp.readdir(directory, { withFileTypes: true })
    const executables = files
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
      .map((entry) => path.join(directory, entry.name))
    if (executables.length !== 1) {
      throw new Error(`便携包根目录应用 EXE 数量异常: ${executables.length}`)
    }
    return executables[0]
  }

  const files = await fsp.readdir(root, { withFileTypes: true })
  const executables = files
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith('.exe') &&
        !entry.name.toLowerCase().startsWith('uninstall'),
    )
    .map((entry) => path.join(root, entry.name))
  if (executables.length !== 1) throw new Error(`安装目录应用 EXE 数量异常: ${executables.length}`)
  return executables[0]
}

function probeHealth() {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1_000 },
      (response) => {
        let body = ''
        response.on('data', (chunk) => (body += chunk.toString()))
        response.on('end', () => resolve(response.statusCode === 200 && body.includes('"ok"')))
      },
    )
    request.once('timeout', () => {
      request.destroy()
      resolve(false)
    })
    request.once('error', () => resolve(false))
  })
}

async function waitForHealth(child) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (await probeHealth()) return true
    if (child.exitCode !== null) throw new Error(`桌面应用提前退出，exitCode=${child.exitCode}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('桌面应用启动后 45 秒内 Daemon 健康检查未就绪')
}

async function collectLogs(roots) {
  const logFiles = []
  for (const root of roots) {
    for (const file of await walk(root)) {
      if (file.toLowerCase().endsWith('.log')) logFiles.push(file)
    }
  }

  let combined = ''
  for (const [index, file] of logFiles.entries()) {
    let content = ''
    try {
      content = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    combined += `\n===== ${file} =====\n${content}\n`
    await fsp.writeFile(
      path.join(evidenceDirectory, `${String(index + 1).padStart(2, '0')}-${path.basename(file)}`),
      content,
      'utf8',
    )
  }
  await fsp.writeFile(path.join(evidenceDirectory, 'combined-logs.txt'), combined, 'utf8')
  return combined
}

function assertStartupLogs(logs) {
  const forbidden = [
    'App whenReady 失败',
    'ERR_INVALID_ARG_VALUE',
    'Cannot find module',
    'Daemon 提前退出',
    '未捕获的异常',
  ]
  const failures = forbidden.filter((text) => logs.includes(text))
  if (failures.length) {
    throw new Error(`启动日志验收失败；致命错误: ${failures.join(', ')}`)
  }
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null) return
  spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    windowsHide: true,
    encoding: 'utf8',
  })
}

const applicationEnvironment = {
  ...process.env,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  PERO_PORT: String(port),
  INFOS_ACCEPTANCE_TEST: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
}

try {
  if (await probeHealth()) {
    throw new Error(`验收端口 ${port} 已被其他健康服务占用，拒绝产生假阳性结果`)
  }

  let executable
  if (mode === 'standard') {
    const installer = await findArtifact('.exe', (name) => name.includes('Setup'))
    await fsp.mkdir(installDirectory, { recursive: true })
    run(installer, ['/S', `/D=${installDirectory}`], {
      env: applicationEnvironment,
      timeout: 180_000,
    })
    executable = await findDesktopExecutable(installDirectory, false)
    const rootFiles = await fsp.readdir(installDirectory, { withFileTypes: true })
    uninstaller = rootFiles
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.toLowerCase().startsWith('uninstall') &&
          entry.name.toLowerCase().endsWith('.exe'),
      )
      .map((entry) => path.join(installDirectory, entry.name))[0]
  } else {
    const archive = await findArtifact('.zip', (name) => name.includes('Portable'))
    await fsp.mkdir(extractDirectory, { recursive: true })
    const asciiArchive = path.join(runRoot, 'portable.zip')
    await fsp.copyFile(archive, asciiArchive)
    run('tar.exe', ['-xf', asciiArchive, '-C', extractDirectory], { timeout: 180_000 })
    executable = await findDesktopExecutable(extractDirectory, true)
  }

  summary.executable = executable
  // 产物烟测显式选择本地模式；只写入本次隔离目录，正常用户仍显示首次连接选择。
  const metadata = JSON.parse(
    await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const connectionDirectory =
    mode === 'portable' ? path.dirname(executable) : path.join(appData, metadata.productName)
  const connectionRelative = path.relative(runRoot, connectionDirectory)
  if (
    !connectionRelative ||
    connectionRelative.startsWith('..') ||
    path.isAbsolute(connectionRelative)
  )
    throw new Error(__t('scripts.validate-release-artifact', '验收连接配置目录越界'))
  await fsp.mkdir(connectionDirectory, { recursive: true })
  summary.connectionProfile = path.join(connectionDirectory, 'client-connection.json')
  await fsp.writeFile(summary.connectionProfile, JSON.stringify({ version: 1, mode: 'local' }), {
    flag: 'wx',
  })
  const processLogFd = fs.openSync(processLogPath, 'a')
  try {
    desktopChild = spawn(executable, [], {
      cwd: path.dirname(executable),
      env: applicationEnvironment,
      windowsHide: true,
      stdio: ['ignore', processLogFd, processLogFd],
    })
  } finally {
    fs.closeSync(processLogFd)
  }

  await waitForHealth(desktopChild)
  summary.healthReady = true

  const logRoots =
    mode === 'portable' ? [path.join(path.dirname(executable), 'data')] : [appData, localAppData]
  let logs = ''
  const logDeadline = Date.now() + 5_000
  while (Date.now() < logDeadline) {
    logs = await collectLogs(logRoots)
    if (logs.trim()) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assertStartupLogs(logs)
  summary.requiredLogsFound = true

  if (mode === 'portable') {
    summary.portableDataFound = fs.existsSync(path.join(path.dirname(executable), 'data'))
    if (!summary.portableDataFound) throw new Error('便携版未在应用目录同级生成 data 目录')
  }
} catch (error) {
  summary.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  throw error
} finally {
  stopProcessTree(desktopChild)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  await collectLogs([appData, localAppData, extractDirectory]).catch(() => '')

  if (mode === 'standard' && uninstaller && fs.existsSync(uninstaller)) {
    try {
      run(uninstaller, ['/S'], { env: applicationEnvironment, timeout: 180_000 })
    } catch (error) {
      if (!summary.error)
        summary.error = `静默卸载失败: ${error instanceof Error ? error.message : error}`
    }
  }

  summary.finishedAt = new Date().toISOString()
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
}

if (summary.error) throw new Error(summary.error)
console.log(__t('scripts.validate-release-artifact', '{0} 最终产物黑盒验收通过', [mode]))
