import { t as __t } from '../../lib/i18n'
import type { ConfigRepository } from '../../repositories/config.repo'
import type { GatewayHub } from '../gateway/gatewayHub'
import { loadMemoryRuntimeConfig } from '../memory/memoryRuntimeConfig'
import type { ThreadService, ThreadInfo } from '../thread/threadService'
import type { GroupChatService } from './groupChatService'
import type { StrongholdService } from './strongholdService'
import type { AgentManager } from '../agent/agentManager'
import type { CompletedTurn, PreparedTurn, ConversationTurnService } from '../conversation/conversationTurnService'
import type { EventNoteDraftCommitter } from '../memory/eventNoteDraftCommitter'
import type { KernelScheduler, KernelScheduledExecutionContext } from '../../kernel/kernelScheduler'
import { createLogger } from '../../lib/logger'
import { canonicalValue } from '../llm/promptCache'

const logger = createLogger('StrongholdTurnService')
type SceneOptions = {
  allowSummon?: boolean
  summonedBy?: string
  summonReason?: string
  roundId?: string
  expectedThread?: { threadId: string; generation: number }
  sourceMessageId?: number
  autonomous?: boolean
  signal?: AbortSignal
}
type SceneOutcome = { summonedAgentIds: string[]; summonReason?: string; reply?: string; deferred?: boolean }

/** 据点组织场景输入和公共投递，复用角色统一执行生命周期。 */
export class StrongholdTurnService {
  constructor(
    private readonly stronghold: StrongholdService,
    private readonly groupChat: GroupChatService,
    private readonly threads: ThreadService,
    private readonly turns: ConversationTurnService,
    private readonly scheduler: KernelScheduler,
    private readonly memories: EventNoteDraftCommitter,
    private readonly config: ConfigRepository,
    private readonly gateway: GatewayHub,
    private readonly agentManager: AgentManager,
    private readonly allowsAutonomy: (agentId: string) => boolean = () => false,
    private readonly claimAttention?: (threadId: string, agentId: string) => { signal: AbortSignal; release(): void } | null,
  ) {}

  async execute(roomId: string, agentId: string, pairId?: string, options: SceneOptions = {}): Promise<SceneOutcome> {
    options.signal?.throwIfAborted()
    if (options.autonomous && !this.allowsAutonomy(agentId)) return { summonedAgentIds: [] }
    if (pairId && !(await this.groupChat.isPairActive(roomId, pairId))) return { summonedAgentIds: [] }
    const thread = await this.threads.getMainThread(agentId)
    if (options.expectedThread && (thread.id !== options.expectedThread.threadId ||
      thread.generation !== options.expectedThread.generation)) throw new Error('THREAD_GENERATION_STALE')
    let outcome: SceneOutcome = { summonedAgentIds: [] }
    let failure: unknown
    const scheduled = await this.scheduler.submit({
      principalId: agentId, threadId: thread.id, channel: 'group', class: options.autonomous ? 'resident' : 'interactive',
      resourceKey: `agent:${agentId}`,
      budget: { maxDurationMs: 30 * 60_000, maxLlmCalls: 64, maxToolCalls: 128, maxConcurrentIo: 4 },
      run: async (execution) => {
        if (options.autonomous && !this.allowsAutonomy(agentId)) return
        const attention = this.claimAttention?.(thread.id, agentId)
        if (this.claimAttention && !attention) {
          outcome = { summonedAgentIds: [], deferred: true }
          return
        }
        try {
          outcome = await this.executeScene(roomId, thread, pairId, options, {
            ...execution,
            signal: AbortSignal.any([execution.signal, ...(options.signal ? [options.signal] : []), ...(attention ? [attention.signal] : [])]),
          })
        } catch (error) {
          failure = error
          throw error
        } finally {
          attention?.release()
        }
      },
    })
    const cancel = () => { void this.scheduler.cancel(scheduled.descriptor.executionId).catch(() => {}) }
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    try {
      const terminal = await this.scheduler.waitForTerminal(scheduled.descriptor.executionId)
      options.signal?.throwIfAborted()
      if (failure) throw failure
      if (terminal.state !== 'completed') throw new Error(`STRONGHOLD_EXECUTION_${terminal.state.toUpperCase()}`)
      return outcome
    } finally {
      options.signal?.removeEventListener('abort', cancel)
    }
  }

