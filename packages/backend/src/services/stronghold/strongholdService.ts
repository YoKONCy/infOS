import { t as __t } from '../../lib/i18n'
/**
 * Stronghold Service — 据点管理服务
 *
 * 据点系统 的核心 CRUD 服务:
 * - Facility (设施) 管理
 * - Room (房间) 管理 (含环境变量)
 * - Agent 位置管理 (当前在哪个房间)
 * - Butler (管家) 配置
 * - 初始化确保默认数据存在
 *
 * 每个 Room 通过相同 ID 关联一个 GroupChatRoom。
 *
 * @module packages/backend/src/services/stronghold/strongholdService
 */

import { and, eq, sql } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { AppError } from '../../lib/appError'
import {
  strongholdFacilities,
  strongholdRooms,
  agentLocations,
  butlerConfigs,
  groupChatRooms,
  groupChatMembers,
} from '../../database/schema'
import type { DrizzleDb } from '../../database'
import { createLogger } from '../../lib/logger'

const logger = createLogger('StrongholdService')

// ── 类型 ──

type FacilityRow = typeof strongholdFacilities.$inferSelect
type RoomRow = typeof strongholdRooms.$inferSelect
type LocationRow = typeof agentLocations.$inferSelect
type ButlerRow = typeof butlerConfigs.$inferSelect
export interface StrongholdOperationSource {
  agentId?: string
  threadId: string
  generation?: number
  pairId?: string
  sourceMessageId?: number
  operationId?: string
  signal?: AbortSignal
}
export interface StrongholdSceneChange {
  roomId: string
  actorId: string
  kind: 'arrival' | 'departure' | 'environment'
  key?: string
  before?: unknown
  after?: unknown
  audience?: string[]
  source?: StrongholdOperationSource
}

export interface CreateFacilityInput {
  name: string
  description?: string
  icon?: string
}

export interface CreateRoomInput {
  facilityId: number
  name: string
  description?: string
  allowedAgents?: string[]
  environment?: Record<string, unknown>
}

// ── Service ──

export class StrongholdService {
  private onLifeChange?: (change: StrongholdSceneChange) => void
  setLifeLifecycle(callback: (change: StrongholdSceneChange) => void): void { this.onLifeChange = callback }
  constructor(
    private db: DrizzleDb,
    private isRegisteredAgent: (agentId: string) => boolean,
  ) {}

  // ─── 初始化 ───

  /**
   * 确保据点系统有默认数据 (启动时调用)
   *
   * 1. 默认设施 "我的据点"
   * 2. 默认房间 "客厅"
   * 3. 无房间的 Agent 归位到客厅
   */
  async ensureDefaults(agentIds: string[] = []): Promise<void> {
    logger.info(__t('logs.stronghold', '检查据点默认数据...'))

    // 1. 确保默认设施
    let facility = await this.getFacilityByName('我的据点')
    if (!facility) {
      facility = await this.createFacility({
        name: '我的据点',
        description: __t('server.stronghold', '温馨的家'),
        icon: 'HomeFilled',
      })
      logger.info(__t('logs.stronghold', '已创建默认设施: 我的据点'))
    }

    // 2. 确保默认房间 (客厅)
    let livingRoom = await this.getRoomByName('客厅')
    if (!livingRoom) {
      livingRoom = await this.createRoom({
        facilityId: facility.id,
        name: '客厅',
        description: __t('server.stronghold', '宽敞明亮的公共区域，适合大家聚在一起。'),
        environment: { 光照: 80, 温度: 24, 音乐: 'Relaxing Piano', 清洁度: 100 },
      })
      logger.info(__t('logs.stronghold', '已创建默认房间: 客厅'))
    }

    await this.removeUnknownAgentRecords()
    for (const agentId of new Set(agentIds)) {
      await this.ensureAgentLocation(agentId, livingRoom.id)
    }

    logger.info(__t('logs.stronghold', '据点默认数据检查完成'))
  }

