/**
 * @file 耳朵的进程回环录音：编译并缓存 C# 助手，启动它录「除 infOS 进程树以外」的整机声音。
 *
 * - 支持条件：Windows 10 2004（内部版本 19041）及以上，实际能否录由运行时探测；系统自带 .NET Framework 4 的 csc.exe。
 * - 编译：与视觉助手同一套机制。源码按内容哈希命名缓存在 `desktop-bridge/`，编译完记下 SHA-256
 *   （assemblyIntegrity，带签名），加载前比对，不一致就删掉重新编译。
 * - 运行：PowerShell 先读 DLL 字节、算哈希，与 TS 侧给出的哈希一致才 `Assembly.Load(byte[])`，再调用
 *   `InfOSEarsLoopback.Run(主进程 PID, 16000)`；读取与加载之间文件被换掉也无效。
 * - 数据：标准输出是 16 kHz float32 裸采样，这里凑满 0.5 秒交给耳朵一次（与 Electron 录音页相同）。
 *   标准错误每行一个 JSON：ready / error。关掉标准输入即要求助手结束。
 *
 * 失败（不支持、编译失败、激活失败、中途退出）一律以 `EARS_LOOPBACK_*` 错误码交给调用方，由
 * earsCaptureSelect 退回 Electron 的整机录音 + 「她出声时整段丢弃」。
 *
 * @platform WINDOWS
 * @see earsLoopbackSource.ts
 * @see .docs/B02_DESKTOP_AUTOMATION.md 耳朵
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assemblyIntegrity, sha256File, type AssemblyIntegrity } from '../home/assemblyIntegrity'
import type { CaptureCallbacks } from './earsCapture'
import { SAMPLE_RATE } from './earsEngine'
import { EARS_LOOPBACK_SOURCE } from './earsLoopbackSource'

/** 进程回环最早可用的 Windows 内部版本（Windows 10 2004）；微软示例标 20348，低于它时靠运行时失败处理。 */
export const LOOPBACK_MIN_BUILD = 19041
/** 每块交给耳朵的采样数（0.5 秒）。 */
export const LOOPBACK_CHUNK = SAMPLE_RATE / 2
/** 等助手报告 ready 的时长（含首次编译之后的启动）。 */
export const LOOPBACK_READY_TIMEOUT_MS = 20_000

/** 系统是否可能支持进程回环；不支持时给出原因（错误码开头）。 */
export function loopbackSupport(
  platform: string = process.platform,
  release: string = os.release(),
): { supported: true } | { supported: false; reason: string } {
  if (platform !== 'win32')
    return { supported: false, reason: 'EARS_LOOPBACK_UNSUPPORTED: 需要 Windows' }
  const build = Number(release.split('.')[2])
  if (!Number.isFinite(build) || build < LOOPBACK_MIN_BUILD)
    return {
      supported: false,
      reason: `EARS_LOOPBACK_UNSUPPORTED: 需要 Windows 10 2004（${LOOPBACK_MIN_BUILD}）或更新版本，当前 ${release}`,
    }
  return { supported: true }
}

/** 系统自带的 csc.exe（优先 64 位）。 */
export function loopbackCompiler(
  windowsDir = process.env.SystemRoot ?? 'C:\\Windows',
  exists: (file: string) => boolean = fs.existsSync,
): string {
  const csc = ['Framework64', 'Framework']
    .map((name) => path.win32.join(windowsDir, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe'))
    .find(exists)
  if (!csc) throw new Error('EARS_LOOPBACK_UNAVAILABLE: 系统没有 .NET Framework 4 的 csc.exe')
  return csc
}

/** 按源码内容命名缓存文件：源码变化后自动重新编译。 */
export function loopbackHelperFile(cacheDir: string, source = EARS_LOOPBACK_SOURCE): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  return path.join(cacheDir, `infos-ears-loopback-${hash}.dll`)
}

function compile(csc: string, output: string, source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      csc,
      ['/nologo', '/target:library', '/optimize+', `/out:${output}`, source],
      { windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) =>
        error ? reject(new Error(`${stdout}${stderr}`.trim() || error.message)) : resolve(),
    )
  })
}

let pending: Promise<{ file: string; sha256: string }> | undefined

/** 返回可加载的助手 DLL 与它的哈希；没有可信缓存时编译。失败抛 `EARS_LOOPBACK_UNAVAILABLE`。 */
export function ensureLoopbackHelper(
  cacheDir: string,
  integrity: AssemblyIntegrity = assemblyIntegrity,
): Promise<{ file: string; sha256: string }> {
  const output = loopbackHelperFile(cacheDir)
  const trusted = integrity.verifyOrRemove(output)
  if (trusted) return Promise.resolve({ file: output, sha256: trusted })
  if (pending) return pending
  const promise = (async () => {
    const csc = loopbackCompiler()
    fs.mkdirSync(cacheDir, { recursive: true })
    const source = `${output}.${process.pid}.cs`
    const temporary = `${output}.${process.pid}.dll`
    fs.writeFileSync(source, EARS_LOOPBACK_SOURCE, 'utf8')
    try {
      await compile(csc, temporary, source)
      const sha256 = sha256File(temporary)
      // 先记下哈希再改名：改名后被替换的文件在加载前会被发现。
      integrity.record(output, sha256)
      fs.renameSync(temporary, output)
      return { file: output, sha256 }
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      throw new Error(
        detail.startsWith('EARS_LOOPBACK_')
          ? detail
          : `EARS_LOOPBACK_UNAVAILABLE: 录音组件编译失败：${detail}`,
      )
    } finally {
      fs.rmSync(source, { force: true })
      fs.rmSync(temporary, { force: true })
    }
  })()
  pending = promise
  const settle = () => {
    if (pending === promise) pending = undefined
  }
  void promise.then(settle, settle)
  return promise
}

