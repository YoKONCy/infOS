/**
 * @file 持续盯着某个窗口（陪看模式的基础）：本机按设定帧率截图，平时不发给模型；
 * agent 来取（拉取）时只返回自上次以来变化的区域，拼成一张带编号的图并附坐标说明，没变就说「无变化」。
 *
 * 思路按 Watch Buddy 公开 README 的描述自己实现（未参考其源码）：逐帧比较 → 只裁变化区域 →
 * 多块拼成一张带坐标说明的图 → 相近的块去重 → 按需拉取而不是定时推送。
 *
 * 资源上限：帧率 0.2–2、时长 10 秒–1 小时、同时最多 MAX_SESSIONS 个、每帧长边至多 FRAME_MAX_WIDTH；
 * 只保留最新一帧原图和两张比较用的小图。窗口关闭、连续截图失败、到时、总开关关闭时自动停止。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 持续盯窗口
 */

import { t as __t } from '../utils/i18n'
import type { DesktopRect } from './desktopCoordinates'
import {
  averageHash,
  blockToFrame,
  changedCells,
  countCells,
  DIFF_WIDTH,
  gridFor,
  hashDistance,
  mergeBlocks,
  sameBlockPixels,
  type Grid,
} from './desktopWatchDiff'
import { ATLAS_MAX_WIDTH, layoutAtlas, renderAtlas } from './desktopWatchAtlas'

export const WATCH_LIMITS = {
  fps: { min: 0.2, max: 2, fallback: 1 },
  durationSec: { min: 10, max: 3600, fallback: 1800 },
} as const
export const MAX_SESSIONS = 2
export const FRAME_MAX_WIDTH = 1600
/** 一次最多发多少块；变化面积超过 FULL_FRAME_RATIO 时直接发整帧。 */
export const MAX_BLOCKS = 12
export const FULL_FRAME_RATIO = 0.5
/** 连续截图失败这么多次后停止。 */
export const MAX_FAILURES = 10

/** 一帧画面：BGRA 位图与它覆盖的物理像素矩形。 */
export interface WatchFrame {
  /** 实际捕获目标的进程身份，防止 HWND 被其他应用复用。 */
  pid?: number
  bitmap: Uint8Array
  width: number
  height: number
  physical: DesktopRect
  at: number
}

export interface WatchDeps {
  /** 截一帧；窗口最小化时返回 undefined（跳过这一帧），窗口关闭时抛 DESKTOP_WINDOW_GONE。 */
  capture: (
    windowId: string,
    signal?: AbortSignal,
    expectedPid?: number,
  ) => Promise<WatchFrame | undefined>
  /** 缩成比较用的小图（长边至多 DIFF_WIDTH，不放大）。 */
  shrink: (
    frame: WatchFrame,
    width: number,
  ) => { bitmap: Uint8Array; width: number; height: number }
  /** 把 BGRA 位图编码成图片 data URL；超过 maxWidth 时整体缩小。 */
  encode: (
    bitmap: Uint8Array,
    width: number,
    height: number,
    maxWidth: number,
  ) => string | { dataUri: string; width: number; height: number }
  /** 总开关打开且电脑没锁屏。 */
  available: () => boolean
  now?: () => number
}

interface Small {
  bitmap: Uint8Array
  width: number
  height: number
}

interface Session {
  controller: AbortController
  targetPid?: number
  owner: string
  windowId: string
  fps: number
  startedAt: number
  expiresAt: number
  timer: ReturnType<typeof setInterval>
  busy: boolean
  frames: number
  skipped: number
  failures: number
  lastError?: string
  latest?: WatchFrame
  previous?: Small
  baseline?: Small
  /** 最近的画面（小图），她开口时拼成一张看。 */
  recent?: Array<{at: number; bitmap: Uint8Array; width: number; height: number}>
  /** 自上次拉取以来出现过变化的格子。 */
  dirty?: Uint8Array
  since: number
  stoppedReason?: string
}

const text = (source: string, args?: unknown[]) => __t('electron.ui.desktopControl', source, args)