  private async removeUnknownAgentRecords(): Promise<void> {
    const locations = await this.db.select().from(agentLocations).all()
    const invalidIds = locations
      .map((location) => location.agentId)
      .filter((agentId) => !this.isRegisteredAgent(agentId))
    for (const agentId of invalidIds) {
      await this.db.delete(agentLocations).where(eq(agentLocations.agentId, agentId))
    }

    const memberships = await this.db.select().from(groupChatMembers).all()
    for (const member of memberships) {
      if (member.agentId === 'system' || member.agentId === 'user') continue
      if (!this.isRegisteredAgent(member.agentId)) {
        await this.db.delete(groupChatMembers).where(eq(groupChatMembers.id, member.id))
      }
    }
    if (invalidIds.length > 0) {
      logger.warn(__t('logs.stronghold', '已清理未知据点角色记录: {0}', [invalidIds.join('、')]))
    }
  }

  // ─── 设施管理 ───

  async createFacility(input: CreateFacilityInput): Promise<FacilityRow> {
    const rows = await this.db
      .insert(strongholdFacilities)
      .values({
        name: input.name,
        description: input.description,
        icon: input.icon,
      })
      .returning()
    return rows[0]!
  }

  async listFacilities(): Promise<FacilityRow[]> {
    return this.db.select().from(strongholdFacilities).all()
  }

  async getFacility(facilityId: number): Promise<FacilityRow | undefined> {
    return this.db
      .select()
      .from(strongholdFacilities)
      .where(eq(strongholdFacilities.id, facilityId))
      .get()
  }

  async getFacilityByName(name: string): Promise<FacilityRow | undefined> {
    return this.db
      .select()
      .from(strongholdFacilities)
      .where(eq(strongholdFacilities.name, name))
      .get()
  }

  // ─── 房间管理 ───

  /**
   * 创建房间 (同时创建关联的 GroupChatRoom + 默认成员)
   */
  async createRoom(input: CreateRoomInput): Promise<RoomRow> {
    const facility = await this.getFacility(input.facilityId)
    if (!facility) {
      throw new AppError('NOT_FOUND', { message: `设施 ${input.facilityId} 不存在` })
    }

    const roomId = uuidv4()
    const allowedAgents = [...new Set(input.allowedAgents ?? [])]
    const invalidAgents = allowedAgents.filter((agentId) => !this.isRegisteredAgent(agentId))
    if (invalidAgents.length > 0) {
      throw new AppError('VALIDATION_ERROR', {
        message: `房间成员只能使用已注册角色：${invalidAgents.join('、')}`,
      })
    }

    // 1. 创建据点房间
    await this.db.insert(strongholdRooms).values({
      id: roomId,
      facilityId: input.facilityId,
      name: input.name,
      description: input.description,
      allowedAgentsJson: JSON.stringify(allowedAgents),
      environmentJson: JSON.stringify(input.environment ?? {}),
    })

    // 2. 创建关联的群聊房间
    await this.db.insert(groupChatRooms).values({
      id: roomId,
      name: input.name,
      description: input.description,
      creatorId: 'system',
    })

    // 3. 添加系统 + 用户为默认成员
    await this.db.insert(groupChatMembers).values([
      { roomId, agentId: 'system', role: 'admin' },
      { roomId, agentId: 'user', role: 'member' },
    ])

    // 4. 添加允许的 Agent
    if (allowedAgents.length > 0) {
      await this.db.insert(groupChatMembers).values(
        allowedAgents.map((agentId) => ({
          roomId,
          agentId,
          role: 'member' as const,
        })),
      )
    }

    const room = await this.db
      .select()
      .from(strongholdRooms)
      .where(eq(strongholdRooms.id, roomId))
      .get()
    return room!
  }

  async getRoom(roomId: string): Promise<RoomRow | undefined> {
    return this.db.select().from(strongholdRooms).where(eq(strongholdRooms.id, roomId)).get()
  }

  async getRoomByName(name: string): Promise<RoomRow | undefined> {
    return this.db.select().from(strongholdRooms).where(eq(strongholdRooms.name, name)).get()
  }

