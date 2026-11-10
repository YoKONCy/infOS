/**
 * @file 耳朵的录音方式选择：优先按进程排除 infOS 自己的声音，不行就退回整机录音 + 整段丢弃。
 *
 * - `process`（设置 `ears.selfExclusion = "process"`，默认）：用进程回环（earsLoopback）录除 infOS 进程树
 *   以外的声音。她的 TTS 根本录不进来，闸门不再需要在她出声时丢弃，电影声音不受影响。
 * - `system`：Electron 录音页录整机声音，她出声时整段丢弃（原来的做法）。用户选了「整段丢弃」、系统不支持
 *   进程回环、或助手启动 / 运行失败时使用。失败原因记在 fallbackReason，同一次运行里 10 分钟内不再重试。
 *
 * 退回是无缝的：进程回环中途失败时立刻换成整机录音继续听，不打断耳朵。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 耳朵
 */

import type { CaptureCallbacks } from './earsCapture'

export type EarsCaptureMode = 'process' | 'system'

export interface CaptureLike {
  start(callbacks: CaptureCallbacks): void
  stop(): void
  readonly running: boolean
  readonly ready?: boolean
}

export interface CaptureSelectDeps {
  /** Electron 录音页（整机声音）。 */
  system: CaptureLike
  /** 进程回环；当前系统不支持时为 undefined，并在 unsupported 里说明原因。 */
  process?: CaptureLike
  unsupported?: string
  /** 用户选的方式。 */
  preferred: () => 'process' | 'drop'
  /** 录音方式变化（设置页状态刷新）。 */
  onChange?: () => void
  now?: () => number
}

/** 进程回环失败后多久再试（毫秒）。 */
export const LOOPBACK_RETRY_MS = 10 * 60_000
/** 陪看的目标录音失败后很快重试：看视频时等 10 分钟，这段就听不到了。 */
export const TARGET_RETRY_MS = 15_000
export const TARGET_RETRY_MAX_MS = 2 * 60_000

export class EarsCaptureSelect implements CaptureLike {
  private active?: CaptureLike
  private callbacks?: CaptureCallbacks
  private failedAt = -Infinity
  private targetFailures = 0
  private target?: CaptureLike
  setTarget(capture?: CaptureLike): void { this.stop(); this.target = capture }
  /** 当前的录音方式（没在录时为 undefined）。 */
  mode?: EarsCaptureMode
  /** 想用进程回环却没用上的原因（错误码开头）。 */
  fallbackReason?: string

  constructor(private readonly deps: CaptureSelectDeps) {}

  get running(): boolean {
    return !!this.active
  }
  /** 目标录音刚失败，还在歇。 */
  get coolingDown(): boolean { return (this.deps.now ?? Date.now)() - this.failedAt < this.retryDelay() }
  private retryDelay(): number {
    if (!this.target && !this.targetFailures) return LOOPBACK_RETRY_MS
    return Math.min(TARGET_RETRY_MAX_MS, TARGET_RETRY_MS * 2 ** Math.max(0, this.targetFailures - 1))
  }
  get capturing(): boolean { return !!this.active && (this.active.ready ?? this.active.running) }

  /** 她自己的声音已经在录音层面排除了（闸门不必在她出声时丢弃）。 */
  get selfExcluded(): boolean {
    return this.mode === 'process'
  }

  start(callbacks: CaptureCallbacks): void {
    if (this.active) return
    this.callbacks = callbacks
    const now = (this.deps.now ?? Date.now)()
    if (this.target) {
      // 目标录音刚失败时先歇一阵，采样每 4 秒都会再要一次，不能反复起进程。
      if (now - this.failedAt < this.retryDelay()) { this.reset(); callbacks.ended(this.fallbackReason ?? 'EARS_TARGET_UNAVAILABLE'); return }
      this.use('process', this.target); return
    }
    const wantProcess = this.deps.preferred() === 'process'
    if (!wantProcess) this.fallbackReason = undefined
    else if (!this.deps.process) this.fallbackReason = this.deps.unsupported
    if (wantProcess && this.deps.process && now - this.failedAt >= LOOPBACK_RETRY_MS) {
      this.fallbackReason = undefined
      this.use('process', this.deps.process)
    } else if (!wantProcess) this.use('system', this.deps.system)
    else { this.reset(); callbacks.ended(this.fallbackReason ?? 'EARS_TARGET_UNAVAILABLE') }
  }

  private use(mode: EarsCaptureMode, capture: CaptureLike): void {
    const callbacks = this.callbacks
    if (!callbacks) return
    this.active = capture
    this.mode = mode
    capture.start({
      ready: () => {
        if (this.active !== capture) return
        // 真的录上了才算恢复，重试间隔回到最短。
        if (capture === this.target) {this.targetFailures = 0; this.failedAt = -Infinity; this.fallbackReason = undefined}
        callbacks.ready?.()
        this.deps.onChange?.()
      },
      chunk: (samples, at) => {
        if (this.active === capture) callbacks.chunk(samples, at)
      },
      ended: (error) => {
        if (this.active !== capture) return
        if (mode === 'process' && error) {
          // 进程回环不可用或中断：直接停止，禁止退回整机录音。
          this.failedAt = (this.deps.now ?? Date.now)()
          this.fallbackReason = error
          if (capture === this.target) this.targetFailures++
          this.reset()
          callbacks.ended(error)
          return
        }
        this.reset()
        callbacks.ended(error)
      },
    })
    this.deps.onChange?.()
  }

  stop(): void {
    const capture = this.active
    this.reset()
    if (capture?.running) capture.stop()
  }

  private reset(): void {
    const changed = !!this.active
    this.active = undefined
    this.callbacks = undefined
    this.mode = undefined
    if (changed) this.deps.onChange?.()
  }
}
