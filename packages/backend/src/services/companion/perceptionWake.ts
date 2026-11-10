import type { PerceptionSnapshot } from '@infos/shared'
import type { ProactiveBudget, ProactiveLevel } from './proactiveBudget'
import { perceptionSnapshots } from '../perception/perceptionSnapshotStore'

const WAKE_REASONS: Record<string, string> = {
  returned: '用户离开一阵后回来了',
  'new-app': '用户切到了新程序并待了一会儿',
  'task-completed': 'infOS 里的长任务完成了',
  'long-window': '用户在同一个窗口待了很久',
}

/** 桌面客户端发来的感知叫醒。 */
export interface PerceptionWakeInput {
  id: string
  kind: string
  expiresAt: number
  level: ProactiveLevel
}

type WakeTarget = {
  id: string
  agentId: string
  channel: string
  purpose?: string
  status?: string
  title?: string | null
}

interface WakeDeps {
  resolveThread(agentId: string): Promise<WakeTarget>
  isBusy(agentId: string): boolean
  run(input: {
    mode: 'companion'
    thread: WakeTarget
    content: string
    snapshot: PerceptionSnapshot
    instruction: string
    signal: AbortSignal
  }): Promise<string | null>
}

/** 叫醒回合需要的调度器状态；由 ProactiveService 提供，按原顺序读取。 */
export interface PerceptionWakeHost {
  deps(): WakeDeps | undefined
  /** 服务已停止、正在主动回合、已有叫醒或陪看插话进行中。 */
  busy(): boolean
  permit: { readonly allowed: boolean }
  budget: ProactiveBudget
  currentAgent(): string | undefined
  /** 登记本次叫醒的中止器（用户活动、许可撤销时会被中止）。 */
  claim(controller: AbortController): void
  release(controller: AbortController): void
}

/** 感知叫醒：抓取当前快照，让当前角色判断要不要说一句。 */
export async function runPerceptionWake(host: PerceptionWakeHost, input: PerceptionWakeInput, signal?: AbortSignal): Promise<{state: string; replied: boolean}> {
  if (!host.deps() || host.busy() || !host.permit.allowed || input.expiresAt < Date.now() || input.expiresAt > Date.now() + 60_000)
    return {state: 'busy', replied: false}
  const snapshot = perceptionSnapshots.take()
  if (!snapshot) return {state: 'cancelled', replied: false}
  const agentId = host.currentAgent()
  if (!agentId || host.deps()!.isBusy(agentId)) return {state: 'busy', replied: false}
  const controller = new AbortController()
  host.claim(controller)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, {once: true})
  if (signal?.aborted) abort()
  let reserved = false, spoke = false
  try {
    const thread = await host.deps()!.resolveThread(agentId)
    if (controller.signal.aborted || input.expiresAt < Date.now() || !host.permit.allowed || thread.channel !== 'desktop' || thread.status !== 'active') return {state: 'cancelled', replied: false}
    reserved = await host.budget.reserve(input.id, 'wake', input.level)
    if (!reserved) return {state: 'busy', replied: false}
    controller.signal.throwIfAborted()
    const reply = await host.deps()!.run({mode: 'companion', thread, content: snapshot.text, snapshot, instruction: `刚发生的事：${WAKE_REASONS[input.kind] ?? input.kind}。请判断要不要说一句。`, signal: controller.signal})
    controller.signal.throwIfAborted()
    spoke = !!reply?.trim()
    return {state: 'completed', replied: spoke}
  } catch { return {state: 'cancelled', replied: false} }
  finally {
    signal?.removeEventListener('abort', abort)
    if (reserved) await host.budget.settle(input.id, spoke)
    host.release(controller)
  }
}