  async listRooms(facilityId?: number): Promise<RoomRow[]> {
    if (facilityId !== undefined) {
      return this.db
        .select()
        .from(strongholdRooms)
        .where(eq(strongholdRooms.facilityId, facilityId))
        .all()
    }
    return this.db.select().from(strongholdRooms).all()
  }

  async updateRoom(
    roomId: string,
    updates: Partial<
      Pick<RoomRow, 'name' | 'description' | 'allowedAgentsJson' | 'environmentJson'>
    >,
  ): Promise<RoomRow | undefined> {
    const rows = await this.db
      .update(strongholdRooms)
      .set(updates)
      .where(eq(strongholdRooms.id, roomId))
      .returning()
    return rows[0]
  }

  /**
   * 删除房间 (客厅不能删除)
   *
   * 房间内的 Agent 自动移到客厅。
   */
  async deleteRoom(roomId: string): Promise<void> {
    const room = await this.getRoom(roomId)
    if (!room) throw new AppError('NOT_FOUND', { message: `房间 ${roomId} 不存在` })
    if (room.name === '客厅') {
      throw new AppError('FORBIDDEN', { message: '客厅不能被删除' })
    }

    // 将该房间内的 Agent 移到客厅
    const livingRoom = await this.getRoomByName('客厅')
    if (livingRoom) {
      const agents = await this.getRoomAgents(roomId)
      for (const agentId of agents) {
        await this.moveAgent(agentId, livingRoom.id)
      }
    }

    // 删除据点房间
    await this.db.delete(strongholdRooms).where(eq(strongholdRooms.id, roomId))
    // 群聊房间保留 (允许查看历史消息)

    logger.info(__t('logs.stronghold', '房间已删除: {0}', [room.name]))
  }

  // ─── 环境变量 ───

  async updateEnvironment(roomId: string, key: string, value: unknown, source?: StrongholdOperationSource): Promise<void> {
    const room = await this.getRoom(roomId)
    if (!room) throw new AppError('NOT_FOUND', { message: `房间 ${roomId} 不存在` })

    this.db.transaction((tx) => {
      const current = tx.select().from(strongholdRooms).where(eq(strongholdRooms.id, roomId)).get()!
      const env = JSON.parse(current.environmentJson ?? '{}') as Record<string, unknown>
      const before = env[key]
      if (JSON.stringify(before) === JSON.stringify(value)) return
      env[key] = value
      tx.update(strongholdRooms).set({ environmentJson: JSON.stringify(env) }).where(eq(strongholdRooms.id, roomId)).run()
      this.onLifeChange?.({ roomId, actorId: 'user', kind: 'environment', key, before, after: value, source })
    })
  }

  // ─── Agent 位置 ───

  async ensureAgentLocation(agentId: string, livingRoomId?: string): Promise<LocationRow> {
    this.requireRegisteredAgent(agentId)
    const existing = await this.db
      .select()
      .from(agentLocations)
      .where(eq(agentLocations.agentId, agentId))
      .get()
    if (existing) {
      await this.ensureRoomMember(existing.roomId, agentId)
      return existing
    }

    const livingRoom = livingRoomId
      ? await this.getRoom(livingRoomId)
      : await this.getRoomByName('客厅')
    if (!livingRoom) {
      throw new AppError('CONFIG_ERROR', { message: '客厅尚未初始化' })
    }
    return this.moveAgent(agentId, livingRoom.id)
  }

  private async ensureRoomMember(roomId: string, agentId: string): Promise<void> {
    const members = await this.db
      .select()
      .from(groupChatMembers)
      .where(eq(groupChatMembers.roomId, roomId))
      .all()
    if (!members.some((member) => member.agentId === agentId)) {
      await this.db.insert(groupChatMembers).values({ roomId, agentId, role: 'member' })
    }
  }

