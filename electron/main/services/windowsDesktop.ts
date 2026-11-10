import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { app } from 'electron'
import path from 'node:path'
import { assemblyIntegrity } from './home/assemblyIntegrity'
import { BridgeLateReplies } from './windowsDesktopLateReplies'
import { WINDOWS_DESKTOP_SOURCE } from './windowsDesktopSource'
import {
  bootstrapScript,
  bridgeAssemblyFile,
  COMPILE_START_TIMEOUT_MS,
  requestTimeout,
  START_TIMEOUT_MS,
  timeoutUncertain,
} from './windowsDesktopProtocol'
import type {
  DesktopWindowInfo,
  DesktopElementInfo,
  DesktopTextInfo,
  DesktopWindowState,
} from '@infos/shared'

interface WorkerMessage {
  visionWorker?: 'abandoned' | 'finished'
  visionId?: string
  id?: string
  ok?: boolean
  result?: unknown
  error?: string
  activity?: string
  ready?: boolean
  monitor?: boolean
  idleMs?: number
  dispatched?: boolean
  compiling?: boolean
  /** 刚编译出的缓存 DLL 的 SHA-256（由启动脚本从加载的字节算出）。 */
  assembly?: string
}

/** 桥接 DLL 的缓存目录；取不到用户数据目录（例如测试环境）时只做内存编译。 */
function assemblyFile(): string | undefined {
  try {
    return bridgeAssemblyFile(
      path.join(app.getPath('userData'), 'desktop-bridge'),
      WINDOWS_DESKTOP_SOURCE,
    )
  } catch {
    return undefined
  }
}

/**
 * 单个受控 Windows 桥接进程；取消必须等待输入清理或进程退出。
 * 单个请求超时只取消这一个请求；执行线程卡死（被放弃的请求长时间没有回音）才回收进程。
 * 事件：activity（用户输入）、unavailable（进程退出）、preparing（true 开始编译 C#，false 就绪）。
 */
