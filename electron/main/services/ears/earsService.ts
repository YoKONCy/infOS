/**
 * @file 耳朵：录电脑放出的声音并在本机转写，台词按调用方「上次到这次」只给一次。
 *
 * 流程：录音窗口（earsCapture）每 0.5 秒交来一块 16 kHz 音频 → 闸门（earsAudio）丢掉静音和 infOS 自己的声音
 * → 识别进程（earsWorker，sherpa-onnx：silero VAD 切段 + SenseVoice）→ 台词列表（earsTranscript）。
 *
 * - 只有设置「桌面与家 → 耳朵」打开、模型已下载并校验通过时才能开始；默认关闭。
 * - 按调用方引用计数：有人在听才录，最后一个人停了就停（录音窗口和识别进程一起关）。
 * - 设置里关掉耳朵、识别进程退出、录音失败时立刻停止，原因记在 lastError。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 耳朵
 */

import { t as __t } from '../../utils/i18n'
import { EventEmitter } from 'node:events'
import type { DesktopHomeEars } from '@infos/shared'
import { AudioGate } from './earsAudio'
import type { CaptureCallbacks } from './earsCapture'
import type { EarsModelPaths } from './earsEngine'
import { formatLines, Transcript, type HeardLine } from './earsTranscript'
import type { EarsWorkerEvent, EarsWorkerRequest } from './earsWorker'

export interface WorkerLike {
  postMessage(message: EarsWorkerRequest): void
  on(event: 'message', listener: (message: EarsWorkerEvent) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  kill(): void
}

export interface EarsDeps {
  settings: () => DesktopHomeEars
  model: { ready(): boolean; paths(): EarsModelPaths }
  capture: { start(callbacks: CaptureCallbacks): void; stop(): void; readonly running: boolean; readonly capturing?: boolean }
  createWorker: () => WorkerLike
  /** infOS 自己的窗口此刻是否在出声（TTS 等）。 */
  selfAudible: () => boolean
  /** 桌面操作总开关仍然打开（关掉后耳朵随之停止）。 */
  allowed: () => boolean
  target?: () => { windowId: string; processGeneration: string } | undefined
  now?: () => number
}

export type ListenResult = { listening: true } | { listening: false; reason: string }

export class EarsService extends EventEmitter {
  readonly transcript: Transcript
  private readonly owners = new Set<string>()
  private worker?: WorkerLike
  private gate?: AudioGate
  lastError?: string

  constructor(private readonly deps: EarsDeps) {
    super()
    this.transcript = new Transcript(deps.now)
  }

  get listening(): boolean {
    return !!this.worker && (this.deps.capture.capturing ?? this.deps.capture.running)
  }

  /** 为调用方开始听；不能听时说明原因（错误码开头），不抛错。 */
  acquire(owner: string): ListenResult {
    if (!this.deps.allowed())
      return {
        listening: false,
        reason: `EARS_DISABLED: ${__t('electron.ui.desktopControl', '桌面操作已关闭')}`,
      }
    const settings = this.deps.settings()
    if (!settings.enabled)
      return {
        listening: false,
        reason: `EARS_DISABLED: ${__t('electron.ui.desktopControl', '耳朵没有打开（设置 → 桌面与家 → 耳朵），请用户自己打开')}`,
      }
    if (!this.deps.model.ready())
      return {
        listening: false,
        reason: `EARS_MODEL_MISSING: ${__t('electron.ui.desktopControl', '识别模型还没下载，请用户在设置「桌面与家 → 耳朵」里点下载')}`,
      }
    this.owners.add(owner)
    this.transcript.begin(owner)
    if (!this.worker) {
      try {
        this.begin(settings)
      } catch {
        this.stopAll('EARS_START_FAILED')
      }
      if (!this.worker) {
        this.owners.delete(owner)
        this.transcript.forget(owner)
      }
    }
    return this.worker
      ? { listening: true }
      : { listening: false, reason: this.lastError ?? 'EARS_START_FAILED' }
  }

  release(owner: string): void {
    this.owners.delete(owner)
    this.transcript.forget(owner)
    if (!this.owners.size) this.end()
  }

