/**
 * approvalPolling — 审批全局轮询的节奏控制与结果比较
 *
 * 由 useApprovalStore 接线：前台按常规间隔轮询，窗口隐藏时降为低频后台补齐。
 */
import type { ApprovalRequest } from '../api/modules/approvalsApi'

const BACKGROUND_POLL_INTERVAL_MS = 60_000

/** 判断两份 pending 集合是否等价；审批数量很少，逐条序列化比较的开销可以忽略。 */
export function samePendingSet(
  current: ReadonlyMap<string, ApprovalRequest>,
  next: ReadonlyMap<string, ApprovalRequest>,
): boolean {
  if (current.size !== next.size) return false
  for (const [id, request] of next) {
    const previous = current.get(id)
    if (!previous || JSON.stringify(previous) !== JSON.stringify(request)) return false
  }
  return true
}

/** 创建轮询控制器；refresh 为每轮执行的刷新，foregroundInterval 为前台间隔。 */
export function createApprovalPolling(refresh: () => Promise<void>, foregroundInterval: number) {
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollInterval = 0
  let pollRequested = false
  let pollPaused = false

  /** 隐藏时保留低频全局补齐；恢复可见时立即刷新并恢复前台间隔。 */
  function syncPolling(): void {
    const interval = pollRequested
      ? pollPaused
        ? BACKGROUND_POLL_INTERVAL_MS
        : foregroundInterval
      : 0
    if (interval === pollInterval) return
    const starting = pollInterval === 0
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    pollInterval = interval
    if (!interval) return
    // 首次启动（含窗口隐藏启动）立即对齐一次，避免托盘启动后一分钟内缺少全局审批。
    if (starting || !pollPaused) void refresh()
    pollTimer = setInterval(() => void refresh(), interval)
  }

  return {
    start(): void {
      pollRequested = true
      syncPolling()
    },
    stop(): void {
      pollRequested = false
      syncPolling()
    },
    /** 窗口隐藏或被应用标签覆盖时，仅降低后台补齐频率，不能依赖席位推送覆盖全局。 */
    setPaused(paused: boolean): void {
      pollPaused = paused
      syncPolling()
    },
  }
}
