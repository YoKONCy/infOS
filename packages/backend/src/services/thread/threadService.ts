import { t as __t } from '../../lib/i18n'
/**
 * Thread Service — 交互线程业务逻辑
 *
 * Thread 是主 Agent 与用户（或外部平台）的一次交互线程。
 * channel 是 Thread 的持久属性，创建时确定，不可变。
 *
 * 职责：
 * - 创建/查询/列表 Thread
 * - 追加消息（用户消息 + Agent 回复）
 * - 软删除消息 / 删除对话对
 * - 查询活跃消息（供 Context Compiler 使用）
 * - 摘要管理
 *
 * 不负责：
 * - 上下文编译（由 ContextCompiler 负责）
 * - 消息内容生成（由 AgentService + ReAct 负责）
 * - 长期记忆（由 MemoryService 负责）
 *
 * @module packages/backend/src/services/thread/threadService
 */

import type { InteractionMode, KernelExecutionDescriptor } from '@infos/shared'
import { resolveExecutionMode, type ExecutionMode } from '@infos/shared'
import type { ThreadRepository } from '../../repositories/thread.repo'
import { type ThreadChannel, type ThreadPurpose } from '../../repositories/thread.repo'
import type { AttachmentRepository } from '../../repositories/attachment.repo'
import type {
  WorkspaceCheckpointService,
  RewindPreview,
} from '../workspace/workspaceCheckpointService'
import { createLogger } from '../../lib/logger'
import { stableHistoryWindow, invalidatePromptReplay } from '../llm/promptCache'
import { AppError } from '../../lib/appError'
import { disposeExecutionOwner } from '../../tools/productivityRuntimeHolder'
import { publicWorkMetadata, workContextText } from '../context/workContext'
import { tokenCounter } from '../tokenizer/tokenCounter'
import { buildConversationTimeAnchors } from '../context/conversationTime'

const logger = createLogger('ThreadService')

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

/** Thread 信息（返回给前端） */
export interface ThreadInfo {
  id: string
  agentId: string
  channel: ThreadChannel
  platform?: string
  platformIdentifier?: string
  title: string
  messageCount: number
  pairCount: number
  lastMessageAt: string | null
  status: string
  /**
   * ContextPolicy（JSON 序列化的 ChannelPolicy 字符串）
   * null 表示使用 DEFAULT_POLICIES 中该 channel 的默认策略
   */
  contextPolicy: string | null
  /** 当前 Thread 明确禁用的工具名；仅作为 Channel 白名单的减法层。 */
  disabledTools: string[]
  interactionMode: InteractionMode
  /** 是否跳过普通工具的审批请求。 */
  autoExecuteTools: boolean
  executionMode: ExecutionMode
  /** M05: Thread 用途（conversation / background_task / companion） */
  purpose: string
  createdAt: string
  updatedAt: string
}

/** Thread 消息（返回给前端） */
export interface ThreadMessageInfo {
  id: number
  threadId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  rawContent: string | null
  pairId: string | null
  senderId: string | null
  agentId: string | null
  revision: number
  metadataJson: string
  timestamp: string
  status: string
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

export interface ThreadCoverageInvalidator {
  invalidatePairs(threadId: string, pairIds: string[]): Promise<void>
  invalidateThread(threadId: string): Promise<void>
}

export class ThreadService {
  private characterStateLifecycle?: {
    rollbackPairs(threadId: string, pairIds: string[]): Promise<void>
    clearThread(threadId: string): Promise<void>
    clearChannel?(channel: string): Promise<void>
  }
  setCharacterStateLifecycle(
    lifecycle: NonNullable<ThreadService['characterStateLifecycle']>,
  ): void {
    this.characterStateLifecycle = lifecycle
  }
  private clearPromptVariables?: (threadId: string) => Promise<void>
  setPromptVariableCleanup(cleanup: (threadId: string) => Promise<void>): void {
    this.clearPromptVariables = cleanup
  }
  private planLifecycle?: {
    rollbackPairs(threadId: string, pairIds: string[]): Promise<void>
    clearThread(threadId: string): Promise<void>
  }
  setPlanLifecycle(lifecycle: NonNullable<ThreadService['planLifecycle']>): void {
    this.planLifecycle = lifecycle
  }
  constructor(
    private threadRepo: ThreadRepository,
    private attachmentRepo?: AttachmentRepository,
    private checkpointService?: WorkspaceCheckpointService,
    private coverageInvalidator?: ThreadCoverageInvalidator,
  ) {}

