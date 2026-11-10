import { randomUUID } from 'node:crypto'
import { ProactiveBudget } from './proactiveBudget'
import { perceptionSnapshots } from '../perception/perceptionSnapshotStore'
import { t as __t } from '../../lib/i18n'
import type { ProactiveMode, ProactiveSettings, ProactiveState } from '@infos/shared'
import { resolveProactiveSettings, type AgentProactiveSettings, type NextAgentActivity } from '@infos/shared'
import type { ToolContext } from '../agent/toolRegistry'
import type { BackgroundTaskInfo } from '../task/backgroundTaskService'
import type { ConfigRepository } from '../../repositories/config.repo'
import { AppError } from '../../lib/appError'
import { createLogger } from '../../lib/logger'
import { WatchAlongTurns } from './watchAlongTurn'
import { PerceptionPermit, type PerceptionPermitInput } from './perceptionPermit'
import { runPerceptionWake, type PerceptionWakeInput } from './perceptionWake'

const logger = createLogger('ProactiveService')
const SETTINGS_KEY = 'proactive.settings'
const STATE_KEY = 'proactive.state'
type Target = {
  id: string
  agentId: string
  generation?: number
  channel: string
  purpose?: string
  status?: string
  title?: string | null
}
interface ProactiveDeps {
  listAgents(): string[]
  /** 用户当前正在用的角色：陪看和感知叫醒都找她，不是列表第一个。 */
  activeAgent?(): string | undefined
  resolveThread(agentId: string): Promise<Target>
  /** 按编号取会话（陪看插话指定会话时用）。 */
  getThread?(threadId: string): Promise<Target | null>
  isBusy(agentId: string): boolean
  runStronghold?(agentId: string, signal: AbortSignal): Promise<string | null>
  groupMessages?(roomId: string, afterMessageId: number, senderId?: string, sourcePairId?: string): Promise<Array<{ id: number; senderId: string }>>
  resumeGroupWait?(messageId: number, agentId: string, wait: ActivityWait): Promise<boolean>
  activitySourceActive?(wait: ActivityWait): Promise<boolean>
  currentRoom?(agentId: string): Promise<string | undefined>
  getTask?(taskId: string): Promise<BackgroundTaskInfo | null>
  resumeTaskWait?(wait: ActivityWait, task: BackgroundTaskInfo): Promise<void>
  run(input: {
    mode: Exclude<ProactiveMode, 'off'>
    thread: Target
    content: string
    signal: AbortSignal
    snapshot?: import('@infos/shared').PerceptionSnapshot
    /** 给她的指令；没有时 content 按看到的内容处理。 */
    instruction?: string
    /** 陪看的回合：不做记忆召回，要快。 */
    watching?: boolean
  }): Promise<string | null>
  changed(state: ProactiveState): Promise<void>
}
export interface ActivityWait {
  kind: 'wait_message' | 'wait_task'
  threadId: string
  generation: number
  sourcePairId: string
  roomId?: string
  senderId?: string
  taskId?: string
  afterMessageId: number
}
interface AgentSchedule {
  consecutiveMessages: number
  nextEligibleAt: number
  quietRuns?: number
  scene?: 'desktop' | 'stronghold'
  lastSceneMessageId?: number
  waiting?: ActivityWait
}
interface PersistedState extends Partial<ProactiveState> {
  day?: string
  cursor?: string
  agents?: Record<string, AgentSchedule>
}
const DEFAULT_SETTINGS: ProactiveSettings = {
  mode: 'off',
  strongholdActivity: false,
  agents: {},
  companionIntervalMinutes: 3,
  autonomousIntervalMinutes: 15,
  goal: '',
  maxDailyRuns: 48,
  timeZone: 'Asia/Shanghai',
}
const timeValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

/** 解析角色策略，合并私聊与据点的空闲机会；静默后延长等待。 */
export class ProactiveService {
  readonly perceptionPermit = new PerceptionPermit((all) => {
    if (all || this.runningMode() === 'companion') this.controller?.abort(new Error('PERCEPTION_STOPPED'))
    if (all || !this.watchAllowed()) this.watchAlong.cancel(undefined, 'PERCEPTION_STOPPED')
    this.wakeController?.abort()
  })

