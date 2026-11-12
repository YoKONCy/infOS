import { t as __t } from '../../lib/i18n'
/**
 * finish_task — 任务完成 + 角色状态更新工具
 *
 * 始终允许调用的生命周期工具 (CapabilityGate 白名单豁免)。
 * Agent 通过此工具主动结束当前任务/对话回合，
 * 并可选地更新角色的情绪/动作/文案状态。
 *
 * - finish_task + update_character_status 合并
 * - 表达、持续状态与动态台词写入角色共享事件流，Thread 标注变更来源
 * - 每次写入关联当前消息轮次，删除或撤回时重放剩余有效状态
 * - Gateway 广播 state_update → 前端看板娘实时同步
 *
 * @module packages/backend/src/tools/finishTask
 */

import type { BuiltinTool } from '../index'
import { normalizeCharacterState, parseStrongholdParticipation, type NextAgentActivity } from '@infos/shared'
import type { ToolContext } from '../../services/agent/toolRegistry'
import { toolFailure, toolSuccess } from '../../services/execution/toolResult'
import { createLogger } from '../../lib/logger'
import type { PetStateData, PetStateScope } from '../../services/agent/petStateService'
import { AppError } from '../../lib/appError'

const logger = createLogger('FinishTask')

// ─────────────────────────────────────────────
// 运行时注入的依赖 (由 container.ts 设置)
// ─────────────────────────────────────────────

interface PetStateUpdater {
  get?(agentId: string, threadId?: string): Promise<Partial<PetStateData> | null>
  update(agentId: string, data: PetStateUpdateData, scope?: PetStateScope): Promise<string | null>
}

interface PetStateUpdateData {
  mood?: string
  vibe?: string
  mind?: string
  ongoingGoals?: string
  commitments?: string
  relationships?: string
  clickMessages?: Record<string, string[]>
  idleMessages?: string[]
  backMessages?: string[]
}

/** 模块引用 */
let _petStateUpdater: PetStateUpdater | null = null
let _gatewayBroadcast:
  | ((action: string, payload: Record<string, unknown>) => Promise<void>)
  | null = null
let _nextActivity: ((activity: NextAgentActivity, context: ToolContext, publishingReply: boolean) => Promise<void>) | undefined

/** 设置 finishTask 依赖 */
export function setFinishTaskDeps(deps: {
  petStateUpdater: PetStateUpdater
  gatewayBroadcast?: (action: string, payload: Record<string, unknown>) => Promise<void>
  nextActivity?: (activity: NextAgentActivity, context: ToolContext, publishingReply: boolean) => Promise<void>
}) {
  _petStateUpdater = deps.petStateUpdater
  _gatewayBroadcast = deps.gatewayBroadcast ?? null
  _nextActivity = deps.nextActivity
}

// ─────────────────────────────────────────────
// 辅助：解析消息列表参数
// ─────────────────────────────────────────────

const STANDARD_TOUCH_PARTS = new Set(['head', 'arm', 'body', 'leg'])

/** 将 string | string[] 输入统一转为 string[] */
function parseMessages(input: unknown): string[] | undefined {
  if (!input) return undefined
  if (Array.isArray(input)) return input.map(String)
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      // 逗号分隔回退
      return input
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    return [input]
  }
  return undefined
}

// ─────────────────────────────────────────────
// 工具定义 + 执行
// ─────────────────────────────────────────────

export async function applyCharacterStateUpdate(
  args: Record<string, unknown>,
  agentId: string,
  scope?: PetStateScope,
): Promise<{ updated: boolean; textExpiresAt?: string | null }> {
  const stateUpdate = normalizeCharacterState({
    mood: args.mood as string | undefined,
    vibe: args.vibe as string | undefined,
    mind: args.mind as string | undefined,
    ongoingGoals: args.ongoing_goals as string | undefined,
    commitments: args.commitments as string | undefined,
    relationships: args.relationships as string | undefined,
  })
  const clickMessages: Record<string, string[]> = {}
  const touchReactions = args.touch_reactions
  if (touchReactions && typeof touchReactions === 'object' && !Array.isArray(touchReactions)) {
    for (const [part, lines] of Object.entries(touchReactions as Record<string, unknown>)) {
      if (!STANDARD_TOUCH_PARTS.has(part)) continue
      const parsed = parseMessages(lines)
      if (parsed?.length) clickMessages[part] = parsed
    }
  }
  for (const [field, part] of [
    ['click_head_msgs', 'head'],
    ['click_arm_msgs', 'arm'],
    ['click_body_msgs', 'body'],
    ['click_leg_msgs', 'leg'],
  ] as const) {
    const parsed = parseMessages(args[field])
    if (parsed?.length)
      clickMessages[part] = [...new Set([...(clickMessages[part] ?? []), ...parsed])]
  }
  const idleMsgs = parseMessages(args.idle_msgs)
  const backMsgs = parseMessages(args.back_msgs)
  if (
    !Object.keys(stateUpdate).length &&
    !Object.keys(clickMessages).length &&
    !idleMsgs &&
    !backMsgs
  ) {
    return { updated: false }
  }
  if (!_petStateUpdater) throw new Error('角色状态服务未初始化')
  // 显式重复设置也保留来源，撤回前一轮时不能误删后一轮仍有效的同值状态。
  const { mood, vibe, mind } = stateUpdate
  const hasStateUpdate = Boolean(
    Object.keys(stateUpdate).length || Object.keys(clickMessages).length || idleMsgs || backMsgs,
  )
  if (!hasStateUpdate) return { updated: false }
  const textExpiresAt = await _petStateUpdater.update(
    agentId,
    {
      ...stateUpdate,
      clickMessages: Object.keys(clickMessages).length ? clickMessages : undefined,
      idleMessages: idleMsgs,
      backMessages: backMsgs,
    },
    scope,
  ).catch(async (error: unknown) => {
    if (error instanceof AppError && error.code === 'CONFLICT' && scope?.characterStateVersion) {
      const current = await _petStateUpdater?.get?.(agentId, scope.threadId)
      throw new AppError('CONFLICT', { message: error.message, data: { currentState: current } })
    }
    throw error
  })
  const payload: Record<string, unknown> = { agentId, threadId: scope?.threadId, scope: 'agent' }
  if (mood) payload.mood = mood
  if (vibe) payload.vibe = vibe
  if (mind) payload.mind = mind
  if (Object.keys(clickMessages).length) payload.click_messages = clickMessages
  if (idleMsgs) payload.idle_messages = idleMsgs
  if (backMsgs) payload.back_messages = backMsgs
  if (textExpiresAt) payload.text_expires_at = textExpiresAt
  const saved = await _petStateUpdater.get?.(agentId, scope?.threadId)
  if (saved?.threadId)
    Object.assign(payload, {
      threadId: saved.threadId,
      revision: saved.revision,
      replace: true,
      mood: saved.mood,
      vibe: saved.vibe,
      mind: saved.mind,
      click_messages: JSON.parse(saved.clickMessagesJson ?? '{}'),
      idle_messages: JSON.parse(saved.idleMessagesJson ?? '[]'),
      back_messages: JSON.parse(saved.backMessagesJson ?? '[]'),
      text_expires_at: saved.textExpiresAt ?? null,
    })
  if (_gatewayBroadcast) await _gatewayBroadcast('state_update', payload)
  logger.info(__t('logs.tools', '角色状态已更新: agent={0}', [agentId]))
  return { updated: true, textExpiresAt }
}

