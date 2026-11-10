/**
 * @file 耳朵在主进程里的音频闸门（纯函数）：静音段丢弃、自己的声音（TTS）在播时丢弃。
 *
 * - 静音：一块音频的 RMS 低于阈值算静音。说话后还会再送 HANGOVER_MS 的静音给 VAD，让它能判断一句话
 *   结束；之后的静音直接丢弃（不送去识别），并让识别端收尾当前这一句。
 * - 自己的声音：infOS 自己的窗口正在出声（例如 TTS 朗读）时整块丢弃，停止后再多丢 SELF_TAIL_MS，
 *   并让识别端收尾，免得把她自己的话当成台词。电脑上其他声音和她的声音混在一起时，这段也一起丢。
 *
 * @platform ELECTRON
 */

/** 说话后继续送给 VAD 的静音时长（毫秒），够它判断一句话结束。 */
export const HANGOVER_MS = 1200
/** infOS 自己停止出声后再丢弃的时长（毫秒）：覆盖播放缓冲的尾巴。 */
export const SELF_TAIL_MS = 600

export function rms(samples: Float32Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (const value of samples) sum += value * value
  return Math.sqrt(sum / samples.length)
}

export type GateDecision =
  /** 送去识别。 */
  | 'feed'
  /** 丢弃，并让识别端收尾当前这一句。 */
  | 'drop-flush'
  /** 丢弃。 */
  | 'drop'

export interface GateStats {
  fed: number
  silent: number
  self: number
}

export class AudioGate {
  private lastLoudAt = -Infinity
  private lastSelfAt = -Infinity
  /** 上一块是否送去了识别（决定丢弃时要不要让识别端收尾）。 */
  private feeding = false
  readonly stats: GateStats = { fed: 0, silent: 0, self: 0 }

  constructor(private threshold: number) {}

  setThreshold(threshold: number): void {
    this.threshold = threshold
  }

  /**
   * @param samples 这一块音频
   * @param at 这一块最后一个采样的时刻（毫秒）
   * @param selfAudible infOS 自己的窗口此刻是否在出声
   */
  decide(samples: Float32Array, at: number, selfAudible: boolean): GateDecision {
    if (selfAudible) this.lastSelfAt = at
    let decision: GateDecision
    if (at - this.lastSelfAt <= SELF_TAIL_MS) {
      this.stats.self++
      decision = this.feeding ? 'drop-flush' : 'drop'
    } else {
      if (rms(samples) >= this.threshold) this.lastLoudAt = at
      if (at - this.lastLoudAt <= HANGOVER_MS) {
        this.stats.fed++
        this.feeding = true
        return 'feed'
      }
      this.stats.silent++
      decision = this.feeding ? 'drop-flush' : 'drop'
    }
    this.feeding = false
    return decision
  }
}
