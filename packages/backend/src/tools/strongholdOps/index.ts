import { t as __t } from '../../lib/i18n'
/**
 * strongholdOps — 据点空间管理工具
 *
 * 功能列表:
 * - stronghold_move_to_room     → 移动到房间
 * - stronghold_call_butler      → 呼叫管家
 * - stronghold_list_rooms       → 列出可用房间
 * - stronghold_get_room_info    → 查看房间详情
 * - stronghold_set_environment  → 调整环境变量
 *
 * 工具层通过注入的 StrongholdService 操作数据，
 * StrongholdService 已由 container.ts DI 注入。
 * 这些工具仅在 group 通道下通过 CapabilityGate 开放。
 *
 * @module packages/backend/src/tools/strongholdOps
 */

import type { BuiltinTool } from '../index'
import type { StrongholdService } from '../../services/stronghold/strongholdService'
import type { ButlerService } from '../../services/stronghold/butlerService'
import { createLogger } from '../../lib/logger'

const logger = createLogger('StrongholdOps')

// ─────────────────────────────────────────────
// Provider 注入
// ─────────────────────────────────────────────

/** 模块引用 */
let _strongholdService: StrongholdService | null = null
let _butlerService: ButlerService | null = null
let _canParticipate: (agentId: string) => boolean = () => true

/** 设置据点服务 */
export function setStrongholdService(service: StrongholdService | null, canParticipate: (agentId: string) => boolean = () => true): void {
  _strongholdService = service
  _canParticipate = canParticipate
}

/** 设置管家执行服务 */
export function setButlerService(service: ButlerService | null): void {
  _butlerService = service
}

/** 辅助: 检查 Service 可用性 */
function requireService(): StrongholdService | string {
  if (!_strongholdService) {
    return JSON.stringify({
      error: '据点服务未初始化。当前环境不支持据点操作。',
    })
  }
  return _strongholdService
}

// ─────────────────────────────────────────────
// stronghold_move_to_room — 移动到房间
// ─────────────────────────────────────────────