  /** 创建新 Thread */
  async createThread(params: {
    agentId: string
    channel: ThreadChannel
    platform?: string
    platformIdentifier?: string
    title?: string
    /** 可选自定义 Thread ID（如语音场景复用 sessionId） */
    id?: string
    /**
     * 可选 ContextPolicy（JSON 序列化的 ChannelPolicy 字符串）
     * 不传则使用 DEFAULT_POLICIES 默认策略
     */
    contextPolicy?: string | null
    /** Thread 用途，默认 conversation；后台任务传 background_task */
    purpose?: ThreadPurpose
    interactionMode?: InteractionMode
  }): Promise<ThreadInfo> {
    const id = params.id ?? `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const row = await this.threadRepo.createThread({
      id,
      agentId: params.agentId,
      channel: params.channel,
      platform: params.platform,
      platformIdentifier: params.platformIdentifier,
      title: params.title,
      contextPolicy: params.contextPolicy ?? null,
      purpose: params.purpose,
      interactionMode: params.interactionMode,
    })
    logger.info(
      __t('logs.thread', 'Thread 已创建: id={0}, agent={1}, channel={2}', [
        id,
        params.agentId,
        params.channel,
      ]),
    )
    return this.toThreadInfo(row)
  }

  /**
   * 更新 Thread 的 ContextPolicy
   *
   * @param threadId       Thread ID
   * @param contextPolicy  JSON 序列化的 ChannelPolicy 字符串；null 表示恢复默认策略
   */
  async updateContextPolicy(threadId: string, contextPolicy: string | null): Promise<boolean> {
    const success = await this.threadRepo.updateContextPolicy(threadId, contextPolicy)
    if (success) {
      logger.info(
        __t('logs.thread', 'Thread ContextPolicy 已更新: thread={0}, {1}', [
          threadId,
          contextPolicy ? '自定义' : '默认',
        ]),
      )
    }
    return success
  }

  /** 持久化 Thread 禁用工具列表；调用方必须先完成 Channel 白名单校验。 */
  async updateDisabledTools(threadId: string, disabledTools: string[]): Promise<void> {
    const unique = [...new Set(disabledTools)].sort()
    const success = await this.threadRepo.updateDisabledTools(threadId, JSON.stringify(unique))
    if (!success) throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
  }

  async updateAutoExecuteTools(threadId: string, autoExecuteTools: boolean): Promise<void> {
    const success = await this.threadRepo.updateAutoExecuteTools(threadId, autoExecuteTools)
    if (!success) throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
  }

  async updateExecutionMode(threadId: string, executionMode: ExecutionMode): Promise<void> {
    if (!(await this.threadRepo.updateExecutionMode(threadId, executionMode))) {
      throw new AppError('NOT_FOUND', { message: '会话不存在或已归档' })
    }
  }

  async updateInteractionMode(threadId: string, mode: InteractionMode): Promise<void> {
    if (!(await this.threadRepo.updateInteractionMode(threadId, mode))) {
      throw new AppError('NOT_FOUND', { message: '会话不存在或已归档' })
    }
  }

  /** 获取或创建 Agent 的最新 Thread */
  async getOrCreateLatest(
    agentId: string,
    channel: ThreadChannel = 'desktop',
    purpose: import('../../repositories/thread.repo').ThreadPurpose = 'conversation',
  ): Promise<ThreadInfo> {
    const row = await this.threadRepo.getOrCreateLatestThread(agentId, channel, purpose)
    return this.toThreadInfo(row)
  }

  /** 获取 Thread 详情 */
  async getThread(threadId: string): Promise<ThreadInfo | null> {
    const row = await this.threadRepo.getThread(threadId)
    return row ? this.toThreadInfo(row) : null
  }

  /** 查询 Thread 列表；agentIds 用于“全部角色”时排除已不存在的孤儿角色数据。 */
  async listThreads(params: {
    agentId?: string
    agentIds?: string[]
    channel?: string
    /** 排除独立应用内部使用的 Channel。 */
    excludeChannels?: string[]
    /** M05: 按用途过滤；不传时返回全部用途 */
    purpose?: import('../../repositories/thread.repo').ThreadPurpose
    page?: number
    pageSize?: number
  }): Promise<{ items: ThreadInfo[]; total: number }> {
    const result = await this.threadRepo.listThreads(params)
    return {
      items: result.items.map((r) => this.toThreadInfo(r)),
      total: result.total,
    }
  }

  /**
   * 追加用户消息
   *
   * 用户消息写入后返回消息信息，供后续 LLM 调用使用。
   * 若 Thread 标题为空（首次对话），自动用消息内容前 20 字作为标题。
   *
   * @param pairId 可选，对话对 ID。传入时会写入消息记录，
   *   使得用户消息与后续 Agent 回复通过相同 pairId 关联，
   *   便于对话对级联删除（softDeletePair）。
   */
  async appendUserMessage(
    threadId: string,
    content: string,
    pairId?: string,
    metadataJson?: string,
    execution?: KernelExecutionDescriptor,
  ): Promise<ThreadMessageInfo> {
    const row = await this.threadRepo.appendMessage({
      threadId,
      role: 'user',
      content,
      pairId,
      metadataJson,
      execution,
    })

    // 用户消息同样计入消息总数，保持与 syncThreadStats 的统计口径一致
    await this.threadRepo.updateMessageCount(threadId, 0)

    // 首次对话自动设置标题：取消息内容前 20 字（去除换行）
    const thread = await this.threadRepo.getThread(threadId)
    if (thread && !thread.title) {
      const titleText = content.replace(/\n/g, ' ').trim()
      const title = titleText.length > 20 ? `${titleText.slice(0, 20)}...` : titleText
      if (title) {
        await this.threadRepo.updateTitle(threadId, title)
      }
    }

    logger.debug(__t('logs.thread', '用户消息已追加: thread={0}, msgId={1}', [threadId, row.id]))
    return this.toMessageInfo(row)
  }

  /**
   * 追加 Agent 回复
   *
   * Agent 回复写入后更新 Thread 的消息计数。
   */
  async appendAssistantMessage(params: {
    threadId: string
    content: string
    rawContent?: string
    pairId: string
    agentId: string
    metadataJson?: string
    scorerStatus?: 'pending' | 'analyzed' | 'failed' | 'skipped'
    status?: 'active' | 'failed' | 'interrupted'
    execution?: KernelExecutionDescriptor
  }): Promise<ThreadMessageInfo> {
    const row = await this.threadRepo.appendMessage({
      threadId: params.threadId,
      role: 'assistant',
      content: params.content,
      rawContent: params.rawContent,
      pairId: params.pairId,
      agentId: params.agentId,
      metadataJson: params.metadataJson,
      scorerStatus: params.scorerStatus,
      status: params.status,
      execution: params.execution,
    })

    // 更新 Thread 计数
    await this.threadRepo.updateMessageCount(params.threadId, 1)

    logger.debug(
      __t('logs.thread', 'Agent 回复已追加: thread={0}, msgId={1}', [params.threadId, row.id]),
    )
    return this.toMessageInfo(row)
  }

  /** 追加系统消息并更新 Thread 消息计数 */
  async appendSystemMessage(params: {
    threadId: string
    content: string
    metadataJson?: string
    pairId?: string
  }): Promise<ThreadMessageInfo> {
    const row = await this.threadRepo.appendMessage({
      threadId: params.threadId,
      role: 'system',
      content: params.content,
      metadataJson: params.metadataJson,
      pairId: params.pairId,
    })
    await this.threadRepo.updateMessageCount(params.threadId, 0)
    logger.debug(
      __t('logs.thread', '系统消息已追加: thread={0}, msgId={1}', [params.threadId, row.id]),
    )
    return this.toMessageInfo(row)
  }

  /**
   * 保存对话对（user + assistant）
   *
   * 便捷方法：一次性写入用户消息和 Agent 回复。
   */
  async saveMessagePair(params: {
    threadId: string
    agentId: string
    userContent: string
    assistantContent: string
    assistantRawContent?: string
    pairId?: string
  }): Promise<{ userMessage: ThreadMessageInfo; assistantMessage: ThreadMessageInfo }> {
    const pairId = params.pairId ?? `pair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const result = await this.threadRepo.saveMessagePair({
      threadId: params.threadId,
      agentId: params.agentId,
      userContent: params.userContent,
      assistantContent: params.assistantContent,
      assistantRawContent: params.assistantRawContent,
      pairId,
    })
    return {
      userMessage: this.toMessageInfo(result.userMessage),
      assistantMessage: this.toMessageInfo(result.assistantMessage),
    }
  }

