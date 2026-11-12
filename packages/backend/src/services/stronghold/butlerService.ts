import { t as __t } from '../../lib/i18n'
/**
 * Butler Service — 据点管家服务 (LLM 增强版)
 *
 * 管家是一个"有自己提示词的普通 LLM"（不是 Agent 角色），负责：
 * - 理解用户/Agent 的自然语言请求
 * - 生成第三人称旁白，增强据点生活气息
 * - 产出结构化维护指令 (maintenance_actions)，由确定性引擎安全执行
 *
 * 执行策略（三层兜底）：
 * 1. 显式结构化 action → 直接确定性执行（工具调用路径）
 * 2. LLM 理解（复用主模型 + mdp 管家提示词）→ 旁白 + 维护指令
 * 3. LLM 失败 / 无效 JSON / 未配置模型 → 回退规则引擎 mapCommand
 *
 * 安全机制：
 * - 动作白名单（仅 update_environment / move_agent / create_room / delete_room 等）
 * - 「客厅」绝对禁止删除（mapper + runAction 双重校验）
 * - 单条动作执行失败不阻断其余动作，逐条记录结果
 * - 全部动作失败且无旁白时抛错，让调用方可见失败原因
 *
 * @module packages/backend/src/services/stronghold/butlerService
 */

import type { AgentManager } from '../agent/agentManager'
import type { GroupChatService } from './groupChatService'
import type { CreateRoomInput, StrongholdService, StrongholdOperationSource } from './strongholdService'
import type { LlmService, ModelConfig } from '../llm/llmService'
import type { MdpEngine } from '../prompt/mdpEngine'
import { parseLlmJson } from '../../shared/llmJsonParser'
import { createLogger } from '../../lib/logger'

const logger = createLogger('ButlerService')

/** 单次管家请求最多执行的结构化动作数（防止 LLM 批量轰炸） */
const MAX_ACTIONS = 4
/** 旁白最大长度（截断保护） */
const MAX_NARRATIVE_LENGTH = 500

export type ButlerAction =
  | { type: 'status' }
  | { type: 'inspect_environment' }
  | { type: 'summon_all' }
  | { type: 'move_agent'; agentId: string; targetRoomId?: string }
  | { type: 'create_room'; room: CreateRoomInput }
  | { type: 'update_environment'; key: string; value: unknown; targetRoomId?: string }
  | { type: 'delete_room'; roomId: string }

export interface ButlerCommandInput {
  roomId: string
  command?: string
  action?: ButlerAction
  requesterId?: string
  source?: StrongholdOperationSource
}

export interface ButlerCommandResult {
  action: ButlerAction['type']
  message: string
  data?: unknown
}

/** LLM 能力依赖（复用主模型；不注入则自动退化为规则引擎） */
export interface ButlerLlmDeps {
  mdpEngine: MdpEngine
  llmService: LlmService
  getModelConfig: () => Promise<ModelConfig | null>
}

/** LLM 输出的单个维护动作（名称与 params 均来自提示词约定） */
interface LlmMaintenanceAction {
  action: string
  params: Record<string, unknown>
}

/** LLM 理解结果 */
interface LlmButlerPlan {
  narrative: string
  actions: LlmMaintenanceAction[]
}

export class ButlerService {
  constructor(
    private strongholdService: StrongholdService,
    private groupChatService: GroupChatService,
    private agentManager: AgentManager,
    private llmDeps?: ButlerLlmDeps,
  ) {}

