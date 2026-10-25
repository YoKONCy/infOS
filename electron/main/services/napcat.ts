import { t as __t } from '../utils/i18n'
/**
 * NapCat QQ 机器人进程管理 (v2)
 *
 * 启动/停止/监控 NapCat 进程，管理日志和命令转发。
 *
 * - 优先使用官方 Node 发行包与内置运行时，保留 Shell 入口支持
 * - QQ 路径从注册表/默认路径自动查找
 * - 安装功能实现 (GitHub Release 自动下载解压)
 * - GatewayHub 通知替代 window.webContents
 * - OpenTelemetry 冲突修复
 *
 * @platform ELECTRON
 * @module electron/main/services/napcat
 */

import type { ChildProcess } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  prepareNapCatWebUi,
  observeNapCatWebUi,
  getNapCatWebUiEndpoint,
  redactNapCatWebUiLog,
} from './napcatWebUi'
import { BrowserWindow } from 'electron'
import AdmZip from 'adm-zip'
import { logger } from '../utils/logger'
import { paths } from '../utils/env'
import {
  NAPCAT_INSTALLATION_MARKER,
  hasNapCatNodeInstallation,
  prepareNapCatNodeInstallation,
  copyNapCatProgramFiles,
  getNapCatBuiltinProblem,
} from './napcatInstallation'

let napCatProcess: ChildProcess | null = null
let startPending: Promise<void> | undefined
let stopPending: Promise<void> | undefined
let launchGeneration = 0
let napCatLogs: string[] = []
let accountDiscoveryTimer: ReturnType<typeof setInterval> | null = null
const MAX_LOG_LINES = 500
export const NAPCAT_VERSION = '4.18.38'
const NAPCAT_ARCHIVE_SHA256 = 'b88007a373a30deefb387e7cf17911752ff900bce22c534b3da6b644f5c6d0ae'
let installationPending: Promise<boolean> | undefined
let installedVersionCache:
  | { file: string; modified: number; size: number; version: string | null }
  | undefined

/** 安装版本来自核心文件；按文件时间缓存，避免状态刷新反复读取大型脚本。 */
export function getInstalledNapCatVersion(): string | null {
  for (const file of [
    path.join(getNapCatDir(), 'napcat', 'napcat.mjs'),
    path.join(getNapCatDir(), 'napcat.mjs'),
  ]) {
    try {
      const stat = fs.statSync(file)
      if (
        installedVersionCache?.file === file &&
        installedVersionCache.modified === stat.mtimeMs &&
        installedVersionCache.size === stat.size
      )
        return installedVersionCache.version
      const source = fs.readFileSync(file, 'utf8')
      const version =
        source.match(/\bnapCatVersion\s*=\s*[^\r\n]*?["']v?(\d+\.\d+\.\d+)["']/)?.[1] ??
        source.match(/&&\s*["']v?(\d+\.\d+\.\d+)["']\s*\|\|\s*["']1\.0\.0-dev["']/)?.[1] ??
        null
      installedVersionCache = { file, modified: stat.mtimeMs, size: stat.size, version }
      return version
    } catch {
      /* 安装尚未完成或使用另一种入口。 */
    }
  }
  return null
}

function needsNapCatUpdate(version: string | null): boolean {
  if (!version) return checkNapCat()
  const actual = version.split('.').map(Number)
  const expected = NAPCAT_VERSION.split('.').map(Number)
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) return actual[index]! < expected[index]!
  }
  return false
}

// ─────────────────────────────────────────────
// 日志广播
// ─────────────────────────────────────────────

/** 向所有窗口推送 NapCat 日志 */
function broadcastNapCatLog(line: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send('napcat-log', line)
    }
  })
}
function broadcastNapCatState(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('napcat-state-changed', getNapCatStatus())
  }
}

/** 向所有窗口推送下载进度 */
function broadcastDownloadProgress(data: Record<string, unknown>): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send('napcat-download-progress', data)
    }
  })
}

// ─────────────────────────────────────────────
// 路径查找
// ─────────────────────────────────────────────

/** 后端 WS 端口 */
const BACKEND_PORT = Number(process.env.PERO_PORT ?? 9120)

/** 后端反向 WS 端点 (NapCat 连入后端的地址) */
const REVERSE_WS_URL = `ws://127.0.0.1:${BACKEND_PORT}/api/social/ws?platform=qq`

