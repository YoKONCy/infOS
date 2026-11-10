/**
 * 右下角活动小提示（不依赖 Electron，便于测试）。
 *
 * - 消费 SSE activity：「改了 报告.docx」这类不打断的提示，几秒后自动收起；鼠标停在上面或展开时不收。
 * - 短时间内同一会话、同一动作的多条合并成一条（「改了 3 个文件」），避免刷屏。
 * - 点开看详情；有检查点且成功的文件改动可以直接撤回（POST /checkpoints/undo，多条按倒序逐条撤）。
 * - 原生桌面动作（app/send/pay/settings/terminal）没有文件检查点，不画撤回。
 */

import type { HomeActivity, HomeScope } from '../../../packages/shared/src/home'
import type { HomeApiCall } from './homeApiCore'

export interface ActivityToast {
  id: string
  scope: HomeScope
  action: string
  activities: HomeActivity[]
  createdAt: number
  updatedAt: number
  expanded: boolean
  undone: boolean
  busy: boolean
  error?: string
}

export interface ActivityBoardDeps {
  api: HomeApiCall
  now(): number
  changed(): void
}

/** 合并窗口：同一会话同一动作在这段时间内的活动并为一条。 */
export const ACTIVITY_MERGE_MS = 4_000
/** 无交互时提示停留多久。 */
export const ACTIVITY_LINGER_MS = 6_000
const MAX_TOASTS = 4
const FILE_ACTIONS = new Set(['write', 'move', 'delete'])

export class ActivityBoard {
  private readonly toasts: ActivityToast[] = []
  private hovered = false

  constructor(private readonly deps: ActivityBoardDeps) {}

  list(): ActivityToast[] {
    return [...this.toasts]
  }

  add(activity: HomeActivity): void {
    if (!activity || typeof activity.id !== 'string' || !Array.isArray(activity.objects)) return
    // 等待确认的记录由确认通知负责，这里不重复提示。
    if (activity.result === 'waiting') return
    const now = this.deps.now()
    if (this.toasts.some((toast) => toast.activities.some((row) => row.id === activity.id))) return
    const target = this.toasts.find(
      (toast) =>
        !toast.expanded &&
        !toast.busy &&
        !toast.undone &&
        toast.action === activity.action &&
        toast.scope.agentId === activity.agentId &&
        toast.scope.sessionId === activity.sessionId &&
        now - toast.updatedAt <= ACTIVITY_MERGE_MS,
    )
    if (target) {
      target.activities.push(activity)
      target.updatedAt = now
    } else {
      this.toasts.push({
        id: activity.id,
        scope: {
          agentId: activity.agentId,
          sessionId: activity.sessionId,
          ...(activity.taskId ? { taskId: activity.taskId } : {}),
        },
        action: activity.action,
        activities: [activity],
        createdAt: now,
        updatedAt: now,
        expanded: false,
        undone: false,
        busy: false,
      })
      while (this.toasts.length > MAX_TOASTS) {
        const index = this.toasts.findIndex((toast) => !toast.expanded && !toast.busy)
        this.toasts.splice(index < 0 ? 0 : index, 1)
      }
    }
    this.deps.changed()
  }

  /** 定时调用：收起到时的提示（悬停或展开、正在撤回时保留）。 */
  sweep(): void {
    if (this.hovered) return
    const now = this.deps.now()
    const before = this.toasts.length
    for (let index = this.toasts.length - 1; index >= 0; index--) {
      const toast = this.toasts[index]!
      if (!toast.expanded && !toast.busy && now - toast.updatedAt >= ACTIVITY_LINGER_MS)
        this.toasts.splice(index, 1)
    }
    if (this.toasts.length !== before) this.deps.changed()
  }

  hover(hovered: boolean): void {
    this.hovered = hovered
    // 移开后重新计时，避免刚移开就消失。
    if (!hovered) for (const toast of this.toasts) toast.updatedAt = this.deps.now()
  }

  toggle(id: string): void {
    const toast = this.find(id)
    if (!toast) return
    toast.expanded = !toast.expanded
    toast.updatedAt = this.deps.now()
    this.deps.changed()
  }

  dismiss(id: string): void {
    const index = this.toasts.findIndex((toast) => toast.id === id)
    if (index < 0) return
    this.toasts.splice(index, 1)
    this.deps.changed()
  }

  /** 这条提示里能撤回的检查点（新的在前，撤回顺序与改动顺序相反）。 */
  undoable(toast: ActivityToast): string[] {
    if (toast.undone || !FILE_ACTIONS.has(toast.action)) return []
    return toast.activities
      .filter((row) => row.result === 'success' && typeof row.checkpointId === 'string')
      .map((row) => row.checkpointId!)
      .reverse()
  }

  async undo(id: string): Promise<void> {
    const toast = this.find(id)
    if (!toast || toast.busy) return
    const checkpoints = this.undoable(toast)
    if (!checkpoints.length) return
    toast.busy = true
    toast.error = undefined
    this.deps.changed()
    try {
      for (const checkpointId of checkpoints)
        await this.deps.api('POST', '/checkpoints/undo', {
          scope: toast.scope,
          input: checkpointId,
        })
      toast.undone = true
    } catch (error) {
      toast.error = error instanceof Error ? error.message : String(error)
    } finally {
      toast.busy = false
      toast.updatedAt = this.deps.now()
      this.deps.changed()
    }
  }

  clear(): void {
    this.toasts.length = 0
    this.deps.changed()
  }

  private find(id: string): ActivityToast | undefined {
    return this.toasts.find((toast) => toast.id === id)
  }
}