  /**
   * 查询活跃消息（供 Context Compiler 使用）
   *
   * 返回最近 N 条 active 消息，时间正序。
   */
  async getActiveMessages(threadId: string, limit = 20): Promise<ThreadMessageInfo[]> {
    const rows = await this.threadRepo.queryActiveMessages({ threadId, limit })
    return rows.map((r) => this.toMessageInfo(r))
  }

  /** 标记依据完整会话时间索引派生，当前输入是否注入由上下文编译器决定。 */
  async getConversationTimeAnchors(
    threadId: string,
    throughMessageId: number,
  ): Promise<ReadonlyMap<number, string>> {
    if (throughMessageId <= 0) return new Map()
    return buildConversationTimeAnchors(
      await this.threadRepo.queryConversationUserTimes(threadId, throughMessageId),
    )
  }

  /**
   * 查询最近 N 个完整对话轮次（供 Context Compiler 使用）。
   * 每轮包含共享 pairId 的全部消息，保证不会从半轮中间截断。
   */
  async getActiveMessagePairs(
    threadId: string,
    pairLimit = 20,
    stable = false,
  ): Promise<ThreadMessageInfo[]> {
    const rows = await this.threadRepo.queryActiveMessagePairs(
      threadId,
      pairLimit + (stable ? 1 : 0),
    )
    if (!stable) return rows.map((row) => this.toMessageInfo(row))
    const pairKey = (row: (typeof rows)[number]) => row.pairId ?? `message:${row.id}`
    const pairs = [...new Set(rows.map(pairKey))]
    const selected = new Set(
      stableHistoryWindow(`thread:${threadId}`, pairs, pairLimit, (key) => key),
    )
    return rows.filter((row) => selected.has(pairKey(row))).map((row) => this.toMessageInfo(row))
  }