  readonly budget: ProactiveBudget
  private wakeController?: AbortController
  watchAllowed(): boolean {
    return !this.perceptionPermit.stopped && this.perceptionPermit.allowed
  }
  private currentAgent(): string | undefined {
    const agents = this.deps?.listAgents() ?? []
    const active = this.deps?.activeAgent?.()
    return active && agents.includes(active) ? active : agents[0]
  }
  async watchTarget(): Promise<{agentId: string; threadId: string} | null> {
    const id = this.currentAgent()
    if (!id || !this.deps) return null
    const thread = await this.deps.resolveThread(id)
    return thread.channel === 'desktop' && thread.status === 'active' ? {agentId: id, threadId: thread.id} : null
  }
  private permitWrites: Promise<unknown> = Promise.resolve()
  async updatePerceptionPermit(input: PerceptionPermitInput): Promise<void> {
    if (!this.perceptionPermit.update(input)) return
    this.schedule()
    this.permitWrites = this.permitWrites.catch(() => {}).then(() => this.config.set('perception.hardStopped', JSON.stringify(input.hardStopped)))
    await this.permitWrites
  }
  private settings = { ...DEFAULT_SETTINGS }
  private state: Omit<ProactiveState, 'settings'> = {
    agentId: null,
    phase: 'off',
    nextRunAt: null,
    lastRunAt: null,
    lastActivityAt: Date.now(),
    lastOutcome: '尚未启用',
    lastError: null,
    dailyRuns: 0,
    recent: [],
  }
  private agents = new Map<string, AgentSchedule>()
  private day = ''
  private cursor = ''
  private deps?: ProactiveDeps
  private timer?: ReturnType<typeof setTimeout>
  private controller?: AbortController
  private runningScene?: 'desktop' | 'stronghold'
  private inFlight?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private changes: Promise<unknown> = Promise.resolve()
  private activityChanges: Promise<unknown> = Promise.resolve()
  private stopped = false
  private schedulingHolds = 0
  /** 陪看模式的主动插话（调度在桌面客户端）。 */
  readonly watchAlong = new WatchAlongTurns(
    () => this.deps,
    () => !!this.inFlight || !!this.wakeController || this.stopped || !this.watchAllowed(),
    Date.now,
    () => this.budget,
  )

  constructor(private config: ConfigRepository) {
    this.budget = new ProactiveBudget(config, () => this.settings)
  }

  async initialize(deps: ProactiveDeps): Promise<void> {
    this.deps = deps
    this.perceptionPermit.restore((await this.config.getJson<boolean>('perception.hardStopped')) === true)
    try {
      const settings = await this.config.getJson<Partial<ProactiveSettings>>(SETTINGS_KEY)
      this.settings = this.validate({ ...DEFAULT_SETTINGS, ...settings })
      const saved = await this.config.getJson<PersistedState>(STATE_KEY)
      if (saved) {
        this.day = typeof saved.day === 'string' ? saved.day : ''
        this.cursor = typeof saved.cursor === 'string' ? saved.cursor : ''
        this.state.dailyRuns = Math.floor(timeValue(saved.dailyRuns))
        this.state.lastRunAt = timeValue(saved.lastRunAt) || null
        this.state.lastActivityAt = timeValue(saved.lastActivityAt) || Date.now()
        this.state.recent = Array.isArray(saved.recent)
          ? saved.recent
              .filter(
                (item) =>
                  item &&
                  timeValue(item.at) &&
                  typeof item.outcome === 'string' &&
                  ['off', 'companion', 'autonomous'].includes(item.mode),
              )
              .slice(-20)
              .map(({ at, mode, agentId, outcome, error }) => ({
                at,
                mode,
                agentId,
                outcome,
                error,
              }))
          : []
        const enabled = new Set(deps.listAgents())
        for (const [id, item] of Object.entries(saved.agents ?? {})) {
          if (enabled.has(id) && item)
            this.agents.set(id, {
              consecutiveMessages: Math.floor(timeValue(item.consecutiveMessages)),
              nextEligibleAt: timeValue(item.nextEligibleAt),
              quietRuns: Math.floor(timeValue(item.quietRuns)),
              scene: item.scene === 'stronghold' ? 'stronghold' : 'desktop',
              lastSceneMessageId: timeValue(item.lastSceneMessageId),
              waiting: item.waiting && ['wait_message', 'wait_task'].includes(item.waiting.kind) &&
                typeof item.waiting.threadId === 'string' && Number.isSafeInteger(item.waiting.generation) &&
                typeof item.waiting.sourcePairId === 'string' && Number.isSafeInteger(item.waiting.afterMessageId)
                ? item.waiting : undefined,
            })
        }
      }
      this.state.phase = this.isEnabled() ? 'waiting' : 'off'
      // 旧版固定会话与信息源配置不会继续落盘，也不会影响恢复。
      this.state.nextRunAt =
        !this.isEnabled()
          ? null
          : Math.max(timeValue(saved?.nextRunAt), Date.now() + this.interval())
      this.state.lastOutcome =
        !this.isEnabled() ? '主动行为已关闭' : '全局模式已恢复，等待下一次唤醒'
    } catch (error) {
      this.settings.mode = 'off'
      this.state.phase = 'error'
      this.state.nextRunAt = null
      this.state.lastError = error instanceof Error ? error.message : String(error)
      logger.warn(__t('logs.companion', '全局主动模式恢复失败，已保持关闭'), {
        error: this.state.lastError,
      })
    }
    await this.config.set(SETTINGS_KEY, JSON.stringify(this.settings))
    await this.budget.initialize(this.day === new Intl.DateTimeFormat('en-CA', {timeZone: this.settings.timeZone}).format(new Date()) ? this.state.dailyRuns : 0)
    await this.changeActivity(() => this.recoverActivities())
    await this.persist()
    this.schedule()
  }

