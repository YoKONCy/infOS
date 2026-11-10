import path from 'node:path'
import type { DesktopWindowInfo, PerceptionSettings, PerceptionSnapshot, PerceptionState } from '@infos/shared'
import { browserProcess, filterPerceptionText, filterWindow, sensitiveWindow, unrecordedProcess } from './perceptionFilter'

export interface PerceptionWindow extends DesktopWindowInfo { processGeneration: string }
export interface AudioSample { pid: number; peak: number; certain: boolean; name?: string }
export interface PerceptionSample { active: PerceptionWindow | null; audio: AudioSample[]; processes?: string[]; mediaTitle?: string; mediaPlaying?: boolean; mediaType?: string
  /** 系统里所有在报媒体的程序，不只前台那个：后台播放也要认。 */
  media?: MediaRow[] }
export interface MediaRow { source: string; title: string; playing: boolean; type: string }
export type WakeKind = 'returned' | 'new-app' | 'task-completed' | 'long-window'
/** infOS 自己的窗口和声音：用户点开 infOS 不等于换了在做的事，她的语音也不算电脑在放什么。 */
const SELF_NAME = path.basename(process.execPath, '.exe').toLowerCase()
function isSelf(item: {pid: number; processName?: string; name?: string}): boolean {
  return item.pid === process.pid || (item.processName ?? item.name ?? '').toLowerCase().replace(/\.exe$/, '') === SELF_NAME
}
/** 程序名和窗口标题合成一句，去掉标题末尾重复的程序名。 */
export function windowLabel(window: {processName: string; title: string}, withTitle: boolean): string {
  if (!withTitle) return window.processName
  const name = window.processName.toLowerCase()
  const title = window.title.trim().replace(/\s+[-–—]\s+([^-–—]+)$/, (whole, tail: string) => tail.trim().toLowerCase() === name ? '' : whole).trim()
  return title && title.toLowerCase() !== name ? `${window.processName} · ${title}` : window.processName
}
interface TimelineEvent { id: number; at: number; text: string }

/** 出声的会话是否都来自这个窗口的程序：按 PID 或进程名，多进程程序的声音不在开窗口的进程上。 */
export function soundFrom(window: PerceptionWindow, sources: AudioSample[]): boolean {
  const name = window.processName.toLowerCase().replace(/\.exe$/, '')
  return sources.length > 0 && sources.every(item => item.certain && (item.pid === window.pid || item.name?.toLowerCase() === name))
}

/** 这个窗口的程序有没有在出声（陪看判断在播用，别的程序同时响也算）。 */
export function soundTouches(window: PerceptionWindow, sources: AudioSample[]): boolean {
  const name = window.processName.toLowerCase().replace(/\.exe$/, '')
  return sources.some(item => item.certain && (item.pid === window.pid || item.name?.toLowerCase() === name))
}

/** 只持有过滤后的数据。单调时钟只累加正常采样间隔，休眠与失败空档不计时。 */
export class PerceptionCoordinator {
  private current: PerceptionWindow | null = null
  private chatting = false
  private lastExternal: PerceptionWindow | null = null
  private events: TimelineEvent[] = []
  private serial = 0
  private previousAt = 0
  private dwell = 0
  private capturedAt = 0
  private audibleUntil = 0
  private audioText = ''
  private mediaTitle = ''
  private transcript = ''
  private others = ''
  private wokeApp = false
  private wokeWindow = false
  private idle = false
  private absentSince = 0
  private generation = 0
  private recordingSource?: PerceptionWindow
  private recordingUntil = 0
  constructor(private readonly state: () => PerceptionState, private readonly wake: (kind: WakeKind) => void, private readonly now = Date.now) {}

