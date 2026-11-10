/**
 * @file 耳朵的识别引擎：silero VAD 切出说话段，每段交给 SenseVoice 离线识别（sherpa-onnx）。
 *
 * 运行在单独的 utilityProcess 里（earsWorker.ts），不占主进程。这里只放与进程无关的逻辑，
 * sherpa 模块由调用方传入，测试用替身。
 *
 * 时间：送进来的每块音频带着「最后一个采样的时刻」。静音块在主进程就被丢掉了，VAD 内部的采样序号
 * 不是连续的墙钟时间，所以按块记下「序号 → 时刻」的对照，再把段落起止换回墙钟时间。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 耳朵
 */

export const SAMPLE_RATE = 16_000
/** silero VAD 每次处理的采样数（16 kHz 下 32 毫秒）。 */
export const VAD_WINDOW = 512

export interface EarsModelPaths {
  vad: string
  model: string
  tokens: string
}

/** sherpa-onnx-node 用到的部分（便于替身）。 */
export interface SherpaModule {
  Vad: new (
    config: Record<string, unknown>,
    bufferSeconds: number,
  ) => {
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    front(enableExternalBuffer?: boolean): { samples: Float32Array; start: number }
    pop(): void
    flush(): void
  }
  OfflineRecognizer: new (config: Record<string, unknown>) => {
    createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void }
    decode(stream: unknown): void
    getResult(stream: unknown): { text: string }
  }
}

/**
 * VAD 切段参数。默认值按中文实测选定（见 B02「耳朵 → 转写参数」）：
 * - 阈值 0.5 → 0.4：背景音乐里的人声不再被整段漏掉（音乐比人声低 5 dB 时字错率 15.8% → 12.2%）；
 * - 最长一句 12 → 8 秒、句末静音 0.5 → 0.3 秒：有背景音乐时 VAD 很少等到静音，一句常拖到 12–20 秒，
 *   缩短后一句台词从开口到交付的平均等待从约 10.6 秒降到约 8 秒，字错率不变。
 */
export interface EarsTuning {
  /** silero 判定为说话的概率阈值。 */
  vadThreshold: number
  /** 静音持续多久（秒）算一句结束。 */
  minSilenceSec: number
  /** 短于它（秒）的片段丢弃。 */
  minSpeechSec: number
  /** 一句太长时强制切开（秒），台词能更早给到。 */
  maxSpeechSec: number
}

export const DEFAULT_TUNING: EarsTuning = {
  vadThreshold: 0.4,
  minSilenceSec: 0.3,
  minSpeechSec: 0.25,
  maxSpeechSec: 8,
}

/**
 * SenseVoice 的逆文本规范化偶尔把数字拆坏（实测「有十年」→「十0年」、「3.7」→「三.7」）；只修这两种
 * 一眼能确定的写法，其余原样保留。
 */
export function tidyText(text: string): string {
  const digits = '一二三四五六七八九'
  return text
    .replace(/十0(?![0-9])/g, '10')
    .replace(/([一二三四五六七八九])\.(?=[0-9])/g, (_, ch: string) => `${digits.indexOf(ch) + 1}.`)
}

export interface HeardSegment {
  text: string
  /** 墙钟毫秒。 */
  start: number
  end: number
}

export class EarsEngine {
  private readonly vad: InstanceType<SherpaModule['Vad']>
  private readonly recognizer: InstanceType<SherpaModule['OfflineRecognizer']>
  private pending = new Float32Array(0)
  /** 已送进 VAD 的采样总数。 */
  private fed = 0
  /** 每块音频的对照：VAD 采样序号 → 这块第一个采样的墙钟时刻。最多留 MAX_MARKS 条。 */
  private marks: Array<{ index: number; at: number }> = []
  private static readonly MAX_MARKS = 600

  constructor(
    sherpa: SherpaModule,
    paths: EarsModelPaths,
    language: string,
    threads = 2,
    tuning: EarsTuning = DEFAULT_TUNING,
  ) {
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: paths.vad,
          threshold: tuning.vadThreshold,
          minSilenceDuration: tuning.minSilenceSec,
          minSpeechDuration: tuning.minSpeechSec,
          maxSpeechDuration: tuning.maxSpeechSec,
          windowSize: VAD_WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false,
      },
      60,
    )
    this.recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: paths.model,
          language: language === 'auto' ? '' : language,
          useInverseTextNormalization: 1,
        },
        tokens: paths.tokens,
        numThreads: threads,
        debug: 0,
      },
    })
  }

  /** 墙钟时刻：找到这个采样所在的块，按采样率推算。 */
  private timeOf(index: number): number {
    return Math.round(this.exactTime(index))
  }

  private exactTime(index: number): number {
    let mark = this.marks[0]
    for (const item of this.marks) {
      if (item.index > index) break
      mark = item
    }
    if (!mark) return Date.now()
    return mark.at + ((index - mark.index) / SAMPLE_RATE) * 1000
  }

  /** 送入一块 16 kHz 单声道音频；at 是这块最后一个采样的时刻。返回这次识别出的句子。 */
  accept(samples: Float32Array, at: number): HeardSegment[] {
    this.marks.push({
      index: this.fed + this.pending.length,
      at: at - (samples.length / SAMPLE_RATE) * 1000,
    })
    if (this.marks.length > EarsEngine.MAX_MARKS)
      this.marks.splice(0, this.marks.length - EarsEngine.MAX_MARKS)
    const joined = new Float32Array(this.pending.length + samples.length)
    joined.set(this.pending)
    joined.set(samples, this.pending.length)
    let offset = 0
    while (joined.length - offset >= VAD_WINDOW) {
      this.vad.acceptWaveform(joined.subarray(offset, offset + VAD_WINDOW))
      offset += VAD_WINDOW
    }
    this.fed += offset
    this.pending = joined.slice(offset)
    return this.drain()
  }

  /** 静音开始（或自己的声音在播）：把正在说的这一段收尾识别掉。 */
  flush(): HeardSegment[] {
    this.vad.flush()
    return this.drain()
  }

  private drain(): HeardSegment[] {
    const result: HeardSegment[] = []
    while (!this.vad.isEmpty()) {
      // Electron 不允许外部内存，要让它把数据复制出来，否则一有语音就报 External buffers are not allowed。
      const segment = this.vad.front(false)
      this.vad.pop()
      const stream = this.recognizer.createStream()
      stream.acceptWaveform({ samples: segment.samples, sampleRate: SAMPLE_RATE })
      this.recognizer.decode(stream)
      const text = tidyText(this.recognizer.getResult(stream).text.trim())
      if (!text) continue
      result.push({
        text,
        start: this.timeOf(segment.start),
        // 按最后一个采样所在的块换算：段尾正好落在块边界时不会跳到下一块（中间可能隔着被丢弃的静音）。
        end: this.timeOf(segment.start + segment.samples.length - 1),
      })
    }
    return result
  }
}
