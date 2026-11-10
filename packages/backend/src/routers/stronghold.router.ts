import { t as __t } from '../lib/i18n'
/**
 * Stronghold Router — 据点/群聊管理 API
 *
 * 路由前缀: /api/stronghold
 *
 * 端点分组:
 * 1. 设施管理: /facilities
 * 2. 房间管理: /rooms
 * 3. Agent 位置: /locations
 * 4. 群聊消息: /rooms/:roomId/messages
 * 5. 管家: /butler
 *
 * @module packages/backend/src/routers/stronghold.router
 */

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'

export function createStrongholdRouter(ctx: AppContext) {
  const router = new Hono()

  // ═══ 设施管理 ═══

  // GET /api/stronghold/facilities — 列出所有设施
  router.get('/facilities', async (c) => {
    const facilities = await ctx.strongholdService.listFacilities()
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: facilities })
  })

  // POST /api/stronghold/facilities — 创建设施
  router.post('/facilities', async (c) => {
    const body = await c.req.json()
    if (!body.name) {
      throw new AppError('VALIDATION_ERROR', { message: 'name 为必填字段' })
    }
    const facility = await ctx.strongholdService.createFacility(body)
    return c.json(
      { code: 'CREATED', message: __t('server.routers', '设施已创建'), data: facility },
      201,
    )
  })

  // ═══ 房间管理 ═══

  // GET /api/stronghold/rooms — 列出所有房间
  router.get('/rooms', async (c) => {
    const facilityId = c.req.query('facilityId')
    const rooms = await ctx.strongholdService.listRooms(facilityId ? Number(facilityId) : undefined)

    // 附加每个房间的 Agent 列表
    const enriched = await Promise.all(
      rooms.map(async (room) => {
        const agents = await ctx.strongholdService.getRoomAgents(room.id)
        return { ...room, agents }
      }),
    )

    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: enriched })
  })

  // POST /api/stronghold/rooms — 创建房间
  router.post('/rooms', async (c) => {
    const body = await c.req.json()
    if (!body.facilityId || !body.name) {
      throw new AppError('VALIDATION_ERROR', { message: 'facilityId 和 name 为必填字段' })
    }
    const room = await ctx.strongholdService.createRoom(body)
    return c.json(
      { code: 'CREATED', message: __t('server.routers', '房间已创建'), data: room },
      201,
    )
  })

  // PUT /api/stronghold/rooms/:roomId — 更新房间
  router.put('/rooms/:roomId', async (c) => {
    const roomId = c.req.param('roomId')
    const body = await c.req.json()
    const room = await ctx.strongholdService.updateRoom(roomId, body)
    if (!room) {
      throw new AppError('NOT_FOUND', { message: `房间 ${roomId} 不存在` })
    }
    return c.json({ code: 'OK', message: __t('server.routers', '房间已更新'), data: room })
  })

  // DELETE /api/stronghold/rooms/:roomId — 删除房间
  router.delete('/rooms/:roomId', async (c) => {
    const roomId = c.req.param('roomId')
    await ctx.strongholdService.deleteRoom(roomId)
    return c.json({ code: 'OK', message: __t('server.routers', '房间已删除') })
  })

  // PUT /api/stronghold/rooms/:roomId/env — 更新环境变量
  router.put('/rooms/:roomId/env', async (c) => {
    const roomId = c.req.param('roomId')
    const body = await c.req.json()
    if (!body.key) {
      throw new AppError('VALIDATION_ERROR', { message: 'key 为必填字段' })
    }
    await ctx.strongholdService.updateEnvironment(roomId, body.key, body.value)
    return c.json({ code: 'OK', message: __t('server.routers', '环境变量已更新') })
  })

  // ═══ Agent 位置 ═══

  // POST /api/stronghold/locations/move — 移动 Agent
  router.post('/locations/move', async (c) => {
    const body = await c.req.json()
    if (!body.agentId || !body.roomId) {
      throw new AppError('VALIDATION_ERROR', { message: 'agentId 和 roomId 为必填字段' })
    }
    const agent = ctx.agentManager.listAgents().find((item) => item.id === body.agentId)
    if (!agent) throw new AppError('NOT_FOUND', { message: `Agent ${body.agentId} 不存在` })
    if (!agent.isEnabled) {
      throw new AppError('VALIDATION_ERROR', { message: `Agent ${body.agentId} 未启用` })
    }
    const location = await ctx.strongholdService.moveAgent(body.agentId, body.roomId)
    return c.json({ code: 'OK', message: __t('server.routers', 'Agent 已移动'), data: location })
  })

  // GET /api/stronghold/locations/:agentId — 获取 Agent 位置
  router.get('/locations/:agentId', async (c) => {
    const agentId = c.req.param('agentId')
    const room = await ctx.strongholdService.getAgentLocation(agentId)
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: room ?? null })
  })

  // ═══ 群聊消息 ═══

  // GET /api/stronghold/rooms/:roomId/projection — 房间、成员与消息 Surface 快照
  router.get('/rooms/:roomId/projection', async (c) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '100')))
      const projection = await ctx.strongholdProjection.getSnapshot(c.req.param('roomId'), limit)
      return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: projection })
    } catch (error) {
      throw new AppError('NOT_FOUND', {
        message: error instanceof Error ? error.message : '据点 Projection 不存在',
      })
    }
  })

  // GET /api/stronghold/rooms/:roomId/messages — 获取房间消息
  router.get('/rooms/:roomId/messages', async (c) => {
    const roomId = c.req.param('roomId')
    const limit = Number(c.req.query('limit') ?? '50')
    const messages = await ctx.groupChatService.getHistory(roomId, limit)
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: messages })
  })

  // GET /api/stronghold/rooms/:roomId/message-count — 获取房间消息数量（轻量计数）
  router.get('/rooms/:roomId/message-count', async (c) => {
    const roomId = c.req.param('roomId')
    const count = await ctx.groupChatService.countMessages(roomId)
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: { count } })
  })

  // POST /api/stronghold/rooms/:roomId/messages — 发送消息 + 触发调度
  router.post('/rooms/:roomId/messages', async (c) => {
    const roomId = c.req.param('roomId')
    const body = await c.req.json()

    if (!body.content) {
      throw new AppError('VALIDATION_ERROR', { message: 'content 为必填字段' })
    }

    // 空房间禁止发言。必须在保存消息前校验，避免绕过前端后留下无人接收的消息。
    const roomAgentIds = await ctx.strongholdService.getRoomAgents(roomId)
    const enabledAgentIds = new Set(
      ctx.agentManager
        .listAgents()
        .filter((agent) => agent.isEnabled)
        .map((agent) => agent.id),
    )
    const validRoomAgents = roomAgentIds.filter((agentId) => enabledAgentIds.has(agentId))
    if (validRoomAgents.length === 0) {
      throw new AppError('VALIDATION_ERROR', {
        message: '当前房间没有已启用的角色，无法发送消息',
      })
    }

    // 1. 保存消息。用户发言创建 pairId，让本轮所有异步回复可被精确级联删除。
    const pairId = (body.role ?? 'user') !== 'system' ? randomUUID() : undefined
    const msg = await ctx.groupChatService.sendMessage({
      roomId,
      senderId: body.senderId ?? 'user',
      content: body.content,
      role: body.role ?? 'user',
      mentions: body.mentions,
      pairId,
      requestReplies: true,
    })
    // 2. 系统消息不触发 Agent；用户消息同步完成调度决策，生成仍在后台执行。
    if (msg.role === 'system') {
      return c.json(
        {
          code: 'CREATED',
          message: __t('server.routers', '系统消息已发送'),
          data: { message: msg, replyQueued: false, reason: '系统消息不触发回复' },
        },
        201,
      )
    }

    const intent = await ctx.strongholdRoundService.prepare(msg.id)
    const initialQueue = intent?.initialQueue ?? []
    if (!initialQueue.length) {
      const reason = intent?.reason ?? __t('server.routers', '当前房间没有已启用的角色')
      logger.info(__t('logs.routers', '调度决定: 无人接话 ({0})', [reason]))
      return c.json(
        {
          code: 'CREATED',
          message: __t('server.routers', '消息已发送，但当前没有角色接话'),
          data: { message: msg, replyQueued: false, reason },
        },
        201,
      )
    }

    const roundId = pairId!
    if (msg.role === 'user') {
      for (const agentId of initialQueue) {
        const target = intent?.targets.find((entry) => entry.agentId === agentId)
        await ctx.companionSchedulerService.notifyActivity(agentId, target?.threadId, roomId).catch((error) =>
          logger.warn(__t('logs.companion', '保存主动行为活动时间失败'), { error }))
      }
    }
    void ctx.strongholdRoundService.kick(msg.id)

    return c.json(
      {
        code: 'CREATED',
        message:
          initialQueue.length > 1
            ? __t('server.routers', '消息已发送，成员将依次回复')
            : __t('server.routers', '消息已发送，角色正在回复'),
        data: {
          message: msg,
          roundId,
          replyQueued: true,
          agentId: initialQueue[0],
          agentIds: initialQueue,
          allAgentIds: intent?.allMention ? initialQueue : undefined,
          reason: intent?.reason,
        },
      },
      201,
    )
  })

  // DELETE /api/stronghold/rooms/:roomId/messages/:messageId — 级联删除本轮群聊消息
  router.delete('/rooms/:roomId/messages/:messageId', async (c) => {
    const roomId = c.req.param('roomId')
    const messageId = Number(c.req.param('messageId'))
    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new AppError('VALIDATION_ERROR', { message: 'messageId 必须为正整数' })
    }
    const room = await ctx.strongholdService.getRoom(roomId)
    if (!room) throw new AppError('NOT_FOUND', { message: `房间 ${roomId} 不存在` })

    try {
      const result = await ctx.groupChatService.deleteMessagePair(roomId, messageId)
      return c.json({
        code: 'OK',
        message:
          result.deletedCount > 1
            ? __t('server.routers', '已删除 {0} 条关联消息', [result.deletedCount])
            : __t('server.routers', '消息已删除'),
        data: result,
      })
    } catch (err) {
      throw new AppError('NOT_FOUND', {
        message: err instanceof Error ? err.message : '消息删除失败',
      })
    }
  })

  // GET /api/stronghold/rooms/:roomId/members — 获取房间成员
  router.get('/rooms/:roomId/members', async (c) => {
    const roomId = c.req.param('roomId')
    const members = await ctx.groupChatService.getRoomMembers(roomId)
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: members })
  })

  // POST /api/stronghold/rooms/:roomId/members — 添加成员
  router.post('/rooms/:roomId/members', async (c) => {
    const roomId = c.req.param('roomId')
    const body = await c.req.json()
    if (!body.agentId) {
      throw new AppError('VALIDATION_ERROR', { message: 'agentId 为必填字段' })
    }
    const agent = ctx.agentManager.getAgent(String(body.agentId))
    if (!agent || !ctx.agentManager.enabledAgents.has(agent.id)) {
      throw new AppError('VALIDATION_ERROR', {
        message: `Agent ${String(body.agentId)} 不存在或未启用，禁止加入据点房间`,
      })
    }
    await ctx.groupChatService.addMember(roomId, agent.id, body.role)
    return c.json({ code: 'OK', message: __t('server.routers', '成员已添加') })
  })

  // ═══ 管家 ═══

  // POST /api/stronghold/rooms/:roomId/butler-command — 执行确定性的管家命令
  router.post('/rooms/:roomId/butler-command', async (c) => {
    const roomId = c.req.param('roomId')
    const body = await c.req.json()
    if (!body.command && !body.action) {
      throw new AppError('VALIDATION_ERROR', { message: 'command 或 action 为必填字段' })
    }
    try {
      const result = await ctx.butlerService.execute({
        roomId,
        command: body.command,
        action: body.action,
        requesterId: body.requesterId ?? 'user',
      })
      return c.json({ code: 'OK', message: __t('server.routers', '管家命令已执行'), data: result })
    } catch (err) {
      throw new AppError('VALIDATION_ERROR', {
        message: err instanceof Error ? err.message : '管家命令执行失败',
      })
    }
  })

  // GET /api/stronghold/butler — 获取管家配置
  router.get('/butler', async (c) => {
    const config = await ctx.strongholdService.getButlerConfig()
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data: config })
  })

  // PUT /api/stronghold/butler/toggle — 切换管家启用
  router.put('/butler/toggle', async (c) => {
    const body = await c.req.json()
    await ctx.strongholdService.updateButlerEnabled(body.enabled ?? false)
    return c.json({ code: 'OK', message: __t('server.routers', '管家状态已更新') })
  })

  return router
}

// ── 局部导入的 logger (避免与模块级 logger 冲突) ──
import { createLogger as _createLogger } from '../lib/logger'
const logger = _createLogger('StrongholdRouter')