  /** 工作历史按材料预算向前分页；保留完整对话对，最终由逐请求窗口整理工具组。 */
  async getWorkingMessagePairs(
    threadId: string,
    inputBudget: number,
  ): Promise<ThreadMessageInfo[]> {
    const messages = new Map<number, ThreadMessageInfo>()
    const budget = inputBudget > 0 ? inputBudget : 64_000
    let used = 0
    let beforeMessageId: number | undefined
    while (used < budget) {
      const rows = await this.threadRepo.queryActiveMessagePairs(threadId, 8, {
        beforeMessageId,
        recoverable: true,
      })
      if (!rows.length) break
      for (const row of rows) {
        if (messages.has(row.id)) continue
        const message = this.toMessageInfo(row)
        messages.set(message.id, message)
        used += tokenCounter.countTokens(workContextText(message))
      }
      const next = Math.min(...rows.map((row) => row.id))
      if (beforeMessageId !== undefined && next >= beforeMessageId) break
      beforeMessageId = next
    }
    return [...messages.values()].sort((left, right) => left.id - right.id)
  }

  /**
   * 按稳定消息游标查询活跃消息（最新在前），供前端历史追加。
   */
  async listMessages(params: {
    threadId: string
    beforeMessageId?: number
    page?: number
    pageSize?: number
  }): Promise<{ items: ThreadMessageInfo[]; total: number; hasMoreBefore: boolean }> {
    const result = await this.threadRepo.listActiveMessages(params)
    return {
      items: result.items.map((row) => {
        const message = this.toMessageInfo(row)
        return { ...message, metadataJson: publicWorkMetadata(message.metadataJson) }
      }),
      total: result.total,
      hasMoreBefore: result.hasMoreBefore,
    }
  }