  clear(): void {
    this.lastExternal = null; this.chatting = false
    this.current = null; this.events = []; this.transcript = ''; this.others = ''; this.previousAt = 0
    this.dwell = 0; this.audioText = ''; this.mediaTitle = ''; this.audibleUntil = 0; this.capturedAt = 0
    this.recordingSource=undefined;this.recordingUntil=0
  }
  canSample(): boolean { return this.state().collecting }
  target(): PerceptionWindow | null { return this.current ? { ...this.current } : null }
  event(text: string): void {
    this.events.push({ id: ++this.serial, at: this.now(), text: filterPerceptionText(text) })
    this.events = this.events.filter(item => item.at > this.now() - 30 * 60_000).slice(-60)
  }
  /** 锁屏和休眠时不采样，要在这里记下开始离开的时间，解锁后才有「回来了」。 */
  markAbsent(): void {
    if (!this.idle) { this.idle = true; this.absentSince = this.now() }
  }
  activity(idleMs: number): void {
    if (idleMs >= 30 * 60_000 && !this.idle) { this.idle = true; this.absentSince = this.now() - idleMs }
    if (idleMs < 30_000 && this.idle) {
      this.idle = false
      if (this.now() - this.absentSince >= 30 * 60_000) { this.event('离开后回来了'); this.wake('returned') }
    }
  }
  accept(sample: PerceptionSample, generation: number, monotonic: number): void {
    const state = this.state()
    if (generation !== state.generation || !state.collecting) return
    this.generation = generation
    // 焦点在 infOS 上时，她知道的仍是用户刚才在看的那个窗口。
    this.chatting = !!sample.active && isSelf(sample.active)
    const raw = this.chatting ? this.lastExternal : sample.active
    if (!this.chatting) this.lastExternal = sample.active
    const previous = this.current
    const next = raw ? filterWindow(raw, state.settings) : null
    const same = previous && next && previous.windowId === next.windowId && previous.processGeneration === next.processGeneration
    const delta = this.previousAt ? Math.max(0, Math.min(6000, monotonic - this.previousAt)) : 0
    this.previousAt = monotonic
    if (!same) {
      this.dwell = 0; this.wokeApp = previous?.processName === next?.processName; this.wokeWindow = false
      this.transcript = ''
      if (next) this.event(`切换到 ${windowLabel(next, state.settings.windowTitles)}`)
    } else if (!this.idle) this.dwell += delta
    this.current = next; this.capturedAt = this.now()
    this.mediaTitle = state.settings.windowTitles ? filterPerceptionText(sample.mediaTitle ?? '').slice(0,120) : ''
    // 按程序名说是谁在响，不跟前台比：用户在聊天时视频照样在放。
    const audio = sample.audio.filter(item => item.peak >= 0.003 && !isSelf(item))
    if (audio.length) {
      this.audibleUntil = this.now() + 8000
      const names = [...new Set(audio.map(item => item.certain && item.name ? (state.settings.redactedApps.some(app => item.name!.toLowerCase().includes(app)) ? '敏感程序' : filterPerceptionText(item.name)) : ''))]
      this.audioText = names.includes('') ? '有声音，分不清是哪个程序' : `${names.join('、')} 在出声`
    } else if (this.audibleUntil <= this.now()) this.audioText = '没有声音'
    if (sample.processes) this.others = sample.processes.slice(0, 30).map(filterPerceptionText).filter(name => !state.settings.redactedApps.some(item => name.toLowerCase().includes(item))).join('、')
    if (same && this.dwell >= 300_000 && !this.wokeApp) { this.wokeApp = true; this.wake('new-app') }
    if (same && this.dwell >= 3_600_000 && !this.wokeWindow) { this.wokeWindow = true; this.wake('long-window') }
  }
  /**
   * 要开了「平时也听」，只录前台那个出声的程序，浏览器不录。
   */
  recordingTarget(sample: PerceptionSample, settings: PerceptionSettings): PerceptionWindow | null {
    const window = sample.active && isSelf(sample.active) ? this.lastExternal : sample.active
    const sources = sample.audio.filter(item => item.peak >= 0.003 && !isSelf(item))
    if(!window || !settings.sound || sensitiveWindow(window,settings) || unrecordedProcess(window.processName,settings) || browserProcess(window.processName)) {this.recordingSource=undefined;return null}
    if(soundFrom(window,sources)) {
      this.recordingSource=filterWindow(window,settings);this.recordingUntil=this.now()+8000
      return this.recordingSource
    }
    if(!sources.length && this.recordingSource?.windowId===window.windowId && this.recordingSource.processGeneration===window.processGeneration && this.now()<this.recordingUntil)return this.recordingSource
    this.recordingSource=undefined;return null
  }
    heard(text: string, target: {windowId: string; processGeneration: string}, generation: number): void {
    if (generation !== this.state().generation || target.windowId !== this.current?.windowId || target.processGeneration !== this.current.processGeneration) return
    this.transcript = filterPerceptionText(text).slice(-500)
  }
  /** 给后端的是全部近期事件，由后端按角色记游标；这里读取不移动任何游标。 */
  snapshot(): PerceptionSnapshot | null {
    const state = this.state()
    if (!state.collecting || this.generation !== state.generation || (!this.current && !this.chatting) || this.now() - this.capturedAt > 12_000) return null
    const events = this.events.filter(item => item.at > this.now() - 30 * 60_000).slice(-4)
    const lines = [
      `现在：${this.current ? `${windowLabel(this.current, state.settings.windowTitles)}，待了 ${Math.floor(this.dwell / 60_000)} 分钟` : '用户还没切到别的程序'}；${this.audioText}${this.mediaTitle ? `（在放 ${this.mediaTitle}）` : ''}${this.chatting ? '；用户此刻在和你聊天' : ''}`,
      events.length ? `最近：${events.map(item => item.text).join(' → ')}` : '',
      this.transcript ? `刚听到：${this.transcript}` : '',
      this.others ? `其他程序：${this.others}` : '',
    ].filter(Boolean)
    const current=lines.find(line=>line.startsWith('现在：'))??''
    const tail=[this.transcript?`刚听到：${this.transcript}`:'',this.others?`其他程序：${this.others}`:''].filter(Boolean).join('\n')
    return { source: 'perception', generation: this.generation, capturedAt: this.capturedAt, text: Array.from(lines.join('\n')).slice(0, 300).join(''), current, tail, events: this.events.filter(item=>item.at>this.now()-30*60_000).slice(-60).map(item=>({...item})) }
  }
}