  getState(): ProactiveState {
    return structuredClone({
      ...this.state,
      dailyRuns: this.budget.counts().budgetUsed,
      settings: this.settings,
      activities: Object.fromEntries([...this.agents].map(([agentId, state]) => [agentId, state.waiting?.kind ?? 'rest'])),
      lastOutcome: __t('server.scheduler', this.state.lastOutcome),
      recent: this.state.recent.map((item) => ({ ...item, outcome: __t('server.scheduler', item.outcome) })),
    })
  }

  configure(patch: Partial<ProactiveSettings>): Promise<ProactiveState> {
    return this.changeSettings(() => patch)
  }

  getAgentSettings(agentId: string) {
    return resolveProactiveSettings(this.settings, agentId)
  }

  configureAgent(agentId: string, patch: { mode?: ProactiveMode | null; strongholdActivity?: boolean | null }): Promise<ProactiveState> {
    return this.changeSettings(() => {
      const agents = { ...this.settings.agents }
      const override = { ...agents[agentId] }
      for (const key of ['mode', 'strongholdActivity'] as const) {
        if (patch[key] === null) delete override[key]
      }
      if (patch.mode !== undefined && patch.mode !== null) override.mode = patch.mode
      if (patch.strongholdActivity !== undefined && patch.strongholdActivity !== null)
        override.strongholdActivity = patch.strongholdActivity
      if (Object.keys(override).length) agents[agentId] = override
      else delete agents[agentId]
      return { agents }
    })
  }

  private changeSettings(patch: () => Partial<ProactiveSettings>): Promise<ProactiveState> {
    const operation = this.changes
      .catch(() => {})
      .then(async () => {
        const settings = this.validate({ ...this.settings, ...patch() })
        const previousSettings = this.settings
        const sharedChanged = ['companionIntervalMinutes', 'autonomousIntervalMinutes', 'goal', 'maxDailyRuns', 'timeZone']
          .some((key) => previousSettings[key as keyof ProactiveSettings] !== settings[key as keyof ProactiveSettings])
        const policyChanged = (agentId: string) => {
          const before = resolveProactiveSettings(previousSettings, agentId)
          const after = resolveProactiveSettings(settings, agentId)
          return before.mode !== after.mode || before.strongholdActivity !== after.strongholdActivity
        }
        this.schedulingHolds++
        try {
          if (sharedChanged || (this.state.agentId && policyChanged(this.state.agentId)))
            await this.cancelCurrent('角色主动行为设置已切换')
          await this.config.set(SETTINGS_KEY, JSON.stringify(settings))
          this.settings = settings
          if (!this.inFlight) {
            this.state.agentId = null
            this.state.phase = this.isEnabled() ? 'waiting' : 'off'
            this.state.nextRunAt = this.isEnabled() ? Date.now() + this.interval() : null
          }
          this.state.lastError = null
          this.state.lastOutcome =
            !this.isEnabled()
              ? '主动行为已关闭，已有定时任务继续按计划运行'
              : '角色主动行为设置已更新'
          for (const [agentId, state] of this.agents) {
            if (sharedChanged || policyChanged(agentId)) {
              state.nextEligibleAt = Date.now() + this.interval(this.getAgentSettings(agentId).mode)
              state.quietRuns = 0
            }
          }
          await this.persist()
          return this.getState()
        } finally {
          this.schedulingHolds--
          this.schedule()
        }
      })
    this.changes = operation
    return operation
  }

  async start(agentId?: string): Promise<void> {
    if (agentId) await this.configureAgent(agentId, { mode: 'companion' })
    else await this.configure({ mode: 'companion' })
  }
  async stop(agentId?: string): Promise<void> {
    if (agentId) await this.configureAgent(agentId, { mode: 'off' })
    else await this.configure({ mode: 'off' })
  }
  isRunning(agentId: string): boolean {
    return this.getAgentSettings(agentId).mode === 'companion' && !!this.deps?.listAgents().includes(agentId)
  }
  listStates(agentIds: string[]) {
    return agentIds.map((agentId) => ({ agentId, enabled: this.isRunning(agentId) }))
  }