  /** 判断角色是否允许进入房间；空白名单表示全部已注册角色可进入。 */
  canAgentEnterRoom(room: RoomRow, agentId: string): boolean {
    try {
      const allowedAgents = JSON.parse(room.allowedAgentsJson ?? '[]') as unknown
      return (
        Array.isArray(allowedAgents) &&
        (allowedAgents.length === 0 || allowedAgents.includes(agentId))
      )
    } catch {
      logger.warn(
        __t('logs.stronghold', '房间 {0} 的角色白名单格式无效，已按禁止进入处理', [room.id]),
      )
      return false
    }
  }

  async moveAgent(agentId: string, roomId: string, source?: StrongholdOperationSource): Promise<LocationRow> {
    this.requireRegisteredAgent(agentId)
    const room = await this.getRoom(roomId)
    if (!room) throw new AppError('NOT_FOUND', { message: `房间 ${roomId} 不存在` })
    if (!this.canAgentEnterRoom(room, agentId)) {
      throw new AppError('FORBIDDEN', {
        message: `Agent ${agentId} 不允许进入房间「${room.name}」`,
      })
    }

    // 位置与成员资格一起提交，消息事务据此固定实际在场者。
    const location = this.db.transaction((tx) => {
      const previous = tx.select().from(agentLocations).where(eq(agentLocations.agentId, agentId)).get()
      const previousAudience = previous ? tx.select({ agentId: agentLocations.agentId }).from(agentLocations)
        .where(eq(agentLocations.roomId, previous.roomId)).all().map((entry) => entry.agentId) : []
      const membership = tx.select().from(groupChatMembers).where(and(
        eq(groupChatMembers.agentId, agentId),
        eq(groupChatMembers.roomId, roomId),
      )).get()
      tx.delete(groupChatMembers).where(eq(groupChatMembers.agentId, agentId)).run()
      tx.insert(groupChatMembers).values({ roomId, agentId, role: membership?.role ?? 'member' }).run()
      const updated = tx.insert(agentLocations)
        .values({ agentId, roomId })
        .onConflictDoUpdate({
          target: agentLocations.agentId,
          set: { roomId, updatedAt: sql`datetime('now', 'localtime')` },
        })
        .returning().get()!
      if (previous?.roomId !== roomId) {
        if (previous) this.onLifeChange?.({ roomId: previous.roomId, actorId: agentId, kind: 'departure',
          before: previous.roomId, after: roomId, audience: previousAudience, source })
        this.onLifeChange?.({ roomId, actorId: agentId, kind: 'arrival', before: previous?.roomId, after: roomId, source })
      }
      return updated
    })

    logger.debug(__t('logs.stronghold', 'Agent {0} 移动到房间 {1}', [agentId, room.name]))
    return location!
  }

  async getAgentLocation(agentId: string): Promise<RoomRow | undefined> {
    const location = await this.db
      .select()
      .from(agentLocations)
      .where(eq(agentLocations.agentId, agentId))
      .get()

    if (!location) return undefined
    return this.getRoom(location.roomId)
  }

  async getRoomAgents(roomId: string): Promise<string[]> {
    const locations = await this.db
      .select({ agentId: agentLocations.agentId })
      .from(agentLocations)
      .where(eq(agentLocations.roomId, roomId))
      .all()
    return locations.map((l) => l.agentId)
  }

  private requireRegisteredAgent(agentId: string): void {
    if (!this.isRegisteredAgent(agentId)) {
      throw new AppError('VALIDATION_ERROR', {
        message: `Agent ${agentId} 不存在，禁止创建据点位置或成员记录`,
      })
    }
  }

  // ─── 管家配置 ───

  async getButlerConfig(): Promise<ButlerRow> {
    let config = await this.db.select().from(butlerConfigs).get()

    if (!config) {
      const rows = await this.db
        .insert(butlerConfigs)
        .values({
          name: 'Butler',
          persona: '你是据点的 AI 管家，负责管理设施和房间。',
          enabled: true,
        })
        .returning()
      config = rows[0]!
    }

    return config
  }

  async updateButlerEnabled(enabled: boolean): Promise<void> {
    const config = await this.getButlerConfig()
    await this.db.update(butlerConfigs).set({ enabled }).where(eq(butlerConfigs.id, config.id))
  }
}
