import { t as __t } from '../utils/i18n'
/**
 * 内置 Daemon — 打包发行版统一运行时拉起
 *
 * 所有打包发行形态（标准安装版、Steam 版、便携版）都随包携带同一份 Daemon：
 *   1. 探测业务健康接口 :9120，已就绪则复用；
 *   2. 未运行则用 Electron 自带 Node 运行时执行 resources/daemon/daemon.mjs；
 *   3. 显式注入 PERO_DATA_DIR / PERO_APP_ROOT，确保 Electron 与后端共享路径；
 *   4. Steam 版额外注入 Steam API 返回的全部 Workshop 安装目录；
 *   5. 开发模式继续使用独立 dev:daemon，不由 Electron 重复拉起。
 *
 * @module electron/main/services/portableDaemon
 */

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { stripVTControlCharacters } from 'node:util'
import { app } from 'electron'
import {
  DAEMON_ALREADY_RUNNING_EXIT_CODE,
  DAEMON_SHUTDOWN_MESSAGE,
  electronProcessEnvironment,
} from '@infos/shared'
import { isDev, paths } from '../utils/env'
import { getWorkshopInstallations } from './steam'
import { isRemoteConnection } from './clientConnection'
import { logger } from '../utils/logger'

/** 业务 HTTP 端口（与 backend SERVER_PORT 一致） */
const BUSINESS_PORT = Number(process.env.PERO_PORT ?? 9120)

/** 就绪轮询间隔（ms） */
const READY_POLL_INTERVAL_MS = 500

/** 就绪超时（ms） */
const READY_TIMEOUT_MS = 30_000

/** 内置 Daemon bundle 在 resources 下的相对路径 */
const DAEMON_BUNDLE_RELPATH = path.join('daemon', 'daemon.mjs')

/** 由本模块拉起的 Daemon 子进程（用于退出时回收） */
let daemonChild: ChildProcess | null = null
let startupPromise: Promise<boolean> | null = null
let shuttingDown = false
let logStartOffset = 0
let logFallback = ''

/** 仅宿主托管的后端可随客户端重启，外部实例不能被顺带结束。 */
export function ownsPortableDaemon(): boolean {
  return !!daemonChild
}

export interface DaemonStartupStatus {
  ready: boolean
  running: boolean
  attempted: boolean
  logPath: string
  error?: string
  logTail?: string
}

let startupStatus: DaemonStartupStatus = {
  ready: false,
  running: false,
  attempted: false,
  logPath: '',
}

/** 返回启动状态与日志尾部，供 Launcher 直接展示真实错误。 */
export function getPortableDaemonStatus(): DaemonStartupStatus {
  const status = { ...startupStatus }
  if (logFallback) status.logTail = stripVTControlCharacters(logFallback).slice(-4000)
  if (status.logPath && fs.existsSync(status.logPath)) {
    try {
      const fd = fs.openSync(status.logPath, 'r')
      try {
        const size = fs.fstatSync(fd).size
        const start = Math.min(size, Math.max(logStartOffset, size - 16_384))
        const buffer = Buffer.alloc(size - start)
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, start)
        status.logTail = stripVTControlCharacters(buffer.subarray(0, bytes).toString('utf8')).slice(
          -4000,
        )
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // 日志可能正被子进程占用，保留已有状态。
    }
  }
  return status
}

/** 确认实际业务服务健康，不能将任意占用端口的程序视为后端。 */
export async function probeBusinessHealth(): Promise<boolean> {
  if (isRemoteConnection()) return false
  try {
    const response = await fetch(`http://127.0.0.1:${BUSINESS_PORT}/api/health`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      return false
    }
    const body = (await response.json()) as { data?: { status?: string } }
    return body.data?.status === 'ok'
  } catch {
    return false
  }
}

/** 轮询等待业务端口就绪 */
async function waitForBusinessReady(timeoutMs: number, child?: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (
      shuttingDown ||
      (child && (daemonChild !== child || child.exitCode !== null || child.signalCode !== null))
    ) {
      // 其他入口已抢先取得同一数据目录的实例锁，等待它就绪，不重复创建进程。
      if (!shuttingDown && child?.exitCode === DAEMON_ALREADY_RUNNING_EXIT_CODE) {
        return waitForBusinessReady(Math.max(0, deadline - Date.now()))
      }
      return false
    }
    if (await probeBusinessHealth()) {
      if (shuttingDown || (child && daemonChild !== child)) return false
      startupStatus = { ...startupStatus, ready: true, running: true, error: undefined }
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS))
  }
  return false
}

