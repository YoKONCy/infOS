/**
 * @file 「桌面与家」设置与状态（Electron 用户数据目录的 `desktop-home.json`）。
 *
 * 眼睛（vision）、耳朵（ears）、陪看（companion）的用户选项集中在一个文件里，
 * 设置页「桌面与家」是唯一入口。桌面操作总开关仍在原来的签名文件里，不在这里。
 */

/** 眼睛：截图清晰度、观察有效期、文字识别语言。 */
export interface DesktopHomeVision {
  /** 截图质量（JPEG 50–95，PNG 更小时自动用 PNG）。 */
  imageQuality: number
  /** 观察的有效期（秒）：超过后引用该 observationId 的操作要求重新观察。 */
  observationTtlSec: number
  /** 文字识别语言（BCP-47，例如 zh-Hans-CN）；空字符串表示跟随系统。 */
  ocrLanguage: string
}

/** 耳朵：录电脑放出的声音并在本机转写（不开麦克风）。 */
export interface DesktopHomeEars {
  /** 允许她听电脑的声音；默认关闭。 */
  enabled: boolean
  /** 转写语言：auto 或 zh、en、ja、ko、yue。 */
  language: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'
  /** 静音阈值（RMS，0.001–0.1）：低于它的片段直接丢弃，不送去识别。 */
  silenceThreshold: number
  /** 在桌宠旁边也显示「正在听」；应用内的标识总会显示。 */
  petIndicator: boolean
  /**
   * 她自己的声音（TTS）怎么排除：process 只排除 infOS 进程的声音（Windows 10 2004+，不支持或失败时自动
   * 退回 drop）；drop 她出声时整段丢弃（电脑上其他声音这段也听不到）。
   */
  selfExclusion: 'process' | 'drop'
}

/** 陪看：主动插话的频率上限与暂停判定。 */
export interface DesktopHomeCompanion {
  /** 陪看时允许她主动插话。 */
  interject: boolean
  /** 两次主动插话的最小间隔（秒）。 */
  minIntervalSec: number
  /** 每小时最多主动插话几次。 */
  maxPerHour: number
  /** 画面和声音都静止这么久（秒）视为暂停：不看、不说话。 */
  pauseAfterSec: number
}

export interface DesktopHomeSettings {
  perception: import('./perception').PerceptionSettings
  vision: DesktopHomeVision
  ears: DesktopHomeEars
  companion: DesktopHomeCompanion
  environment: DesktopHomeEnvironment
}

/**
 * 环境事件（默认关闭）：只有空闲、全屏、infOS 自己启动的任务结束三种。
 * 事件先存在主进程的信箱里，只在用户下次说话时随消息附带给她，不会因为事件叫醒模型。
 */
export interface DesktopHomeEnvironment {
  /** 总开关，默认关闭。 */
  enabled: boolean
  /** 空闲：多久没碰键盘鼠标算离开，以及回来。 */
  idle: boolean
  /** 判定为空闲的分钟数。 */
  idleMinutes: number
  /** 全屏：前台有别的程序进入或退出全屏（只记是否全屏，不记程序名或画面）。 */
  fullscreen: boolean
  /** infOS 自己启动的后台任务完成。 */
  taskCompleted: boolean
}

/** 交给后端的一条环境事件；at 为毫秒时间戳。 */
export type DesktopEnvironmentEvent =
  | { kind: 'idle' | 'fullscreen'; at: number; active: boolean }
  | { kind: 'task-completed'; at: number; taskId: string }

export type DesktopHomeSection = keyof DesktopHomeSettings

/** 耳朵模型的状态（只读，由主进程根据文件与校验结果给出）。 */
export interface DesktopEarsModelStatus {
  state: 'missing' | 'downloading' | 'verifying' | 'ready' | 'failed'
  /** 全部文件的总大小（字节）。 */
  totalBytes: number
  /** 已下载的字节数（下载中）。 */
  receivedBytes?: number
  /** 失败原因（错误码开头）。 */
  error?: string
}

/** 「家」的实时状态：设置页与录音标识据此显示。 */
export interface DesktopHomeStatus {
  /** 正在录电脑的声音。 */
  listening: boolean
  /** 正在陪看的窗口标题（没有陪看时为空）。 */
  companionTitle?: string
  /** 陪看是否处于暂停（画面与声音都静止）。 */
  companionPaused?: boolean
  model: DesktopEarsModelStatus
  /** 耳朵上次停止的原因（错误码开头；没在听时才有）。 */
  earsError?: string
  /** 正在听时的录音方式：process 按进程排除她的声音，system 整机录音 + 她出声时整段丢弃。 */
  earsCapture?: 'process' | 'system'
  /** 想按进程排除却退回了整机录音的原因（错误码开头）。 */
  earsCaptureFallback?: string
}
