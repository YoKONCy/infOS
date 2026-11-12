import { t as __t } from '../i18n/index'
/**
 * useStronghold — 据点管理 composable
 *
 * 将 strongholdApi 封装为响应式状态:
 * - 设施/房间列表加载
 * - 当前选中设施/房间
 * - Agent 状态
 * - 管家配置
 * - 群聊消息轮询
 *
 * @module packages/frontend/src/composables/useStronghold
 */

import type { StrongholdProjectionSnapshot } from '@infos/shared'
import {
  inject,
  ref,
  shallowRef,
  computed,
  watch,
  onActivated,
  onDeactivated,
  onMounted,
  onUnmounted,
} from 'vue'
import { strongholdApi } from '../api/modules/strongholdApi'
import type { Facility, Room, ButlerConfig, GroupMessage } from '../api/modules/strongholdApi'
import { agentApi } from '../api/modules/agentApi'
import { getApiBaseUrl } from '../api/transport'
import { useNotificationStore } from '../stores/useNotificationStore'
import { useCompositorStore } from '../stores/useCompositorStore'
import { useGateway } from './gateway/useGateway'
import { logger } from '../lib/logger'

/** Agent 档案 (来自 /api/agents，用于把 agentId 映射为真实名字与头像) */
export interface AgentProfileInfo {
  name: string
  avatarUrl?: string
}

/** 档案表：agentId → 档案信息 */
export type AgentProfileMap = Map<string, AgentProfileInfo>

/** Agent 展示状态 (前端扩展) */
export interface AgentDisplayStatus {
  /** 角色 ID (唯一键) */
  agentId: string
  /** 显示名 (档案 name，缺失时回退 agentId) */
  name: string
  /** 头像完整 URL */
  avatarUrl?: string
  roomName: string
  roomId: string
}

export interface StrongholdRoundAgentState {
  agentId: string
  status: 'queued' | 'streaming' | 'tool' | 'completed' | 'failed'
  draft: string
  toolName?: string
  error?: string
}

export interface StrongholdRoundState {
  roundId: string
  roomId: string
  agents: StrongholdRoundAgentState[]
  completed: boolean
}

/** 轮询间隔 (ms) */
const POLL_INTERVAL_MS = 5000