/** 回收本模块拉起的 Daemon 子进程 */
export async function stopPortableDaemon(): Promise<void> {
  shuttingDown = true
  startupStatus = { ...startupStatus, ready: false }
  const child = daemonChild
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  logger.info(
    'PortableDaemon',
    __t('electron.logs.portableDaemon', '正在停止本模块拉起的 Daemon...'),
  )
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish()
    const terminate = () => {
      try {
        child.kill()
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    child.once('exit', onExit)
    const timer = setTimeout(() => {
      try {
        forceTimer = setTimeout(
          () => finish(new Error(__t('electron.logs.portableDaemon', '等待 Daemon 退出超时'))),
          2000,
        )
        child.kill('SIGKILL')
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }, 5000)
    try {
      if (child.connected) {
        child.send({ type: DAEMON_SHUTDOWN_MESSAGE }, (error) => {
          if (error && !settled) terminate()
        })
      } else {
        terminate()
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
  startupStatus = { ...startupStatus, ready: false, running: false }
}

/**
 * 确保 Daemon 可用
 *
 * 所有打包版共用内置 Daemon；并发请求共用一次启动，失败后可由用户重试。
 * 开发模式仍由外部管理 Daemon，退出过程中禁止重新拉起。
 *
 * @returns 是否成功等待到 Daemon 就绪
 */
export async function ensurePortableDaemon(): Promise<boolean> {
  if (isRemoteConnection()) return false
  if (shuttingDown) return false
  if (startupPromise) return startupPromise
  startupPromise = startPortableDaemon()
  try {
    return await startupPromise
  } finally {
    startupPromise = null
  }
}

async function startPortableDaemon(): Promise<boolean> {
  // 已在运行（或外部 Daemon）：直接确认就绪
  if (await probeBusinessHealth()) {
    if (shuttingDown) return false
    startupStatus = { ...startupStatus, ready: true, running: true, error: undefined }
    return true
  }

  // 开发模式继续使用独立 dev:daemon，避免热开发时 Electron 重复拉起打包 bundle。
  if (isDev) {
    logger.info(
      'PortableDaemon',
      __t(
        'electron.logs.portableDaemon',
        '开发模式，跳过内置 Daemon 拉起（:{0} 未就绪，请运行 dev:daemon）',
        [BUSINESS_PORT],
      ),
    )
    return false
  }

  if (shuttingDown) return false
  // 超时但仍存活的子进程继续等待，不能重复启动并争用同一数据目录。
  if (daemonChild) {
    return waitForBusinessReady(READY_TIMEOUT_MS, daemonChild)
  }
  startupStatus = {
    ...startupStatus,
    ready: false,
    running: false,
    attempted: true,
    error: undefined,
    logPath: '',
  }
  logFallback = ''

  const bundlePath = path.join(process.resourcesPath, DAEMON_BUNDLE_RELPATH)
  if (!fs.existsSync(bundlePath)) {
    const error = __t('electron.logs.portableDaemon', '未找到内置 Daemon bundle: {0}', [bundlePath])
    startupStatus = { ...startupStatus, error }
    logger.warn(
      'PortableDaemon',
      __t('electron.logs.portableDaemon', '{0}，桌面能力将不可用', [error]),
    )
    return false
  }

  // Electron 与后端共享同一个业务数据目录；标准/Steam 位于 userData/data，便携位于 exe/data。
  const dataDir = paths.data
  // 后端运行时根 = resources/backend（内置 prompts/agents/presets 均在此）。
  const backendRoot = path.join(process.resourcesPath, 'backend')
  // Steam API 返回真实安装目录，兼容多磁盘和跨平台；非 Steam 版自然为空。
  const workshopDirs = getWorkshopInstallations().map((item) => item.folder)

  logger.info(
    'PortableDaemon',
    __t('electron.logs.portableDaemon', '打包版拉起内置 Daemon: {0}', [bundlePath]),
  )
  logger.info('PortableDaemon', __t('electron.logs.portableDaemon', '  数据目录: {0}', [dataDir]))
  logger.info(
    'PortableDaemon',
    __t('electron.logs.portableDaemon', '  后端根:   {0}', [backendRoot]),
  )
  logger.info(
    'PortableDaemon',
    __t('electron.logs.portableDaemon', '  Workshop: {0} 个订阅目录', [workshopDirs.length]),
  )

  // Daemon 在窗口隐藏模式下运行，必须持久化 stdout/stderr，否则启动早期异常会完全丢失。
  const daemonLogPath = path.join(paths.logs, 'daemon-bootstrap.log')
  startupStatus = { ...startupStatus, running: true, error: undefined }
  let daemonLogFd: number | null = null
  try {
    try {
      fs.mkdirSync(paths.logs, { recursive: true })
      daemonLogFd = fs.openSync(daemonLogPath, 'a')
      logStartOffset = fs.fstatSync(daemonLogFd).size
      fs.writeSync(
        daemonLogFd,
        `\n[${new Date().toISOString()}] ${__t('electron.logs.portableDaemon', '启动内置 Daemon')}\n`,
      )
      startupStatus = { ...startupStatus, logPath: daemonLogPath }
    } catch (error) {
      if (daemonLogFd !== null) fs.closeSync(daemonLogFd)
      daemonLogFd = null
      // 日志只是诊断设施；单个日志文件被占用时改用限长内存缓冲，继续启动业务后端。
      logFallback =
        __t('electron.logs.portableDaemon', '启动日志暂不可写，改用内存诊断: {0}', [
          String(error),
        ]) + '\n'
      logger.warn('PortableDaemon', logFallback.trim())
    }
    daemonChild = spawn(process.execPath, [bundlePath], {
      env: electronProcessEnvironment(
        {
          ...process.env,
          NODE_ENV: 'production',
          // 数据目录一锤定音，确保数据库、Agent、Workspace、扩展和 Skills 全部同根。
          PERO_DATA_DIR: dataDir,
          // 后端根目录（内置角色/提示词/预设资源位置）。
          PERO_APP_ROOT: backendRoot,
          INFOS_RESOURCES_ROOT: process.resourcesPath,
          INFOS_FRONTEND_ROOT: path.join(process.resourcesPath, 'frontend'),
          // 多个 Workshop item 根以 JSON 传递，避免 Windows 路径分隔与盘符歧义。
          PERO_WORKSHOP_DIRS: JSON.stringify(workshopDirs),
        },
        'node',
      ),
      cwd: path.dirname(app.getPath('exe')),
      stdio: ['ignore', daemonLogFd ?? 'pipe', daemonLogFd ?? 'pipe', 'ipc'],
      windowsHide: true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    startupStatus = {
      ...startupStatus,
      ready: false,
      running: false,
      error: __t('electron.logs.portableDaemon', '进程启动失败: {0}', [message]),
    }
    logger.error(
      'PortableDaemon',
      __t('electron.logs.portableDaemon', '内置 Daemon 启动失败: {0}', [message]),
    )
    return false
  } finally {
    // spawn 已为子进程复制日志句柄，父进程必须立即释放自己的描述符。
    if (daemonLogFd !== null) fs.closeSync(daemonLogFd)
  }

  const child = daemonChild
  if (!child) return false
  const capture = (chunk: Buffer) => {
    logFallback = (logFallback + chunk.toString('utf8')).slice(-8000)
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  child.on('error', (err) => {
    if (daemonChild !== child) return
    // 未取得 PID 代表进程根本没有创建成功，允许下次重试。
    if (!child.pid) daemonChild = null
    startupStatus = {
      ...startupStatus,
      ready: false,
      running: false,
      error: __t('electron.logs.portableDaemon', '进程启动失败: {0}', [err.message]),
    }
    logger.error(
      'PortableDaemon',
      __t('electron.logs.portableDaemon', '内置 Daemon 启动失败: {0}', [err.message]),
    )
  })
  child.on('exit', (code, signal) => {
    if (daemonChild !== child) return
    startupStatus = {
      ...startupStatus,
      ready: false,
      running: false,
      error: shuttingDown
        ? undefined
        : __t('electron.logs.portableDaemon', 'Daemon 已退出：code={0}, signal={1}', [
            code,
            signal,
          ]),
    }
    logger.warn(
      'PortableDaemon',
      __t('electron.logs.portableDaemon', '内置 Daemon 退出: code={0}, signal={1}；启动日志: {2}', [
        code,
        signal,
        daemonLogPath,
      ]),
    )
    daemonChild = null
  })

  // 等待业务端口就绪（最多 30s），失败不阻塞主流程（capabilityProvider 重连兜底）
  const ready = await waitForBusinessReady(READY_TIMEOUT_MS, child)
  if (shuttingDown) return false
  if (ready) {
    startupStatus = { ...startupStatus, ready: true, running: true, error: undefined }
    logger.info(
      'PortableDaemon',
      __t('electron.logs.portableDaemon', '内置 Daemon 已就绪 → :{0}', [BUSINESS_PORT]),
    )
  } else {
    startupStatus = {
      ...startupStatus,
      ready: false,
      error:
        startupStatus.error ??
        __t('electron.logs.portableDaemon', 'Daemon 启动超时（:{0}）', [BUSINESS_PORT]),
    }
    logger.warn(
      'PortableDaemon',
      __t('electron.logs.portableDaemon', '内置 Daemon 启动超时（:{0}），桌面能力可能暂不可用', [
        BUSINESS_PORT,
      ]),
    )
  }
  return ready
}