  /** 设置里关掉耳朵或其他原因：所有人一起停。 */
  stopAll(reason?: string): void {
    if (reason) this.lastError = reason
    for (const owner of [...this.owners]) this.transcript.forget(owner)
    this.owners.clear()
    this.end()
  }

  isListeningFor(owner: string): boolean {
    return this.listening && this.owners.has(owner)
  }

  private begin(settings: DesktopHomeEars): void {
    this.lastError = undefined
    let worker: WorkerLike
    try {
      worker = this.deps.createWorker()
    } catch (error) {
      this.lastError = `EARS_START_FAILED: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    this.worker = worker
    this.gate = new AudioGate(settings.silenceThreshold)
    worker.on('message', (message) => {
      if (this.worker !== worker) return
      if (message.type === 'line')
        this.emit(
          'line',
          this.transcript.add({ text: message.text, start: message.start, end: message.end, target: this.deps.target?.() }),
        )
      else if (message.type === 'error') this.stopAll(message.error)
    })
    worker.on('exit', () => {
      if (this.worker === worker)
        this.stopAll(
          this.lastError ??
            `EARS_WORKER_EXITED: ${__t('electron.ui.desktopControl', '识别进程已退出')}`,
        )
    })
    worker.postMessage({
      type: 'init',
      paths: this.deps.model.paths(),
      language: settings.language,
    })
    this.deps.capture.start({
      ready: () => { if (this.worker === worker) this.emit('status') },
      chunk: (samples, at) => this.onChunk(samples, at),
      ended: (error) => {
        if (this.worker === worker) this.stopAll(error ?? 'EARS_CAPTURE_ENDED')
      },
    })
    this.emit('status')
  }

  private onChunk(samples: Float32Array, at: number): void {
    const worker = this.worker
    const gate = this.gate
    if (!worker || !gate) return
    if (!this.deps.allowed())
      return void this.stopAll(
        `EARS_DISABLED: ${__t('electron.ui.desktopControl', '桌面操作已关闭')}`,
      )
    const decision = gate.decide(samples, at, this.deps.selfAudible())
    if (decision === 'feed') worker.postMessage({ type: 'audio', samples, at })
    else if (decision === 'drop-flush') worker.postMessage({ type: 'flush' })
  }

  private end(): void {
    const worker = this.worker
    this.worker = undefined
    this.gate = undefined
    if (this.deps.capture.running) this.deps.capture.stop()
    if (worker) {
      try {
        worker.postMessage({ type: 'stop' })
      } catch {
        // 进程已退出。
      }
      setTimeout(() => worker.kill(), 2000).unref?.()
      this.emit('status')
    }
  }

  /** 交付给调用方：上次到这次之间的新台词（每句一次）。没在听也没有新台词时返回 undefined。 */
  deliver(owner: string): Record<string, unknown> | undefined {
    const listening = this.isListeningFor(owner)
    const { lines, more } = this.transcript.takeNew(owner)
    if (!lines.length && !listening) return undefined
    return heardField(lines, more, listening ? undefined : this.lastError)
  }

  /** 按时间段查询（只看，不移动游标）。 */
  query(from: number, to: number): Record<string, unknown> {
    const lines = this.transcript.range(from, to)
    return {
      from: new Date(from).toISOString(),
      to: new Date(Math.min(to, (this.deps.now ?? Date.now)())).toISOString(),
      count: lines.length,
      lines: formatLines(lines),
    }
  }

  setThreshold(threshold: number): void {
    this.gate?.setThreshold(threshold)
  }
}

/** 结果里的 heard 字段：紧凑文本，一行一句。 */
export function heardField(
  lines: HeardLine[],
  more: boolean,
  stopped?: string,
): Record<string, unknown> {
  return {
    ...(lines.length
      ? {
          since: new Date(lines[0]!.start).toISOString(),
          until: new Date(lines.at(-1)!.end).toISOString(),
        }
      : {}),
    count: lines.length,
    ...(lines.length ? { lines: formatLines(lines) } : {}),
    ...(more ? { more: true } : {}),
    ...(stopped ? { stopped } : {}),
  }
}