export const finishTaskTool: BuiltinTool = {
  name: 'finish_task',

  async execute(args, ctx) {
    if (args.participation !== undefined) {
      try {
        if (ctx.channel !== 'group' || !ctx.sceneRoomId) throw new Error('STRONGHOLD_PARTICIPATION_INVALID')
        parseStrongholdParticipation(args.participation)
      } catch {
        return toolFailure('STRONGHOLD_PARTICIPATION_INVALID', __t('server.tools', '请在据点提供有效的参与状态和发言目的。'))
      }
    }
    // 主线可以先独立发表消息，再结算执行；侧线和任务继续校验交付正文。
    const reply = typeof args.reply === 'string' ? args.reply.trim() : ''
    if (!reply && !ctx.conversation && ctx.channel !== 'group') {
      logger.warn(__t('logs.tools', 'finish_task 缺少必填参数 reply (agent={0})', [ctx.agentId]))
      return toolFailure(
        'FINISH_TASK_NO_REPLY',
        'finish_task 必须携带 reply 参数：即完成任务后要交给用户的最终回复正文。' +
          '请把回复内容完整写入 reply 后重新调用，不要留空。',
      )
    }

    if (args.task_result !== undefined) {
      if (!ctx.taskId) return toolFailure('TASK_CONTEXT_REQUIRED', '任务交接仅用于后台任务')
      const { getTaskToolRuntime } = await import('../taskControl/runtime')
      const { parseTaskSegment } = await import('../../services/task/taskLifecycle')
      await getTaskToolRuntime().submitSegment(
        ctx.taskId,
        ctx.executionId,
        parseTaskSegment(args.task_result),
      )
    }
    if (args.next_activity !== undefined) {
      const activity = args.next_activity as NextAgentActivity
      if (!activity || !['rest', 'wait_message', 'wait_task'].includes(activity.kind) ||
        (activity.kind === 'wait_message' && typeof activity.senderId !== 'string') ||
        (activity.kind === 'wait_task' && typeof activity.taskId !== 'string'))
        return toolFailure('ACTIVITY_INVALID', __t('server.tools', '请提供有效的休息、等待发言者或等待任务设置。'))
      if (!_nextActivity) return toolFailure('ACTIVITY_UNAVAILABLE', __t('server.tools', '主动行为服务尚未初始化'))
      try {
        await _nextActivity(activity, ctx, Boolean(reply))
      } catch (error) {
        const messages: Record<string, string> = {
          ACTIVITY_MAIN_THREAD_REQUIRED: '请在角色主会话或据点设置等待，后台任务使用 task_result。',
          ACTIVITY_SENDER_INVALID: '请选择当前场景中的其他角色或用户。',
          ACTIVITY_SENDER_PAUSED: '这位伙伴已关闭据点自由活动。',
          ACTIVITY_MESSAGE_REQUIRED: '请提供本次发言，作为等待的来源。',
          ACTIVITY_TASK_INVALID: '请选择当前角色的已有任务。',
        }
        if (error instanceof Error && messages[error.message])
          return toolFailure(error.message, __t('server.tools', messages[error.message]!))
        throw error
      }
    }
    const summary = (args.summary as string) ?? reply
    const status = (args.status as string) ?? 'done'

    // 状态更新失败不阻断任务终止，但复用update_state的同一持久化与广播路径。
    try {
      await applyCharacterStateUpdate(args, ctx.agentId, ctx)
    } catch (err) {
      logger.error(
        __t('logs.tools', '角色状态更新失败: {0}', [
          err instanceof Error ? err.stack || err.message : err,
        ]),
      )
    }

    // finish_task 的实际终止效果由 ReAct Loop 层处理 (检测到此工具调用后停止循环)
    // reply 为交付给用户的最终回复，随结果一起返回供日志/调试追踪。
    return toolSuccess(JSON.stringify({ finished: true, status, summary, reply }))
  },
}
