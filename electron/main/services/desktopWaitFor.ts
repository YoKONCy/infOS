/**
 * @file 「手」的等待：wait_for 某个窗口或某段文字出现（或消失），有超时上限。
 *
 * - `until.window`：标题或进程名含这段字的窗口出现（不需要观察）。
 * - `until.text` / `until.gone`：观察的那个窗口里出现 / 不再有这段字（控件名字、当前值、文档正文开头）；
 *   需要 observationId（只用来确定是哪个窗口）。读控件树不登记控件引用，也不切前台、不发出任何输入。
 * - 每 500ms 看一次，默认最多等 10 秒，上限 30 秒；总开关关闭、用户按停止或任务取消时立即停。
 * - 等到了只报告结果，不替角色观察：要操作时用返回的 windowId 重新观察。
 *
 * 参考 dsh-computer-use-win 的 `wait_for`（轮询 + 超时，看到才报 observed；MIT，见 THIRD_PARTY_NOTICES.md）。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 等待
 */

import type { DesktopWindowInfo } from '@infos/shared'
import type { DesktopCaller } from './desktopControl'
import { abortableSleep } from './desktopSettle'
import { findObservation } from './desktopObservationIndex'
import { windowsDesktop } from './windowsDesktop'

export const WAIT_FOR_DEFAULT_MS = 10_000
export const WAIT_FOR_MAX_MS = 30_000
export const WAIT_FOR_INTERVAL_MS = 500

export interface WaitUntil {
  window?: string
  text?: string
  gone?: string
}

export interface TextProbe {
  found: boolean
  role?: string
  text?: string
  truncated?: boolean
}

export interface WaitForDeps {
  assertAvailable(signal?: AbortSignal): void
  windows(): Promise<DesktopWindowInfo[]>
  findText(windowId: string, text: string, signal?: AbortSignal): Promise<TextProbe>
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
  now?(): number
}

const invalid = () =>
  new Error('DESKTOP_WAIT_INVALID: until 只能包含 window、text、gone（字符串，200 字以内）')

/** 读取并校验 `until`。 */
export function readUntil(value: unknown): WaitUntil {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const result: WaitUntil = {}
  for (const [key, item] of Object.entries(value)) {
    if (!['window', 'text', 'gone'].includes(key)) throw invalid()
    if (typeof item !== 'string' || !item.trim() || item.length > 200) throw invalid()
    result[key as keyof WaitUntil] = item.trim()
  }
  if (!Object.keys(result).length) throw invalid()
  return result
}

/** 等待上限：默认 10 秒，限制在 0.5–30 秒。 */
export function waitForTimeout(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : WAIT_FOR_DEFAULT_MS
  return Math.round(Math.max(WAIT_FOR_INTERVAL_MS, Math.min(WAIT_FOR_MAX_MS, number)))
}

const lower = (value: string) => value.toLowerCase()

/** 轮询直到条件全部满足或超时。超时抛 `DESKTOP_WAIT_TIMEOUT`，附最接近的线索。 */
export async function pollUntil(
  until: WaitUntil,
  options: { timeoutMs: number; windowId?: string; signal?: AbortSignal },
  deps: WaitForDeps,
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? abortableSleep
  if ((until.text || until.gone) && !options.windowId)
    throw new Error(
      'DESKTOP_OBSERVATION_STALE: 等文字需要先观察目标窗口，并提供那次的 observationId',
    )
  const start = now()
  let titles: string[] = []
  for (;;) {
    deps.assertAvailable(options.signal)
    const met: Record<string, unknown> = {}
    let ok = true
    if (until.window) {
      const windows = await deps.windows()
      titles = windows.map((window) => window.title).filter(Boolean)
      const want = lower(until.window)
      const found = windows.find(
        (window) =>
          lower(window.title).includes(want) || lower(window.processName ?? '').includes(want),
      )
      if (found)
        met.window = {
          windowId: found.windowId,
          title: found.title,
          processName: found.processName,
        }
      else ok = false
    }
    if (ok && until.text) {
      const probe = await deps.findText(options.windowId!, until.text, options.signal)
      if (probe.found) met.text = { role: probe.role, text: probe.text }
      else ok = false
    }
    if (ok && until.gone) {
      let probe: TextProbe
      try {
        probe = await deps.findText(options.windowId!, until.gone, options.signal)
      } catch (error) {
        // 窗口关了，那段字自然也不在了。
        if (!String((error as Error)?.message ?? error).startsWith('DESKTOP_WINDOW_GONE'))
          throw error
        probe = { found: false }
      }
      if (probe.found) ok = false
      else met.gone = until.gone
    }
    const waitedMs = now() - start
    if (ok) return { success: true, observed: true, waitedMs, ...met }
    if (waitedMs + WAIT_FOR_INTERVAL_MS > options.timeoutMs) break
    await sleep(WAIT_FOR_INTERVAL_MS, options.signal)
  }
  const seconds = Math.round(options.timeoutMs / 100) / 10
  const parts = [
    until.window ? `标题含「${until.window}」的窗口` : '',
    until.text ? `文字「${until.text}」` : '',
    until.gone ? `「${until.gone}」消失` : '',
  ].filter(Boolean)
  const hint =
    until.window && titles.length
      ? `现在的窗口有：${titles
          .slice(0, 6)
          .map((title) => `「${title.slice(0, 40)}」`)
          .join('、')}。`
      : ''
  throw new Error(
    `DESKTOP_WAIT_TIMEOUT: 等了 ${seconds} 秒，没等到${parts.join('、')}。${hint}可以重新观察看看卡在哪，或者再等一会儿。`,
  )
}

/** capabilityProvider 的入口：`action: wait` 带 `until` 时走这里。 */
export async function waitForDesktop(
  input: Record<string, unknown>,
  caller: DesktopCaller,
  assertAvailable: (signal?: AbortSignal) => void,
): Promise<unknown> {
  const until = readUntil(input.until)
  let windowId: string | undefined
  if (until.text || until.gone) {
    const observation = findObservation(input.observationId, caller)
    if (!observation)
      throw new Error(
        'DESKTOP_OBSERVATION_STALE: 请先观察目标窗口，再引用本次 observationId 等文字',
      )
    windowId = observation.window.windowId
  }
  const result = await pollUntil(
    until,
    { timeoutMs: waitForTimeout(input.timeoutMs), windowId, signal: caller.signal },
    {
      assertAvailable,
      windows: () => windowsDesktop.windows(),
      findText: (id, text, signal) =>
        windowsDesktop.request<TextProbe>('findText', { windowId: id, text }, signal),
    },
  )
  return {
    ...result,
    message: '等到了。要继续操作，请先用 take_screenshot 传对应的 windowId 重新观察。',
  }
}