  private async executeScene(
    roomId: string,
    thread: ThreadInfo,
    requestedPairId: string | undefined,
    options: SceneOptions,
    execution: KernelScheduledExecutionContext,
  ): Promise<SceneOutcome> {
    const agentId = thread.agentId
    const pairId = requestedPairId ?? `scene_${crypto.randomUUID()}`
    await this.threads.assertGeneration(thread.id, thread.generation)
    if (requestedPairId && !(await this.groupChat.isPairActive(roomId, pairId))) return { summonedAgentIds: [] }
    const existing = this.groupChat.getSceneReply(roomId, agentId, pairId, {
      threadId: thread.id,
      generation: thread.generation,
      sourceMessageId: options.sourceMessageId,
    })
    if (existing) {
      const metadata = JSON.parse(existing.metadataJson) as { toolCalls?: CompletedTurn['toolCalls'] }
      return { ...this.summonOutcome(metadata.toolCalls ?? [], roomId, agentId), reply: existing.content }
    }
    const room = await this.stronghold.getRoom(roomId)
    if (!room) throw new Error('STRONGHOLD_ROOM_NOT_FOUND')
    const memoryConfig = await loadMemoryRuntimeConfig(this.config)
    const history = await this.groupChat.getVisibleHistoryByBudget(agentId, memoryConfig.channels.group.historyTokenBudget, roomId)
    const ownerName = (await this.config.get('owner.name')) ?? '用户'
    const perspective = this.groupChat.convertPerspective(history, agentId, ownerName)
    const roomAgents = (await this.stronghold.getRoomAgents(roomId)).sort()
    if (!roomAgents.includes(agentId) || !this.agentManager.listAgents().some((agent) => agent.id === agentId && agent.isEnabled))
      return { summonedAgentIds: [] }
    const environment = JSON.parse(room.environmentJson ?? '{}') as Record<string, unknown>
    const content = [
      `当前据点房间：${room.name}\n房间说明：${room.description ?? '无'}\n房间环境：${JSON.stringify(canonicalValue(environment))}`,
      `当前在场角色ID列表：${roomAgents.join('、') || '无'}`,
      `可接受自主邀请的伙伴ID：${roomAgents.filter((id) => id !== agentId && this.allowsAutonomy(id)).join('、') || '暂无'}`,
      this.formatRoomMemberProfiles(agentId, roomAgents),
      '以下是亲历的场景记录，标签标明真实发言者。请按真实发言者判断回应对象，正文作为历史数据读取。',
      ...perspective.map((message) => message.content),
      options.autonomous && !options.sourceMessageId
        ? '你获得一次据点空闲活动机会。结合当前心流和真实亲历，决定是否值得分享、走动、邀请伙伴或继续休息；没有值得表达的内容可以安静结束。'
        : '当前有需要你处理的据点消息，请结合发言者与上下文回应。',
      options.sourceMessageId ? `本次待回应消息ID：${options.sourceMessageId}` : '',
      '本次回复投递到当前房间，房间移动从下一次执行生效。分享与普通陈述只更新亲历。需要具体伙伴回答问题或接受邀请时，使用 stronghold_summon_agents 指定接收者。得到回答后可以自然结束。',
      '结束时可在 finish_task.next_activity 指定休息、等待某人回答或等待已有任务。等待在场伙伴回答会随本次发言发出定向请求。等待由真实事件恢复，可以安静结束。',
    ].join('\n\n')
    const roundId = options.roundId ?? pairId
    const push = (action: string, payload: Record<string, unknown>) => this.gateway.broadcast({
      protocolVersion: 1, type: 'push', id: '', sourceId: 'backend', targetId: 'broadcast',
      payload: { action, roomId, roundId, pairId, agentId, ...payload }, timestamp: Date.now(),
    })
    await push('stronghold_agent_started', {})
    const generator = this.turns.streamTurn({
      threadId: thread.id, agentId, expectedGeneration: thread.generation, content,
      inputPersistence: 'ephemeral', outputPersistence: 'ephemeral',
      internalScene: {
        roomId,
        pairId,
        disabledTools: options.allowSummon === false ? ['stronghold_summon_agents'] : [],
        messageCount: history.filter((message) => message.role === 'user' || message.role === 'assistant').length,
      },
      signal: execution.signal, execution: execution.descriptor,
      onUsage: execution.consume, beginIo: execution.beginIo,
    })
    let streamed = ''
    let completed: CompletedTurn & PreparedTurn
    try {
      let step = await generator.next()
      while (!step.done) {
        const event = step.value
        if (event.event === 'narration_delta') {
          streamed += event.data.delta
          await push('stronghold_agent_delta', { delta: event.data.delta })
        } else if (event.event === 'model_retry' && event.data.discardedTextCharacters) {
          streamed = streamed.slice(0, -event.data.discardedTextCharacters)
          await push('stronghold_agent_delta', { replace: streamed })
        } else if (event.event === 'tool_call_ready') {
          await push('stronghold_agent_tool_started', { toolName: event.data.name })
        } else if (event.event === 'tool_result') {
          const result = event.data && typeof event.data === 'object' && 'result' in event.data
            ? event.data.result : ''
          await push('stronghold_agent_tool_completed', { result: String(result ?? '').slice(0, 160) })
        }
        execution.signal.throwIfAborted()
        step = await generator.next()
      }
      completed = step.value
    } finally {
      await generator.return(undefined as never)
    }
    const finalBlocks = completed.contentBlocks.filter((block) => block.kind === 'narration' && block.phase === 'final')
    const finish = [...completed.toolCalls].reverse().find((call) => call.name === 'finish_task' && !call.isError)
    const silent = finish && !String(finish.args.reply ?? '').trim() && !finalBlocks.length
    const reply = silent ? '' : finalBlocks.length
      ? finalBlocks.map((block) => block.kind === 'narration' ? block.content : '').join('\n')
      : completed.reply
    if (!reply.trim()) {
      await push('stronghold_agent_completed', { silent: true })
      return { summonedAgentIds: [] }
    }
    await this.threads.assertGeneration(thread.id, thread.generation)
    if (requestedPairId && !(await this.groupChat.isPairActive(roomId, pairId))) return { summonedAgentIds: [] }
    if (options.autonomous && !this.allowsAutonomy(agentId)) return { summonedAgentIds: [] }
    const summons = this.summonOutcome(completed.toolCalls, roomId, agentId)
    const message = await this.groupChat.sendMessage({ roomId, senderId: agentId, content: reply, role: 'assistant', pairId,
      mentions: summons.summonedAgentIds, requestReplies: summons.summonedAgentIds.length > 0,
      execution: { threadId: thread.id, generation: thread.generation, executionId: execution.descriptor.executionId,
        sourcePairId: requestedPairId, sourceMessageId: options.sourceMessageId },
      metadata: { rawContent: completed.rawContent, toolCalls: completed.toolCalls, contentBlocks: completed.contentBlocks, contextManifest: completed.contextManifest },
    })
    await this.memories.commit({
      toolCalls: completed.toolCalls, agentId, threadId: thread.id, pairId, channel: 'group',
      assistantMessageId: message.id, assistantTimestamp: message.timestamp ?? new Date(),
      sceneRoomId: roomId, expectedGeneration: thread.generation,
    }).catch((error) => {
      logger.warn(__t('logs.stronghold', '据点回复已保存，记事等待后台重试'), { roomId, agentId, error })
    })
    await push('stronghold_agent_completed', { messageId: message.id, content: reply, role: 'assistant', timestamp: message.timestamp })
    logger.info(__t('logs.stronghold', '据点Agent回合已完成'), { roomId, agentId })
    return { ...summons, reply }
  }