class WindowsDesktop extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      cleanup: () => void
    }
  >()
  /** 超时被放弃的请求、视觉工作线程与临时文件（windowsDesktopLateReplies.ts）。 */
  private readonly late = new BridgeLateReplies(() => this.process)
  monitor = false
  lastActivityAt = 0
  /** 正在编译桥接 C#（首次启动或源码更新后）。 */
  preparing = false

  async start(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = this.launch().catch((error) => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }

  private launch(): Promise<void> {
    if (process.platform !== 'win32')
      throw new Error('DESKTOP_PLATFORM_UNSUPPORTED: 当前桌面执行器需要 Windows')
    const bootstrap = bootstrapScript()
    // 缓存 DLL 与编译时记下的哈希不一致（或没有记录）就删掉，启动脚本会重新编译。
    const dll = assemblyFile()
    const trusted = dll ? assemblyIntegrity.verifyOrRemove(dll) : undefined
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(bootstrap, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        stdio: 'pipe',
        env: {
          ...process.env,
          INFOS_DESKTOP_ASSEMBLY: dll ?? '',
          INFOS_DESKTOP_ASSEMBLY_SHA256: trusted ?? '',
        },
      },
    )
    this.process = child
    child.stdin.on('error', () => {})
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-3000)
    })
    return new Promise<void>((resolve, reject) => {
      let ready = false
      const expire = () => {
        child.kill()
        reject(new Error('DESKTOP_BRIDGE_TIMEOUT: Windows 桌面组件启动超时'))
      }
      let timer = setTimeout(expire, START_TIMEOUT_MS)
      const setPreparing = (value: boolean) => {
        if (this.preparing === value) return
        this.preparing = value
        this.emit('preparing', value)
      }
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        let message: WorkerMessage
        try {
          message = JSON.parse(line.replace(/^\uFEFF/, '')) as WorkerMessage
        } catch {
          return
        }
        if (this.late.visionMessage(message, child)) return
        if (message.assembly && dll) {
          assemblyIntegrity.record(dll, message.assembly)
        } else if (message.compiling) {
          // 首次编译 C# 需要更久：放宽启动超时并通知界面显示进度。
          clearTimeout(timer)
          timer = setTimeout(expire, COMPILE_START_TIMEOUT_MS)
          setPreparing(true)
        } else if (message.ready) {
          ready = true
          clearTimeout(timer)
          setPreparing(false)
          this.monitor = message.monitor === true
          this.lastActivityAt = Date.now() - Number(message.idleMs ?? 0)
          resolve()
        } else if (message.activity) {
          this.lastActivityAt = Date.now()
          this.emit('activity', message.activity)
        } else if (message.id) {
          if (this.late.late(message.id)) return
          const call = this.pending.get(message.id)
          if (!call) return
          this.pending.delete(message.id)
          this.late.settled(message.id)
          call.cleanup()
          if (message.ok) call.resolve(message.result)
          else
            call.reject(
              Object.assign(
                new Error(message.error ?? 'DESKTOP_BRIDGE_ERROR: Windows 桌面操作失败'),
                { dispatched: message.dispatched },
              ),
            )
        }
      })
      const closed = (error: Error) => {
        clearTimeout(timer)
        lines.close()
        setPreparing(false)
        if (!ready) reject(error)
        if (this.process !== child) return
        this.process = undefined
        this.starting = undefined
        this.monitor = false
        for (const call of this.pending.values()) {
          call.cleanup()
          call.reject(error)
        }
        this.pending.clear()
        this.late.reset()
        this.emit('unavailable', error.message)
      }
      child.once('error', (error) => closed(error))
      child.once('exit', () =>
        closed(
          new Error(`DESKTOP_BRIDGE_CLOSED: Windows 桌面组件已退出${stderr ? '：' + stderr : ''}`),
        ),
      )
      child.stdin.write(Buffer.from(WINDOWS_DESKTOP_SOURCE, 'utf8').toString('base64') + '\n')
    })
  }

  async request<T = unknown>(
    operation: string,
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    await this.start()
    if (signal?.aborted) throw new Error('DESKTOP_CANCELLED: 桌面操作已取消')
    const child = this.process!
    const id = randomUUID()
    this.late.track(id, operation, input)
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        if (!child.killed && child.stdin.writable)
          child.stdin.write(JSON.stringify({ operation: 'cancel', targetId: id }) + '\n')
      }
      // 超时只取消这一个请求：桥接收到取消后不会再发出这次请求的输入，迟到的回音丢弃。
      const timer = setTimeout(() => {
        const call = this.pending.get(id)
        if (!call) return
        this.pending.delete(id)
        call.cleanup()
        cancel()
        this.late.abandon(id, child)
        call.reject(
          Object.assign(
            new Error(
              `DESKTOP_REQUEST_TIMEOUT: Windows 桌面组件处理 ${operation} 超时，已取消这一个请求`,
            ),
            { dispatched: timeoutUncertain(operation) },
          ),
        )
      }, requestTimeout(operation))
      this.pending.set(id, {
        resolve: (value) =>
          signal?.aborted
            ? reject(new Error('DESKTOP_CANCELLED: 桌面操作已取消'))
            : resolve(value as T),
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
        },
      })
      signal?.addEventListener('abort', cancel, { once: true })
      // 视觉助手 DLL：附上编译时记下的哈希，桥接按字节比对后再加载。
      const helperSha256 =
        typeof input.helper === 'string' ? assemblyIntegrity.expected(input.helper) : undefined
      child.stdin.write(
        JSON.stringify({ ...input, ...(helperSha256 ? { helperSha256 } : {}), operation, id }) +
          '\n',
      )
      if (signal?.aborted) cancel()
    })
  }

  async stop(): Promise<void> {
    const child = this.process
    if (!child) return
    await this.request('release').catch(() => {})
    child.stdin.end()
  }

  async release(): Promise<void> {
    if (this.process && this.monitor) await this.request('release').catch(() => {})
  }

  windows(): Promise<DesktopWindowInfo[]> {
    return this.request('windows')
  }
  active(): Promise<DesktopWindowInfo | null> {
    return this.request('active')
  }
  observe(windowId?: string, includeElements = false, signal?: AbortSignal) {
    return this.request<{
      window: DesktopWindowInfo
      elements: DesktopElementInfo[]
      /** 界面文字（includeElements 时）。 */
      texts?: DesktopTextInfo[]
      /** 遍历因节点数、条数或耗时上限提前结束。 */
      truncated?: boolean
      state?: DesktopWindowState
    }>('observe', { windowId, includeElements }, signal)
  }
}

export const windowsDesktop = new WindowsDesktop()