/** PowerShell 启动脚本：按字节比对哈希后加载助手并开始录音。 */
export function loopbackScript(): string {
  return [
    '$ErrorActionPreference="Stop"',
    '$b=[IO.File]::ReadAllBytes($env:INFOS_EARS_HELPER)',
    '$h=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace("-","").ToLowerInvariant()',
    `if($h -ne $env:INFOS_EARS_HELPER_SHA256){[Console]::Error.WriteLine('{"error":"EARS_LOOPBACK_UNAVAILABLE: helper hash mismatch"}');exit 3}`,
    '[void][Reflection.Assembly]::Load([byte[]]$b)',
    `exit [InfOSEarsLoopback]::Run([int]$env:INFOS_EARS_EXCLUDE_PID,${SAMPLE_RATE},[int]$env:INFOS_EARS_INCLUDE_TARGET)`,
  ].join(';')
}

/** 把标准输出的字节流切成 0.5 秒一块的 float32 采样（跨 data 事件拼接，不丢不重）。 */
export class SampleChunker {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  constructor(private readonly emit: (samples: Float32Array) => void) {}

  push(data: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data
    const bytes = LOOPBACK_CHUNK * 4
    while (this.buffer.length >= bytes) {
      const chunk = new Float32Array(LOOPBACK_CHUNK)
      Buffer.from(chunk.buffer).set(this.buffer.subarray(0, bytes))
      this.buffer = this.buffer.subarray(bytes)
      this.emit(chunk)
    }
  }
}

/** 子进程的最小接口（便于替身）。 */
export interface LoopbackChild {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  stdin: { end(): void; on(event: 'error', listener: () => void): void }
  on(event: 'exit', listener: (code: number | null) => void): void
  kill(): void
}

export interface LoopbackDeps {
  /** 准备好助手 DLL（编译或校验缓存）。 */
  helper: () => Promise<{ file: string; sha256: string }>
  /** 要排除的进程树根（infOS 主进程）。 */
  excludePid: number
  /** 目标模式只能录此进程树，不支持时停止，禁止退回整机。 */
  includeTarget?: boolean
  launch?: (env: Record<string, string>) => LoopbackChild
  now?: () => number
  readyTimeoutMs?: number
}

function launchPowerShell(env: Record<string, string>): LoopbackChild {
  return spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(loopbackScript(), 'utf16le').toString('base64'),
    ],
    { windowsHide: true, stdio: 'pipe', env: { ...process.env, ...env } },
  )
}

/** 进程回环录音（与 EarsCapture 同一接口）。ready 之前失败与之后中断都通过 ended(error) 报告。 */
export class ProcessLoopbackCapture {
  private child?: LoopbackChild
  private callbacks?: CaptureCallbacks
  private session = 0
  /** 助手已报告开始录音。 */
  ready = false

  constructor(private readonly deps: LoopbackDeps) {}

  get running(): boolean {
    return !!this.callbacks
  }

  start(callbacks: CaptureCallbacks): void {
    if (this.callbacks) return
    this.callbacks = callbacks
    this.ready = false
    const session = ++this.session
    void this.deps.helper().then(
      (helper) => {
        if (session === this.session) this.spawn(session, helper)
      },
      (error: Error) => {
        if (session === this.session) this.finish(error.message)
      },
    )
  }

  private spawn(session: number, helper: { file: string; sha256: string }): void {
    let child: LoopbackChild
    try {
      child = (this.deps.launch ?? launchPowerShell)({
        INFOS_EARS_HELPER: helper.file,
        INFOS_EARS_HELPER_SHA256: helper.sha256,
        INFOS_EARS_EXCLUDE_PID: String(this.deps.excludePid),
        INFOS_EARS_INCLUDE_TARGET: this.deps.includeTarget ? '1' : '0',
      })
    } catch (error) {
      return this.finish(
        `EARS_LOOPBACK_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.child = child
    child.stdin.on('error', () => {})
    const now = this.deps.now ?? Date.now
    const chunker = new SampleChunker((samples) => {
      if (session === this.session) this.callbacks?.chunk(samples, now())
    })
    child.stdout.on('data', (data: Buffer) => chunker.push(data))
    let reported: string | undefined
    let text = ''
    child.stderr.on('data', (data: Buffer | string) => {
      text += data.toString()
      const lines = text.split(/\r?\n/)
      text = lines.pop() ?? ''
      for (const line of lines) {
        let message: { ready?: boolean; error?: string }
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue
        }
        if (message.ready && session === this.session) { this.ready = true; this.callbacks?.ready?.() }
        if (typeof message.error === 'string') reported = message.error.slice(0, 300)
      }
    })
    const timer = setTimeout(() => {
      if (session === this.session && !this.ready)
        this.finish('EARS_LOOPBACK_FAILED: 录音组件启动超时')
    }, this.deps.readyTimeoutMs ?? LOOPBACK_READY_TIMEOUT_MS)
    timer.unref?.()
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (session !== this.session) return
      this.finish(reported ?? `EARS_LOOPBACK_FAILED: 录音组件已退出（${code ?? 'killed'}）`)
    })
  }

  stop(): void {
    this.finish()
  }

  private finish(error?: string): void {
    const callbacks = this.callbacks
    const child = this.child
    this.session++
    this.callbacks = undefined
    this.child = undefined
    this.ready = false
    if (child) {
      try {
        child.stdin.end()
      } catch {
        // 进程已退出。
      }
      setTimeout(() => child.kill(), 1500).unref?.()
    }
    callbacks?.ended(error)
  }
}
