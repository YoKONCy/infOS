/**
 * @file 动作后等画面稳定：按固定间隔采样画面指纹，连续两次差异足够小就停，超过上限也停。
 *
 * 取代原来“动作后固定等 200ms 就截图”：打开菜单、加载页面等慢一些的变化不会再截到旧画面；
 * 画面本来就不变的动作（例如点了没反应）最多多等一个采样间隔。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 动作后的画面
 */

import { FRAME_STABLE_THRESHOLD, frameDifference } from './desktopFrame'

/** 默认上限（毫秒）；可由 automation_execute 的 settleTimeoutMs 调整。 */
export const SETTLE_DEFAULT_MS = 1500
export const SETTLE_MIN_MS = 200
export const SETTLE_MAX_MS = 5000
/** 采样间隔：太短会把动画中间帧误判为稳定，太长会拖慢每一步。 */
export const SETTLE_INTERVAL_MS = 150

export interface SettleResult {
  /** 是否等到了稳定画面；false 表示到上限仍在变化，或无法采样。 */
  stable: boolean
  /** 实际等了多久（毫秒）。 */
  waitedMs: number
  /** 采样次数。 */
  samples: number
}

export interface SettleOptions {
  sample: () => Promise<Uint8Array>
  maxMs?: number
  intervalMs?: number
  threshold?: number
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** 读取并限制等待上限；非法值用默认值。 */
export function settleTimeout(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : SETTLE_DEFAULT_MS
  return Math.round(Math.max(SETTLE_MIN_MS, Math.min(SETTLE_MAX_MS, number)))
}

/** 可被中断的等待；中断时抛 `DESKTOP_CANCELLED`。 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer)
      reject(new Error('DESKTOP_CANCELLED: 桌面操作已暂停'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
  })
}

/** 等画面稳定。采样失败（例如截图暂时不可用）时提前结束并返回 stable=false，不抛错。 */
export async function waitForStableFrame(options: SettleOptions): Promise<SettleResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep
  const interval = options.intervalMs ?? SETTLE_INTERVAL_MS
  const threshold = options.threshold ?? FRAME_STABLE_THRESHOLD
  const maxMs = settleTimeout(options.maxMs)
  const start = now()
  let samples = 0
  const take = async (): Promise<Uint8Array | undefined> => {
    try {
      samples++
      return await options.sample()
    } catch {
      return undefined
    }
  }
  await sleep(interval, options.signal)
  let previous = await take()
  while (previous) {
    if (now() - start + interval > maxMs) break
    await sleep(interval, options.signal)
    const current = await take()
    if (!current) break
    if (frameDifference(previous, current) <= threshold)
      return { stable: true, waitedMs: now() - start, samples }
    previous = current
  }
  return { stable: false, waitedMs: now() - start, samples }
}