  async notifyActivity(agentId: string, threadId?: string, sceneRoomId?: string): Promise<void> {
    this.wakeController?.abort()
    await this.budget.activity()
    this.watchAlong.cancel(agentId)
    await this.watchAlong.wait(agentId)
    this.state.lastActivityAt = Date.now()
    const previous = this.agents.get(agentId)
    const waiting = previous?.waiting
    this.agents.set(agentId, {
      consecutiveMessages: 0,
      nextEligibleAt: Date.now() + this.interval(this.getAgentSettings(agentId).mode),
      quietRuns: 0,
      scene: sceneRoomId ? 'stronghold' : 'desktop',
      waiting: waiting?.kind === 'wait_message' && waiting.senderId === 'user' &&
        (sceneRoomId ? waiting.roomId === sceneRoomId : !waiting.roomId && (!threadId || waiting.threadId === threadId))
        ? undefined : waiting,
    })
    this.schedulingHolds++
    try {
      if (this.runningMode() === 'companion' || agentId === this.state.agentId || (sceneRoomId && this.runningScene === 'stronghold')) {
        // 先等待主动回合退出，避免与新用户输入交叉入库。
        await this.cancelCurrent('用户开始交互，主动回合让出执行')
        if (this.isEnabled()) this.state.nextRunAt = Date.now() + this.interval()
      }
      await this.persist().catch((error) =>
        logger.warn(__t('logs.companion', '保存主动行为活动时间失败'), { error }),
      )
    } finally {
      this.schedulingHolds--
      this.schedule()
    }
  }

  async recordNextActivity(activity: NextAgentActivity, context: ToolContext, publishingReply = true): Promise<void> {
    return this.changeActivity(async () => {
      if (!this.deps || context.taskId || context.realmId || !context.pairId ||
        (context.channel === 'group' && !context.sceneRoomId))
        throw new Error('ACTIVITY_MAIN_THREAD_REQUIRED')
      const main = await this.deps.resolveThread(context.agentId)
      if (main.id !== context.threadId || !Number.isSafeInteger(context.generation) || main.generation !== context.generation || main.status !== 'active')
        throw new Error('THREAD_GENERATION_STALE')
      if (activity.kind === 'wait_message' && (!activity.senderId || activity.senderId === context.agentId ||
        (activity.senderId !== 'user' && !this.deps.listAgents().includes(activity.senderId)) ||
        (!context.sceneRoomId && activity.senderId !== 'user'))) throw new Error('ACTIVITY_SENDER_INVALID')
      if (activity.kind === 'wait_message' && activity.senderId !== 'user' && context.sceneRoomId && this.deps.currentRoom &&
        await this.deps.currentRoom(activity.senderId!) !== context.sceneRoomId) throw new Error('ACTIVITY_SENDER_INVALID')
      if (activity.kind === 'wait_message' && activity.senderId !== 'user' &&
        !this.getAgentSettings(activity.senderId!).strongholdActivity) throw new Error('ACTIVITY_SENDER_PAUSED')
      if (activity.kind === 'wait_task') {
        const task = activity.taskId && await this.deps.getTask?.(activity.taskId)
        if (!task || task.agentId !== context.agentId) throw new Error('ACTIVITY_TASK_INVALID')
      }
      if (activity.kind === 'wait_message' && context.sceneRoomId && !publishingReply)
        throw new Error('ACTIVITY_MESSAGE_REQUIRED')
      let waiting: ActivityWait | undefined
      if (activity.kind !== 'rest') {
        const messages = context.sceneRoomId ? await this.deps.groupMessages?.(context.sceneRoomId, -1) ?? [] : []
        waiting = {
          kind: activity.kind, threadId: main.id, generation: context.generation!, sourcePairId: context.pairId,
          roomId: context.sceneRoomId, senderId: activity.senderId, taskId: activity.taskId,
          afterMessageId: messages.at(-1)?.id ?? 0,
        }
        if (context.sceneRoomId && !publishingReply && this.deps.activitySourceActive && !await this.deps.activitySourceActive(waiting))
          throw new Error('ACTIVITY_MESSAGE_REQUIRED')
      }
      context.signal?.throwIfAborted()
      const state: AgentSchedule = this.agents.get(context.agentId) ?? { consecutiveMessages: 0, nextEligibleAt: 0 }
      state.scene = context.sceneRoomId ? 'stronghold' : 'desktop'
      state.nextEligibleAt = Date.now() + this.interval(this.getAgentSettings(context.agentId).mode)
      state.waiting = waiting
      this.agents.set(context.agentId, state)
      await this.persist()
      // 先登记等待再检查权威结果，覆盖任务在登记过程中结束的竞态。
      if (state.waiting?.taskId) {
        const task = await this.deps.getTask?.(state.waiting.taskId)
        if (task) await this.completeTaskWait(task)
      }
    })
  }

