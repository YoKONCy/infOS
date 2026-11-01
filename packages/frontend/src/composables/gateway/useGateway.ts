import { t as __t, applyLanguage } from '../../i18n/index'
import { createClientUuid } from '../../lib/clientPlatform'
/**
 * Gateway WebSocket Composable
 *
 * 管理与后端 GatewayHub 的 WebSocket 连接：
 * - 自动连接 / 断线重连（指数退避）
 * - 事件分发（通知、任务进度、流结束、心跳）
 * - RPC 请求/响应配对 (pendingRequests Map + timeout)
 * - 二进制音频流传输 (sendStream)
 * - 发送消息
 *
 * @module packages/frontend/src/composables/gateway/useGateway
 */

import { ref, computed, onUnmounted } from 'vue'
import {
  validateSurfaceFrame,
  validateVersionedMessage,
  type GatewayEnvelope as SharedGatewayEnvelope,
  type KernelInputSeat,
  type SurfaceFrame,
} from '@infos/shared'
import { getGatewayWsUrl } from '../../api/transport'
import { logger } from '../../lib/logger'

/** WS 连接状态 */
export type GatewayState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/** 后端推送的消息类型 */
export interface GatewayMessage {
  type: string
  payload: Record<string, unknown>
}

export function useGateway(events: GatewayEvents = {}) {
  const unsubscribeEvents = sharedGateway.subscribeEvents(events)
  onUnmounted(unsubscribeEvents)
  return { ...sharedGateway, disconnect: unsubscribeEvents }
}

export interface GatewayEnvelope extends GatewayMessage {
  protocolVersion: 1
  id?: string
  sourceId?: string
  targetId?: string
  streamId?: string
  sequence?: number
  timestamp?: number
}

type PushHandler = (payload: Record<string, unknown>) => void

/** 通知推送 */
export interface GatewayNotification {
  title: string
  body: string
  severity?: 'info' | 'warn' | 'error'
}

/** 任务进度推送 */
export interface TaskProgress {
  taskId: string
  progress: number
  status: string
  message?: string
}

/** 事件回调 */
export interface GatewayEvents {
  onNotification?: (data: GatewayNotification) => void
  onTaskProgress?: (data: TaskProgress) => void
  onSurface?: (frame: SurfaceFrame) => void
  onStateUpdate?: (data: Record<string, unknown>) => void
  onAudioChunk?: (data: ArrayBuffer) => void
  onVoiceState?: (data: { sessionId: string; state: string }) => void
  onHeartbeat?: () => void
}

/** RPC 请求超时 (ms) */
const RPC_TIMEOUT_MS = 30_000

/** 等待中的 RPC 请求 */
interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 重连配置 */
interface ReconnectConfig {
  /** 初始延迟（毫秒） */
  baseDelay: number
  /** 最大延迟（毫秒） */
  maxDelay: number
}

const DEFAULT_RECONNECT: ReconnectConfig = {
  baseDelay: 1000,
  maxDelay: 30000,
}

const CONNECTION_TIMEOUT_MS = 12_000
const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_TIMEOUT_MS = 12_000

const CLIENT_NODE_KEY = 'infos.clientNodeId'
function getOrCreateStableNodeId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_NODE_KEY)
    if (existing) return existing
    const nodeId = `client-${createClientUuid()}`
    localStorage.setItem(CLIENT_NODE_KEY, nodeId)
    return nodeId
  } catch {
    return `client-${createClientUuid()}`
  }
}

function isElectronClient(): boolean {
  return typeof window !== 'undefined' && 'electron' in window
}

function detectClientOs(): 'windows' | 'linux' | 'macos' | 'android' | 'ios' | 'web' {
  const platform = navigator.userAgent.toLowerCase()
  if (platform.includes('windows')) return 'windows'
  if (platform.includes('android')) return 'android'
  if (platform.includes('iphone') || platform.includes('ipad')) return 'ios'
  if (platform.includes('mac')) return 'macos'
  if (platform.includes('linux')) return 'linux'
  return 'web'
}

const sharedGateway = createGatewayClient()
if (import.meta.hot) import.meta.hot.dispose(() => sharedGateway.dispose())