  /** 修改用户可见的 Thread 标题。空白标题统一保存为空，由前端显示“未命名会话”。 */
  async renameThread(threadId: string, title: string): Promise<void> {
    const thread = await this.threadRepo.getThread(threadId)
    if (!thread || thread.status === 'deleted') {
      throw new AppError('NOT_FOUND', { message: '会话不存在' })
    }
    await this.threadRepo.updateTitle(threadId, title.trim())
    logger.info(__t('logs.thread', 'Thread 已改名: thread={0}', [threadId]))
  }

  /** 获取删除某轮的链式 rewind 预检：目标轮次及所有后续轮次。 */
  async previewMessageRewind(threadId: string, messageId: number): Promise<RewindPreview> {
    const preview = await this.checkpointService?.previewPair(threadId, messageId)
    if (!preview) throw new AppError('NOT_FOUND', { message: '消息不存在、已删除或不属于当前会话' })
    return preview
  }

  /** 整条会话删除只统计历史，不读取或回滚文件检查点。 */
  async previewThreadRewind(threadId: string): Promise<RewindPreview> {
    const thread = await this.threadRepo.getThread(threadId)
    if (!thread || thread.status === 'deleted')
      throw new AppError('NOT_FOUND', { message: '会话不存在或已删除' })
    const pairIds = await this.threadRepo.activePairIds(threadId)
    return {
      threadId,
      agentId: thread.agentId,
      wholeThread: true,
      pairIds,
      pairCount: pairIds.length,
      createdCount: 0,
      editedCount: 0,
      preservedCount: 0,
      files: [],
      forceWarning: false,
    }
  }

  /**
   * 执行链式 rewind：先安全回滚未发生后续变动的文件，再删除目标轮次及全部后续轮次。
   */
  async rewindMessage(
    threadId: string,
    messageId: number,
    deletedBy = 'user',
    preserveInputAttachments = false,
  ) {
    invalidatePromptReplay(threadId, true)
    const preview = await this.previewMessageRewind(threadId, messageId)
    if (preserveInputAttachments) {
      const input = await this.threadRepo.getMessageCoverageContext(messageId)
      if (input?.threadId !== threadId || input.role !== 'user' || input.status === 'deleted')
        throw new AppError('INVALID_PARAMETER', { message: '重新生成必须从当前会话的用户消息开始' })
    }
    let messageIds: number[] = []
    const workspace = await this.checkpointService!.rollback(preview, async () => {
      messageIds = await this.checkpointService!.deletePairs(preview, deletedBy)
    })
    await this.planLifecycle?.rollbackPairs(threadId, preview.pairIds)
    await this.characterStateLifecycle?.rollbackPairs(threadId, preview.pairIds)
    await this.attachmentRepo?.softDeleteByMessageIds(
      messageIds,
      preserveInputAttachments ? { threadId, messageId } : undefined,
    )
    await this.coverageInvalidator?.invalidatePairs(threadId, preview.pairIds)
    await this.threadRepo.syncThreadStats(threadId)
    logger.info(
      __t('logs.thread', '对话已链式回滚: thread={0}, pairs={1}, messages={2}', [
        threadId,
        preview.pairCount,
        messageIds.length,
      ]),
    )
    return {
      preview: this.completedRewindPreview(preview, workspace),
      workspace,
      deletedMessageIds: messageIds,
    }
  }

  /** 兼容旧删除入口：整条会话删除保留所有文件。 */
  async rewindThread(threadId: string) {
    invalidatePromptReplay(threadId, true)
    const preview = await this.previewThreadRewind(threadId)
    const result = await this.threadRepo.softDeleteThread(threadId)
    if (!result.deleted) throw new AppError('NOT_FOUND', { message: '会话不存在或已删除' })
    const messageIds = result.messageIds
    const workspace = { files: [], rolledBackCount: 0, preservedCount: 0 }
    await this.planLifecycle?.clearThread(threadId)
    await this.characterStateLifecycle?.clearThread(threadId)
    await this.attachmentRepo?.softDeleteByMessageIds(messageIds)
    await this.coverageInvalidator?.invalidateThread(threadId)
    logger.info(
      __t('logs.thread', 'Thread 已软删除，文件保持原样: thread={0}, pairs={1}', [
        threadId,
        preview.pairCount,
      ]),
    )
    return {
      preview: this.completedRewindPreview(preview, workspace),
      workspace,
      deletedMessageIds: messageIds,
    }
  }