  async execute(input: ButlerCommandInput): Promise<ButlerCommandResult> {
    const room = await this.strongholdService.getRoom(input.roomId)
    if (!room) throw new Error(`房间 ${input.roomId} 不存在`)

    const config = await this.strongholdService.getButlerConfig()
    if (!config.enabled) throw new Error('管家服务当前已关闭')

    const requestText = input.command?.trim() || this.describeAction(input.action)
    if (!requestText) throw new Error('command 或 action 为必填字段')

    // 1. 用户请求落库为可见的 system 消息
    await this.groupChatService.sendMessage({
      roomId: input.roomId,
      senderId: input.requesterId ?? 'user',
      role: 'system',
      content: `管家请求：${requestText}`,
    })

    // 2. 解析维护动作：结构化 action 优先；否则走 LLM 理解，失败回退规则引擎
    let actions: ButlerAction[]
    let narrative = ''
    if (input.action) {
      actions = [input.action]
    } else {
      const plan = await this.tryLlmPlan(input.roomId, room, requestText)
      if (plan) {
        narrative = plan.narrative
        actions = await this.mapLlmActions(input.roomId, plan.actions)
      } else {
        // 规则引擎兜底：至少能响应状态/环境/召唤等固定指令
        actions = [this.mapCommand(requestText)]
      }
    }

    // 3. 逐条执行，单条失败不阻断；汇总旁白 + 执行结果
    const lines: string[] = []
    if (narrative) lines.push(narrative)
    let successCount = 0
    if (actions.length === 0) {
      lines.push('管家没有需要执行的维护操作。')
    } else {
      for (const action of actions) {
        try {
          const result = await this.runAction(input.roomId, action, input.source)
          lines.push(result.message)
          successCount++
        } catch (err) {
          lines.push(`执行失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    const summary = lines.join('\n')

    // 全部失败且无旁白 → 视为失败并抛错，让调用方（前端 toast / 工具调用）可见
    if (actions.length > 0 && successCount === 0 && !narrative) {
      throw new Error(summary || '管家执行失败')
    }

    // 4. 结果回写群聊历史（以管家身份）
    await this.groupChatService.sendMessage({
      roomId: input.roomId,
      senderId: 'butler',
      role: 'system',
      content: summary,
    })

    return {
      action: actions[0]?.type ?? 'status',
      message: summary,
      data: { narrative, actions: actions.map((action) => action.type) },
    }
  }

  // ─────────────────────────────────────────
  // LLM 理解层
  // ─────────────────────────────────────────

  /**
   * 尝试用 LLM 理解管家请求。
   * 返回 null 表示应回退规则引擎（未配置模型 / LLM 失败 / JSON 无效）。
   */
  private async tryLlmPlan(
    roomId: string,
    room: { name: string; description?: string | null; environmentJson?: string | null },
    requestText: string,
  ): Promise<LlmButlerPlan | null> {
    if (!this.llmDeps) return null
    try {
      const modelConfig = await this.llmDeps.getModelConfig()
      if (!modelConfig) {
        logger.warn(__t('logs.stronghold', '未配置主模型，管家回退规则引擎'))
        return null
      }

      const promptSnapshot = this.llmDeps.mdpEngine.capturePromptSnapshot?.()
      const persona = this.llmDeps.mdpEngine.render(
        'group/butler/persona',
        { channel: 'group' },
        promptSnapshot,
      )

      const rooms = await this.strongholdService.listRooms()
      const agents = this.agentManager.listAgents()
      const roomDetails = await Promise.all(
        rooms.map(async (item) => ({
          name: item.name,
          description: item.description ?? '',
          agents: await this.strongholdService.getRoomAgents(item.id),
        })),
      )
      const history = await this.groupChatService.getHistory(roomId, 20)
      const environment = (() => {
        try {
          return JSON.parse(room.environmentJson ?? '{}') as Record<string, unknown>
        } catch {
          return {}
        }
      })()

      const prompt = this.llmDeps.mdpEngine.render(
        'group/butler/narrate_and_maintain',
        {
          persona,
          channel: 'group',
          agent_name: inputRequesterLabel(requestText),
          user_query: requestText,
          all_rooms_list: roomDetails
            .map(
              (item) =>
                `- ${item.name}${item.description ? `：${item.description}` : ''}${item.agents.length ? ` (成员: ${item.agents.join('、')})` : ''}`,
            )
            .join('\n'),
          all_agents_status: agents
            .map((agent) => `- ${agent.name} (${agent.isEnabled ? '已启用' : '未启用'})`)
            .join('\n'),
          current_room_name: room.name,
          stronghold_environment: JSON.stringify(environment),
          flattened_group_history: history
            .slice(-10)
            .map((message) => `[${message.senderId}] ${message.content}`)
            .join('\n'),
        },
        promptSnapshot,
      )

      const completion = await this.llmDeps.llmService.chat(
        modelConfig,
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `请响应管家请求："${requestText}"` },
        ],
        { responseFormat: { type: 'json_object' } },
      )

      const rawContent = completion.choices[0]?.message?.content ?? ''
      if (!rawContent) return null

      const parsed = parseLlmJson<{
        narrative?: unknown
        maintenance_actions?: unknown
      }>(rawContent)
      if (!parsed || typeof parsed !== 'object') {
        logger.warn(__t('logs.stronghold', '管家 LLM 返回的 JSON 解析失败，回退规则引擎'))
        return null
      }

      const rawActions = Array.isArray(parsed.maintenance_actions) ? parsed.maintenance_actions : []
      const actions: LlmMaintenanceAction[] = rawActions
        .slice(0, MAX_ACTIONS)
        .filter((item): item is LlmMaintenanceAction =>
          Boolean(
            item &&
            typeof item === 'object' &&
            typeof (item as { action?: unknown }).action === 'string',
          ),
        )
        .map((item) => ({
          action: (item as { action: string }).action,
          params: (item as { params?: Record<string, unknown> }).params ?? {},
        }))

      const narrative =
        typeof parsed.narrative === 'string'
          ? parsed.narrative.trim().slice(0, MAX_NARRATIVE_LENGTH)
          : ''
      return { narrative, actions }
    } catch (err) {
      logger.error(__t('logs.stronghold', '管家 LLM 理解失败，回退规则引擎: {0}', [err]))
      return null
    }
  }

  /**
   * 把 LLM 输出的维护指令映射为确定性 ButlerAction（含安全校验）。
   * 未知动作 / 非法参数 / 危险目标（客厅）一律丢弃，不进入执行层。
   */
  private async mapLlmActions(
    roomId: string,
    actions: LlmMaintenanceAction[],
  ): Promise<ButlerAction[]> {
    const mapped: ButlerAction[] = []
    for (const item of actions) {
      const params = item.params ?? {}
      try {
        switch (item.action) {
          case 'update_room_env': {
            const roomName = String(params.room_name ?? '').trim()
            const target = roomName
              ? await this.strongholdService.getRoomByName(roomName)
              : await this.strongholdService.getRoom(roomId)
            const key = String(params.key ?? '').trim()
            const value = params.value
            if (!target || !key || value === undefined || String(value).length > 40) break
            mapped.push({ type: 'update_environment', key, value, targetRoomId: target.id })
            break
          }
          case 'move_agent': {
            const agentId = String(params.agent_id ?? '')
            const agent = this.findEnabledAgent(agentId)
            const targetRoomName = String(params.target_room ?? '').trim()
            const targetRoom = targetRoomName
              ? await this.strongholdService.getRoomByName(targetRoomName)
              : undefined
            mapped.push({ type: 'move_agent', agentId: agent.id, targetRoomId: targetRoom?.id })
            break
          }
          case 'create_room': {
            const name = String(params.name ?? '').trim()
            if (!name) break
            if (await this.strongholdService.getRoomByName(name)) {
              logger.warn(__t('logs.stronghold', '管家要创建的房间已存在: {0}', [name]))
              break
            }
            const facilityName = String(params.facility_name ?? '我的据点').trim()
            const facility = await this.strongholdService.getFacilityByName(facilityName)
            if (!facility) break
            mapped.push({
              type: 'create_room',
              room: {
                facilityId: facility.id,
                name,
                description: String(params.description ?? '')
                  .trim()
                  .slice(0, 120),
              },
            })
            break
          }
          case 'delete_room': {
            const roomName = String(params.room_name ?? '').trim()
            if (!roomName || roomName === '客厅') {
              logger.warn(__t('logs.stronghold', '管家尝试删除「客厅」或空房间名，已拒绝'))
              break
            }
            const target = await this.strongholdService.getRoomByName(roomName)
            if (!target) break
            mapped.push({ type: 'delete_room', roomId: target.id })
            break
          }
          default:
            logger.warn(__t('logs.stronghold', '管家 LLM 返回未知动作，已忽略: {0}', [item.action]))
        }
      } catch (err) {
        logger.warn(
          __t('logs.stronghold', '管家维护指令映射失败，已跳过: {0} ({1})', [item.action, err]),
        )
      }
    }
    return mapped
  }

  // ─────────────────────────────────────────
  // 规则引擎（兜底）
  // ─────────────────────────────────────────

  private mapCommand(command: string): ButlerAction {
    const normalized = command.trim()
    if (/^(查看|检查).*(据点)?状态$/.test(normalized)) return { type: 'status' }
    if (/^(扫描|检查).*房间环境$/.test(normalized)) return { type: 'inspect_environment' }
    if (/把所有(已启用)?(成员|Agent|智能体|角色).*叫到(这里|当前房间)/i.test(normalized)) {
      return { type: 'summon_all' }
    }

    const summon = normalized.match(/^把\s*(.+?)\s*叫到(这里|当前房间)(来)?$/i)
    if (summon?.[1]) return { type: 'move_agent', agentId: summon[1].trim() }

    throw new Error('无法识别该管家指令，请使用快捷指令或更具体的描述')
  }

  // ─────────────────────────────────────────
  // 确定性执行层（安全）
  // ─────────────────────────────────────────

  private async runAction(roomId: string, action: ButlerAction, source?: StrongholdOperationSource): Promise<ButlerCommandResult> {
    switch (action.type) {
      case 'status': {
        const facilities = await this.strongholdService.listFacilities()
        const rooms = await this.strongholdService.listRooms()
        const details = await Promise.all(
          rooms.map(async (room) => ({
            id: room.id,
            name: room.name,
            agents: await this.strongholdService.getRoomAgents(room.id),
            environment: JSON.parse(room.environmentJson ?? '{}') as Record<string, unknown>,
          })),
        )
        return {
          action: action.type,
          message: __t('server.stronghold', '据点状态：{0} 个设施，{1} 个房间。{2}', [
            facilities.length,
            rooms.length,
            details.map((item) => `${item.name}（${item.agents.join('、') || '无人'}）`).join('；'),
          ]),
          data: { facilities, rooms: details },
        }
      }
      case 'inspect_environment': {
        const room = await this.requireRoom(roomId)
        const environment = JSON.parse(room.environmentJson ?? '{}') as Record<string, unknown>
        return {
          action: action.type,
          message: __t('server.stronghold', '当前房间「{0}」环境：{1}', [
            room.name,
            JSON.stringify(environment),
          ]),
          data: { roomId: room.id, roomName: room.name, environment },
        }
      }
      case 'summon_all': {
        const agents = this.agentManager.listAgents().filter((agent) => agent.isEnabled)
        await Promise.all(agents.map((agent) => this.strongholdService.moveAgent(agent.id, roomId, source)))
        return {
          action: action.type,
          message: __t('server.stronghold', '已将所有已启用 Agent 叫到当前房间：{0}', [
            agents.map((agent) => agent.name).join('、') || '无',
          ]),
          data: { agentIds: agents.map((agent) => agent.id), roomId },
        }
      }
      case 'move_agent': {
        const agent = this.findEnabledAgent(action.agentId)
        const targetRoomId = action.targetRoomId ?? roomId
        const targetRoom = await this.requireRoom(targetRoomId)
        const location = await this.strongholdService.moveAgent(agent.id, targetRoomId, source)
        return {
          action: action.type,
          message: __t('server.stronghold', '已将 {0} 叫到「{1}」。', [
            agent.name,
            targetRoom.name,
          ]),
          data: location,
        }
      }
      case 'create_room': {
        // 双重校验：mapper 已查重，结构化路径在此兜底
        if (await this.strongholdService.getRoomByName(action.room.name)) {
          throw new Error(`房间「${action.room.name}」已存在`)
        }
        const created = await this.strongholdService.createRoom(action.room)
        return {
          action: action.type,
          message: __t('server.stronghold', '已创建房间「{0}」。', [created.name]),
          data: created,
        }
      }
      case 'update_environment': {
        const targetRoomId = action.targetRoomId ?? roomId
        const targetRoom = await this.requireRoom(targetRoomId)
        if (!action.key || String(action.value ?? '').length > 40) {
          throw new Error('环境变量参数不合法')
        }
        await this.strongholdService.updateEnvironment(targetRoomId, action.key, action.value, source)
        const updated = await this.requireRoom(targetRoomId)
        return {
          action: action.type,
          message: __t('server.stronghold', '已将「{0}」的 {1} 修改为 {2}。', [
            targetRoom.name,
            action.key,
            String(action.value),
          ]),
          data: { roomId: targetRoomId, environment: JSON.parse(updated.environmentJson ?? '{}') },
        }
      }
      case 'delete_room': {
        const target = await this.requireRoom(action.roomId)
        // 硬性安全红线：客厅绝不允许删除
        if (target.name === '客厅') throw new Error('客厅不能被删除')
        await this.strongholdService.deleteRoom(action.roomId)
        return {
          action: action.type,
          message: __t('server.stronghold', '已删除房间「{0}」，其中的角色已转移到客厅。', [
            target.name,
          ]),
          data: { roomId: action.roomId },
        }
      }
    }
  }

  private findEnabledAgent(identifier: string) {
    const normalized = identifier.trim().toLocaleLowerCase()
    const agent = this.agentManager
      .listAgents()
      .find(
        (candidate) =>
          candidate.id.toLocaleLowerCase() === normalized ||
          candidate.name.toLocaleLowerCase() === normalized,
      )
    if (!agent) throw new Error(`Agent ${identifier} 不存在`)
    if (!agent.isEnabled) throw new Error(`Agent ${agent.name} 未启用`)
    return agent
  }

  private async requireRoom(roomId: string) {
    const room = await this.strongholdService.getRoom(roomId)
    if (!room) throw new Error(`房间 ${roomId} 不存在`)
    return room
  }

  private describeAction(action?: ButlerAction): string {
    if (!action) return ''
    switch (action.type) {
      case 'status':
        return '查看当前据点状态'
      case 'inspect_environment':
        return '扫描当前房间环境'
      case 'summon_all':
        return '把所有已启用 Agent 叫到当前房间'
      case 'move_agent':
        return `移动 Agent ${action.agentId}`
      case 'create_room':
        return `创建房间 ${action.room.name}`
      case 'update_environment':
        return `修改环境 ${action.key}=${String(action.value)}`
      case 'delete_room':
        return `删除房间 ${action.roomId}`
    }
  }
}

/** 旁白模板中请求者显示名（UI 场景统一显示为用户） */
function inputRequesterLabel(_requestText: string): string {
  return '用户'
}