/** 我们在 NapCat 配置中使用的连接名称 (用于标识是我们自动注入的) */
const WS_CLIENT_NAME = 'infOS'

/** 获取 NapCat 安装目录 */
function getNapCatDir(): string {
  return path.join(paths.data, 'tools', 'NapCat')
}

/**
 * 获取 NapCat 配置目录
 *
 * NapCat Shell 的目录结构：
 *   <NapCat>/index.js          ← 启动入口（cwd）
 *   <NapCat>/napcat/napcat.mjs ← NapCat 核心
 *   <NapCat>/napcat/config/    ← 配置目录（onebot11_<QQ>.json 在这里）
 *
 * 旧代码误用 <NapCat>/config，实际 NapCat 把配置放在 napcat/config 子目录下。
 */
function getNapCatConfigDir(): string {
  return path.join(getNapCatDir(), 'napcat', 'config')
}
export function getNapCatDashboardEndpoint(): URL | undefined {
  return getNapCatWebUiEndpoint(getNapCatConfigDir())
}

/** 保存最近一次成功登录的账号，用于后续启动时自动传入快速登录参数。 */
function getQuickLoginAccountPath(): string {
  return path.join(getNapCatDir(), '.infos-quick-login-account')
}

function readQuickLoginAccount(): string | undefined {
  try {
    const account = fs.readFileSync(getQuickLoginAccountPath(), 'utf-8').trim()
    return /^\d{5,12}$/.test(account) ? account : undefined
  } catch {
    return undefined
  }
}

function saveQuickLoginAccount(account: string): void {
  if (!/^\d{5,12}$/.test(account) || account === readQuickLoginAccount()) return
  fs.writeFileSync(getQuickLoginAccountPath(), account, 'utf-8')
  logger.info(
    'NapCat',
    __t('electron.logs.napcat', '已记录 QQ {0}，下次启动将自动使用快速登录', [account]),
  )
  broadcastNapCatLog(`[系统] 已为 QQ ${account} 启用下次启动快速登录`)
}

/** 从 NapCat 生成的账号配置中识别扫码成功的账号，并完成 WS 与快速登录配置。 */
function discoverLoggedInAccounts(): string[] {
  const { accounts } = syncNapCatConfig()
  const currentAccount = readQuickLoginAccount()
  if (!currentAccount && accounts[0]) saveQuickLoginAccount(accounts[0])
  return accounts
}

function stopAccountDiscovery(): void {
  if (!accountDiscoveryTimer) return
  clearInterval(accountDiscoveryTimer)
  accountDiscoveryTimer = null
}

function startAccountDiscovery(): void {
  stopAccountDiscovery()
  // NapCat 会在登录、切换账号和运行期保存设置时重写 onebot11 配置。
  // 因此必须在进程存活期间持续幂等同步，不能因发现旧快速登录账号就提前停止。
  discoverLoggedInAccounts()
  accountDiscoveryTimer = setInterval(() => {
    discoverLoggedInAccounts()
  }, 1500)
}