  /** 预检后仍可能出现新改动，完成结果以实际恢复和保留的文件重新计数。 */
  private completedRewindPreview(
    preview: RewindPreview,
    workspace: { files: RewindPreview['files']; preservedCount: number },
  ): RewindPreview {
    return {
      ...preview,
      files: workspace.files,
      createdCount: workspace.files.filter((file) => file.action === 'delete_created').length,
      editedCount: workspace.files.filter(
        (file) => file.action !== 'delete_created' && file.action !== 'preserve_changed',
      ).length,
      preservedCount: workspace.preservedCount,
      forceWarning: workspace.files.some((file) => file.action !== 'preserve_changed'),
    }
  }

  /** 软删除已退役 Channel 的全部 Thread 与消息。 */
  async deleteThreadsByChannel(channel: string): Promise<number> {
    invalidatePromptReplay()
    const count = await this.threadRepo.softDeleteByChannel(channel)
    if (count > 0) {
      await this.characterStateLifecycle?.clearChannel?.(channel)
      logger.info(
        __t('logs.thread', '已软删除退役 Channel 会话: channel={0}, count={1}', [channel, count]),
      )
    }
    return count
  }

  /** 软删除整条 Thread；不会删除由该 Thread 提炼出的长期记忆。 */
  async deleteThread(threadId: string): Promise<boolean> {
    await disposeExecutionOwner({ threadId })
    invalidatePromptReplay(threadId, true)
    const result = await this.threadRepo.softDeleteThread(threadId)
    if (!result.deleted) return false
    try {
      await this.clearPromptVariables?.(threadId)
    } catch (error) {
      logger.warn(__t('logs.thread', '会话已删除，但酒馆变量清理失败'), { error })
    }
    await this.planLifecycle?.clearThread(threadId)
    await this.characterStateLifecycle?.clearThread(threadId)
    await this.attachmentRepo?.softDeleteByMessageIds(result.messageIds)
    await this.coverageInvalidator?.invalidateThread(threadId)
    logger.info(
      __t('logs.thread', 'Thread 已软删除: thread={0}, messages={1}', [
        threadId,
        result.messageIds.length,
      ]),
    )
    return true
  }

  /** 软删除单条消息 */
  async deleteMessage(messageId: number, deletedBy = 'user'): Promise<boolean> {
    const context = await this.threadRepo.getMessageCoverageContext(messageId)
    if (context) invalidatePromptReplay(context.threadId, true)
    const success = await this.threadRepo.softDeleteMessage(messageId, deletedBy)
    if (success) {
      if (context?.pairId)
        await this.planLifecycle?.rollbackPairs(context.threadId, [context.pairId])
      if (context?.pairId)
        await this.characterStateLifecycle?.rollbackPairs(context.threadId, [context.pairId])
      await this.attachmentRepo?.softDeleteByMessageIds([messageId])
      if (context?.pairId) {
        await this.coverageInvalidator?.invalidatePairs(context.threadId, [context.pairId])
      }
      logger.info(__t('logs.thread', '消息已软删除: msgId={0}', [messageId]))
    }
    return success
  }

  /** 软删除整对消息 */
  async deleteMessagePair(messageId: number, deletedBy = 'user'): Promise<number> {
    const context = await this.threadRepo.getMessageCoverageContext(messageId)
    if (context) invalidatePromptReplay(context.threadId, true)
    const messageIds = await this.threadRepo.getPairMessageIds(messageId)
    const count = await this.threadRepo.softDeletePair(messageId, deletedBy)
    if (count > 0) {
      if (context?.pairId)
        await this.planLifecycle?.rollbackPairs(context.threadId, [context.pairId])
      if (context?.pairId)
        await this.characterStateLifecycle?.rollbackPairs(context.threadId, [context.pairId])
      await this.attachmentRepo?.softDeleteByMessageIds(messageIds)
      if (context?.pairId) {
        await this.coverageInvalidator?.invalidatePairs(context.threadId, [context.pairId])
      }
      logger.info(__t('logs.thread', '对话对已软删除: msgId={0}, count={1}', [messageId, count]))
    }
    return count
  }