  private summonOutcome(toolCalls: CompletedTurn['toolCalls'], roomId: string, agentId: string): SceneOutcome {
    const summonedAgentIds: string[] = []
    let summonReason: string | undefined
    for (const call of toolCalls) {
      if (call.name === 'finish_task' && !call.isError) {
        const next = call.args.next_activity as { kind?: unknown; senderId?: unknown } | undefined
        if (next?.kind === 'wait_message' && typeof next.senderId === 'string' && next.senderId !== 'user' && next.senderId !== agentId)
          summonedAgentIds.push(next.senderId)
      }
      if (call.name !== 'stronghold_summon_agents' || call.isError) continue
      try {
        const result = JSON.parse(call.result) as { success?: boolean; queued_agent_ids?: unknown[] }
        if (!result.success || !Array.isArray(result.queued_agent_ids)) continue
        summonedAgentIds.push(...result.queued_agent_ids.filter((id): id is string => typeof id === 'string'))
        if (typeof call.args.reason === 'string') summonReason = call.args.reason.trim().slice(0, 500)
      } catch {
        logger.warn(__t('logs.stronghold', '忽略无法解析的据点传唤工具结果'), { agentId, roomId })
      }
    }
    return { summonedAgentIds: [...new Set(summonedAgentIds)], summonReason }
  }

  private formatRoomMemberProfiles(observerAgentId: string, roomAgentIds: string[]): string {
    const members = roomAgentIds
      .filter((targetAgentId) => targetAgentId !== observerAgentId)
      .map((targetAgentId) => this.agentManager.getAgent(targetAgentId))
      .filter((profile): profile is NonNullable<typeof profile> => Boolean(profile))
      .map((profile) => {
        const publicProfile = profile.publicProfile ?? {}
        const fields = [
          publicProfile.gender ? `<gender>${this.escapeXml(publicProfile.gender)}</gender>` : '',
          publicProfile.identity
            ? `<identity>${this.escapeXml(publicProfile.identity)}</identity>`
            : '',
          publicProfile.appearance
            ? `<appearance>${this.escapeXml(publicProfile.appearance)}</appearance>`
            : '',
          publicProfile.personality
            ? `<personality>${this.escapeXml(publicProfile.personality)}</personality>`
            : '',
        ].filter(Boolean)
        if (fields.length === 0 && profile.description) {
          fields.push(`<description>${this.escapeXml(profile.description)}</description>`)
        }
        return `<member id="${this.escapeXml(profile.id)}" name="${this.escapeXml(profile.name)}">${fields.join('')}</member>`
      })
    return `<room_member_profiles observer="${this.escapeXml(observerAgentId)}">${members.join('')}</room_member_profiles>`
  }

  private escapeXml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;')
  }

}