  async notifyGroupMessage(roomId: string, messageId: number, senderId: string, sourcePairId?: string): Promise<void> {
    return this.changeActivity(async () => {
      let changed = false
      for (const [agentId, state] of this.agents) {
        const wait = state.waiting
        if (wait?.kind !== 'wait_message' || wait.roomId !== roomId || wait.senderId !== senderId || messageId <= wait.afterMessageId) continue
        if (senderId !== 'user' && sourcePairId !== undefined && sourcePairId !== wait.sourcePairId) continue
        const current = await this.currentWait(agentId, wait)
        if (!current && this.deps?.isBusy(agentId)) continue
        if (current && this.deps?.resumeGroupWait && !await this.deps.resumeGroupWait(messageId, agentId, wait)) {
          wait.afterMessageId = messageId
          changed = true
          continue
        }
        delete state.waiting
        state.quietRuns = 0
        state.nextEligibleAt = Date.now() + this.interval(this.getAgentSettings(agentId).mode)
        changed = true
      }
      if (changed) await this.persist()
    })
  }

  async notifyTask(task: BackgroundTaskInfo): Promise<void> {
    return this.changeActivity(() => this.completeTaskWait(task))
  }

  async noteSceneActivity(agentId: string, messageId: number): Promise<void> {
    return this.changeActivity(async () => {
      const state: AgentSchedule = this.agents.get(agentId) ?? { consecutiveMessages: 0, nextEligibleAt: 0 }
      if ((state.lastSceneMessageId ?? 0) >= messageId) return
      state.lastSceneMessageId = messageId
      state.quietRuns = 0
      state.scene = 'stronghold'
      state.nextEligibleAt = Date.now() + this.interval(this.getAgentSettings(agentId).mode)
      this.agents.set(agentId, state)
      await this.recoverActivities(agentId)
      await this.persist()
    })
  }

  async discardSceneActivity(roomId: string, sourcePairId: string): Promise<void> {
    return this.changeActivity(async () => {
      for (const state of this.agents.values()) {
        if (state.waiting?.roomId === roomId && state.waiting.sourcePairId === sourcePairId) delete state.waiting
      }
      await this.persist()
    })
  }

  async discardThreadActivity(threadId: string, sourceIds?: string[]): Promise<void> {
    return this.changeActivity(async () => {
      const thread = await this.deps?.getThread?.(threadId)
      if (!sourceIds && thread) this.agents.delete(thread.agentId)
      else {
        for (const state of this.agents.values()) {
          if (state.waiting?.threadId === threadId && (!sourceIds || sourceIds.includes(state.waiting.sourcePairId)))
            delete state.waiting
        }
      }
      await this.persist()
    })
  }

  private changeActivity(operation: () => Promise<void>): Promise<void> {
    const pending = this.activityChanges.catch(() => {}).then(operation)
    this.activityChanges = pending
    return pending
  }

  private async currentWait(agentId: string, wait: ActivityWait): Promise<boolean> {
    const thread = await this.deps?.getThread?.(wait.threadId)
    if (!thread || thread.agentId !== agentId || thread.status !== 'active' || thread.generation !== wait.generation) return false
    if (wait.kind === 'wait_message' && wait.senderId !== 'user' &&
      (!wait.senderId || !this.deps?.listAgents().includes(wait.senderId) || !this.getAgentSettings(wait.senderId).strongholdActivity)) return false
    if (wait.roomId && this.deps?.currentRoom && await this.deps.currentRoom(agentId) !== wait.roomId) return false
    return this.deps?.activitySourceActive ? this.deps.activitySourceActive(wait) : true
  }