export function createGatewayClient() {
  const eventSubscribers = new Set<GatewayEvents>()
  const events: GatewayEvents = {
    onNotification: (data) => eventSubscribers.forEach((item) => item.onNotification?.(data)),
    onTaskProgress: (data) => eventSubscribers.forEach((item) => item.onTaskProgress?.(data)),
    onSurface: (frame) => eventSubscribers.forEach((item) => item.onSurface?.(frame)),
    onStateUpdate: (data) => eventSubscribers.forEach((item) => item.onStateUpdate?.(data)),
    onAudioChunk: (data) => eventSubscribers.forEach((item) => item.onAudioChunk?.(data)),
    onVoiceState: (data) => eventSubscribers.forEach((item) => item.onVoiceState?.(data)),
    onHeartbeat: () => eventSubscribers.forEach((item) => item.onHeartbeat?.()),
  }
  const state = ref<GatewayState>('disconnected')
  const retryCount = ref(0)
  const lastError = ref<string | null>(null)
  const isConnected = computed(() => state.value === 'connected')
  let stableNodeId = getOrCreateStableNodeId()
  const sessionId = ref<string | null>(null)
  const sessionGeneration = ref(0)
  const inputSeat = ref<KernelInputSeat | null>(null)
  let principalId = 'pero'
  const subscriptions = new Map<string, number>()
  const seenMessageIds = new Set<string>()

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let heartbeatDeadline: ReturnType<typeof setTimeout> | null = null
  let connectionDeadline: ReturnType<typeof setTimeout> | null = null
  let connectionAttempt: Promise<void> | null = null
  let connectionEpoch = 0
  let lastInboundAt = 0
  let hasStarted = false
  let authorizationBlocked = false
  let disposed = false
  let seatRenewTimer: ReturnType<typeof setInterval> | null = null
  let seatRecovery: Promise<void> | null = null
  const seatAcquisitions = new Map<string, Promise<KernelInputSeat>>()
  let inputActionQueue: Promise<void> = Promise.resolve()
  const sessionWaiters = new Set<{
    resolve: (id: string) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  let isManualClose = false

  /** RPC 请求/响应配对 Map */
  const pendingRequests = new Map<string, PendingRequest>()
  /** 按 action 精确订阅的推送回调，适合页面或组件只监听自己关心的事件。 */
  const pushHandlers = new Map<string, PushHandler[]>()
  /** 通配订阅回调，主要用于调试面板或日志面板观察所有 Gateway 推送。 */
  const wildcardHandlers: PushHandler[] = []

  function createEnvelope(
    type: string,
    payload: Record<string, unknown> = {},
    targetId = 'backend',
  ): GatewayEnvelope {
    return {
      protocolVersion: 1,
      id: createClientUuid(),
      type,
      sourceId: 'frontend',
      targetId,
      timestamp: Date.now(),
      payload,
    }
  }

  function onPush(action: string, handler: PushHandler): void {
    if (action === '*') {
      wildcardHandlers.push(handler)
      return
    }

    const list = pushHandlers.get(action) ?? []
    list.push(handler)
    pushHandlers.set(action, list)
  }

  function offPush(action: string, handler: PushHandler): void {
    if (action === '*') {
      const index = wildcardHandlers.indexOf(handler)
      if (index >= 0) {
        wildcardHandlers.splice(index, 1)
      }
      return
    }

    const list = pushHandlers.get(action)
    if (!list) {
      return
    }

    pushHandlers.set(
      action,
      list.filter((item) => item !== handler),
    )
  }

  // ═══ 连接管理 ═══

  /** Electron 渲染层与主进程能力提供者必须共享 Node ID，确保 Input Seat 能定向到 audio.output Offer。 */
  async function resolveStableNodeId(): Promise<void> {
    if (!isElectronClient() || !window.electron) return
    try {
      const capabilityNodeId = await window.electron.invoke('get-capability-node-id')
      if (typeof capabilityNodeId === 'string' && capabilityNodeId.trim()) {
        stableNodeId = capabilityNodeId.trim()
      }
    } catch (error) {
      logger.warn(
        'Gateway',
        __t('logs.frontend.gateway', '读取 Electron 能力节点 ID 失败: {0}', [
          (error as Error).message,
        ]),
      )
    }
  }

  /** 建立 WebSocket 连接 */
  async function connect(): Promise<void> {
    if (disposed || authorizationBlocked) return
    hasStarted = true
    isManualClose = false
    if (navigator.onLine === false) {
      state.value = 'disconnected'
      return
    }
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      if (
        sessionId.value &&
        Date.now() - lastInboundAt > HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS
      )
        return reconnect()
      return
    }
    if (connectionAttempt) return connectionAttempt
    clearReconnectTimer()
    const epoch = ++connectionEpoch
    state.value = retryCount.value > 0 ? 'reconnecting' : 'connecting'
    connectionDeadline = setTimeout(() => {
      if (connectionEpoch === epoch) restartConnection('连接或握手超时，正在重新连接')
    }, CONNECTION_TIMEOUT_MS)
    const attempt = openConnection(epoch)
    connectionAttempt = attempt
    try {
      await attempt
    } finally {
      if (connectionAttempt === attempt) connectionAttempt = null
    }
  }

  async function openConnection(epoch: number): Promise<void> {
    await resolveStableNodeId()
    if (epoch !== connectionEpoch || disposed || isManualClose || authorizationBlocked) return

    let socket: WebSocket
    try {
      socket = new WebSocket(getGatewayWsUrl())
      ws = socket
    } catch (error) {
      restartConnection((error as Error).message)
      return
    }

    socket.onopen = () => {
      if (ws !== socket) return
      const sent = sendEnvelope(
        createEnvelope('hello', {
          nodeId: stableNodeId,
          principalId,
          deviceName: isElectronClient() ? 'Electron Client' : 'Web Client',
          platform: {
            os: detectClientOs(),
            runtime: isElectronClient() ? 'electron' : 'browser',
          },
          supportedVersions: [1],
          features: ['surface-v1', 'audience-v1', 'cursor-v1', 'input-seat-v1', 'audio-output-v1'],
        }),
      )
      if (!sent) restartConnection('发送连接握手失败')
    }

    socket.onmessage = (event) => {
      if (ws !== socket) return
      // 二进制消息 → 音频 chunk
      if (event.data instanceof ArrayBuffer) {
        events.onAudioChunk?.(event.data)
        return
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buf) => {
          if (ws === socket) events.onAudioChunk?.(buf)
        })
        return
      }
      handleMessage(event.data as string)
    }

    socket.onclose = (event) => {
      if (ws !== socket) return
      closeCurrentConnection()

      if (!isElectronClient() && event.code === 1008 && event.reason.includes('授权')) {
        window.dispatchEvent(new Event('infos:unauthorized'))
      }
      if (!isElectronClient() && event.code === 1006 && !isManualClose) {
        // 浏览器不暴露握手 HTTP 状态，由统一身份管理确认授权；临时断网仍继续重连。
        window.dispatchEvent(new Event('infos:session-check-requested'))
      }

      if (!isManualClose) {
        scheduleReconnect()
      }
    }

    socket.onerror = () => {
      if (ws !== socket) return
      lastError.value = '连接错误'
    }
  }

  function sendEnvelope(envelope: GatewayEnvelope): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn('Gateway', __t('logs.frontend.gateway', 'WS 未连接，无法发送消息'))
      return false
    }
    try {
      ws.send(JSON.stringify(envelope))
      return true
    } catch (error) {
      logger.warn('Gateway', __t('logs.frontend.gateway', '发送网关消息失败'), error)
      return false
    }
  }

  /** 立即废弃旧连接及其异步回调，浏览器未触发 close 时也能重新建立连接。 */
  function closeCurrentConnection(): void {
    connectionEpoch++
    connectionAttempt = null
    if (connectionDeadline) clearTimeout(connectionDeadline)
    connectionDeadline = null
    stopHeartbeat()
    stopSeatRenewal()
    inputSeat.value = null
    sessionId.value = null
    rejectSessionWaiters()

    // 清理等待中的 RPC 请求
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('[Gateway] 连接已断开'))
      pendingRequests.delete(id)
    }

    const socket = ws
    ws = null
    if (socket) socket.close()
    state.value = 'disconnected'
  }

  /** 断开连接 */
  function disconnect(): void {
    isManualClose = true
    hasStarted = false
    clearReconnectTimer()
    closeCurrentConnection()
    retryCount.value = 0
  }

  function restartConnection(message: string): void {
    lastError.value = message
    closeCurrentConnection()
    scheduleReconnect()
  }

  /** 手动重连必须释放失活但仍显示 OPEN 的旧连接。 */
  async function reconnect(): Promise<void> {
    clearReconnectTimer()
    closeCurrentConnection()
    await connect()
  }

  /** 发送消息 (fire-and-forget) */
  function send(type: string, payload: Record<string, unknown> = {}): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn('Gateway', __t('logs.frontend.gateway', 'WS 未连接，无法发送消息'))
      return
    }
    sendEnvelope(createEnvelope(type, payload))
  }

  /**
   * RPC 请求 — 发送 request 并等待匹配的 response
   *
   * 基于 pendingRequests Map + timeout 模式。
   * 后端返回 type='response' 且 id 匹配时自动 resolve。
   *
   * @param action - 请求动作名
   * @param payload - 请求负载
   * @param timeoutMs - 超时时间 (默认 30s)
   * @returns 响应负载
   * @throws 超时或连接断开时 reject
   */
  function request(
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId.value) {
        reject(new Error('[Gateway] WS 未连接，无法发送 RPC 请求'))
        return
      }

      const id = createClientUuid()
      const timer = setTimeout(() => {
        pendingRequests.delete(id)
        reject(new Error(`[Gateway] RPC 超时: ${action} (${timeoutMs}ms)`))
      }, timeoutMs)

      pendingRequests.set(id, { resolve, reject, timer })
      const sent = sendEnvelope({
        ...createEnvelope('request', { action, ...payload }),
        id,
      })
      if (!sent) {
        clearTimeout(timer)
        pendingRequests.delete(id)
        reject(new Error('[Gateway] 发送请求失败，请稍后重试'))
        restartConnection('发送请求失败，正在重新连接')
      }
    })
  }

  async function subscribe(streamId: string): Promise<void> {
    if (!subscriptions.has(streamId)) subscriptions.set(streamId, 0)
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId.value) return
    const requestedSession = sessionId.value
    const result = await request('gateway.subscribe', {
      streamId,
      lastSequence: subscriptions.get(streamId) ?? 0,
    })
    if (sessionId.value !== requestedSession) return
    subscriptions.set(streamId, Number(result.latestSequence ?? 0))
    if (result.snapshotRequired === true) {
      window.dispatchEvent(
        new CustomEvent('infos:gateway-snapshot-required', { detail: { streamId } }),
      )
      return
    }
    for (const event of (result.events ?? []) as SharedGatewayEnvelope[]) {
      handleMessage(JSON.stringify(event))
    }
  }

  async function restoreSubscriptions(): Promise<void> {
    await Promise.all([...subscriptions.keys()].map((streamId) => subscribe(streamId)))
  }

  function rejectSessionWaiters(): void {
    for (const waiter of sessionWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('交互连接已断开，请稍后重试'))
    }
    sessionWaiters.clear()
  }

  /** 审批必须等握手返回真实 Session，不能携带空凭证提交。 */
  async function requireInputSession(): Promise<string> {
    await connect()
    if (sessionId.value) return sessionId.value
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          sessionWaiters.delete(waiter)
          reject(new Error('交互连接尚未就绪，请稍后重试；你的选择已保留'))
          // 连接打开却没有完成握手时，释放旧连接，下一次操作可重新建立会话。
          if (!sessionId.value) ws?.close()
        }, 8_000),
      }
      sessionWaiters.add(waiter)
    })
  }

  async function acquireSeatFor(targetPrincipal: string): Promise<KernelInputSeat> {
    const requestedSession = await requireInputSession()
    const key = `${requestedSession}:${targetPrincipal}`
    const pending = seatAcquisitions.get(key)
    if (pending) return pending
    const acquisition = (async () => {
      const response = await request('input_seat.acquire', {
        principalId: targetPrincipal,
        windowId: stableNodeId,
        leaseMs: 60_000,
      })
      const seat = response.seat as unknown as KernelInputSeat | undefined
      if (
        !seat ||
        sessionId.value !== requestedSession ||
        seat.sessionId !== requestedSession ||
        seat.principalId !== targetPrincipal ||
        seat.windowId !== stableNodeId
      )
        throw new Error('交互连接已变化，请重新提交；你的选择已保留')
      if (principalId === targetPrincipal && document.hasFocus()) {
        inputSeat.value = seat
        startSeatRenewal()
      }
      return seat
    })()
    seatAcquisitions.set(key, acquisition)
    try {
      return await acquisition
    } finally {
      if (seatAcquisitions.get(key) === acquisition) seatAcquisitions.delete(key)
    }
  }

  async function acquireInputSeat(): Promise<void> {
    await acquireSeatFor(principalId)
  }

  async function selectPrincipal(id: string, acquireSeat = false): Promise<void> {
    const oldSeat = inputSeat.value
    const changed = id !== principalId
    principalId = id
    if (!sessionId.value) return
    if (changed) {
      stopSeatRenewal()
      inputSeat.value = null
      if (oldSeat) await request('input_seat.release', { seatId: oldSeat.seatId }).catch(() => {})
    }
    if (principalId !== id) return
    await request('gateway.select_principal', { principalId: id })
    if (acquireSeat && principalId === id) await acquireInputSeat()
  }

  function recoverInputSeat(): Promise<void> {
    if (seatRecovery) return seatRecovery
    if (!document.hasFocus()) return Promise.resolve()
    inputSeat.value = null
    seatRecovery = acquireInputSeat().finally(() => {
      seatRecovery = null
    })
    return seatRecovery
  }

  function handleWindowFocus(): void {
    resumeConnection()
    if (sessionId.value) {
      void recoverInputSeat().catch((error) => {
        logger.warn(
          'Gateway',
          __t('logs.frontend.gateway', '聚焦窗口获取 Input Seat 失败: {0}', [
            (error as Error).message,
          ]),
        )
      })
    }
  }

  function handleWindowBlur(): void {
    stopSeatRenewal()
    inputSeat.value = null
  }

  function resumeConnection(): void {
    if (!hasStarted || disposed || isManualClose || authorizationBlocked || document.hidden) return
    if (navigator.onLine === false) return
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      clearReconnectTimer()
      void connect()
    } else if (sessionId.value) {
      if (Date.now() - lastInboundAt > HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS) {
        void reconnect()
      } else {
        probeConnection()
      }
    }
  }

  function handleOffline(): void {
    if (!hasStarted) return
    clearReconnectTimer()
    closeCurrentConnection()
    lastError.value = '网络已断开，恢复网络后将自动连接'
  }

  function handleUnauthorized(): void {
    if (isElectronClient()) return
    authorizationBlocked = true
    clearReconnectTimer()
    closeCurrentConnection()
  }

  function handleAuthorized(): void {
    authorizationBlocked = false
    resumeConnection()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('online', resumeConnection)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('pageshow', resumeConnection)
    window.addEventListener('infos:authorized', handleAuthorized)
    window.addEventListener('infos:unauthorized', handleUnauthorized)
    document.addEventListener('visibilitychange', resumeConnection)
  }

  function startSeatRenewal(): void {
    stopSeatRenewal()
    seatRenewTimer = setInterval(() => {
      const seat = inputSeat.value
      if (!seat) return
      void request('input_seat.renew', { seatId: seat.seatId, leaseMs: 60_000 })
        .then((response) => {
          if (inputSeat.value?.seatId === seat.seatId && principalId === seat.principalId)
            inputSeat.value = response.seat as unknown as KernelInputSeat
        })
        .catch((error: Error & { code?: string }) => {
          if (inputSeat.value?.seatId !== seat.seatId) return
          if (
            error.code === 'INPUT_SEAT_EXPIRED' ||
            error.code === 'INPUT_SEAT_IDENTITY_MISMATCH'
          ) {
            void recoverInputSeat().catch((recoveryError) => {
              logger.warn(
                'Gateway',
                __t('logs.frontend.gateway', 'Input Seat 重新获取失败: {0}', [
                  (recoveryError as Error).message,
                ]),
              )
            })
            return
          }
          logger.warn(
            'Gateway',
            __t('logs.frontend.gateway', 'Input Seat 续租失败: {0}', [error.message]),
          )
        })
    }, 30_000)
  }

  function stopSeatRenewal(): void {
    if (seatRenewTimer) clearInterval(seatRenewTimer)
    seatRenewTimer = null
  }

  function seatProof(): NonNullable<import('@infos/shared').SurfaceInput['seat']> | undefined {
    const seat = inputSeat.value
    if (!seat) return undefined
    return {
      seatId: seat.seatId,
      sessionId: seat.sessionId,
      windowId: seat.windowId,
      epoch: seat.epoch,
    }
  }

  /** 任务面板可处理其他角色的请求，不因此切换全局对话角色或语音席位。 */
  async function withInputSeatFor<T>(
    targetPrincipal: string,
    action: (proof: ReturnType<typeof seatProof>) => Promise<T>,
  ): Promise<T> {
    // 临时席位的释放必须晚于该窗口上一项输入，避免多个面板互相撤销凭证。
    const result = inputActionQueue.then(() => performSeatInput(targetPrincipal, action))
    inputActionQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function performSeatInput<T>(
    targetPrincipal: string,
    action: (proof: ReturnType<typeof seatProof>) => Promise<T>,
  ): Promise<T> {
    if (!targetPrincipal.trim()) throw new Error('请求缺少所属角色，请重新打开面板')
    for (let attempt = 0; attempt < 2; attempt++) {
      let seat: KernelInputSeat
      try {
        seat = await acquireSeatFor(targetPrincipal)
      } catch (error) {
        const code = String((error as { code?: string })?.code ?? '')
        const message = error instanceof Error ? error.message : ''
        const staleSession =
          /^(NODE_SESSION_EXPIRED|NODE_SESSION_NOT_FOUND|GATEWAY_HELLO_REQUIRED)/.test(code) ||
          message.includes('RPC 超时: input_seat.acquire')
        if (attempt === 0 && staleSession) {
          // 获取席位尚无业务副作用，可以重新连接后再取一次。
          disconnect()
          await connect()
          continue
        }
        if (staleSession) throw new Error('交互连接暂时不可用，请稍后重试；你的选择已保留')
        throw error
      }
      try {
        // 使用本次取得的凭证，避免失焦清空共享状态后提交空 seat。
        return await action({
          seatId: seat.seatId,
          sessionId: seat.sessionId,
          windowId: seat.windowId,
          epoch: seat.epoch,
        })
      } catch (error) {
        const reason = (error as { data?: { reason?: string } })?.data?.reason
        // 仅重试后端在副作用之前明确拒绝的租约；网络错误不能重放批准操作。
        if (
          attempt > 0 ||
          !['INPUT_SEAT_REQUIRED', 'INPUT_SEAT_EXPIRED', 'INPUT_SEAT_IDENTITY_MISMATCH'].includes(
            reason ?? '',
          )
        )
          throw error
      } finally {
        if (targetPrincipal !== principalId)
          await request('input_seat.release', { seatId: seat.seatId }).catch(() => {})
      }
    }
    throw new Error('交互连接已失效，请重新提交')
  }

  /**
   * 发送二进制音频流 sendStream()
   *
   * @param audioData - PCM/Opus 音频 ArrayBuffer
   */
  function sendStream(audioData: ArrayBuffer): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn('Gateway', __t('logs.frontend.gateway', 'WS 未连接，无法发送音频流'))
      return
    }
    ws.send(audioData)
  }

  // ═══ 消息分发 ═══

  /**
   * 分发后端主动推送。
   *
   * onPush 注册的是额外监听器；GatewayEvents 是常用事件的强类型快捷回调。
   * 两者都会收到同一条推送，因此页面应避免在两边重复执行有副作用的逻辑。
   */
  function dispatchPush(action: string, payload: Record<string, unknown>): void {
    for (const handler of wildcardHandlers) {
      try {
        handler(payload)
      } catch (error) {
        logger.error('Gateway', __t('logs.frontend.gateway', '通配符回调错误'), error)
      }
    }

    const handlers = pushHandlers.get(action)
    if (!handlers) {
      return
    }

    for (const handler of handlers) {
      try {
        handler(payload)
      } catch (error) {
        logger.error('Gateway', __t('logs.frontend.gateway', '回调错误 ({0})', [action]), error)
      }
    }
  }

  function handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as GatewayEnvelope & {
        payload: Record<string, unknown>
      }
      validateVersionedMessage(msg)
      lastInboundAt = Date.now()
      if (msg.type === 'hello_ack') {
        if (
          msg.payload.agreedVersion !== 1 ||
          typeof msg.payload.sessionId !== 'string' ||
          !msg.payload.sessionId
        ) {
          restartConnection('网关握手无效，正在重新连接')
          return
        }
        if (sessionId.value) return
        if (connectionDeadline) clearTimeout(connectionDeadline)
        connectionDeadline = null
        sessionId.value = msg.payload.sessionId
        sessionGeneration.value = Number(msg.payload.generation ?? 0)
        state.value = 'connected'
        retryCount.value = 0
        lastError.value = null
        startHeartbeat()
        logger.info('Gateway', __t('logs.frontend.gateway', '连接与会话握手已完成'))
        if (sessionId.value) {
          for (const waiter of sessionWaiters) {
            clearTimeout(waiter.timer)
            waiter.resolve(sessionId.value)
          }
          sessionWaiters.clear()
        }
        if (document.hasFocus()) {
          void acquireInputSeat().catch((error) => {
            logger.error('Gateway', __t('logs.frontend.gateway', 'Input Seat 获取失败'), error)
          })
        }
        const restoredSession = sessionId.value
        void restoreSubscriptions().catch((error) => {
          logger.error('Gateway', __t('logs.frontend.gateway', 'Durable Stream 恢复失败'), error)
          if (sessionId.value === restoredSession && !(error as { code?: string }).code)
            restartConnection('恢复事件订阅失败，正在重新连接')
        })
        window.dispatchEvent(
          new CustomEvent('infos:gateway-ready', {
            detail: { sessionId: restoredSession },
          }),
        )
      }
      if (msg.id && msg.type === 'push') {
        if (seenMessageIds.has(msg.id)) return
        seenMessageIds.add(msg.id)
        if (seenMessageIds.size > 2_000)
          seenMessageIds.delete(seenMessageIds.values().next().value!)
      }
      if (msg.streamId && Number.isInteger(msg.sequence)) {
        subscriptions.set(
          msg.streamId,
          Math.max(subscriptions.get(msg.streamId) ?? 0, msg.sequence ?? 0),
        )
      }
      // 后端推送通常把业务动作放在 payload.action；没有 action 时退回使用 envelope.type。
      const action = msg.payload?.action as string | undefined

      // ── RPC 响应配对 ──
      if (msg.type === 'response' && msg.id) {
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingRequests.delete(msg.id)
          pending.resolve(msg.payload)
          return
        }
      }

      // ── RPC 错误 (携带 code，方便上层区分错误类型) ──
      if (msg.type === 'error' && msg.id) {
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingRequests.delete(msg.id)
          const errMsg = (msg.payload?.message as string) ?? '未知网关错误'
          const errCode = (msg.payload?.code as string) ?? 'GATEWAY_ERROR'
          const error = new Error(errMsg) as Error & { code?: string }
          error.code = errCode
          pending.reject(error)
          return
        }
      }

      dispatchPush(action ?? msg.type, msg.payload)

      // ── 推送事件分发 ──
      switch (action ?? msg.type) {
        case 'notification':
          events.onNotification?.(msg.payload as unknown as GatewayNotification)
          break
        case 'task_progress':
          events.onTaskProgress?.(msg.payload as unknown as TaskProgress)
          break
        case 'surface': {
          const frame = msg.payload.frame as SurfaceFrame | undefined
          if (frame) {
            validateSurfaceFrame(frame)
            events.onSurface?.(frame)
          }
          break
        }
        case 'state_update':
          if (typeof msg.payload.language === 'string' || msg.payload.language === null)
            applyLanguage(msg.payload.language)
          events.onStateUpdate?.(msg.payload)
          break
        case 'audio_chunk': {
          // base64 编码的音频 chunk → ArrayBuffer
          const b64 = msg.payload.audio as string
          if (b64 && events.onAudioChunk) {
            const bin = window.atob(b64)
            const bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            events.onAudioChunk(bytes.buffer)
          }
          break
        }
        case 'voice_state':
          events.onVoiceState?.(msg.payload as unknown as { sessionId: string; state: string })
          break
        case 'heartbeat':
        case 'heartbeat_ack':
        case 'pong':
          if (heartbeatDeadline) clearTimeout(heartbeatDeadline)
          heartbeatDeadline = null
          events.onHeartbeat?.()
          break
        default:
          logger.debug(
            'Gateway',
            __t('logs.frontend.gateway', '未知消息: type={0} action={1}', [msg.type, action]),
          )
      }
    } catch {
      // JSON 解析失败，忽略
    }
  }

  // ═══ 重连逻辑（指数退避） ═══

  function scheduleReconnect(): void {
    if (disposed || isManualClose || authorizationBlocked || !hasStarted || reconnectTimer) return
    if (navigator.onLine === false) return

    // 指数退避 + 随机抖动
    const delay = Math.min(
      DEFAULT_RECONNECT.baseDelay * 2 ** Math.min(retryCount.value, 6) + Math.random() * 500,
      DEFAULT_RECONNECT.maxDelay,
    )

    logger.info(
      'Gateway',
      __t('logs.frontend.gateway', '{0}ms 后重连 (第 {1} 次)', [
        delay.toFixed(0),
        retryCount.value + 1,
      ]),
    )
    state.value = 'reconnecting'

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      retryCount.value++
      void connect()
    }, delay)
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  // ═══ 心跳 ═══

  function startHeartbeat(): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(probeConnection, HEARTBEAT_INTERVAL_MS)
  }

  /** OPEN 只是浏览器本地状态，必须收到心跳回执才算链路仍然可用。 */
  function probeConnection(): void {
    if (heartbeatDeadline || !sessionId.value) return
    if (!sendEnvelope(createEnvelope('heartbeat'))) {
      restartConnection('心跳发送失败，正在重新连接')
      return
    }
    const socket = ws
    heartbeatDeadline = setTimeout(() => {
      heartbeatDeadline = null
      if (ws === socket) restartConnection('心跳未收到回执，正在重新连接')
    }, HEARTBEAT_TIMEOUT_MS)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (heartbeatDeadline) clearTimeout(heartbeatDeadline)
    heartbeatDeadline = null
  }

  // 应用级共享客户端由应用生命周期管理，不随单个组件卸载而断开。
  function dispose(): void {
    disposed = true
    disconnect()
    window.removeEventListener('focus', handleWindowFocus)
    window.removeEventListener('blur', handleWindowBlur)
    window.removeEventListener('online', resumeConnection)
    window.removeEventListener('offline', handleOffline)
    window.removeEventListener('pageshow', resumeConnection)
    window.removeEventListener('infos:authorized', handleAuthorized)
    window.removeEventListener('infos:unauthorized', handleUnauthorized)
    document.removeEventListener('visibilitychange', resumeConnection)
    eventSubscribers.clear()
    pushHandlers.clear()
    wildcardHandlers.length = 0
  }

  return {
    subscribeEvents(events: GatewayEvents): () => void {
      eventSubscribers.add(events)
      return () => eventSubscribers.delete(events)
    },
    /** 连接状态 */
    state,
    /** WS 是否已连接 */
    isConnected,
    /** 最后一次错误 */
    lastError,
    /** 重连次数 */
    retryCount,
    /** 建立连接 */
    connect,
    /** 断开连接 */
    disconnect,
    dispose,
    /** 注册 push 回调 */
    onPush,
    /** 移除 push 回调 */
    offPush,
    /** 手动重连 */
    reconnect,
    /** 发送消息 (fire-and-forget) */
    send,
    /** RPC 请求/响应 */
    request,
    /** 订阅 Durable Stream 并从 Cursor 恢复 */
    subscribe,
    selectPrincipal,
    /** 当前稳定 Client Node ID */
    stableNodeId,
    sessionId,
    sessionGeneration,
    inputSeat,
    seatProof,
    withInputSeatFor,
    /** 发送二进制音频流 */
    sendStream,
  }
}