/** 从注册表/默认路径查找 QQ.exe */
async function getQQPath(): Promise<string> {
  if (process.platform !== 'win32') return ''

  // 尝试注册表查找 (非阻塞, 兼容非 Windows 环境)
  try {
    // 动态导入 winreg (可能未安装)
    const winreg = await import('winreg').catch(() => null)
    if (winreg) {
      const regKeys = [
        '\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
        '\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      ]

      for (const keyPath of regKeys) {
        try {
          const key = new winreg.default({
            hive: winreg.default.HKLM,
            key: keyPath,
          })

          const item = await new Promise<{ value: string } | null>((resolve) => {
            key.get('UninstallString', (err: Error | null, item: { value: string } | null) => {
              if (err) resolve(null)
              else resolve(item)
            })
          })

          if (item) {
            const uninstallPath = item.value.replace(/"/g, '')
            const binDir = path.dirname(uninstallPath)
            const qqInBin = path.join(binDir, 'QQ.exe')
            const qqInRoot = path.join(binDir, '..', 'QQ.exe')

            if (fs.existsSync(qqInBin)) return qqInBin
            if (fs.existsSync(qqInRoot)) return path.normalize(qqInRoot)
          }
        } catch {
          // 忽略单个注册表键错误
        }
      }
    }
  } catch {
    // winreg 不可用
  }

  // 默认路径后备
  const possiblePaths = [
    'C:\\Program Files (x86)\\Tencent\\QQ\\Bin\\QQ.exe',
    'C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe',
  ]

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p
  }

  return ''
}

// ─────────────────────────────────────────────
// 入口点检测
// ─────────────────────────────────────────────

/** 检查 NapCat 是否已安装 */
export function checkNapCat(): boolean {
  const dir = getNapCatDir()
  const entryPoints = [
    path.join(dir, 'NapCat.Shell.exe'),
    path.join(dir, 'napcat.mjs'),
    path.join(dir, 'index.js'),
  ]
  return entryPoints.some((p) => fs.existsSync(p))
}

/** 解析启动命令和参数 */
export async function resolveEntryPoint(
  napCatDir: string,
  quickLoginAccount?: string,
): Promise<{
  cmd: string
  args: string[]
  env: Record<string, string | undefined>
}> {
  const shellExe = path.join(napCatDir, 'NapCat.Shell.exe')
  const napcatBat = path.join(napCatDir, 'napcat.bat')

  const env: Record<string, string | undefined> = {
    ...process.env,
    // [修复] 禁用 OpenTelemetry 以防止 libprotobuf UTF-8 错误
    OTEL_SDK_DISABLED: 'true',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    NAPCAT_PATH: napCatDir,
  }

  if (hasNapCatNodeInstallation(napCatDir)) {
    const installation = prepareNapCatNodeInstallation(napCatDir)
    if (installation.runtimeRepairWarning) {
      logger.warn('NapCat', installation.runtimeRepairWarning)
      broadcastNapCatLog(`[提示] ${installation.runtimeRepairWarning}`)
    }
    if (installation.repaired) {
      logger.info(
        'NapCat',
        __t('electron.logs.napcat', '已校正 QQ 版本信息：{0}', [installation.version]),
      )
      broadcastNapCatLog(`[系统] 已校正 QQ 版本信息：${installation.version}`)
    }
    if (installation.runtimeRepaired) {
      logger.info('NapCat', __t('electron.logs.napcat', '已应用 NapCat 运行兼容修复'))
      broadcastNapCatLog('[系统] 已应用 NapCat 运行兼容修复')
    }
    env.NAPCAT_WRAPPER_PATH = path.join(napCatDir, 'wrapper.node')
    env.NAPCAT_QQ_PACKAGE_INFO_PATH = path.join(napCatDir, 'package.json')
    env.NAPCAT_QQ_VERSION_CONFIG_PATH = path.join(napCatDir, 'config.json')
    env.NAPCAT_DISABLE_PIPE = '1'
    const args = [installation.entry]
    if (quickLoginAccount) args.push('--qq', quickLoginAccount)
    return { cmd: installation.command, args, env }
  }

  const qqPath = await getQQPath()

  if (fs.existsSync(shellExe)) {
    const args = qqPath ? ['-q', qqPath] : []
    if (quickLoginAccount) args.push('--qq', quickLoginAccount)
    return { cmd: shellExe, args, env }
  }

  if (fs.existsSync(napcatBat) && qqPath) {
    return { cmd: 'cmd.exe', args: ['/c', 'napcat.bat', '-q', qqPath], env }
  }

  throw new Error('未找到有效的 NapCat 入口点')
}

// ─────────────────────────────────────────────
// 反向 WS 自动配置
// ─────────────────────────────────────────────

/**
 * 扫描 NapCat 已登录的 QQ 号配置文件，
 * 自动注入指向后端 /api/social/ws 的反向 WS 连接。
 *
 * 配置文件格式: config/onebot11.json（新账号默认）及 onebot11_<QQ号>.json
 * 目标字段:     network.websocketClients[]
 *
 * 逻辑:
 * - 扫描 config/ 目录下所有 onebot11_*.json
 * - 如果已有 name='infOS' 的连接 → 确保 url 和 enable 正确
 * - 如果没有 → 追加一条新连接
 * - 首次扫码前准备默认配置，不将默认文件计入已登录账号
 *
 * @returns 已扫描账号及本轮实际修改的账号
 */
export interface NapCatConfigSyncResult {
  accounts: string[]
  changedAccounts: string[]
}

export function syncNapCatConfig(): NapCatConfigSyncResult {
  const configDir = getNapCatConfigDir()
  const configuredAccounts: string[] = []
  const changedAccounts: string[] = []
  const result = (): NapCatConfigSyncResult => ({
    accounts: configuredAccounts,
    changedAccounts,
  })

  // 扫描所有 onebot11_<QQ号>.json
  let entries: string[]
  try {
    // NapCat 支持 onebot11.json 作为新账号默认配置，必须在首次扫码前写入。
    fs.mkdirSync(configDir, { recursive: true })
    entries = [
      'onebot11.json',
      ...fs.readdirSync(configDir).filter((f) => /^onebot11_\d+\.json$/.test(f)),
    ]
  } catch {
    logger.warn('NapCat', __t('electron.logs.napcat', '读取配置目录失败'))
    return result()
  }

  for (const filename of entries) {
    const filePath = path.join(configDir, filename)
    const isDefault = filename === 'onebot11.json'
    const qqNumber = filename.replace('onebot11_', '').replace('.json', '')

    try {
      const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '{}'
      const config = JSON.parse(raw) as Record<string, unknown>
      let changed = false

      // 确保 network 对象存在
      if (!config.network || typeof config.network !== 'object' || Array.isArray(config.network)) {
        config.network = {}
        changed = true
      }
      const network = config.network as Record<string, unknown>

      // 确保 websocketClients 数组存在
      if (!Array.isArray(network.websocketClients)) {
        network.websocketClients = []
        changed = true
      }
      const clients = network.websocketClients as Array<Record<string, unknown>>

      // 查找是否已有 infOS 连接
      const existing = clients.find((client) => client.name === WS_CLIENT_NAME)
      const expectedClient: Record<string, unknown> = {
        name: WS_CLIENT_NAME,
        enable: true,
        url: REVERSE_WS_URL,
        messagePostFormat: 'array',
        reportSelfMessage: false,
        token: '',
      }

      if (existing) {
        for (const [key, value] of Object.entries(expectedClient)) {
          if (existing[key] !== value) {
            existing[key] = value
            changed = true
          }
        }
      } else {
        clients.push(expectedClient)
        changed = true
      }

      if (changed) {
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
        if (!isDefault) changedAccounts.push(qqNumber)
        logger.info(
          'NapCat',
          __t('electron.logs.napcat', '已同步{0}反向 WS 配置 → {1}', [
            isDefault ? '新账号默认' : ` QQ ${qqNumber} 的`,
            REVERSE_WS_URL,
          ]),
        )
      }

      if (!isDefault) configuredAccounts.push(qqNumber)
    } catch (err) {
      logger.warn(
        'NapCat',
        __t('electron.logs.napcat', '处理配置文件 {0} 失败: {1}', [filename, err]),
      )
    }
  }

  if (changedAccounts.length > 0) {
    broadcastNapCatLog(`[系统] 已自动同步 ${changedAccounts.length} 个账号的反向 WS 连接`)
  }
  return result()
}

/** 兼容渲染进程现有 IPC，仅返回已扫描并配置的账号。 */
export function ensureNapCatConfig(): string[] {
  return syncNapCatConfig().accounts
}

// ─────────────────────────────────────────────
// 启动 / 停止
// ─────────────────────────────────────────────

/** 启动 NapCat */
export function startNapCat(): Promise<void> {
  if (stopPending) return Promise.reject(new Error('NapCat 正在停止，请稍后重试'))
  if (startPending) return startPending
  startPending = launchNapCat(++launchGeneration).finally(() => {
    startPending = undefined
  })
  return startPending
}

async function launchNapCat(generation: number): Promise<void> {
  if (installationPending && !(await installationPending))
    throw new Error('NapCat 安装或更新失败，请完成更新后再启动')
  if (generation !== launchGeneration) throw new Error('NapCat 启动已取消')
  if (napCatProcess) {
    logger.warn('NapCat', __t('electron.logs.napcat', 'NapCat 进程已在运行'))
    return
  }

  const napCatDir = getNapCatDir()
  if (!checkNapCat()) {
    throw new Error('NapCat 未安装，请先执行安装')
  }
  if (fs.existsSync(path.join(napCatDir, NAPCAT_INSTALLATION_MARKER)))
    throw new Error('NapCat 上次安装未完成，请重新安装或更新后再启动')
  prepareNapCatWebUi(getNapCatConfigDir())

  // 启动前自动配置反向 WS，并恢复最近登录账号。
  const configured = discoverLoggedInAccounts()
  if (configured.length > 0) {
    broadcastNapCatLog(`[系统] 已预配置 ${configured.length} 个账号: ${configured.join(', ')}`)
  }

  const quickLoginAccount = readQuickLoginAccount()
  const { cmd, args, env } = await resolveEntryPoint(napCatDir, quickLoginAccount)
  if (generation !== launchGeneration) throw new Error('NapCat 启动已取消')
  if (quickLoginAccount) {
    broadcastNapCatLog(`[系统] 将使用 QQ ${quickLoginAccount} 尝试快速登录`)
  } else {
    broadcastNapCatLog('[系统] 首次登录成功后将自动启用快速登录')
  }
  logger.info(
    'NapCat',
    __t('electron.logs.napcat', '启动: {0} {1} (cwd: {2})', [cmd, args.join(' '), napCatDir]),
  )
  broadcastNapCatLog('[系统] 正在启动 NapCat...')

  const child = spawn(cmd, args, {
    cwd: napCatDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  napCatProcess = child
  broadcastNapCatState()

  // 按完整 UTF-8 行识别端口与凭据，避免分块输出截断链接或泄露 Token。
  const attachOutput = (stream: typeof child.stdout, prefix: string) => {
    const decoder = new StringDecoder('utf8')
    let pending = ''
    const publish = (line: string) => {
      if (!line) return
      if (napCatProcess === child) observeNapCatWebUi(line)
      const safe = prefix + redactNapCatWebUiLog(line)
      napCatLogs.push(safe)
      if (napCatLogs.length > MAX_LOG_LINES) napCatLogs.shift()
      broadcastNapCatLog(safe)
    }
    stream?.on('data', (data: Buffer) => {
      pending += decoder.write(data)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) publish(line)
      if (pending.length > 65536) pending = ''
    })
    stream?.on('end', () => publish(pending + decoder.end()))
  }
  attachOutput(child.stdout, '')
  attachOutput(child.stderr, '[ERROR] ')

  child.on('exit', (code) => {
    if (napCatProcess !== child) return
    stopAccountDiscovery()
    logger.info('NapCat', __t('electron.logs.napcat', 'NapCat 进程退出: code={0}', [code]))
    broadcastNapCatLog(`[系统] NapCat 已退出 (code=${code})`)
    napCatProcess = null
    broadcastNapCatState()
  })

  child.on('error', (err) => {
    if (napCatProcess !== child) return
    stopAccountDiscovery()
    logger.error('NapCat', __t('electron.logs.napcat', 'NapCat 启动失败: {0}', [err.message]))
    broadcastNapCatLog(`[错误] NapCat 启动失败: ${err.message}`)
    napCatProcess = null
    broadcastNapCatState()
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  if (napCatProcess === child) startAccountDiscovery()
}

/** 停止 NapCat (带超时保护) */
export function stopNapCat(): Promise<void> {
  if (stopPending) return stopPending
  // 取消尚在等待安装或入口解析的启动，避免退出后迟到的启动继续拉起进程。
  launchGeneration++
  stopAccountDiscovery()
  const operation = new Promise<void>((resolve) => {
    const child = napCatProcess
    if (!child) {
      resolve()
      return
    }

    logger.info('NapCat', __t('electron.logs.napcat', '正在停止 NapCat...'))
    let treeStopped: Promise<void> | undefined

    child.once('close', () => {
      clearTimeout(timer)
      if (napCatProcess === child) napCatProcess = null
      broadcastNapCatState()
      if (treeStopped) void treeStopped.then(resolve)
      else resolve()
    })
    // 超时强杀
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (napCatProcess === child) napCatProcess = null
      broadcastNapCatState()
      resolve()
    }, 4000)
    if (process.platform === 'win32' && child.pid) {
      // 新版 NapCat 会拉起 Worker；退出时必须同时结束子进程，释放 QQ 原生文件。
      treeStopped = new Promise<void>((done) => {
        execFile(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 3000 },
          (error) => {
            if (error && child.exitCode === null) child.kill('SIGKILL')
            done()
          },
        )
      })
    } else {
      child.kill('SIGTERM')
    }
  })
  stopPending = operation.finally(() => {
    stopPending = undefined
  })
  return stopPending
}

/** 获取 NapCat 日志 */
export function getNapCatLogs(): string[] {
  return [...napCatLogs]
}

/** 清空日志 */
export function clearNapCatLogs(): void {
  napCatLogs = []
}

/** 发送命令到 NapCat 进程 stdin */
export function sendNapCatCommand(command: string): void {
  if (!napCatProcess?.stdin) {
    logger.warn('NapCat', __t('electron.logs.napcat', '无法发送命令: NapCat 未运行'))
    return
  }
  napCatProcess.stdin.write(command + '\n')
}

/** 获取 NapCat 运行状态 */
export function getNapCatStatus(): {
  running: boolean
  pid: number | null
  logCount: number
  version: string | null
  targetVersion: string
  updateAvailable: boolean
  installing: boolean
} {
  const version = getInstalledNapCatVersion()
  return {
    running: napCatProcess !== null,
    pid: napCatProcess?.pid ?? null,
    logCount: napCatLogs.length,
    version,
    targetVersion: NAPCAT_VERSION,
    updateAvailable:
      needsNapCatUpdate(version) ||
      getNapCatBuiltinProblem(getNapCatDir()) !== null ||
      fs.existsSync(path.join(getNapCatDir(), NAPCAT_INSTALLATION_MARKER)),
    installing: !!installationPending,
  }
}

// ─────────────────────────────────────────────
// 安装
// ─────────────────────────────────────────────

/** 下载文件到 Buffer (简易实现) */
function downloadToBuffer(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('NapCat 下载重定向次数过多'))
    if (new URL(url).protocol !== 'https:')
      return reject(new Error('NapCat 下载地址必须使用 HTTPS'))
    const request = https.get(url, { timeout: 60000 }, (res) => {
      // 处理重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadToBuffer(new URL(res.headers.location, url).href, redirects + 1)
          .then(resolve)
          .catch(reject)
        return
      }

      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      const chunks: Buffer[] = []
      let totalSize = 0
      const contentLength = res.headers['content-length']
        ? Number.parseInt(res.headers['content-length'], 10)
        : NaN
      const maxSize = 512 * 1024 * 1024
      if (contentLength > maxSize) {
        res.destroy()
        reject(new Error('NapCat 安装包超过大小限制'))
        return
      }

      res.on('data', (chunk: Buffer) => {
        totalSize += chunk.length
        if (totalSize > maxSize) {
          res.destroy()
          reject(new Error('NapCat 安装包超过大小限制'))
          return
        }
        chunks.push(chunk)
        if (contentLength > 0) {
          const percent = Math.round((totalSize / contentLength) * 100)
          broadcastDownloadProgress({ percent, status: `下载中... ${percent}%` })
        }
      })

      res.on('end', () => {
        if (!res.complete || (Number.isFinite(contentLength) && totalSize !== contentLength))
          reject(new Error('NapCat 安装包下载不完整'))
        else resolve(Buffer.concat(chunks))
      })
      res.on('aborted', () => reject(new Error('NapCat 安装包下载中断')))
      res.on('error', reject)
    })

    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy()
      reject(new Error('下载超时'))
    })
  })
}