export const strongholdMoveToRoomTool: BuiltinTool = {
  name: 'stronghold_move_to_room',
  allowedSources: ['group'],

  async execute(args, ctx) {
    const service = requireService()
    if (typeof service === 'string') return service

    const roomName = args.room_name as string
    const agentId = ctx.agentId

    try {
      const room = await service.getRoomByName(roomName)
      if (!room) {
        // 列出可用房间作为提示
        const allRooms = await service.listRooms()
        const names = allRooms.map((r) => r.name).join('、')
        return JSON.stringify({
          error: `找不到名为 "${roomName}" 的房间`,
          available_rooms: names,
          hint: __t('server.tools', '可用房间: {0}', [names]),
        })
      }

      await service.moveAgent(agentId, room.id, { agentId: ctx.agentId, threadId: ctx.threadId, generation: ctx.generation, pairId: ctx.pairId,
        sourceMessageId: ctx.sceneSourceMessageId, operationId: ctx.toolCallId, signal: ctx.signal })

      // 获取房间内其他角色
      const agents = await service.getRoomAgents(room.id)
      const others = agents.filter((a) => a !== agentId)

      return JSON.stringify({
        success: true,
        message: __t('server.tools', '已移动到 "{0}"', [roomName]),
        room: {
          name: room.name,
          description: room.description,
          environment: JSON.parse(room.environmentJson ?? '{}'),
        },
        present_agents: others.length > 0 ? others : ['(空无一人)'],
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(__t('logs.tools', '移动到房间失败: {0}', [errMsg]))
      return JSON.stringify({ error: `移动失败: ${errMsg}` })
    }
  },
}

// ─────────────────────────────────────────────
// stronghold_list_rooms — 列出房间
// ─────────────────────────────────────────────

export const strongholdListRoomsTool: BuiltinTool = {
  name: 'stronghold_list_rooms',
  allowedSources: ['group'],

  async execute(_args, ctx) {
    const service = requireService()
    if (typeof service === 'string') return service

    try {
      const rooms = await service.listRooms()
      const agentId = ctx.agentId
      const accessibleRooms = rooms.filter((room) => service.canAgentEnterRoom(room, agentId))

      // 获取当前位置
      const currentRoom = await service.getAgentLocation(agentId)

      const roomList = await Promise.all(
        accessibleRooms.map(async (r) => {
          const agents = await service.getRoomAgents(r.id)
          return {
            name: r.name,
            description: r.description,
            agent_count: agents.length,
            is_current: currentRoom?.id === r.id,
          }
        }),
      )

      return JSON.stringify({
        success: true,
        rooms: roomList,
        current_room: currentRoom?.name ?? '(未定位)',
        total: roomList.length,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return JSON.stringify({ error: `列出房间失败: ${errMsg}` })
    }
  },
}

// ─────────────────────────────────────────────
// stronghold_get_room_info — 房间详情
// ─────────────────────────────────────────────

export const strongholdGetRoomInfoTool: BuiltinTool = {
  name: 'stronghold_get_room_info',
  allowedSources: ['group'],

  async execute(args, ctx) {
    const service = requireService()
    if (typeof service === 'string') return service

    try {
      let room
      const roomName = args.room_name as string | undefined

      if (roomName) {
        room = await service.getRoomByName(roomName)
      } else {
        room = await service.getAgentLocation(ctx.agentId)
      }

      if (!room) {
        return JSON.stringify({
          error: roomName ? `找不到房间 "${roomName}"` : '你当前没有在任何房间中',
        })
      }

      const agents = await service.getRoomAgents(room.id)
      const env = JSON.parse(room.environmentJson ?? '{}')

      return JSON.stringify({
        success: true,
        room: {
          name: room.name,
          description: room.description,
          environment: env,
          present_agents: agents,
        },
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return JSON.stringify({ error: `查看房间信息失败: ${errMsg}` })
    }
  },
}

// ─────────────────────────────────────────────
// stronghold_set_environment — 调整环境
// ─────────────────────────────────────────────

export const strongholdSetEnvironmentTool: BuiltinTool = {
  name: 'stronghold_set_environment',
  allowedSources: ['group'],

  async execute(args, ctx) {
    const service = requireService()
    if (typeof service === 'string') return service

    const key = args.key as string
    const value = args.value as string

    try {
      const room = await service.getAgentLocation(ctx.agentId)
      if (!room) {
        return JSON.stringify({ error: '你当前没有在任何房间中，无法调整环境。' })
      }

      // 尝试解析为数字
      const numValue = Number(value)
      await service.updateEnvironment(room.id, key, isNaN(numValue) ? value : numValue, {
        agentId: ctx.agentId, threadId: ctx.threadId, generation: ctx.generation, pairId: ctx.pairId,
        sourceMessageId: ctx.sceneSourceMessageId, operationId: ctx.toolCallId, signal: ctx.signal,
      })

      const env = JSON.parse((await service.getRoom(room.id))?.environmentJson ?? '{}')

      return JSON.stringify({
        success: true,
        message: __t('server.tools', '已将 "{0}" 的 {1} 调整为 {2}', [room.name, key, value]),
        current_environment: env,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return JSON.stringify({ error: `调整环境失败: ${errMsg}` })
    }
  },
}

// ─────────────────────────────────────────────
// stronghold_call_butler — 呼叫管家
// ─────────────────────────────────────────────

export const strongholdSummonAgentsTool: BuiltinTool = {
  name: 'stronghold_summon_agents',
  allowedSources: ['group'],

  async execute(args, ctx) {
    const service = requireService()
    if (typeof service === 'string') return service
    if (ctx.channel !== 'group') return JSON.stringify({ error: '该工具仅能在据点群聊中使用。' })

    const requested = Array.isArray(args.agent_ids) ? args.agent_ids : []
    const room = await service.getAgentLocation(ctx.agentId)
    if (!room) return JSON.stringify({ error: '调用角色当前不在任何据点房间中。' })
    const present = new Set(await service.getRoomAgents(room.id))
    const accepted = [
      ...new Set(
        requested.filter(
          (id): id is string => typeof id === 'string' && id !== ctx.agentId && present.has(id) && _canParticipate(id),
        ),
      ),
    ].slice(0, 5)
    const rejected = requested.filter(
      (id) => typeof id !== 'string' || id === ctx.agentId || !present.has(id) || !_canParticipate(id),
    )
    if (accepted.length === 0) {
      return JSON.stringify({
        error: '没有可传唤的有效角色。只能传唤当前房间内的其他角色。',
        present_agents: [...present],
        rejected,
      })
    }
    return JSON.stringify({
      success: true,
      queued_agent_ids: accepted,
      rejected,
      message: __t('server.tools', '已登记向{0}的接话请求。', [accepted.join('、')]),
    })
  },
}

export const strongholdCallButlerTool: BuiltinTool = {
  name: 'stronghold_call_butler',
  allowedSources: ['group'],

  async execute(args, ctx) {
    const service = requireService()
    if (typeof service === 'string') return service
    if (!_butlerService) return JSON.stringify({ error: '管家服务未初始化。' })

    const request = args.request as string

    try {
      const room = await service.getAgentLocation(ctx.agentId)
      if (!room) return JSON.stringify({ error: '调用 Agent 当前没有所在房间。' })

      logger.info(
        __t('logs.tools', '管家收到来自 {0} 的请求（房间: {1}）: {2}', [
          ctx.agentId,
          room.name,
          request,
        ]),
      )
      const result = await _butlerService.execute({
        roomId: room.id,
        command: request,
        requesterId: ctx.agentId,
        source: { agentId: ctx.agentId, threadId: ctx.threadId, generation: ctx.generation, pairId: ctx.pairId,
          sourceMessageId: ctx.sceneSourceMessageId, operationId: ctx.toolCallId, signal: ctx.signal },
      })
      return JSON.stringify({ success: true, ...result })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return JSON.stringify({ error: `呼叫管家失败: ${errMsg}` })
    }
  },
}