export function useStronghold() {
  const notify = useNotificationStore()
  const compositor = useCompositorStore()
  const gateway = useGateway()
  // ── 状态 ──

  const facilities = shallowRef<Facility[]>([])
  const rooms = shallowRef<Room[]>([])
  const currentFacility = ref<Facility | null>(null)
  const currentRoom = ref<Room | null>(null)
  const isLoading = ref(false)

  const agentsStatus = shallowRef<AgentDisplayStatus[]>([])
  const butlerConfig = ref<ButlerConfig | null>(null)

  /** 角色档案表：将 agentId 映射为真实名字与头像 URL */
  const agentProfiles = shallowRef<AgentProfileMap>(new Map())

  // 群聊消息
  const messages = shallowRef<GroupMessage[]>([])
  const roomProjection = shallowRef<StrongholdProjectionSnapshot | null>(null)
  const isLoadingMessages = ref(false)
  const isSendingMessage = ref(false)
  /** 已完成调度，正在等待后台 Agent 回写回复。 */
  const isAwaitingReply = ref(false)
  const activeRound = ref<StrongholdRoundState | null>(null)
  /** 给聊天区展示的可读调度状态。 */
  const replyStatus = ref('')
  let messageRequestId = 0
  let roundFallbackTimer: ReturnType<typeof setTimeout> | null = null

  /** 错误信息 */
  const error = ref<string | null>(null)

  // ── 当前房间成员 ──

  const currentRoomAgents = computed(() => {
    if (!currentRoom.value) return []
    return agentsStatus.value.filter((agent) => agent.roomId === currentRoom.value!.id)
  })

  // ── 设施操作 ──

  /** 加载设施列表 */
  async function fetchFacilities(): Promise<void> {
    try {
      isLoading.value = true
      const res = await strongholdApi.listFacilities()
      facilities.value = res.data ?? []
      // 默认选中第一个设施
      if (!currentFacility.value && facilities.value.length > 0) {
        currentFacility.value = facilities.value[0]!
      }
    } catch (e) {
      error.value = `加载设施失败: ${(e as Error).message}`
      logger.error('Stronghold', error.value)
    } finally {
      isLoading.value = false
    }
  }

  /** 选择设施 */
  async function selectFacility(fac: Facility): Promise<void> {
    currentFacility.value = fac
    currentRoom.value = null
    messages.value = []
    cancelReplyWait()
    await fetchRooms(fac.id)
  }

  // ── 房间操作 ──

  /** 加载房间列表 (按设施过滤) */
  async function fetchRooms(facilityId?: number): Promise<void> {
    try {
      const res = await strongholdApi.listRooms(facilityId)
      rooms.value = res.data ?? []

      // 从 rooms 中提取所有 agents 的展示信息
      rebuildAgentStatus()
    } catch (e) {
      error.value = `加载房间失败: ${(e as Error).message}`
      logger.error('Stronghold', error.value)
    }
  }

  /** 选择房间 */
  async function selectRoom(room: Room): Promise<void> {
    if (currentRoom.value?.id === room.id) return
    cancelReplyWait()
    if (currentRoom.value) compositor.disposeScope(`stronghold:${currentRoom.value.id}`)
    currentRoom.value = room
    messages.value = []
    await fetchMessages(room.id)
  }

  // ── Agent 状态重建 ──

  /** 加载角色档案 (名字/头像)，然后重建成员展示状态 */
  async function fetchAgentProfiles(): Promise<void> {
    try {
      const res = await agentApi.list()
      const map: AgentProfileMap = new Map()
      for (const agent of res.data ?? []) {
        map.set(agent.id, {
          name: agent.name,
          avatarUrl: agent.avatarUrl ? `${getApiBaseUrl()}${agent.avatarUrl}` : undefined,
        })
      }
      agentProfiles.value = map
      // 档案可能改变了已有成员的展示信息，重建一次
      rebuildAgentStatus()
    } catch (e) {
      // 档案加载失败不阻塞据点功能：回退为显示 agentId
      logger.error('Stronghold', __t('logs.frontend.useStronghold', '加载角色档案失败'), e)
    }
  }

  /** 从 rooms 的 agents 字段提取全局 Agent 状态（合并档案信息） */
  function rebuildAgentStatus(): void {
    const statusList: AgentDisplayStatus[] = []
    for (const room of rooms.value) {
      if (!room.agents) continue
      for (const agentId of room.agents) {
        const profile = agentProfiles.value.get(agentId)
        statusList.push({
          agentId,
          name: profile?.name ?? agentId,
          avatarUrl: profile?.avatarUrl,
          roomName: room.name,
          roomId: room.id,
        })
      }
    }
    agentsStatus.value = statusList
  }

  function armRoundFallback(roundId: string, roomId: string): void {
    if (roundFallbackTimer) clearTimeout(roundFallbackTimer)
    roundFallbackTimer = setTimeout(async () => {
      if (activeRound.value?.roundId !== roundId || activeRound.value.completed) return
      await fetchMessages(roomId)
      isAwaitingReply.value = false
      replyStatus.value = ''
      activeRound.value = null
      notify.toast(__t('ui.useStronghold', '连接中断，消息已刷新'), { type: 'warning' })
    }, 90_000)
  }

  function ensureRound(payload: Record<string, unknown>): StrongholdRoundState | null {
    const roomId = String(payload.roomId ?? '')
    const roundId = String(payload.roundId ?? '')
    if (!roomId || !roundId || currentRoom.value?.id !== roomId) return null
    if (!activeRound.value || activeRound.value.roundId !== roundId) {
      activeRound.value = { roundId, roomId, agents: [], completed: false }
    }
    return activeRound.value
  }

  function ensureRoundAgent(
    round: StrongholdRoundState,
    agentId: string,
  ): StrongholdRoundAgentState {
    let agent = round.agents.find((item) => item.agentId === agentId)
    if (!agent) {
      agent = { agentId, status: 'queued', draft: '' }
      round.agents.push(agent)
    }
    return agent
  }

  function onRoundStarted(payload: Record<string, unknown>): void {
    const round = ensureRound(payload)
    if (!round) return
    const agentIds = Array.isArray(payload.agentIds) ? payload.agentIds.map(String) : []
    round.agents = agentIds.map((agentId) => ({ agentId, status: 'queued', draft: '' }))
    isAwaitingReply.value = true
    armRoundFallback(round.roundId, round.roomId)
    replyStatus.value = `${agentIds.length} 位角色已进入本轮回复队列`
  }

  function onAgentQueued(payload: Record<string, unknown>): void {
    const round = ensureRound(payload)
    const agentId = String(payload.agentId ?? '')
    if (!round || !agentId) return
    ensureRoundAgent(round, agentId).status = 'queued'
    activeRound.value = { ...round, agents: [...round.agents] }
  }

  function onAgentStarted(payload: Record<string, unknown>): void {
    const round = ensureRound(payload)
    const agentId = String(payload.agentId ?? '')
    if (!round || !agentId) return
    const agent = ensureRoundAgent(round, agentId)
    agent.status = 'streaming'
    agent.toolName = undefined
    isAwaitingReply.value = true
    replyStatus.value = `${agentProfiles.value.get(agentId)?.name ?? agentId} 正在回复...`
    activeRound.value = { ...round, agents: [...round.agents] }
  }

  function onAgentDelta(payload: Record<string, unknown>): void {
    const round = ensureRound(payload)
    const agentId = String(payload.agentId ?? '')
    if (!round || !agentId) return
    const agent = ensureRoundAgent(round, agentId)
    agent.status = 'streaming'
    if (typeof payload.replace === 'string') agent.draft = payload.replace
    else agent.draft += String(payload.delta ?? '')
    activeRound.value = { ...round, agents: [...round.agents] }
  }

  function onAgentToolStarted(payload: Record<string, unknown>): void {
    const round = ensureRound(payload)
    const agentId = String(payload.agentId ?? '')
    if (!round || !agentId) return
    const agent = ensureRoundAgent(round, agentId)
    agent.status = 'tool'
    agent.toolName = String(payload.toolName ?? '工具')
    replyStatus.value = `${agentProfiles.value.get(agentId)?.name ?? agentId} 正在调用${agent.toolName}`
    activeRound.value = { ...round, agents: [...round.agents] }
  }

  function onAgentToolCompleted(payload: Record<string, unknown>): void {
    const round = ensureRound(payload)
    const agentId = String(payload.agentId ?? '')
    if (!round || !agentId) return
    const agent = ensureRoundAgent(round, agentId)
    agent.status = 'streaming'
    agent.toolName = undefined
    activeRound.value = { ...round, agents: [...round.agents] }
  }

  async function onAgentCompleted(payload: Record<string, unknown>): Promise<void> {
    const round = ensureRound(payload)
    const agentId = String(payload.agentId ?? '')
    if (!round || !agentId) return
    const agent = ensureRoundAgent(round, agentId)
    agent.status = 'completed'
    agent.draft = ''
    agent.toolName = undefined
    activeRound.value = { ...round, agents: [...round.agents] }
    await fetchMessages(round.roomId)
  }

  function onAgentFailed(payload: Record<string, unknown>): void {
    const round = ensureRound(payload)
    const agentId = String(payload.agentId ?? '')
    if (!round || !agentId) return
    const agent = ensureRoundAgent(round, agentId)
    agent.status = 'failed'
    agent.error = String(payload.error ?? '回复失败')
    activeRound.value = { ...round, agents: [...round.agents] }
  }

  async function onRoundCompleted(payload: Record<string, unknown>): Promise<void> {
    const round = ensureRound(payload)
    if (!round) return
    round.completed = true
    activeRound.value = { ...round, agents: [...round.agents] }
    await fetchMessages(round.roomId)
    if (roundFallbackTimer) clearTimeout(roundFallbackTimer)
    roundFallbackTimer = null
    isAwaitingReply.value = false
    replyStatus.value = ''
    window.setTimeout(() => {
      if (activeRound.value?.roundId === round.roundId) activeRound.value = null
    }, 650)
  }

  const onAgentCompletedPush = (payload: Record<string, unknown>) => void onAgentCompleted(payload)
  const onRoundCompletedPush = (payload: Record<string, unknown>) => void onRoundCompleted(payload)

  // ── 群聊消息 ──

  /** 加载房间消息，并返回本次服务端快照供回复等待状态机判断。 */
  async function fetchMessages(roomId: string): Promise<GroupMessage[]> {
    const requestId = ++messageRequestId
    try {
      isLoadingMessages.value = true
      const res = await strongholdApi.getProjection(roomId, 100)
      const projection = res.data
      if (!projection) throw new Error('服务端未返回据点 Projection')
      const snapshot: GroupMessage[] = projection.messages.map(
        (message: StrongholdProjectionSnapshot['messages'][number]) => ({
          id: Number(message.messageId),
          roomId: message.roomId,
          senderId: message.senderId,
          content: message.content,
          role: message.role,
          timestamp: message.timestamp ?? undefined,
          outputTokens: message.outputTokens,
        }),
      )
      if (requestId === messageRequestId && currentRoom.value?.id === roomId) {
        compositor.replaceScope(`stronghold:${roomId}`, projection.surfaces)
        roomProjection.value = projection
        messages.value = snapshot
      }
      return snapshot
    } catch (e) {
      logger.error('Stronghold', __t('logs.frontend.useStronghold', '加载消息失败'), e)
      return []
    } finally {
      if (requestId === messageRequestId) isLoadingMessages.value = false
    }
  }

  function cancelReplyWait(): void {
    if (roundFallbackTimer) clearTimeout(roundFallbackTimer)
    roundFallbackTimer = null
    isAwaitingReply.value = false
    replyStatus.value = ''
    activeRound.value = null
  }

  /** 发送消息；complete 用于与共用 CHAR OPS 输入组件握手。 */
  async function sendMessage(
    content: string,
    mentions: string[] = [],
    complete?: (success: boolean) => void,
  ): Promise<boolean> {
    const roomId = currentRoom.value?.id
    const trimmed = content.trim()
    const roomAgentCount = currentRoomAgents.value.length || currentRoom.value?.agents?.length || 0
    if (
      !roomId ||
      roomAgentCount === 0 ||
      !trimmed ||
      isSendingMessage.value ||
      isAwaitingReply.value
    ) {
      complete?.(false)
      return false
    }
    try {
      isSendingMessage.value = true
      const response = await strongholdApi.sendMessage(roomId, trimmed, {
        senderId: 'user',
        role: 'user',
        mentions,
      })
      const dispatch = response.data
      if (!dispatch) throw new Error('服务端未返回群聊调度结果')

      // 立即显示服务端确认保存的用户消息，无需等待下一次轮询。
      messages.value = [
        ...messages.value.filter((item) => item.id !== dispatch.message.id),
        dispatch.message,
      ]
      complete?.(true)

      if (dispatch.replyQueued && dispatch.roundId) {
        if (!activeRound.value || activeRound.value.roundId !== dispatch.roundId) {
          activeRound.value = {
            roundId: dispatch.roundId,
            roomId,
            completed: false,
            agents: (dispatch.agentIds ?? []).map((agentId) => ({
              agentId,
              status: 'queued',
              draft: '',
            })),
          }
        }
        isAwaitingReply.value = true
        replyStatus.value = `${dispatch.agentIds?.length ?? 1} 位角色已进入本轮回复队列`
      } else if (!dispatch.replyQueued) {
        notify.toast(__t('ui.useStronghold', '消息已发送；{0}', [dispatch.reason]), {
          type: 'info',
        })
      }
      return true
    } catch (e) {
      complete?.(false)
      notify.toast(__t('ui.useStronghold', '发送消息失败: ') + (e as Error).message, {
        type: 'error',
      })
      logger.error('Stronghold', __t('logs.frontend.useStronghold', '发送消息失败'), e)
      return false
    } finally {
      isSendingMessage.value = false
    }
  }

  /**
   * 级联删除本轮群聊消息，并按服务端返回的权威 ID 即时更新本地列表。
   * 旧消息没有 pairId 时服务端会保守地仅删除目标消息。
   */
  async function deleteMessage(messageId: number): Promise<boolean> {
    const roomId = currentRoom.value?.id
    if (!roomId) return false
    try {
      const response = await strongholdApi.deleteMessage(roomId, messageId)
      const deleted = new Set(response.data?.deletedMessageIds ?? [messageId])
      await fetchMessages(roomId)
      const deletedCount = response.data?.deletedCount ?? deleted.size
      notify.toast(
        deletedCount > 1
          ? __t('ui.useStronghold', '已删除 {0} 条关联消息', [deletedCount])
          : __t('ui.useStronghold', '消息已删除'),
        {
          type: 'success',
        },
      )
      return true
    } catch (e) {
      notify.toast(__t('ui.useStronghold', '删除消息失败: ') + (e as Error).message, {
        type: 'error',
      })
      logger.error('Stronghold', __t('logs.frontend.useStronghold', '删除消息失败'), e)
      return false
    }
  }

  // ── 管家 ──

  /** 加载管家配置 */
  async function fetchButlerConfig(): Promise<void> {
    try {
      const res = await strongholdApi.getButlerConfig()
      butlerConfig.value = (res.data as ButlerConfig) ?? null
    } catch {
      // 管家不存在时静默
      butlerConfig.value = null
    }
  }

  /** 调用管家专用执行入口 */
  async function callButler(query: string): Promise<void> {
    const roomId = currentRoom.value?.id
    if (!roomId) return
    try {
      const res = await strongholdApi.callButler(roomId, query)
      // 管家执行结果（含 LLM 旁白/动作汇总）以 toast 反馈
      notify.toast(res.data?.message || __t('ui.useStronghold', '管家已执行'), { type: 'success' })
      await Promise.all([fetchMessages(roomId), fetchRooms(currentFacility.value?.id)])
    } catch (e) {
      notify.toast(__t('ui.useStronghold', '管家调用失败: ') + (e as Error).message, 'error')
      logger.error('Stronghold', __t('logs.frontend.useStronghold', '管家调用失败'), e)
    }
  }

  // ── 轮询 ──

  let pollTimer: ReturnType<typeof setInterval> | null = null
  const mainVisible = inject('infos:main-surface-visible', shallowRef(true))
  let pageActive = true
  let disposed = false
  let pollBusy = false

  function startPolling(): void {
    if (pollTimer || !pageActive || !mainVisible.value || document.hidden || disposed) return
    pollTimer = setInterval(async () => {
      // 仅在有选中房间时轮询消息
      if (currentRoom.value && !pollBusy) {
        pollBusy = true
        try {
          await fetchMessages(currentRoom.value.id)
        } finally {
          pollBusy = false
        }
      }
    }, POLL_INTERVAL_MS)
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
  function syncPolling(): void {
    if (pageActive && mainVisible.value && !document.hidden && !disposed) {
      if (currentRoom.value && !pollBusy) {
        pollBusy = true
        void fetchMessages(currentRoom.value.id).finally(() => {
          pollBusy = false
        })
      }
      startPolling()
    } else stopPolling()
  }
  watch(mainVisible, syncPolling)
  onActivated(() => {
    pageActive = true
    syncPolling()
  })
  onDeactivated(() => {
    pageActive = false
    stopPolling()
  })

  // ── 生命周期 ──

  onMounted(async () => {
    document.addEventListener('visibilitychange', syncPolling)
    gateway.onPush('stronghold_round_started', onRoundStarted)
    gateway.onPush('stronghold_agent_queued', onAgentQueued)
    gateway.onPush('stronghold_agent_started', onAgentStarted)
    gateway.onPush('stronghold_agent_delta', onAgentDelta)
    gateway.onPush('stronghold_agent_tool_started', onAgentToolStarted)
    gateway.onPush('stronghold_agent_tool_completed', onAgentToolCompleted)
    gateway.onPush('stronghold_agent_completed', onAgentCompletedPush)
    gateway.onPush('stronghold_agent_failed', onAgentFailed)
    gateway.onPush('stronghold_round_completed', onRoundCompletedPush)
    // 档案与设施并行加载，互不阻塞；rebuildAgentStatus 会在两者完成后自动合并
    await Promise.all([fetchFacilities(), fetchAgentProfiles()])
    if (currentFacility.value) {
      await fetchRooms(currentFacility.value.id)
    }
    await fetchButlerConfig()
    startPolling()
  })

  onUnmounted(() => {
    disposed = true
    document.removeEventListener('visibilitychange', syncPolling)
    gateway.offPush('stronghold_round_started', onRoundStarted)
    gateway.offPush('stronghold_agent_queued', onAgentQueued)
    gateway.offPush('stronghold_agent_started', onAgentStarted)
    gateway.offPush('stronghold_agent_delta', onAgentDelta)
    gateway.offPush('stronghold_agent_tool_started', onAgentToolStarted)
    gateway.offPush('stronghold_agent_tool_completed', onAgentToolCompleted)
    gateway.offPush('stronghold_agent_completed', onAgentCompletedPush)
    gateway.offPush('stronghold_agent_failed', onAgentFailed)
    gateway.offPush('stronghold_round_completed', onRoundCompletedPush)
    messageRequestId++
    cancelReplyWait()
    stopPolling()
  })

  return {
    // 状态
    facilities,
    rooms,
    currentFacility,
    currentRoom,
    isLoading,
    agentsStatus,
    agentProfiles,
    butlerConfig,
    messages,
    roomProjection,
    isLoadingMessages,
    isSendingMessage,
    isAwaitingReply,
    activeRound,
    replyStatus,
    error,

    // 计算属性
    currentRoomAgents,

    // 操作
    selectFacility,
    selectRoom,
    fetchFacilities,
    fetchRooms,
    fetchAgentProfiles,
    fetchMessages,
    sendMessage,
    deleteMessage,
    callButler,
    fetchButlerConfig,
  }
}