/** 安装 NapCat (从 GitHub Release 下载) */
export function installNapCat(update = false): Promise<boolean> {
  if (installationPending) return installationPending
  const operation = performNapCatInstallation(update)
  installationPending = operation.finally(() => {
    installationPending = undefined
    broadcastNapCatState()
  })
  broadcastNapCatState()
  return installationPending
}

async function performNapCatInstallation(update: boolean): Promise<boolean> {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('NapCat 自动安装目前仅支持 Windows x64')
  const dir = getNapCatDir()
  const emit = (msg: string) => {
    logger.info('NapCat', msg)
    broadcastNapCatLog(`[安装] ${msg}`)
  }

  const marker = path.join(dir, NAPCAT_INSTALLATION_MARKER)
  let intact = !fs.existsSync(marker)
  if (intact && !napCatProcess && !startPending && hasNapCatNodeInstallation(dir)) {
    try {
      const installation = prepareNapCatNodeInstallation(dir)
      if (installation.runtimeRepairWarning) emit(installation.runtimeRepairWarning)
      if (installation.repaired) emit(`已校正 QQ 版本信息：${installation.version}`)
      if (installation.runtimeRepaired) emit('已应用 NapCat 运行兼容修复')
    } catch {
      intact = false
    }
  }
  if (intact && checkNapCat() && (!update || !needsNapCatUpdate(getInstalledNapCatVersion()))) {
    emit('NapCat 已安装')
    return true
  }

  if (napCatProcess || startPending || stopPending) throw new Error('请先停止 NapCat，再更新版本')

  emit('开始安装 NapCat...')
  fs.mkdirSync(dir, { recursive: true })

  const version = `v${NAPCAT_VERSION}`
  const assetName = 'NapCat.Shell.Windows.Node.zip'

  // GitHub 镜像列表
  const mirrors = [
    `https://github.com/NapNeko/NapCatQQ/releases/download/${version}/${assetName}`,
    `https://gh-proxy.com/https://github.com/NapNeko/NapCatQQ/releases/download/${version}/${assetName}`,
    `https://mirror.ghproxy.com/https://github.com/NapNeko/NapCatQQ/releases/download/${version}/${assetName}`,
  ]

  let zipBuffer: Buffer | null = null

  for (const url of mirrors) {
    try {
      emit(`尝试下载: ${url}`)
      broadcastDownloadProgress({ percent: 0, status: '连接中...' })
      zipBuffer = await downloadToBuffer(url)
      if (createHash('sha256').update(zipBuffer).digest('hex') !== NAPCAT_ARCHIVE_SHA256) {
        zipBuffer = null
        throw new Error('安装包校验失败')
      }
      break
    } catch (err) {
      emit(`下载失败: ${err}`)
      continue
    }
  }

  if (!zipBuffer) {
    emit('所有镜像下载失败')
    broadcastDownloadProgress({ percent: 0, status: '下载失败', error: true })
    return false
  }

  emit('下载完成，正在解压...')
  broadcastDownloadProgress({ percent: 100, status: '解压中...', processing: true })

  const staging = fs.mkdtempSync(path.join(dir, '.infos-update-'))
  try {
    const zip = new AdmZip(zipBuffer)
    const prefix = path.resolve(staging) + path.sep
    for (const entry of zip.getEntries()) {
      const target = path.resolve(staging, entry.entryName)
      if (
        path.isAbsolute(entry.entryName) ||
        entry.entryName.includes(':') ||
        (target !== path.resolve(staging) && !target.startsWith(prefix)) ||
        ((entry.attr >>> 16) & 0xf000) === 0xa000
      )
        throw new Error('安装包包含越界路径')
    }
    zip.extractAllTo(staging, true)
    const candidates = [
      staging,
      ...fs
        .readdirSync(staging, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(staging, entry.name)),
    ]
    const source = candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, 'napcat', 'napcat.mjs')),
    )
    if (!source) throw new Error('安装包缺少 NapCat 核心文件')
    prepareNapCatNodeInstallation(source)
    const core = fs.readFileSync(path.join(source, 'napcat', 'napcat.mjs'), 'utf8')
    if (!new RegExp(`(?:["'])${NAPCAT_VERSION.replace(/\./g, '\\.')}["']`).test(core))
      throw new Error('安装包的 NapCat 版本与目标版本不一致')
    for (const action of [
      'fetch_custom_face_detail',
      'add_custom_face',
      'set_custom_face_desc',
      'delete_custom_face',
    ]) {
      if (!core.includes(action)) throw new Error(`安装包缺少收藏管理接口：${action}`)
    }
    // 原生文件被占用或磁盘写入失败时保留标记，下次只允许完整修复后启动。
    fs.writeFileSync(marker, NAPCAT_VERSION, 'utf8')
    copyNapCatProgramFiles(source, dir)
    prepareNapCatNodeInstallation(dir)
    installedVersionCache = undefined
    if (getInstalledNapCatVersion() !== NAPCAT_VERSION)
      throw new Error('NapCat 安装后版本校验失败，请重新安装')
    fs.unlinkSync(marker)

    emit('安装完成')
    broadcastDownloadProgress({ percent: 100, status: '安装完成', completed: true })
    return true
  } catch (err) {
    emit(`解压失败: ${err}`)
    broadcastDownloadProgress({ percent: 0, status: '安装失败', error: true })
    return false
  } finally {
    if (path.dirname(path.resolve(staging)) === path.resolve(dir))
      fs.rmSync(staging, { recursive: true, force: true })
  }
}
