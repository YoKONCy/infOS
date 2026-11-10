/**
 * @file 环境事件信箱（纯逻辑，不依赖 Electron）。
 *
 * - 只收三种事件：空闲（离开/回来）、全屏（进入/退出）、infOS 自己启动的任务完成；
 * - 没有计时器、模型或网络依赖：事件只能被用户下一次说话时取走，不会主动叫醒她；
 * - 有上限：最多保留 ENVIRONMENT_EVENT_LIMIT 条、最长 24 小时；关掉总开关或某一类时，对应事件立即丢弃。
 *
 * @platform ELECTRON
 * @see environmentRuntime.ts 采样与接线
 */

import type { DesktopEnvironmentEvent, DesktopHomeEnvironment } from '@infos/shared'

type StateKind = 'idle' | 'fullscreen'
type Stored = DesktopEnvironmentEvent & { agentId?: string }

/** 信箱最多保留的事件数。 */
export const ENVIRONMENT_EVENT_LIMIT = 50
/** 一次附带给她的最多条数（取最新的）。 */
export const ENVIRONMENT_TAKE_LIMIT = 20
/** 超过这个时长的事件没有参考价值，直接丢弃。 */
export const ENVIRONMENT_EVENT_MAX_AGE_MS = 24 * 60 * 60_000
const ID = /^[\w:.-]{1,200}$/

export class EnvironmentEvents {
  private events: Stored[] = []
  /** 上一次观察到的状态；第一次观察只记基线，不算变化。 */
  private readonly states = new Map<StateKind, boolean>()
  /** 已记录过的任务，防止同一任务的完成通知重复进信箱。 */
  private readonly seenTasks = new Set<string>()

  constructor(
    private readonly settings: () => DesktopHomeEnvironment,
    private readonly now: () => number = Date.now,
  ) {}

  /** 全部清空（总开关关闭时）。 */
  clear(): void {
    this.events = []
    this.states.clear()
    this.seenTasks.clear()
  }

  /** 观察中断（锁屏、休眠、桌面操作关闭）：丢弃基线，恢复后重新起算，不把中断本身当成变化。 */
  resetBaseline(): void {
    this.states.clear()
  }

  /** 设置变化后：总开关关了就清空；只关了某一类就丢弃这一类。 */
  applySettings(): void {
    const settings = this.settings()
    if (!settings.enabled) return this.clear()
    for (const kind of ['idle', 'fullscreen'] as const)
      if (!settings[kind]) this.states.delete(kind)
    this.events = this.events.filter((event) => this.wanted(event, settings))
  }

  /** 采样结果：只在状态翻转时记一条。 */
  changed(kind: StateKind, active: boolean): void {
    const settings = this.settings()
    if (!settings.enabled || !settings[kind]) {
      this.states.delete(kind)
      return
    }
    const previous = this.states.get(kind)
    this.states.set(kind, active)
    if (previous === undefined || previous === active) return
    this.push({ kind, active, at: this.now() })
  }

  /** infOS 自己启动的后台任务完成；只交给发起任务的角色。 */
  taskCompleted(agentId: string, taskId: string): void {
    const settings = this.settings()
    if (!settings.enabled || !settings.taskCompleted) return
    if (!ID.test(agentId) || !ID.test(taskId) || this.seenTasks.has(taskId)) return
    this.seenTasks.add(taskId)
    if (this.seenTasks.size > ENVIRONMENT_EVENT_LIMIT * 4)
      this.seenTasks.delete(this.seenTasks.values().next().value!)
    this.push({ kind: 'task-completed', taskId, agentId, at: this.now() })
  }

  /** 用户对这个角色说话时取走：空闲、全屏是共享的，任务只给对应角色。取走后从信箱删除。 */
  take(agentId: string): DesktopEnvironmentEvent[] {
    const settings = this.settings()
    if (!settings.enabled) {
      this.clear()
      return []
    }
    this.events = this.events.filter((event) => this.wanted(event, settings))
    const mine = (event: Stored) => event.kind !== 'task-completed' || event.agentId === agentId
    const taken = this.events.filter(mine)
    this.events = this.events.filter((event) => !mine(event))
    return taken.slice(-ENVIRONMENT_TAKE_LIMIT).map(({ agentId: _owner, ...event }) => event)
  }

  /** 信箱里还有多少条（测试与状态展示用）。 */
  get size(): number {
    return this.events.length
  }

  private wanted(event: Stored, settings: DesktopHomeEnvironment): boolean {
    if (this.now() - event.at >= ENVIRONMENT_EVENT_MAX_AGE_MS) return false
    return event.kind === 'task-completed' ? settings.taskCompleted : settings[event.kind]
  }

  private push(event: Stored): void {
    this.events = [...this.events, event]
      .filter((item) => this.now() - item.at < ENVIRONMENT_EVENT_MAX_AGE_MS)
      .slice(-ENVIRONMENT_EVENT_LIMIT)
  }
}