  /** 编辑消息内容 */
  async editMessage(
    messageId: number,
    newContent: string,
    expectedThreadId?: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    const context = await this.threadRepo.getMessageCoverageContext(messageId)
    if (
      !context ||
      context.status === 'deleted' ||
      (expectedThreadId && context.threadId !== expectedThreadId)
    )
      return false
    const success = await this.threadRepo.editMessage(messageId, newContent, expectedRevision)
    if (!success && expectedRevision !== undefined)
      throw new AppError('CONFLICT', { message: '消息已更新，请重新打开编辑后再保存' })
    if (success) {
      if (context?.pairId) {
        await this.coverageInvalidator?.invalidatePairs(context.threadId, [context.pairId])
      }
      logger.info(__t('logs.thread', '消息已编辑: msgId={0}', [messageId]))
    }
    return success
  }

  // ── 摘要（已废弃，见 .docs/archived/03-context-runtime.md 第 0 节决策） ──
  // 超出上下文窗口的早期消息由长记忆系统兜底，不再生成滚动摘要。

  /** @deprecated 已废弃，超窗口消息由长记忆系统兜底 */
  async getSummary(threadId: string): Promise<string | null> {
    const row = await this.threadRepo.getLatestSummary(threadId)
    return row?.content ?? null
  }

  /** @deprecated 已废弃，超窗口消息由长记忆系统兜底 */
  async upsertSummary(
    threadId: string,
    content: string,
    coversMessageIds: string[],
  ): Promise<void> {
    await this.threadRepo.upsertSummary({ threadId, content, coversMessageIds })
    logger.info(
      __t('logs.thread', '摘要已更新: thread={0}, covers={1} 条消息', [
        threadId,
        coversMessageIds.length,
      ]),
    )
  }

  // ── 私有转换 ──

  private toThreadInfo(row: ReturnType<typeof Object>): ThreadInfo {
    const r = row as Record<string, unknown>
    return {
      id: r.id as string,
      agentId: r.agentId as string,
      channel: r.channel as ThreadChannel,
      platform: (r.platform as string) ?? undefined,
      platformIdentifier: (r.platformIdentifier as string) ?? undefined,
      title: (r.title as string) ?? '',
      messageCount: (r.messageCount as number) ?? 0,
      pairCount: (r.pairCount as number) ?? 0,
      lastMessageAt: (r.lastMessageAt as string) ?? null,
      status: (r.status as string) ?? 'active',
      contextPolicy: (r.contextPolicy as string) ?? null,
      disabledTools: this.parseDisabledTools(r.disabledToolsJson),
      interactionMode:
        r.interactionMode === 'minimal'
          ? 'minimal'
          : r.interactionMode === 'chat'
            ? 'chat'
            : 'work',
      autoExecuteTools: Boolean(r.autoExecuteTools),
      executionMode: resolveExecutionMode(r.executionMode, Boolean(r.autoExecuteTools)),
      purpose: (r.purpose as string) ?? 'conversation',
      createdAt: (r.createdAt as string) ?? '',
      updatedAt: (r.updatedAt as string) ?? '',
    }
  }

  private parseDisabledTools(raw: unknown): string[] {
    if (typeof raw !== 'string') return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : []
    } catch {
      return []
    }
  }

  private toMessageInfo(row: ReturnType<typeof Object>): ThreadMessageInfo {
    const r = row as Record<string, unknown>
    return {
      id: r.id as number,
      threadId: r.threadId as string,
      role: r.role as ThreadMessageInfo['role'],
      content: r.content as string,
      rawContent: (r.rawContent as string) ?? null,
      pairId: (r.pairId as string) ?? null,
      senderId: (r.senderId as string) ?? null,
      agentId: (r.agentId as string) ?? null,
      revision: (r.revision as number) ?? 1,
      metadataJson: (r.metadataJson as string) ?? '{}',
      timestamp: (r.timestamp as string) ?? '',
      status: (r.status as string) ?? 'active',
    }
  }
}
