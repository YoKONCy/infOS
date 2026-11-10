/**
 * @file take_screenshot 里「家」的部分：盯窗口（watch）加上耳朵与陪看、按时间段查台词，
 * 以及每次观察时附带「上次到这次」的新台词。
 *
 * watch.action：
 * - start：windowId 开始盯窗口；listen:true 同时开始听（耳朵可用时）；companion:true 开始陪看（含 listen）。
 *   不给 windowId 只给 listen:true 时只听不看。
 * - poll：盯窗口的变化 + 新台词（heard）+ 陪看时钟（companion）。
 * - heard：按时间段查台词（from/to 为 ISO 时间，或 lastSec 表示最近多少秒），只看不移动游标。
 * - status / stop：同时查询 / 停止盯窗口、耳朵与陪看。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 耳朵、陪看模式
 */

import { t as __t } from '../../utils/i18n'
import type { DesktopCaller } from '../desktopControl'
import { desktopWatch, watchOwner } from '../desktopWatchService'
import { windowsDesktop } from '../windowsDesktop'
import { earsService, setPerceptionAudioTarget } from '../ears/earsRuntime'
import { companionService } from '../companion/companionRuntime'
import { onDesktopObservationStop } from '../desktopObservationLifecycle'
import { perceptionControl } from './perceptionState'

type Result = Record<string, unknown>

/** 按时间段查台词的最长范围（与台词保留时长一致）。 */
const HEARD_MAX_RANGE_MS = 2 * 60 * 60_000

function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

/** heard 的查询范围：lastSec 优先；from/to 缺省时取最近 5 分钟到现在。 */
export function heardRange(watch: Result, now: number): { from: number; to: number } {
  const lastSec = typeof watch.lastSec === 'number' && watch.lastSec > 0 ? watch.lastSec : undefined
  const to = Math.min(parseTime(watch.to) ?? now, now)
  const from =
    lastSec !== undefined ? now - lastSec * 1000 : (parseTime(watch.from) ?? to - 5 * 60_000)
  if (from > to)
    throw new Error(
      `DESKTOP_HEARD_RANGE_INVALID: ${__t('electron.ui.desktopControl', 'heard 的 from 必须早于 to')}`,
    )
  return { from: Math.max(from, to - HEARD_MAX_RANGE_MS), to }
}

async function windowTitle(windowId: string): Promise<string | undefined> {
  try {
    const info = await windowsDesktop.observe(windowId, false)
    return info.window.title || undefined
  } catch {
    return undefined
  }
}

function attach(result: Result, owner: string): Result {
  const heard = earsService.deliver(owner)
  const companion = companionService.describe(owner)
  return {
    ...result,
    ...(heard ? { heard } : {}),
    ...(companion ? { companion } : {}),
  }
}

export async function handleHomeWatch(
  caller: DesktopCaller,
  windowId: unknown,
  watch: Result,
): Promise<unknown> {
  const owner = watchOwner(caller)
  const action = watch.action
  if (action !== 'stop' && perceptionControl.state().settings.hardStopped)
    throw new Error(__t('errors.electron', 'PERCEPTION_STOPPED: 感知已全部停止，请在界面点击恢复'))
  if (action === 'heard') {
    const { from, to } = heardRange(watch, Date.now())
    return { success: true, heard: earsService.query(from, to) }
  }
  if (action === 'start') {
    const companion = watch.companion === true
    const listen = companion || watch.listen === true
    const hasWindow = typeof windowId === 'string' && windowId !== ''
    let result: Result = { success: true }
    // 只听不看时不需要窗口；看和陪看都需要窗口（缺少时由盯窗口给出错误）。
    if (hasWindow || !listen || companion)
      result = (await desktopWatch.handle(owner, windowId, watch)) as Result
    if (companion) {
      if (!caller.agentId || !caller.threadId) {
        desktopWatch.stop(owner)
        throw new Error(
          `DESKTOP_COMPANION_UNAVAILABLE: ${__t('electron.ui.desktopControl', '陪看需要在对话会话里开始')}`,
        )
      }
      result.companion = companionService.start(
        owner,
        { agentId: caller.agentId, threadId: caller.threadId },
        String(windowId),
        await windowTitle(String(windowId)),
      )
    }
    // 手动陪看要听的是这个视频，不是常驻跟着前台录的那个程序。
    if (companion) setPerceptionAudioTarget(undefined)
    if (listen) result.ears = earsService.acquire(owner)
    return result
  }
  if (action === 'stop') {
    const stoppedCompanion = companionService.stop(owner)
    const wasListening = earsService.isListeningFor(owner)
    earsService.release(owner)
    const result = desktopWatch.running(owner)
      ? ((await desktopWatch.handle(owner, windowId, watch)) as Result)
      : { success: true, running: false }
    return {
      ...result,
      ...(wasListening ? { earsStopped: true } : {}),
      ...(stoppedCompanion ? { companionStopped: true } : {}),
    }
  }
  if (action === 'poll' || action === 'status') {
    if (!desktopWatch.running(owner) && earsService.isListeningFor(owner))
      return attach({ success: true, running: false, listening: true }, owner)
    const result = (await desktopWatch.handle(owner, windowId, watch)) as Result
    return action === 'poll'
      ? attach(result, owner)
      : {
          ...result,
          listening: earsService.isListeningFor(owner),
          ...(companionService.describe(owner)
            ? { companion: companionService.describe(owner) }
            : {}),
        }
  }
  return desktopWatch.handle(owner, windowId, watch)
}

/** 普通观察（不是 watch）的结果：在听时附上上次到这次之间的新台词。 */
export function attachHeard(caller: DesktopCaller, result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const heard = earsService.deliver(watchOwner(caller))
  return heard ? { ...(result as Result), heard } : result
}

/** 总开关关闭等情况：耳朵与陪看一起停。 */
export function stopHome(reason: string): void {
  companionService.stopAll()
  earsService.stopAll(reason)
}

// 桌面暂停、断线、锁屏、退出时盯窗口已停；耳朵与陪看也要一起停，不能在暂停期间继续录音。
onDesktopObservationStop((reason) =>
  stopHome(`EARS_DESKTOP_PAUSED: ${__t('electron.ui.desktopControl', reason)}`),
)
