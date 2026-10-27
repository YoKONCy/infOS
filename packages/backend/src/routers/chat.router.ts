import { t as __t } from '../lib/i18n'
/**
 * Chat Router — 新版对话 HTTP/SSE 端点
 *
 * 基于 Thread + ContextCompiler 架构：
 * - POST /api/chat             非流式对话 { threadId, content, agentId? }
 * - POST /api/chat/stream       流式对话 (SSE) { threadId, content, agentId? }
 * - POST /api/chat/stop         停止生成
 * - GET  /api/threads           Thread 列表
 * - GET  /api/threads/:id       Thread 详情 + 消息
 * - POST /api/threads           创建新 Thread
 * - PATCH /api/threads/:id/messages/:msgId  编辑消息
 * - DELETE /api/threads/:id/messages/:msgId 软删除消息
 * - DELETE /api/threads/:id/messages/:msgId/pair 软删除对话对
 *
 * SSE 事件类型：
 * - delta: 文本增量
 * - tool_call: 工具调用开始
 * - tool_result: 工具执行结果
 * - status: 状态变更 (thinking/calling/generating)
 * - done: 对话完成 (含 usage)
 * - error: 错误
 *
 * @module packages/backend/src/routers/chat.router
 */

import { Hono, type MiddlewareHandler } from 'hono'
import { validate as zValidator } from '../lib/validation'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import { runChatStream } from '../services/conversation/chatStreamRunner'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'
import { disposeExecutionOwner } from '../tools/productivityRuntimeHolder'
import { resolveToolUserDescription, resolveToolUserLabel } from '../tools/toolUserLabels'
import { isAdvancedTool } from '../tools/advancedTools'
import { isSystemProtocolTool } from '../tools/systemProtocolTools'
import { isToolAllowedInInteractionMode } from '../tools/interactionMode'
import type { ThreadChannel } from '@infos/shared'
import { REASONING_EFFORT_VALUES } from '@infos/shared'

// ─────────────────────────────────────────────
// Zod Schema
// ─────────────────────────────────────────────

/** 新版对话请求：只接受 threadId + content */
const chatRequestSchema = z.object({
  threadId: z.string().min(1),
  content: z.string().min(1),
  /** 仅选择提示词条目的生成触发类型，不改变消息持久化或工具权限。 */
  generationType: z
    .enum(['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'])
    .optional(),
  /** 可选覆盖 Agent（默认用 Thread 的 agentId） */
  agentId: z.string().optional(),
  attachmentIds: z.array(z.string().uuid()).max(5).optional(),
  /** 图片识别方式：原生视觉或专用多模态转述。 */
  imageMode: z.enum(['auto', 'native', 'relay']).optional(),
  /** 工作区隐式上下文：仅注入模型上下文，不写入用户消息正文。 */
  workspaceContext: z
    .object({
      filePath: z.string().max(2048).optional(),
      fileHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      fileDirty: z.boolean().optional(),
      terminalId: z.string().max(256).optional(),
      selection: z
        .object({
          text: z.string().min(1).max(4000),
          startLine: z.number().int().min(1),
          endLine: z.number().int().min(1),
        })
        .optional(),
    })
    .optional(),
})

/**
 * 创建 Thread 请求
 *
 * 注：social/group channel 已从 ContextCompiler 剥离，由社交子 Agent 应用独立处理。
 * 当前 Thread API 服务本地主 Agent 的 desktop 场景。
 */
const createThreadSchema = z.object({
  agentId: z.string().default('pero'),
  channel: z.literal('desktop').default('desktop'),
  platform: z.string().optional(),
  platformIdentifier: z.string().optional(),
  title: z.string().optional(),
})

/** 修改会话标题请求；允许空字符串恢复为“未命名会话”展示。 */
const renameThreadSchema = z.object({
  title: z.string().max(100),
})

/** 编辑消息请求 */
const threadToolsSchema = z.object({
  disabledTools: z.array(z.string().min(1)).max(500),
})

const threadExecutionModeSchema = z
  .object({
    executionMode: z.enum(['manual', 'auto', 'auto_approve', 'full']).optional(),
    autoExecuteTools: z.boolean().optional(),
  })
  .refine((value) => value.executionMode !== undefined || value.autoExecuteTools !== undefined, {
    message: __t('server.routers', '必须指定执行模式'),
  })

const threadInteractionModeSchema = z.object({
  interactionMode: z.enum(['minimal', 'chat', 'work']),
})

