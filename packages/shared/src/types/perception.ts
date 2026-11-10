/** 常驻感知只通过主进程受信任 IPC 操作；正文快照只在内存中传递。 */
export interface PerceptionSettings {
  enabled: boolean
  hardStopped: boolean
  /** 毫秒时间戳；0 表示没有软暂停。 */
  pausedUntil: number
  windowTitles: boolean
  screenImages: boolean
  sound: boolean
  proactive: boolean
  watchAlong: boolean
  /** 少：至少隔 60 分钟，每天 6 次；中：30 分钟，12 次；多：15 分钟，24 次。 */
  proactiveLevel: 'low' | 'medium' | 'high'
  redactedApps: string[]
  unrecordedApps: string[]
}

export type PerceptionSwitch = 'windowTitles' | 'screenImages' | 'sound' | 'proactive' | 'watchAlong'
export type PerceptionDisabledReason =
  | 'disabled' | 'hard-stopped' | 'paused' | 'desktop-disabled'
  | 'locked' | 'suspended' | 'desktop-unavailable' | 'sensitive-target'

export interface PerceptionTarget {
  windowId: string
  processGeneration: string
}

export interface PerceptionState {
  generation: number
  settings: PerceptionSettings
  disabledReasons: PerceptionDisabledReason[]
  collecting: boolean
  counts: (PerceptionDailyCounts & { wakeLimit: number; budgetUsed: number; budgetLimit: number }) | null
  /** 聊天窗看不到（最小化或被全屏盖住），她说的话要另外弹出来。 */
  chatHidden?: boolean
}

/** 不含正文、标题或摘要；次数由后端统计，不能由界面累加。 */
export interface PerceptionDailyCounts {
  day: string
  timeZone: string
  spoken: number
  perceptionWake: number
  watchAlong: number
}

export interface PerceptionSnapshot {
  source: 'perception'
  generation: number
  capturedAt: number
  text: string
  /** 过滤后的结构化短期事件，服务端按角色独立交付；不落盘。 */
  current?: string
  tail?: string
  events?: Array<{id: number; at: number; text: string}>
  /** 正在手动陪看：这一轮带上当前画面。 */
  watching?: boolean
  /** 手动陪看插话不是「要不要开口」，不带主动回合的那段规则。 */
  omitProactiveRules?: boolean
  /** 临时图片内容，不得转换为附件或保存至历史。 */
  images?: Array<{ mimeType: 'image/png' | 'image/jpeg'; data: string }>
}

export type PerceptionAction =
  | { type: 'stop-all' }
  | { type: 'resume' }
  | { type: 'pause-hour' }
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'set-switch'; key: PerceptionSwitch; enabled: boolean }

/** 沿用 window.electron.invoke/on；所有操作均校验主应用来源。 */
export interface PerceptionIpc {
  'desktop-home:perception-get': { input: void; output: PerceptionState }
  'desktop-home:perception-action': { input: PerceptionAction; output: PerceptionState }
  'desktop-home:perception-snapshot': { input: void; output: PerceptionSnapshot | null }
}

/** 主进程广播状态时不附带快照正文。今日次数在第 4 步接后端权威预算。 */
export const PERCEPTION_STATE_EVENT = 'desktop-home:perception-state'