function clamp(key: keyof typeof WATCH_LIMITS, value: unknown): number {
  const limit = WATCH_LIMITS[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return limit.fallback
  return Math.max(limit.min, Math.min(limit.max, value))
}

const iso = (time: number) => new Date(time).toISOString()

// 手动陪看开口时拼成一张：约 15 秒一格，9 格连起来是最近两分多钟。
const RECENT_WIDTH = 480
const RECENT_MAX = 9
const RECENT_GAP_SECONDS = 15
/** 接口收图的上限是 4 MB；PNG 可能超，超了就缩小。 */
const GRID_MAX_BASE64 = 3_900_000

export class DesktopWatch {
  /**
   * 最近变化过的画面按时间拼成一张。这些帧在截取时已经打过码。
   * 不取走：她每次开口都能看到前后，下一次也能接上。尺寸不一致（窗口大小变了）的不拼。
   */
  recentGrid(owner: string): {mimeType: 'image/png' | 'image/jpeg'; data: string} | undefined {
    const frames = this.sessions.get(owner)?.recent
    if (!frames?.length) return undefined
    const {width: cellWidth, height: cellHeight} = frames.at(-1)!
    const usable = frames.filter(item => item.width === cellWidth && item.height === cellHeight)
    const columns = Math.min(3, usable.length)
    const rows = Math.ceil(usable.length / columns)
    const width = cellWidth * columns, height = cellHeight * rows
    const pixels = new Uint8Array(width * height * 4)
    usable.forEach((item, index) => {
      const left = (index % columns) * cellWidth, top = Math.floor(index / columns) * cellHeight
      for (let y = 0; y < cellHeight; y++)
        pixels.set(item.bitmap.subarray(y * cellWidth * 4, (y + 1) * cellWidth * 4), ((top + y) * width + left) * 4)
    })
    for (const maxWidth of [width, Math.round(width / 2)]) {
      const encoded = this.deps.encode(pixels, width, height, maxWidth)
      const match = (typeof encoded === 'string' ? encoded : encoded.dataUri).match(/^data:(image\/(?:png|jpeg));base64,(.+)$/)
      if (match && match[2]!.length <= GRID_MAX_BASE64) return {mimeType: match[1] as 'image/png' | 'image/jpeg', data: match[2]!}
    }
    return undefined
  }
  private remember(session: Session, frame: WatchFrame, changed: boolean): void {
    if (!changed) return
    const frames = session.recent ??= []
    const last = frames.at(-1)
    if (last && frame.at - last.at < RECENT_GAP_SECONDS * 1000) return
    frames.push({at: frame.at, ...this.deps.shrink(frame, RECENT_WIDTH)})
    if (frames.length > RECENT_MAX) frames.shift()
  }
  /** 陪看续期不重建会话、基线或观看时钟。 */
  renew(owner: string): void {
    const session = this.sessions.get(owner)
    if (session) session.expiresAt = this.now() + 30 * 60_000
  }
  private readonly sessions = new Map<string, Session>()
  /** 最近停止的原因（按调用方）：查询时告诉 agent 为什么停了。 */
  private readonly stopped = new Map<string, string>()
  /** 画面有变化时通知（陪看据此判断「在播」）。 */
  private readonly activity = new Set<(owner: string, at: number) => void>()
  private readonly capturing = new Set<Session>()
  private readonly lastCapture = new Map<string, number>()
  private readonly captureTimes: number[] = []

  constructor(private readonly deps: WatchDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** 统一入口：`take_screenshot` 的 watch 参数。 */
  async handle(owner: string, windowId: unknown, watch: Record<string, unknown>): Promise<unknown> {
    const action = watch.action
    if (action === 'start') {
      if (typeof windowId !== 'string' || !windowId)
        throw new Error(`DESKTOP_WINDOW_REQUIRED: ${text('开始盯窗口需要 windowId。')}`)
      return this.start(owner, windowId, watch)
    }
    if (action === 'poll') return this.poll(owner)
    if (action === 'stop') return this.stop(owner, text('已按要求停止。'))
    if (action === 'status') return this.status(owner)
    throw new Error(
      __t(
        'errors.electron',
        'DESKTOP_WATCH_ACTION_INVALID: watch.action 必须是 start、poll、status 或 stop',
      ),
    )
  }

  start(owner: string, windowId: string, options: Record<string, unknown>): unknown {
    this.stop(owner)
    if (!this.deps.available())
      throw new Error(`DESKTOP_WAITING: ${text('桌面观察已暂停或不可用。')}`)
    if (new Set([...this.sessions.values(), ...this.capturing]).size >= MAX_SESSIONS)
      throw new Error(
        `DESKTOP_WATCH_LIMIT: ${text('同时最多盯 {0} 个窗口，请先停掉一个。', [MAX_SESSIONS])}`,
      )
    const fps = clamp('fps', options.fps)
    const now = this.now()
    const session: Session = {
      controller: new AbortController(),
      owner,
      windowId,
      fps,
      startedAt: now,
      expiresAt: now + clamp('durationSec', options.durationSec) * 1000,
      timer: setInterval(() => void this.tick(session), Math.round(1000 / fps)),
      busy: false,
      frames: 0,
      skipped: 0,
      failures: 0,
      since: now,
    }
    session.timer.unref?.()
    this.sessions.set(owner, session)
    this.stopped.delete(owner)
    void this.tick(session)
    return {
      success: true,
      ...this.describe(session),
      message: text('开始盯着这个窗口。之后用 watch.action=poll 取变化。'),
    }
  }

  /** 截一帧并累计变化格子。 */
  async tick(session: Session): Promise<void> {
    if (this.sessions.get(session.owner) !== session) return
    if (this.now() >= session.expiresAt)
      return void this.stop(session.owner, text('已到设定的时长。'))
    if (!this.deps.available()) return void this.stop(session.owner, text('桌面操作已关闭。'))
    if (session.busy) return
    const now = this.now()
    while (this.captureTimes.length && now - this.captureTimes[0]! >= 1000)
      this.captureTimes.shift()
    if (
      now - (this.lastCapture.get(session.owner) ?? -Infinity) < 1000 / session.fps ||
      this.captureTimes.length >= MAX_SESSIONS * WATCH_LIMITS.fps.max
    )
      return
    this.captureTimes.push(now)
    this.lastCapture.delete(session.owner)
    this.lastCapture.set(session.owner, now)
    if (this.lastCapture.size > 128) this.lastCapture.delete(this.lastCapture.keys().next().value!)
    session.busy = true
    this.capturing.add(session)
    try {
      const frame = await this.deps.capture(
        session.windowId,
        session.controller.signal,
        session.targetPid,
      )
      if (this.sessions.get(session.owner) !== session) return
      if (!this.deps.available()) return void this.stop(session.owner, text('桌面操作已关闭。'))
      if (this.now() >= session.expiresAt)
        return void this.stop(session.owner, text('已到设定的时长。'))
      if (!frame) {
        session.skipped++
        return
      }
      if (session.targetPid !== undefined && frame.pid !== session.targetPid)
        return void this.stop(session.owner, text('窗口已关闭。'))
      session.targetPid ??= frame.pid
      const small = this.deps.shrink(frame, DIFF_WIDTH)
      const previous = session.previous
      let changed = false
      if (previous && previous.width === small.width && previous.height === small.height) {
        const cells = changedCells(
          previous.bitmap,
          small.bitmap,
          gridFor(small.width, small.height),
        )
        if (countCells(cells)) {
          changed = true
          for (const listener of this.activity) listener(session.owner, frame.at)
          session.dirty ??= new Uint8Array(cells.length)
          for (let index = 0; index < cells.length; index++) session.dirty[index]! |= cells[index]!
        }
      }
      this.remember(session, frame, changed)
      session.previous = small
      session.latest = frame
      session.frames++
      session.failures = 0
      session.lastError = undefined
    } catch (error) {
      if (this.sessions.get(session.owner) !== session) return
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('DESKTOP_WINDOW_GONE')) this.stop(session.owner, text('窗口已关闭。'))
      else if (++session.failures >= MAX_FAILURES)
        this.stop(session.owner, text('连续截图失败：{0}', [message]))
      else session.lastError = message
    } finally {
      session.busy = false
      this.capturing.delete(session)
    }
  }

  /** 拉取自上次以来的变化。 */
  poll(owner: string): Record<string, unknown> {
    const session = this.sessions.get(owner)
    if (!session) return this.notRunning(owner)
    if (!this.deps.available()) {
      this.stop(owner, text('桌面观察已暂停或不可用。'))
      return this.notRunning(owner)
    }
    const latest = session.latest
    const until = latest?.at ?? this.now()
    const range = { since: iso(session.since), until: iso(until), frames: session.frames }
    if (!latest || !session.previous)
      return {
        success: true,
        changed: false,
        ...range,
        message: text('还没有截到画面，请稍后再取。'),
      }
    const current = session.previous
    const baseline = session.baseline
    session.since = until
    session.baseline = current
    const dirty = session.dirty
    session.dirty = undefined
    // 第一次拉取或窗口尺寸变了：发整帧作为基准。
    if (!baseline || baseline.width !== current.width || baseline.height !== current.height)
      return this.fullFrame(
        latest,
        range,
        text('这是开始盯以来的第一张（或窗口大小变了），发整帧作为基准。'),
      )
    const grid = gridFor(current.width, current.height)
    const net = changedCells(baseline.bitmap, current.bitmap, grid)
    // 只发「现在和上次取时不一样」的格子；中间变过又变回去的只计数。
    const transient = dirty
      ? countCells(dirty) - countCells(net.map((cell, i) => cell & dirty[i]!))
      : 0
    if (!countCells(net))
      return {
        success: true,
        changed: false,
        ...range,
        ...(transient > 0 ? { transientCells: transient } : {}),
        message: text('无变化。'),
      }
    return this.atlas(latest, grid, net, range, transient)
  }

  private fullFrame(frame: WatchFrame, range: Record<string, unknown>, message: string) {
    const encoded = this.deps.encode(frame.bitmap, frame.width, frame.height, FRAME_MAX_WIDTH)
    const output =
      typeof encoded === 'string'
        ? { dataUri: encoded, width: frame.width, height: frame.height }
        : encoded
    return {
      success: true,
      changed: true,
      kind: 'full',
      ...range,
      frame: { width: frame.width, height: frame.height, physical: frame.physical },
      screenshots: [
        {
          index: 0,
          ...output,
        },
      ],
      message,
    }
  }

  private atlas(
    frame: WatchFrame,
    grid: Grid,
    cells: Uint8Array,
    range: Record<string, unknown>,
    transient: number,
  ): Record<string, unknown> {
    const scale = frame.width / grid.width
    const rects = mergeBlocks(cells, grid).map((block) => blockToFrame(block, grid, scale, frame))
    const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0)
    if (area > FULL_FRAME_RATIO * frame.width * frame.height)
      return this.fullFrame(frame, range, text('变化面积很大，发整帧。'))
    // 相近的块去重：画面几乎一样的只留第一块，其余记下重复了哪一块。
    const kept: Array<{ rect: DesktopRect; hash: string; duplicates: DesktopRect[] }> = []
    for (const rect of rects) {
      const hash = averageHash(frame.bitmap, frame.width, rect)
      const same = kept.find(
        (item) =>
          hashDistance(item.hash, hash) <= 2 &&
          Math.abs(item.rect.width - rect.width) <= 4 &&
          Math.abs(item.rect.height - rect.height) <= 4 &&
          sameBlockPixels(frame.bitmap, frame.width, item.rect, rect),
      )
      if (same) same.duplicates.push(rect)
      else kept.push({ rect, hash, duplicates: [] })
    }
    const sent = kept.slice(0, MAX_BLOCKS)
    const pieces = sent.map((item, index) => ({ n: index + 1, source: item.rect }))
    const layout = layoutAtlas(pieces)
    const canvas = renderAtlas(
      { bitmap: frame.bitmap, width: frame.width, height: frame.height },
      pieces,
      layout,
    )
    const encoded = this.deps.encode(canvas.bitmap, canvas.width, canvas.height, ATLAS_MAX_WIDTH)
    const output =
      typeof encoded === 'string'
        ? { dataUri: encoded, width: canvas.width, height: canvas.height }
        : encoded
    const atlasRect = (rect: DesktopRect): DesktopRect => {
      const sx = output.width / canvas.width,
        sy = output.height / canvas.height
      const x = Math.round(rect.x * sx),
        y = Math.round(rect.y * sy)
      return {
        x,
        y,
        width: Math.round((rect.x + rect.width) * sx) - x,
        height: Math.round((rect.y + rect.height) * sy) - y,
      }
    }
    const toPhysical = (rect: DesktopRect): DesktopRect => {
      const sx = frame.physical.width / frame.width
      const sy = frame.physical.height / frame.height
      return {
        x: Math.round(frame.physical.x + rect.x * sx),
        y: Math.round(frame.physical.y + rect.y * sy),
        width: Math.round(rect.width * sx),
        height: Math.round(rect.height * sy),
      }
    }
    return {
      success: true,
      changed: true,
      kind: 'atlas',
      ...range,
      frame: { width: frame.width, height: frame.height, physical: frame.physical },
      blocks: sent.map((item, index) => ({
        n: index + 1,
        frame: item.rect,
        physical: toPhysical(item.rect),
        atlas: atlasRect(layout.placements[index]!.atlas),
        ...(item.duplicates.length ? { alsoAt: item.duplicates } : {}),
      })),
      ...(kept.length > sent.length ? { omittedBlocks: kept.length - sent.length } : {}),
      ...(transient > 0 ? { transientCells: transient } : {}),
      screenshots: [
        {
          index: 0,
          ...output,
        },
      ],
      message: text(
        '图里是自上次以来变化的 {0} 块区域，按编号排列；blocks 给出每块在窗口画面（frame）、屏幕物理像素（physical）和这张图（atlas）里的位置。',
        [sent.length],
      ),
    }
  }

  onActivity(listener: (owner: string, at: number) => void): () => void {
    this.activity.add(listener)
    return () => this.activity.delete(listener)
  }

  /** 这个调用方是否正在盯窗口。 */
  running(owner: string): boolean {
    return this.sessions.has(owner)
  }

  status(owner: string): Record<string, unknown> {
    const session = this.sessions.get(owner)
    if (!session) return this.notRunning(owner)
    return { success: true, ...this.describe(session) }
  }

  stop(owner: string, reason?: string): Record<string, unknown> {
    const session = this.sessions.get(owner)
    if (!session) return this.notRunning(owner)
    clearInterval(session.timer)
    session.controller.abort(reason)
    this.sessions.delete(owner)
    if (reason) {
      this.stopped.delete(owner)
      this.stopped.set(owner, reason)
      if (this.stopped.size > 128) this.stopped.delete(this.stopped.keys().next().value!)
    }
    return { success: true, running: false, ...(reason ? { reason } : {}), frames: session.frames }
  }

  stopAll(reason: string): void {
    for (const owner of [...this.sessions.keys()]) this.stop(owner, reason)
  }

  private notRunning(owner: string): Record<string, unknown> {
    const reason = this.stopped.get(owner)
    return {
      success: true,
      running: false,
      ...(reason ? { reason } : {}),
      message: text('没有正在盯的窗口。用 watch.action=start 并传 windowId 开始。'),
    }
  }

  private describe(session: Session): Record<string, unknown> {
    const latest = session.latest
    const memoryBytes =
      (latest?.bitmap.length ?? 0) +
      (session.previous?.bitmap.length ?? 0) +
      (session.baseline?.bitmap.length ?? 0)
    return {
      running: true,
      windowId: session.windowId,
      fps: session.fps,
      startedAt: iso(session.startedAt),
      expiresAt: iso(session.expiresAt),
      frames: session.frames,
      ...(session.skipped ? { skippedFrames: session.skipped } : {}),
      ...(session.lastError ? { lastError: session.lastError } : {}),
      memoryBytes,
    }
  }
}