  private async completeTaskWait(task: BackgroundTaskInfo): Promise<void> {
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) return
    const state = this.agents.get(task.agentId)
    const wait = state?.waiting
    if (!state || wait?.kind !== 'wait_task' || wait.taskId !== task.id) return
    const current = await this.currentWait(task.agentId, wait)
    if (!current && this.deps?.isBusy(task.agentId)) return
    if (current) await this.deps?.resumeTaskWait?.(wait, task)
    delete state.waiting
    state.quietRuns = 0
    state.nextEligibleAt = Date.now() + this.interval(this.getAgentSettings(task.agentId).mode)
    await this.persist()
  }

  private async recoverActivities(onlyAgentId?: string): Promise<void> {
    for (const [agentId, state] of this.agents) {
      if (onlyAgentId && agentId !== onlyAgentId) continue
      const wait = state.waiting
      if (!wait) continue
      if (!await this.currentWait(agentId, wait)) {
        if (!this.deps?.isBusy(agentId)) delete state.waiting
        continue
      }
      if (wait.kind === 'wait_task' && wait.taskId) {
        const task = await this.deps?.getTask?.(wait.taskId)
        if (task) await this.completeTaskWait(task)
        else delete state.waiting
      } else if (wait.roomId) {
        const messages = await this.deps?.groupMessages?.(wait.roomId, wait.afterMessageId, wait.senderId,
          wait.senderId === 'user' ? undefined : wait.sourcePairId) ?? []
        const reply = messages.find((message) => message.senderId === wait.senderId)
        if (reply) {
          if (await this.deps?.resumeGroupWait?.(reply.id, agentId, wait)) delete state.waiting
          else wait.afterMessageId = reply.id
        }
      }
    }
  }

  async checkNow(): Promise<ProactiveState> {
    if (!this.isEnabled())
      throw new AppError('INVALID_PARAMETER', { message: '请先开启智能陪伴或自主行动' })
    if (!this.inFlight) {
      this.state.nextRunAt = Date.now()
      this.schedule()
    }
    return this.getState()
  }

  async shutdown(): Promise<void> {
    this.perceptionPermit.dispose()
    this.watchAlong.cancel(undefined, '服务正在关闭')
    this.stopped = true
    await this.watchAlong.wait()
    await this.cancelCurrent('服务正在关闭')
    await this.activityChanges.catch(() => {})
    await this.persist()
  }

  inputActivity(agentId: string, active: boolean): void {
    this.budget.input(active)
    this.watchAlong.inputActivity(agentId, active)
    // 打字只打断正在开口的；自主行动不受影响，备好的台词也留着。
    if (active) { if (this.runningMode() === 'companion') this.controller?.abort(); this.wakeController?.abort() }
  }

  async wake(input: PerceptionWakeInput, signal?: AbortSignal): Promise<{state: string; replied: boolean}> {
    return runPerceptionWake({
      deps: () => this.deps,
      busy: () => this.stopped || !!this.inFlight || !!this.wakeController || this.watchAlong.running,
      permit: this.perceptionPermit,
      budget: this.budget,
      currentAgent: () => this.currentAgent(),
      claim: (controller) => { this.wakeController = controller },
      release: (controller) => { if (this.wakeController === controller) this.wakeController = undefined },
    }, input, signal)
  }

  private runningMode(): ProactiveMode {
    if (this.runningScene === 'stronghold') return 'autonomous'
    return this.state.agentId ? this.getAgentSettings(this.state.agentId).mode : this.settings.mode
  }

  private interval(mode?: ProactiveMode): number {
    if (mode === undefined) {
      const policies = (this.deps?.listAgents() ?? []).map((id) => this.getAgentSettings(id))
      const intervals: number[] = []
      if (policies.some((policy) => policy.mode === 'companion')) intervals.push(this.settings.companionIntervalMinutes)
      if (policies.some((policy) => policy.mode === 'autonomous' || policy.strongholdActivity)) intervals.push(this.settings.autonomousIntervalMinutes)
      return Math.min(...(intervals.length ? intervals : [this.settings.autonomousIntervalMinutes])) * 60_000
    }
    return (
      (mode === 'companion'
        ? this.settings.companionIntervalMinutes
        : this.settings.autonomousIntervalMinutes) * 60_000
    )
  }

  private sceneForAgent(agentId: string): 'desktop' | 'stronghold' | undefined {
    const policy = this.getAgentSettings(agentId)
    const desktop = policy.mode !== 'off' && this.perceptionPermit.allows(policy.mode) &&
      this.budget.counts().budgetUsed < this.settings.maxDailyRuns
    if (policy.strongholdActivity && this.deps?.runStronghold &&
      (!desktop || this.agents.get(agentId)?.scene !== 'stronghold')) return 'stronghold'
    return desktop ? 'desktop' : undefined
  }

  /** 等待取消回传期间，全局模式可能已被另一项设置操作关闭。 */
  private isEnabled(): boolean {
    return this.settings.mode !== 'off' || Boolean(this.settings.strongholdActivity) ||
      Object.values(this.settings.agents ?? {}).some((item) =>
        (item.mode !== undefined && item.mode !== 'off') || item.strongholdActivity === true)
  }

  private validate(input: ProactiveSettings): ProactiveSettings {
    if (
      !['off', 'companion', 'autonomous'].includes(input.mode) ||
      ![input.companionIntervalMinutes, input.autonomousIntervalMinutes].every(
        (value) => Number.isFinite(value) && value >= 1 && value <= 1440,
      ) ||
      !Number.isInteger(input.maxDailyRuns) ||
      input.maxDailyRuns < 1 ||
      input.maxDailyRuns > 1440 ||
      typeof input.goal !== 'string' ||
      input.goal.length > 8000
    )
      throw new AppError('INVALID_PARAMETER', {
        message: '主动行为配置无效，请检查模式、间隔和每日预算',
      })
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timeZone })
    } catch {
      throw new AppError('INVALID_PARAMETER', { message: '主动行为时区无效' })
    }
    if (input.strongholdActivity !== undefined && typeof input.strongholdActivity !== 'boolean')
      throw new AppError('INVALID_PARAMETER', { message: '主动行为配置无效，请检查模式、间隔和每日预算' })
    const agents: Record<string, AgentProactiveSettings> = {}
    if (input.agents !== undefined && (!input.agents || typeof input.agents !== 'object' || Array.isArray(input.agents)))
      throw new AppError('INVALID_PARAMETER', { message: '主动行为配置无效，请检查模式、间隔和每日预算' })
    for (const [agentId, item] of Object.entries(input.agents ?? {})) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
        (item.mode !== undefined && !['off', 'companion', 'autonomous'].includes(item.mode)) ||
        (item.strongholdActivity !== undefined && typeof item.strongholdActivity !== 'boolean'))
        throw new AppError('INVALID_PARAMETER', { message: '主动行为配置无效，请检查模式、间隔和每日预算' })
      agents[agentId] = {
        ...(item.mode !== undefined ? { mode: item.mode } : {}),
        ...(item.strongholdActivity !== undefined ? { strongholdActivity: item.strongholdActivity } : {}),
      }
    }
    // 仅保留正式设置，避免旧配置中的会话和 URL 字段随展开运算符重新保存。
    return {
      mode: input.mode,
      strongholdActivity: input.strongholdActivity ?? false,
      agents,
      companionIntervalMinutes: input.companionIntervalMinutes,
      autonomousIntervalMinutes: input.autonomousIntervalMinutes,
      goal: input.goal.trim(),
      maxDailyRuns: input.maxDailyRuns,
      timeZone: input.timeZone,
    }
  }

  private async cancelCurrent(reason: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.controller?.abort(new Error(reason))
    await this.inFlight?.catch(() => {})
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.stopped || this.perceptionPermit.stopped || this.schedulingHolds || !this.isEnabled() || this.inFlight)
      return
    const delay = Math.min(
      2_147_483_647,
      Math.max(100, (this.state.nextRunAt ?? Date.now() + this.interval()) - Date.now()),
    )
    this.timer = setTimeout(() => {
      const controller = new AbortController()
      this.controller = controller
      this.inFlight = this.tick(controller.signal)
        .catch(async (error) => {
          this.state.agentId = null
          this.state.phase = controller.signal.aborted ? 'waiting' : 'error'
          this.state.lastError = controller.signal.aborted
            ? null
            : error instanceof Error
              ? error.message
              : String(error)
          this.state.lastOutcome = controller.signal.aborted
            ? '主动回合已取消'
            : '调度发生异常，稍后重试'
          this.state.nextRunAt = Date.now() + this.interval()
          if (!controller.signal.aborted)
            logger.error(__t('logs.companion', '主动行为调度失败'), { error })
          await this.persist().catch(() => {})
        })
        .finally(() => {
          this.inFlight = undefined
          this.controller = undefined
          this.runningScene = undefined
          this.schedule()
        })
    }, delay)
    this.timer.unref?.()
  }

  private async tick(signal: AbortSignal): Promise<void> {
    if (!this.deps || this.perceptionPermit.stopped || !this.isEnabled()) return
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.settings.timeZone }).format(
      new Date(),
    )
    if (this.day !== day) {
      this.day = day
      this.state.dailyRuns = 0
    }
    const ids = [...new Set(this.deps.listAgents())].sort()
    await this.changeActivity(() => this.recoverActivities())
    for (const id of this.agents.keys()) if (!ids.includes(id)) this.agents.delete(id)
    const offset = ids.indexOf(this.cursor) + 1
    const ordered = [...ids.slice(offset), ...ids.slice(0, offset)]
    const agentId = ordered.find((id) => {
      return this.sceneForAgent(id) !== undefined &&
        !this.agents.get(id)?.waiting &&
        (this.agents.get(id)?.nextEligibleAt ?? 0) <= Date.now() &&
        !this.deps!.isBusy(id) &&
        !this.watchAlong.running && !this.wakeController && this.budget.canDeliver()
    })
    if (!agentId) {
      this.state.phase = 'waiting'
      this.state.lastError = null
      this.state.lastOutcome = ids.length
        ? '角色正在忙碌或冷却，稍后唤醒'
        : '当前没有已启用角色，等待角色启用'
      this.state.nextRunAt = Date.now() + Math.min(60_000, this.interval())
      await this.persist()
      return
    }
    this.cursor = agentId
    this.state.agentId = agentId
    const policy = this.getAgentSettings(agentId)
    const mode = policy.mode === 'off' ? 'companion' : policy.mode
    const agent: AgentSchedule = this.agents.get(agentId) ?? { consecutiveMessages: 0, nextEligibleAt: 0 }
    this.agents.set(agentId, agent)
    const reservation = randomUUID()
    let reserved = false
    let spoke = false
    let outcome = '',
      error: string | undefined
    try {
      // 会话仅在本次执行时自动解析，删除或新建会话不会关闭全局模式。
      const thread = await this.deps.resolveThread(agentId)
      signal.throwIfAborted()
      if (
        thread.agentId !== agentId ||
        thread.channel !== 'desktop' ||
        thread.purpose !== 'conversation' ||
        (thread.status && thread.status !== 'active')
      )
        throw new Error('自动取得的执行会话无效，本轮稍后重试')
      if (!this.deps.listAgents().includes(agentId) || this.deps.isBusy(agentId)) {
        outcome = '角色状态已改变，本轮暂缓执行'
        return
      }
      const sceneKind = this.sceneForAgent(agentId)
      if (!sceneKind) return
      if (sceneKind === 'desktop') {
        reserved = await this.budget.reserve(reservation, mode)
        if (!reserved) { outcome = '本轮主动准入未通过'; return }
      }
      this.state.phase = 'running'
      this.state.dailyRuns = this.budget.counts().budgetUsed
      this.state.lastRunAt = Date.now()
      await this.persist()
      signal.throwIfAborted()
      const content =
        mode === 'companion'
          ? '依据真实记忆与近期互动决定是否值得说一句，可以安静结束。本轮只能说话，不使用工具。'
          : `【自主行动唤醒】结合真实记忆、用户授权事项、已有任务与当前心流，判断现在值得推进什么。优先延续获准工作，通过现有工具取得资料与回执。没有值得行动或表达的内容可以安静结束。需要等待具体回答或已有任务结果时，在 finish_task.next_activity 中登记等待，由真实事件接续。${this.settings.goal ? `\n用户的行动偏好：${this.settings.goal}` : ''}`
      const useStronghold = sceneKind === 'stronghold'
      this.runningScene = useStronghold ? 'stronghold' : 'desktop'
      const sceneReply = useStronghold && this.deps.runStronghold
        ? await this.deps.runStronghold(agentId, signal)
        : null
      agent.scene = sceneKind
      const reply = useStronghold ? sceneReply : await this.deps.run(
        mode === 'companion'
          ? { mode, thread, content, signal, instruction: content, snapshot: perceptionSnapshots.take() ?? { source: 'perception', generation: 0, capturedAt: Date.now(), text: '' } }
          : { mode, thread, content, signal },
      )
      signal.throwIfAborted()
      if (reply?.trim()) {
        spoke = true
        agent.quietRuns = 0
        if (!useStronghold) agent.consecutiveMessages++
        outcome =
          mode === 'companion' ? '主动陪伴消息已保存并推送' : '自主行动本轮已完成，结果已保存'
      } else {
        agent.quietRuns = Math.min(6, (agent.quietRuns ?? 0) + 1)
        outcome = '本轮没有需要通知的新内容，已安静结束'
      }
    } catch (failure) {
      if (signal.aborted) outcome = '主动回合已取消，未重放已执行操作'
      else {
        error = failure instanceof Error ? failure.message : String(failure)
        outcome = '本轮执行失败，其他角色仍可继续调度'
      }
    } finally {
      if (reserved) await this.budget.settle(reservation, spoke)
      this.state.agentId = null
      this.state.phase = error ? 'error' : 'waiting'
      this.state.lastError = error ?? null
      this.state.lastOutcome = outcome
      this.state.recent.push({
        at: Date.now(),
        mode,
        agentId,
        outcome,
        ...(error ? { error } : {}),
      })
      this.state.recent = this.state.recent.slice(-20)
      const backoff = Math.min(16, 2 ** Math.floor(agent.consecutiveMessages / 3))
      const hour = Number(
        new Intl.DateTimeFormat('en', {
          timeZone: this.settings.timeZone,
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(new Date()),
      )
      const intervalMode = this.runningScene === 'stronghold' ? 'autonomous' : mode
      const night = intervalMode === 'companion' && (hour < 7 || hour >= 23) ? 3 : 1
      agent.nextEligibleAt =
        Date.now() + this.interval(intervalMode) * Math.max(2 ** (agent.quietRuns ?? 0), intervalMode === 'companion' ? backoff * night : 1)
      this.state.nextRunAt = Date.now() + this.interval()
      logger.info(__t('logs.companion', '全局主动行为本轮结束'), {
        mode,
        agentId,
        outcome,
        dailyRuns: this.state.dailyRuns,
        error,
      })
      await this.persist()
    }
  }

  private persist(): Promise<void> {
    const data = JSON.stringify({
      version: 2,
      ...this.state,
      day: this.day,
      cursor: this.cursor,
      agents: Object.fromEntries(this.agents),
    })
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        await this.config.set(STATE_KEY, data)
        await this.deps
          ?.changed(this.getState())
          .catch((error) => logger.warn(__t('logs.companion', '主动状态推送失败'), { error }))
      })
    this.writes = write
    return write
  }
}