const rewindSchema = z
  .object({
    messageId: z.number().int().positive().optional(),
    wholeThread: z.boolean().optional(),
    preserveInputAttachments: z.boolean().optional(),
  })
  .refine((value) => value.wholeThread === true || value.messageId !== undefined, {
    message: __t('server.routers', '必须指定 messageId 或 wholeThread=true'),
  })

const editMessageSchema = z.object({
  content: z.string().min(1),
  expectedRevision: z.number().int().positive().optional(),
})

// ─────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────

export function createChatRouter(ctx: AppContext) {
  const router = new Hono()
  const achievementSubject = (request: Request, generationType?: string) =>
    !generationType || generationType === 'normal'
      ? ctx.clientAccess?.authenticate(request)?.id
      : undefined
  const historyMutation: MiddlewareHandler = async (c, next) => {
    const threadId = c.req.param('id')
    if (!threadId) throw new AppError('INVALID_PARAMETER', { message: '缺少会话标识' })
    const release = ctx.conversationQueue.beginHistoryChange(threadId)
    try {
      await next()
    } finally {
      release()
    }
  }

  const queueIdentity = async (threadId: string) => {
    const thread = await ctx.threadService.getThread(threadId)
    if (!thread || thread.channel !== 'desktop' || thread.status !== 'active')
      throw new AppError('NOT_FOUND', { message: '目标对话不存在' })
    return thread
  }
  router.get('/queue/:threadId', async (c) => {
    await queueIdentity(c.req.param('threadId'))
    return c.json({ code: 'OK', data: ctx.conversationQueue.snapshot(c.req.param('threadId')) })
  })
  router.get('/queue/:threadId/live', async (c) => {
    await queueIdentity(c.req.param('threadId'))
    return c.json({ code: 'OK', data: ctx.conversationQueue.getLive(c.req.param('threadId')) })
  })
  router.post(
    '/queue/:threadId',
    zValidator('json', chatRequestSchema.extend({ clientMessageId: z.string().uuid() })),
    async (c) => {
      const { clientMessageId, ...input } = c.req.valid('json')
      if (input.threadId !== c.req.param('threadId'))
        throw new AppError('CONFLICT', { message: '队列目标会话不一致' })
      return c.json({
        code: 'OK',
        data: await ctx.conversationQueue.enqueue(clientMessageId, {
          ...input,
          achievementSubjectId: achievementSubject(c.req.raw, input.generationType),
        }),
      })
    },
  )
  router.patch(
    '/queue/:threadId/items/:id',
    zValidator(
      'json',
      z.object({
        revision: z.number().int().positive(),
        content: z.string().trim().min(1).max(1_000_000).optional(),
        action: z.enum(['edit', 'cancel', 'immediate', 'draft']),
      }),
    ),
    async (c) => {
      const threadId = c.req.param('threadId')
      await queueIdentity(threadId)
      const input = c.req.valid('json')
      if (input.action === 'edit' && input.content === undefined)
        throw new AppError('MISSING_FIELD', { message: '缺少编辑后的消息内容' })
      const snapshot = await ctx.conversationQueue.change(
        threadId,
        c.req.param('id'),
        input.revision,
        {
          content: input.content,
          cancel: input.action === 'cancel',
          immediate: input.action === 'immediate' || undefined,
          draft: input.action === 'draft' || undefined,
        },
      )
      return c.json({ code: 'OK', data: snapshot })
    },
  )
  router.post(
    '/queue/:threadId/control',
    zValidator('json', z.object({ paused: z.boolean() })),
    async (c) => {
      await queueIdentity(c.req.param('threadId'))
      return c.json({
        code: 'OK',
        data: ctx.conversationQueue.pause(c.req.param('threadId'), c.req.valid('json').paused),
      })
    },
  )
  router.post(
    '/queue/:threadId/order',
    zValidator(
      'json',
      z.object({
        order: z
          .array(z.object({ id: z.string().min(1), revision: z.number().int().positive() }))
          .max(100),
      }),
    ),
    async (c) => {
      await queueIdentity(c.req.param('threadId'))
      return c.json({
        code: 'OK',
        data: ctx.conversationQueue.reorder(c.req.param('threadId'), c.req.valid('json').order),
      })
    },
  )

  // ─────────────────────────────────────────────
  // 对话接口
  // ─────────────────────────────────────────────

  /**
   * POST /api/chat — 非流式对话
   *
   * 请求体：{ threadId, content, agentId? }
   * 流程：
   * 1. 追加用户消息到 Thread
   * 2. ContextCompiler 编译上下文
   * 3. AgentService 执行对话（ReAct Loop）
   * 4. 追加 Agent 回复到 Thread
   */
  router.post('/', zValidator('json', chatRequestSchema), async (c) => {
    const body = c.req.valid('json')
    const { threadId, content } = body

    const thread = await queueIdentity(threadId)
    if (body.agentId && body.agentId !== thread.agentId)
      throw new AppError('CONFLICT', { message: '角色与目标会话不匹配' })
    ctx.runtimeStateService.registerTask(threadId, thread.agentId)
    let succeeded = false
    try {
      const result = await ctx.conversationTurnService.executeTurn({
        achievementSubjectId: achievementSubject(c.req.raw, body.generationType),
        threadId,
        agentId: thread.agentId,
        signal: ctx.runtimeStateService.getAbortSignal(threadId),
        content,
        attachmentIds: body.attachmentIds,
        imageMode: body.imageMode,
        generationType: body.generationType,
        workspaceContext: body.workspaceContext,
      })

      const messageId = result.assistantMessage?.id
      if (!messageId) throw new Error('非流式对话完成后缺少持久消息身份')
      ctx.conversationProjection.invalidate(threadId)
      const projection = await ctx.conversationProjection.getSnapshot(threadId)
      const surface = projection.surfaces.find((item) => item.messageId === String(messageId))
      if (!surface) throw new Error(`Conversation Surface 不存在: message=${messageId}`)

      succeeded = !result.executionPause
      return c.json({
        code: 'OK',
        message: result.executionPause
          ? __t('server.routers', '对话已暂停')
          : __t('server.routers', '对话完成'),
        data: {
          executionId: result.execution?.executionId,
          executionPause: result.executionPause,
          threadId: result.threadId,
          messageId: String(messageId),
          surface,
        },
      })
    } finally {
      try {
        ctx.conversationQueue.afterTurn(threadId, { success: succeeded })
      } finally {
        ctx.runtimeStateService.unregisterTask(threadId)
      }
    }
  })

  /**
   * POST /api/chat/stream — 流式对话 (SSE)
   *
   * 请求体：{ threadId, content, agentId? }
   */
  router.post('/stream', zValidator('json', chatRequestSchema), async (c) => {
    const body = c.req.valid('json')
    const thread = await ctx.threadService.getThread(body.threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: '目标会话不存在' })
    if (body.agentId && body.agentId !== thread.agentId)
      throw new AppError('CONFLICT', { message: '角色与目标会话不匹配' })
    if (ctx.runtimeStateService.getTaskInfo(body.threadId))
      throw new AppError('RESOURCE_BUSY', {
        message: '当前会话仍在执行，请加入消息队列或先停止任务',
      })
    ctx.runtimeStateService.registerTask(body.threadId, thread.agentId)
    return streamSSE(c, async (stream) => {
      let detached = false
      let writing = false
      stream.onAbort(() => {
        detached = true
      })
      const writeEvent = async (event: { event: string; data: string }) => {
        if (detached || stream.aborted) return
        let timer: ReturnType<typeof setTimeout> | undefined
        writing = true
        try {
          await Promise.race([
            stream.writeSSE(event).catch(() => {
              detached = true
            }),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                detached = true
                resolve()
              }, 3_000)
            }),
          ])
        } finally {
          clearTimeout(timer)
          writing = false
        }
      }
      const heartbeat = setInterval(() => {
        if (!writing) void writeEvent({ event: 'heartbeat', data: '{}' })
      }, 15_000)
      heartbeat.unref?.()
      try {
        await runChatStream(
          ctx,
          {
            ...body,
            achievementSubjectId: achievementSubject(c.req.raw, body.generationType),
          },
          writeEvent,
        )
      } finally {
        clearInterval(heartbeat)
      }
    })
  })

  // POST /api/chat/stop — 停止生成
  router.post('/stop', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const threadId = ((body as Record<string, unknown>).threadId as string) ?? ''
    if (threadId) {
      ctx.conversationQueue.pause(threadId, true)
      ctx.runtimeStateService.cancelTask(threadId)
      await disposeExecutionOwner({ threadId }, true)
    }
    return c.json({ code: 'OK', message: __t('server.routers', '已停止生成') })
  })

  // ─────────────────────────────────────────────
  // Thread 管理接口
  // ─────────────────────────────────────────────

  /**
   * GET /api/threads — Thread 列表
   *
   * 查询参数：agentId, channel, page, pageSize
   */
  router.get('/threads', async (c) => {
    const agentId = c.req.query('agentId') || undefined
    const channel = c.req.query('channel') ?? undefined
    const page = Math.max(1, Number(c.req.query('page') ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 20)))

    const knownAgentIds = ctx.agentManager.listAgents().map((agent) => agent.id)
    if (agentId && !ctx.agentManager.getAgent(agentId)) {
      throw new AppError('NOT_FOUND', { message: `角色不存在: ${agentId}` })
    }

    // M05 §8.3: 普通聊天列表默认排除后台任务 Thread，除非显式传 purpose
    const purpose = c.req.query('purpose') ?? 'conversation'

    const result = await ctx.threadService.listThreads({
      agentId,
      agentIds: agentId ? undefined : knownAgentIds,
      channel,
      // 社交是独立应用；其用于心流生命周期的内部 Thread 不属于主应用对话日志。
      // 同时排除旧版本已误标为 conversation 的 social Thread。
      excludeChannels: ['social'],
      purpose: purpose as import('../repositories/thread.repo').ThreadPurpose,
      page,
      pageSize,
    })

    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: result })
  })

  async function assertThreadMutable(threadId: string): Promise<void> {
    const thread = await ctx.threadService.getThread(threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
    const reactBusy = ctx.runtimeStateService
      .listActiveTasks()
      .some((task) => task.threadId === threadId)
    const taskBusy = ctx.backgroundTaskService
      ? await ctx.backgroundTaskService.hasActiveWork({ threadId })
      : false
    const proactiveBusy =
      ctx.kernelScheduler
        ?.list()
        .some(
          (item) =>
            item.descriptor.threadId === threadId &&
            !['completed', 'failed', 'cancelled', 'timed_out'].includes(item.state),
        ) ?? false
    if (reactBusy || taskBusy || proactiveBusy) {
      throw new AppError('CONFLICT', {
        message: '会话关联的 Agent 工作仍在进行，请先停止或等待完成',
      })
    }
  }

  /** 计算 Thread 可配置工具：Registry 通道声明 ∩ Agent/Channel 能力矩阵。 */
  async function resolveThreadTools(threadId: string) {
    const thread = await ctx.threadService.getThread(threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
    const registryTools = ctx.toolRegistry
      .getDefinitions(thread.channel)
      .filter((tool) => tool.name !== 'runtime_debug')
      .filter((tool) => !ctx.applicationRealms.isPrivateTool(tool.name))
    const allowed = ctx.capabilityGate.resolve(
      thread.agentId,
      thread.channel,
      thread.id,
    ).allowedTools
    const disabled = new Set(thread.disabledTools.filter((name) => !isSystemProtocolTool(name)))
    const tools = registryTools
      .filter(
        (tool) =>
          !isAdvancedTool(tool.name) && (isSystemProtocolTool(tool.name) || allowed.has(tool.name)),
      )
      .map((tool) => ({
        name: tool.name,
        packageId: tool.packageId,
        label: resolveToolUserLabel(tool.name, tool.display?.label),
        description: resolveToolUserDescription(
          tool.name,
          tool.display?.description,
          tool.description,
        ),
        display: tool.display ?? undefined,
        enabled:
          isToolAllowedInInteractionMode(tool.name, thread.interactionMode, ctx.toolRegistry) &&
          (isSystemProtocolTool(tool.name) || !disabled.has(tool.name)),
        userEnabled: isSystemProtocolTool(tool.name) || !disabled.has(tool.name),
        modeAllowed: isToolAllowedInInteractionMode(
          tool.name,
          thread.interactionMode,
          ctx.toolRegistry,
        ),
        locked: isSystemProtocolTool(tool.name),
      }))
    return { thread, tools }
  }

  /** GET /threads/:id/projection — 从领域表重建 Conversation 权威读模型。 */
  router.get('/threads/:id/projection', async (c) => {
    const threadId = c.req.param('id')
    const thread = await ctx.threadService.getThread(threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
    const beforeCursor = c.req.query('beforeCursor')
    const requestedPageSize = Number(c.req.query('pageSize') ?? 60)
    const pageSize = Number.isFinite(requestedPageSize)
      ? Math.min(100, Math.max(1, requestedPageSize))
      : 60
    const data = await ctx.conversationProjection.getSnapshot(threadId, {
      beforeCursor,
      pageSize,
    })
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data })
  })

  /** GET /threads/:id/flow-state — 查看当前 Thread 的心流；group 返回全部 Agent。 */
  router.get('/threads/:id/flow-state', async (c) => {
    const threadId = c.req.param('id')
    const agentId = c.req.query('agentId')
    const thread = await ctx.threadService.getThread(threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
    const data = agentId
      ? [await ctx.flowStateService.get(threadId, agentId)]
      : thread.channel === 'group'
        ? await ctx.flowStateService.listByThread(threadId)
        : [await ctx.flowStateService.get(threadId, thread.agentId)]
    return c.json({ code: 'OK', data })
  })

  /** DELETE /threads/:id/flow-state — 用户清空指定 Agent 的当前会话心流。 */
  router.delete('/threads/:id/flow-state', async (c) => {
    const threadId = c.req.param('id')
    const thread = await ctx.threadService.getThread(threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
    const agentId = c.req.query('agentId') ?? thread.agentId
    const data = await ctx.flowStateService.clear(threadId, agentId)
    return c.json({ code: 'OK', message: __t('server.routers', '心流已清空'), data })
  })

  router.post('/threads/:id/token-budget-preview', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      agentId?: string
      content?: string
    }
    const data = await ctx.conversationTurnService.previewTokenBudget({
      threadId: c.req.param('id'),
      agentId: body.agentId,
      content: body.content,
    })
    return c.json({ code: 'OK', message: __t('server.routers', '预算计算完成'), data })
  })

  /** 会话级模型配置仅返回卡片摘要，不暴露认证信息。 */
  router.get('/threads/:id/model-settings', async (c) => {
    const thread = await ctx.threadService.getThread(c.req.param('id'))
    if (!thread || thread.channel !== 'desktop' || thread.purpose !== 'conversation')
      throw new AppError('NOT_FOUND', { message: '聊天会话不存在' })
    return c.json({ code: 'OK', data: await ctx.threadModelService.settings(thread.id) })
  })

  router.put(
    '/threads/:id/model-settings',
    zValidator(
      'json',
      z.object({
        modelConfigId: z.number().int().positive().nullable(),
        reasoningEffort: z.enum(REASONING_EFFORT_VALUES).nullable(),
      }),
    ),
    async (c) => {
      const threadId = c.req.param('id')
      await assertThreadMutable(threadId)
      const data = await ctx.threadModelService.update(threadId, c.req.valid('json'))
      return c.json({ code: 'OK', message: __t('server.routers', '已保存'), data })
    },
  )

  /** GET /threads/:id/tools — 仅返回当前 Channel 合法且可由会话控制的工具。 */
  router.get('/threads/:id/tools', async (c) => {
    const { thread, tools } = await resolveThreadTools(c.req.param('id'))
    return c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: {
        threadId: thread.id,
        channel: thread.channel,
        executionMode: thread.executionMode,
        autoExecuteTools: thread.autoExecuteTools,
        interactionMode: thread.interactionMode,
        disabledTools: thread.disabledTools,
        tools,
      },
    })
  })

  router.put(
    '/threads/:id/interaction-mode',
    zValidator('json', threadInteractionModeSchema),
    async (c) => {
      const threadId = c.req.param('id')
      const thread = await ctx.threadService.getThread(threadId)
      if (!thread || thread.channel !== 'desktop' || thread.purpose !== 'conversation') {
        throw new AppError('INVALID_PARAMETER', { message: '只能修改普通桌面会话的交互模式' })
      }
      await assertThreadMutable(threadId)
      const { interactionMode } = c.req.valid('json')
      if (interactionMode !== 'work') await ctx.runtimeDebug.close(threadId)
      await ctx.threadService.updateInteractionMode(threadId, interactionMode)
      const { thread: updated, tools } = await resolveThreadTools(threadId)
      return c.json({
        code: 'OK',
        message: __t('server.routers', '会话模式已保存'),
        data: {
          threadId,
          channel: updated.channel,
          interactionMode: updated.interactionMode,
          executionMode: updated.executionMode,
          autoExecuteTools: updated.autoExecuteTools,
          disabledTools: updated.disabledTools,
          tools,
        },
      })
    },
  )

  router.put(
    '/threads/:id/execution-mode',
    zValidator('json', threadExecutionModeSchema),
    async (c) => {
      const threadId = c.req.param('id')
      await assertThreadMutable(threadId)
      const thread = await ctx.threadService.getThread(threadId)
      if (!thread || thread.channel !== 'desktop' || thread.purpose !== 'conversation') {
        throw new AppError('INVALID_PARAMETER', { message: '只能修改普通桌面会话的执行模式' })
      }
      const input = c.req.valid('json')
      const executionMode = input.executionMode ?? (input.autoExecuteTools ? 'auto' : 'manual')
      const autoExecuteTools = executionMode !== 'manual'
      await ctx.threadService.updateExecutionMode(threadId, executionMode)
      return c.json({
        code: 'OK',
        message: __t('server.routers', '执行模式已保存'),
        data: { threadId, executionMode, autoExecuteTools },
      })
    },
  )

  /** PUT /threads/:id/tools — 持久化禁用集合；禁止提交 Channel 白名单之外的工具。 */
  router.put('/threads/:id/tools', zValidator('json', threadToolsSchema), async (c) => {
    const threadId = c.req.param('id')
    if (ctx.runtimeStateService.listActiveTasks().some((task) => task.threadId === threadId)) {
      throw new AppError('INVALID_PARAMETER', { message: '会话正在生成中，请停止后再修改工具配置' })
    }
    const { thread, tools } = await resolveThreadTools(threadId)
    const configurable = new Set([...tools.map((tool) => tool.name), ...thread.disabledTools])
    const requestedDisabled = [...new Set(c.req.valid('json').disabledTools)]
    const advancedTools = requestedDisabled.filter(isAdvancedTool)
    if (advancedTools.length) {
      throw new AppError('INVALID_PARAMETER', {
        message: `高级工具由系统统一管理，不可单独禁用: ${advancedTools.join(', ')}`,
      })
    }
    const protocolTools = requestedDisabled.filter(isSystemProtocolTool)
    if (protocolTools.length) {
      throw new AppError('INVALID_PARAMETER', {
        message: `系统协议工具不可禁用: ${protocolTools.join(', ')}`,
      })
    }
    const disabledTools = requestedDisabled
    const invalid = disabledTools.filter((name) => !configurable.has(name))
    if (invalid.length) {
      throw new AppError('INVALID_PARAMETER', {
        message: `工具不属于当前 Channel: ${invalid.join(', ')}`,
      })
    }
    await ctx.threadService.updateDisabledTools(threadId, disabledTools)
    const { thread: updatedThread, tools: updatedTools } = await resolveThreadTools(threadId)
    return c.json({
      code: 'OK',
      message: __t('server.routers', '本会话工具配置已保存'),
      data: {
        disabledTools,
        channel: updatedThread.channel,
        executionMode: updatedThread.executionMode,
        autoExecuteTools: updatedThread.autoExecuteTools,
        interactionMode: updatedThread.interactionMode,
        tools: updatedTools,
      },
    })
  })

  /**
   * GET /api/threads/:id — Thread 详情 + 消息列表
   *
   * 查询参数：page, pageSize（消息分页）
   */
  router.get('/threads/:id', async (c) => {
    const threadId = c.req.param('id')
    const page = Math.max(1, Number(c.req.query('page') ?? 1))
    const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize') ?? 100)))

    const thread = await ctx.threadService.getThread(threadId)
    if (!thread) {
      throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
    }

    const messages = await ctx.threadService.listMessages({
      threadId,
      page,
      pageSize,
    })

    const attachmentMap = await ctx.attachmentService.listForMessages(
      messages.items.map((message) => message.id),
    )
    const messagesWithAttachments = messages.items.map((message) => ({
      ...message,
      attachments: attachmentMap.get(message.id) ?? [],
    }))

    return c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: {
        thread,
        messages: messagesWithAttachments,
        total: messages.total,
      },
    })
  })

  /**
   * POST /api/threads — 创建新 Thread
   */
  router.post('/threads', zValidator('json', createThreadSchema), async (c) => {
    const body = c.req.valid('json')
    if (!ctx.agentManager.getAgent(body.agentId)) {
      throw new AppError('NOT_FOUND', { message: `角色不存在: ${body.agentId}` })
    }
    const thread = await ctx.threadService.createThread({
      agentId: body.agentId,
      channel: body.channel as ThreadChannel,
      platform: body.platform,
      platformIdentifier: body.platformIdentifier,
      title: body.title,
    })
    return c.json({ code: 'OK', message: __t('server.routers', 'Thread 已创建'), data: { thread } })
  })

  /**
   * POST /api/threads/latest — 获取或创建 Agent 的最新 Thread
   *
   * 前端打开聊天页时调用，自动获取最新 Thread 或创建新的。
   */
  router.post('/threads/latest', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const agentId = ((body as Record<string, unknown>).agentId as string) ?? 'pero'
    const channel = 'desktop'

    const thread = await ctx.threadService.getOrCreateLatest(agentId, channel, 'conversation')
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: { thread } })
  })

  /** PATCH /api/threads/:id — 修改会话标题。 */
  router.patch('/threads/:id', zValidator('json', renameThreadSchema), async (c) => {
    const threadId = c.req.param('id')
    const body = c.req.valid('json')
    await ctx.threadService.renameThread(threadId, body.title)
    return c.json({ code: 'OK', message: __t('server.routers', '会话标题已更新') })
  })

  /** POST /threads/:id/rewind-preview — 返回删除及文件回滚清单，不产生副作用。 */
  router.post('/threads/:id/rewind-preview', zValidator('json', rewindSchema), async (c) => {
    const threadId = c.req.param('id')
    const body = c.req.valid('json')
    const preview = body.wholeThread
      ? await ctx.threadService.previewThreadRewind(threadId)
      : await ctx.threadService.previewMessageRewind(threadId, body.messageId!)
    return c.json({ code: 'OK', message: __t('server.routers', '预检成功'), data: preview })
  })

  /** POST /threads/:id/rewind — 单轮撤回回滚文件；整条会话删除保留文件。 */
  router.post(
    '/threads/:id/rewind',
    zValidator('json', rewindSchema),
    historyMutation,
    async (c) => {
      const threadId = c.req.param('id')
      ctx.conversationQueue.pause(threadId, true)
      await assertThreadMutable(threadId)
      const body = c.req.valid('json')
      const preview = body.wholeThread
        ? await ctx.threadService.previewThreadRewind(threadId)
        : await ctx.threadService.previewMessageRewind(threadId, body.messageId!)
      const result = body.wholeThread
        ? await ctx.threadService.rewindThread(threadId)
        : await ctx.threadService.rewindMessage(
            threadId,
            body.messageId!,
            'user',
            body.preserveInputAttachments,
          )
      ctx.conversationQueue.historyChanged(threadId, body.wholeThread, true)
      if (body.wholeThread) {
        await ctx.runtimeDebug.close(threadId)
        await ctx.flowStateService.deleteThread(threadId)
        ctx.toolContextService.deleteThread(threadId)
      } else {
        // 文件与消息都恢复到目标轮次之前，临时状态和材料按相同范围撤回。
        if (preview.pairIds.length)
          await ctx.flowStateService.rollbackPairs(threadId, preview.pairIds)
        if (preview.pairIds.length) ctx.toolContextService.deletePairs(threadId, preview.pairIds)
      }
      let projection
      if (!body.wholeThread) {
        ctx.conversationProjection.invalidate(threadId)
        projection = await ctx.conversationProjection.getSnapshot(threadId)
      } else {
        ctx.conversationProjection.invalidate(threadId)
      }
      return c.json({
        code: 'OK',
        message: body.wholeThread
          ? __t('server.routers', '会话已删除，文件保持原样')
          : __t('server.routers', '对话、工作区与心流已回滚'),
        data: { ...result, ...(projection ? { projection } : {}) },
      })
    },
  )

  /** DELETE /api/threads/:id — 删除会话历史，保留全部文件。 */
  router.delete('/threads/:id', historyMutation, async (c) => {
    const threadId = c.req.param('id')
    ctx.conversationQueue.pause(threadId, true)
    await assertThreadMutable(threadId)
    await ctx.threadService.rewindThread(threadId)
    await ctx.runtimeDebug.close(threadId)
    await ctx.flowStateService.deleteThread(threadId)
    ctx.toolContextService.deleteThread(threadId)
    ctx.conversationProjection.invalidate(threadId)
    ctx.conversationQueue.historyChanged(threadId, true)
    return c.json({ code: 'OK', message: __t('server.routers', '会话已删除，文件保持原样') })
  })

  // ─────────────────────────────────────────────
  // 消息编辑/删除
  // ─────────────────────────────────────────────

  /**
   * PATCH /api/threads/:id/messages/:msgId — 编辑消息内容
   */
  router.patch(
    '/threads/:id/messages/:msgId',
    zValidator('json', editMessageSchema),
    historyMutation,
    async (c) => {
      const threadId = c.req.param('id')
      ctx.conversationQueue.pause(threadId, true)
      await assertThreadMutable(threadId)
      const msgId = Number(c.req.param('msgId'))
      if (!Number.isInteger(msgId) || msgId <= 0) {
        throw new AppError('INVALID_PARAMETER', {
          message: '无效的消息 ID',
          data: { field: 'msgId', expected: 'positive integer' },
        })
      }
      const body = c.req.valid('json')
      const success = await ctx.threadService.editMessage(
        msgId,
        body.content,
        threadId,
        body.expectedRevision,
      )
      if (!success) {
        throw new AppError('NOT_FOUND', { message: '消息不存在' })
      }
      ctx.conversationProjection.invalidate(c.req.param('id'))
      const data = await ctx.conversationProjection.getSnapshot(threadId, {
        beforeCursor: String(msgId + 1),
        pageSize: 100,
      })
      ctx.conversationQueue.historyChanged(threadId, false)
      return c.json({ code: 'OK', message: __t('server.routers', '消息已更新'), data })
    },
  )

  /**
   * DELETE /api/threads/:id/messages/:msgId — 软删除单条消息
   */
  router.delete('/threads/:id/messages/:msgId', historyMutation, async (c) => {
    const threadId = c.req.param('id')
    ctx.conversationQueue.pause(threadId, true)
    await assertThreadMutable(threadId)
    const msgId = Number(c.req.param('msgId'))
    if (!Number.isInteger(msgId) || msgId <= 0) {
      throw new AppError('INVALID_PARAMETER', {
        message: '无效的消息 ID',
        data: { field: 'msgId', expected: 'positive integer' },
      })
    }
    const success = await ctx.threadService.deleteMessage(msgId)
    if (!success) {
      throw new AppError('NOT_FOUND', { message: '消息不存在' })
    }
    ctx.conversationQueue.historyChanged(threadId, false, true)
    ctx.conversationProjection.invalidate(c.req.param('id'))
    const data = await ctx.conversationProjection.getSnapshot(c.req.param('id'))
    return c.json({ code: 'OK', message: __t('server.routers', '消息已删除'), data })
  })

  /**
   * DELETE /api/threads/:id/messages/:msgId/pair — 软删除整对消息
   */
  router.delete('/threads/:id/messages/:msgId/pair', historyMutation, async (c) => {
    const msgId = Number(c.req.param('msgId'))
    if (!Number.isInteger(msgId) || msgId <= 0) {
      throw new AppError('INVALID_PARAMETER', {
        message: '无效的消息 ID',
        data: { field: 'msgId', expected: 'positive integer' },
      })
    }
    const threadId = c.req.param('id')
    ctx.conversationQueue.pause(threadId, true)
    await assertThreadMutable(threadId)
    const result = await ctx.threadService.rewindMessage(threadId, msgId)
    ctx.conversationQueue.historyChanged(threadId, false, true)
    if (result.preview.pairIds.length) {
      await ctx.flowStateService.rollbackPairs(threadId, result.preview.pairIds)
      ctx.toolContextService.deletePairs(threadId, result.preview.pairIds)
    }
    ctx.conversationProjection.invalidate(threadId)
    const projection = await ctx.conversationProjection.getSnapshot(threadId)
    return c.json({
      code: 'OK',
      message: __t('server.routers', '已回滚 {0} 轮对话及关联文件', [result.preview.pairCount]),
      data: {
        deletedCount: result.deletedMessageIds.length,
        preview: result.preview,
        deletedMessageIds: result.deletedMessageIds,
        projection,
      },
    })
  })

  // ─────────────────────────────────────────────
  // 任务控制 (保留)
  // ─────────────────────────────────────────────

  router.get('/tasks', (c) => {
    const tasks = ctx.runtimeStateService.listActiveTasks()
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: tasks })
  })

  router.post('/tasks/pause', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const threadId = ((body as Record<string, unknown>).threadId as string) ?? ''
    if (!threadId) {
      throw new AppError('MISSING_FIELD', { message: '缺少 threadId', data: { field: 'threadId' } })
    }
    const ok = ctx.runtimeStateService.pauseTask(threadId)
    return ok
      ? c.json({ code: 'OK', message: __t('server.routers', '任务已暂停') })
      : c.json({ code: 'NOT_FOUND', message: __t('server.routers', '任务不存在') }, 404)
  })

  router.post('/tasks/resume', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const threadId = ((body as Record<string, unknown>).threadId as string) ?? ''
    if (!threadId) {
      throw new AppError('MISSING_FIELD', { message: '缺少 threadId', data: { field: 'threadId' } })
    }
    const ok = ctx.runtimeStateService.resumeTask(threadId)
    return ok
      ? c.json({ code: 'OK', message: __t('server.routers', '任务已恢复') })
      : c.json({ code: 'NOT_FOUND', message: __t('server.routers', '任务不存在') }, 404)
  })

  router.post('/tasks/inject', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const threadId = ((body as Record<string, unknown>).threadId as string) ?? ''
    const instruction = ((body as Record<string, unknown>).instruction as string) ?? ''
    if (!threadId || !instruction.trim()) {
      throw new AppError('MISSING_FIELD', {
        message: '缺少 threadId 或 instruction',
        data: { field: 'threadId, instruction' },
      })
    }
    const ok = ctx.runtimeStateService.injectInstruction(threadId, instruction)
    return ok
      ? c.json({ code: 'OK', message: __t('server.routers', '指令已注入') })
      : c.json({ code: 'NOT_FOUND', message: __t('server.routers', '任务不存在') }, 404)
  })

  return router
}
