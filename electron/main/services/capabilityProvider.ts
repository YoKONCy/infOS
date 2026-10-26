import { t as __t } from '../utils/i18n'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, screen } from 'electron'
import { runtimeDiagnostics } from './runtimeDiagnostics'
import WebSocket from 'ws'
import type {
  DaemonToNodeMessage,
  KernelCapabilityOffer,
  KernelNodeDescriptor,
  KernelNodeId,
  KernelNodeSessionId,
  NodeToDaemonMessage,
  WebPageOperation,
} from '@infos/shared'
import { logger } from '../utils/logger'
import { windowManager } from '../windows/manager'
import { launchApplication } from './applicationLauncher'
import { listWindows, mousePosition } from './desktopAutomation'
import { browserRuntime } from './browserRuntime'
import { renderStatusCard } from './statusCard'
import { captureScreen, getActiveWindow, readClipboard, writeClipboard } from './desktopAwareness'
import { desktopControl, type DesktopCaller } from './desktopControl'
import { mapScreenshotRegion, screenshotMaxWidth, type ScreenshotRect } from './screenshotGeometry'
import { windowsDesktop } from './windowsDesktop'
import { completionAlerts } from './completionAlerts'
import { isApplicationFocused } from './notificationVisibility'
import { renderDocumentPdf } from './documentPdf'
import { getCapabilityEndpoint, isRemoteConnection, clientConnection } from './clientConnection'

const CAPABILITY_PORT = Number(process.env.PERO_CAPABILITY_PORT ?? 9121)
const DAEMON_HOST = process.env.PERO_DAEMON_HOST ?? '127.0.0.1'
const HEARTBEAT_INTERVAL_MS = 25_000
const RECONNECT_INTERVAL_MS = 5_000
const NODE_ID_FILE = 'electron-node-id.txt'
const DEVICE_CREDENTIAL_FILE = 'capability-device-credential.json'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type OutboundCapabilityMessage = DistributiveOmit<NodeToDaemonMessage, 'protocolVersion'>

const WEB_OPERATIONS: readonly WebPageOperation[] = [
  'open',
  'inspect',
  'extract',
  'search',
  'screenshot',
  'elementScreenshot',
  'click',
  'nativeClick',
  'hover',
  'type',
  'sendKeys',
  'setValue',
  'selectOption',
  'check',
  'scroll',
  'back',
  'wait',
  'listTargets',
  'createTarget',
  'switchTarget',
  'closeTarget',
  'domQuery',
  'frameQuery',
  'sourceSearch',
  'handleDialog',
  'networkQuery',
  'networkBody',
  'networkConfigure',
  'downloadConfigure',
  'uploadFile',
  'storage',
  'emulate',
  'evaluate',
  'runtimeStatus',
]
const DESKTOP_OPERATIONS = [
  'runtimeDiagnostics',
  'control',
  'statusCard',
  'screenCapture',
  'clipboardRead',
  'clipboardWrite',
  'activeWindow',
  'listWindows',
  'activateWindow',
  'applicationLaunch',
  'mousePosition',
  'mouseAction',
  'keyboardAction',
] as const
const AUDIO_OUTPUT_OPERATIONS = ['play', 'stop', 'status'] as const

class ElectronCapabilityProvider {
  private socket: WebSocket | null = null
  private nodeId = '' as KernelNodeId
  private sessionId?: KernelNodeSessionId
  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private readonly invocations = new Map<string, AbortController>()
  private readonly screenObservations = new Map<
    string,
    {
      owner: string
      createdAt: number
      geometry: string
      displayId: string
      bounds: ScreenshotRect
      width: number
      height: number
    }
  >()
  private readonly playbackStates = new Map<
    string,
    { state: 'playing' | 'completed' | 'cancelled'; startedAt: string }
  >()
  private readonly playbackReceipts = new Map<
    string,
    { resolve: (state: 'completed' | 'cancelled') => void; timer: NodeJS.Timeout }
  >()
  private stopped = false

  getNodeId(): KernelNodeId {
    if (!this.nodeId) this.nodeId = this.loadOrCreateNodeId()
    return this.nodeId
  }

  async start(): Promise<void> {
    this.stopped = false
    desktopControl.initialize()
    this.nodeId = this.getNodeId()
    void this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.screenObservations.clear()
    for (const controller of this.invocations.values()) controller.abort('客户端退出')
    await desktopControl.stop()
    await browserRuntime.close()
    this.stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
    this.sessionId = undefined
    logger.info('CapabilityProvider', __t('electron.logs.capabilityProvider', '已停止'))
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const url = getCapabilityEndpoint()
    let token = this.loadDeviceToken(url)
    try {
      if (!token && isRemoteConnection()) {
        token = await clientConnection().capabilityPairingCode()
      } else if (isRemoteConnection()) {
        await clientConnection().verify()
      }
    } catch {
      if (!this.stopped) this.scheduleReconnect()
      return
    }
    if (this.stopped) return
    logger.info(
      'CapabilityProvider',
      __t('electron.logs.capabilityProvider', '正在连接 Daemon: {0}', [url]),
    )
    const socket = new WebSocket(url)
    this.socket = socket
    socket.on('open', () => {
      const message: OutboundCapabilityMessage = {
        type: 'authenticate',
        token:
          token || process.env.INFOS_CAPABILITY_PAIRING_CODE || process.env.INFOS_API_TOKEN || '',
      }
      this.send(message)
    })
    socket.on('message', (data) => void this.handleMessage(data.toString()))
    socket.on('close', () => {
      for (const controller of this.invocations.values()) controller.abort('能力连接断开')
      desktopControl.disconnect()
      this.screenObservations.clear()
      if (this.socket === socket) this.socket = null
      this.sessionId = undefined
      this.stopHeartbeat()
      this.scheduleReconnect()
    })
    socket.on('error', (error) =>
      logger.error(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', '连接错误: {0}', [error.message]),
      ),
    )
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: DaemonToNodeMessage
    try {
      message = JSON.parse(raw) as DaemonToNodeMessage
    } catch {
      logger.warn(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', '收到非法 JSON: {0}', [raw.slice(0, 200)]),
      )
      return
    }
    if (message.type === 'authenticated') {
      if (message.deviceToken) {
        this.saveDeviceToken(getCapabilityEndpoint(), message.deviceToken)
      }
      this.sendHello()
      return
    }
    if (message.type === 'node_accepted') {
      this.sessionId = message.sessionId
      this.startHeartbeat()
      logger.info(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', 'Node已接入，Session={0}', [message.sessionId]),
      )
      return
    }
    if (message.type === 'capability_invoke') {
      await this.invoke(message)
      return
    }
    if (message.type === 'capability_cancel') {
      this.invocations.get(message.invocationId)?.abort(message.reason)
      this.invocations.delete(message.invocationId)
      return
    }
    if (message.type === 'error') {
      if (isRemoteConnection() && /CAPABILITY_AUTH_(FAILED|REQUIRED)/.test(message.message)) {
        // 设备凭据撤销后重新申请一次性配对，不将业务访问令牌发给能力通道。
        try {
          fs.rmSync(this.credentialFile(), { force: true })
        } catch {
          /* 下次连接仍按服务端鉴权结果处理。 */
        }
        this.socket?.close()
      }
      logger.error(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', 'Daemon错误: {0}', [message.message]),
      )
    }
  }

  private sendHello(): void {
    const descriptor: KernelNodeDescriptor = {
      nodeId: this.nodeId,
      displayName: 'infOS Electron Client',
      facets: ['client', 'capability', 'device'],
      trust: 'local',
      platform: {
        os:
          process.platform === 'win32'
            ? 'windows'
            : process.platform === 'darwin'
              ? 'macos'
              : process.platform === 'linux'
                ? 'linux'
                : 'unknown',
        arch: process.arch,
        runtime: 'electron',
        version: process.versions.electron,
      },
      protocolVersion: 1,
      labels: { edition: process.env.INFOS_EDITION ?? 'desktop' },
      registeredAt: new Date().toISOString(),
    }
    this.send({ type: 'node_hello', descriptor, offers: this.createOffers() })
  }

  private createOffers(): KernelCapabilityOffer[] {
    return [
      this.offer('electron.web-page', 'web.page', WEB_OPERATIONS, ['web-page', 'browser-session']),
      this.offer('electron.desktop-environment', 'desktop.environment', DESKTOP_OPERATIONS, [
        'screen',
        'clipboard',
        'active-window',
      ]),
      this.offer('electron.audio-output', 'audio.output', AUDIO_OUTPUT_OPERATIONS, [
        'speaker',
        'audio-playback',
      ]),
      this.offer('electron.document-render', 'document.render', ['renderPdf'], ['pdf']),
      this.offer(
        'electron.completion-alert',
        'client.completion-alert',
        ['notify'],
        ['completion-notification'],
      ),
    ]
  }

  private offer(
    id: string,
    capabilityType: string,
    operations: readonly string[],
    resourceKinds: readonly string[],
  ): KernelCapabilityOffer {
    return {
      offerId: `${id}@1.0:${this.nodeId}`,
      provider: {
        objectType: 'capability-provider',
        objectId: `${id}/provider` as KernelCapabilityOffer['provider']['objectId'],
        generation: 1,
        ownerPrincipalId: 'electron-client',
        authorityNodeId: this.nodeId,
        authorityEpoch: 1,
      },
      capabilityType,
      contractVersion: '1.0',
      operations,
      resourceKinds,
      health: 'available',
      placement: {
        providerNodeId: this.nodeId,
        providerFacet: 'capability',
        executionLocation: 'client-local',
        resourceAuthorityNodeId: this.nodeId,
        requiresClientPresence: true,
        requiresInputSeat: capabilityType === 'desktop.environment',
        supportsHeadless: false,
        dataResidency: 'device-only',
        latencyClass: 'local',
        costClass: 'free',
      },
    }
  }

  private async invoke(
    message: Extract<DaemonToNodeMessage, { type: 'capability_invoke' }>,
  ): Promise<void> {
    const { invocationId, envelope } = message
    const operation = envelope.payload.operation
    const controller = new AbortController()
    this.invocations.set(invocationId, controller)
    const remaining = envelope.deadline ? Date.parse(envelope.deadline) - Date.now() : undefined
    const deadlineTimer =
      remaining !== undefined && remaining > 0
        ? setTimeout(() => controller.abort('调用已过期'), remaining)
        : undefined
    try {
      if (envelope.deadline && Date.parse(envelope.deadline) <= Date.now()) {
        throw new Error('CAPABILITY_DEADLINE_EXCEEDED: 调用已过期')
      }
      let output: unknown
      if (envelope.operation.startsWith('web.page/')) {
        if (!WEB_OPERATIONS.includes(operation as WebPageOperation)) {
          throw new Error(`CAPABILITY_OPERATION_UNSUPPORTED: ${operation}`)
        }
        output = await browserRuntime.invoke(
          operation,
          envelope.payload.input as Record<string, unknown>,
          envelope.principalId,
        )
      } else if (envelope.operation.startsWith('desktop.environment/')) {
        if (operation === 'runtimeDiagnostics') {
          output = await runtimeDiagnostics(controller.signal)
        } else {
          output =
            operation === 'statusCard'
              ? await renderStatusCard(
                  envelope.payload.input as Record<string, unknown>,
                  controller.signal,
                )
              : await this.invokeDesktop(
                  operation,
                  envelope.payload.input as Record<string, unknown>,
                  controller.signal,
                )
        }
      } else if (envelope.operation.startsWith('audio.output/')) {
        output = await this.invokeAudioOutput(
          operation,
          envelope.payload.input as Record<string, unknown>,
          controller.signal,
        )
      } else if (envelope.operation === 'document.render/renderPdf') {
        output = await renderDocumentPdf(envelope.payload.input, controller.signal)
      } else if (envelope.operation === 'client.completion-alert/notify') {
        controller.signal.throwIfAborted()
        output = await completionAlerts.notify(envelope.payload.input)
      } else {
        throw new Error(`CAPABILITY_TYPE_UNSUPPORTED: ${envelope.operation}`)
      }
      this.send({ type: 'capability_result', invocationId, success: true, output })
      logger.info(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', '调用完成: {0}', [envelope.operation]),
      )
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const separator = text.indexOf(':')
      this.send({
        type: 'capability_result',
        invocationId,
        success: false,
        error: {
          code: separator > 0 ? text.slice(0, separator) : 'CAPABILITY_PROVIDER_ERROR',
          message: separator > 0 ? text.slice(separator + 1).trim() : text,
          retryable: /TIMEOUT|UNAVAILABLE|DISCONNECTED/.test(text),
        },
      })
      logger.error(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', '调用失败: {0} - {1}', [envelope.operation, text]),
      )
    } finally {
      clearTimeout(deadlineTimer)
      this.invocations.delete(invocationId)
    }
  }

  private async invokeAudioOutput(
    operation: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const playbackId = String(input.playbackId ?? randomUUID())
    if (operation === 'status') {
      return { playbackId, ...(this.playbackStates.get(playbackId) ?? { state: 'cancelled' }) }
    }
    if (operation === 'stop') {
      for (const win of [
        windowManager.petWin,
        windowManager.dashboardWin,
        windowManager.launcherWin,
      ]) {
        if (win && !win.isDestroyed()) win.webContents.send('audio-output:stop', { playbackId })
      }
      this.completePlayback(playbackId, 'cancelled')
      return { playbackId, state: 'cancelled' }
    }
    if (operation !== 'play') throw new Error(`CAPABILITY_OPERATION_UNSUPPORTED: ${operation}`)
    const assetUrl = String(input.assetUrl ?? '')
    if (!assetUrl.startsWith('/api/assets/audio/')) {
      throw new Error('AUDIO_ASSET_INVALID: audio.output.play 需要受控 Audio Asset URL')
    }
    this.playbackStates.set(playbackId, { state: 'playing', startedAt: new Date().toISOString() })
    if (signal.aborted) throw new Error('CAPABILITY_CANCELLED: 播放已取消')
    const targetWindow =
      windowManager.petWin ??
      windowManager.chatWin ??
      windowManager.dashboardWin ??
      windowManager.launcherWin
    targetWindow?.webContents.send('audio-output:play', {
      playbackId,
      assetUrl,
      agentId: typeof input.agentId === 'string' ? input.agentId : undefined,
      threadId: typeof input.threadId === 'string' ? input.threadId : undefined,
      volume: Number(input.volume ?? 1),
      caption:
        typeof input.caption === 'string' && input.caption.length <= 240
          ? input.caption
          : undefined,
    })
    const state = await this.waitForPlaybackReceipt(playbackId, signal)
    return { playbackId, state }
  }

  completePlayback(playbackId: string, state: 'completed' | 'cancelled'): void {
    const current = this.playbackStates.get(playbackId)
    if (current) current.state = state
    const receipt = this.playbackReceipts.get(playbackId)
    if (!receipt) return
    clearTimeout(receipt.timer)
    this.playbackReceipts.delete(playbackId)
    receipt.resolve(state)
  }

  private waitForPlaybackReceipt(
    playbackId: string,
    signal: AbortSignal,
  ): Promise<'completed' | 'cancelled'> {
    return new Promise((resolve) => {
      const finish = (state: 'completed' | 'cancelled') => {
        signal.removeEventListener('abort', onAbort)
        resolve(state)
      }
      const onAbort = () => {
        const targetWindow =
          windowManager.petWin ??
          windowManager.chatWin ??
          windowManager.dashboardWin ??
          windowManager.launcherWin
        try {
          if (
            targetWindow &&
            !targetWindow.isDestroyed() &&
            !targetWindow.webContents.isDestroyed()
          )
            targetWindow.webContents.send('audio-output:stop', { playbackId })
        } finally {
          // 窗口失效时也要结束回执等待，避免取消操作遗留计时器。
          this.completePlayback(playbackId, 'cancelled')
        }
      }
      const timer = setTimeout(() => this.completePlayback(playbackId, 'cancelled'), 5 * 60_000)
      timer.unref?.()
      this.playbackReceipts.set(playbackId, { resolve: finish, timer })
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  private async invokeDesktop(
    operation: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const identity = input.__desktopCaller as DesktopCaller | undefined
    const caller: DesktopCaller = {
      agentId: identity?.agentId,
      threadId: identity?.threadId,
      taskId: identity?.taskId,
      signal,
    }
    signal.throwIfAborted()
    if (operation === 'control') {
      if (input.action === 'status') return desktopControl.snapshot()
      if (input.action === 'resume')
        return desktopControl.snapshot().phase === 'idle'
          ? desktopControl.snapshot()
          : desktopControl.resume()
      throw new Error('DESKTOP_CONTROL_DENIED: 不支持的桌面控制操作')
    }
    if (operation === 'screenCapture' && process.platform === 'win32')
      return desktopControl.observe(input, caller)
    if (operation === 'screenCapture') {
      const maxWidth = screenshotMaxWidth(input.maxWidth)
      const owner = JSON.stringify([caller.agentId, caller.taskId ?? caller.threadId])
      const geometry = () =>
        JSON.stringify(
          screen
            .getAllDisplays()
            .map((display) => [display.id, display.bounds, display.scaleFactor]),
        )
      const layout = geometry()
      const reference =
        input.region !== undefined
          ? this.screenObservations.get(String(input.observationId ?? ''))
          : undefined
      if (
        input.region !== undefined &&
        (!reference ||
          reference.owner !== owner ||
          Date.now() - reference.createdAt > 120_000 ||
          reference.geometry !== layout ||
          (input.displayId !== undefined && String(input.displayId) !== reference.displayId))
      )
        throw new Error(
          __t('errors.electron', 'SCREENSHOT_REFERENCE_REQUIRED: 区域截图需要有效的参考截图编号'),
        )
      const raw = await captureScreen(maxWidth, {
        displayId:
          reference?.displayId ??
          (input.displayId !== undefined ? String(input.displayId) : undefined),
        bounds: reference
          ? mapScreenshotRegion(input.region, reference, reference.bounds)
          : undefined,
      })
      if (!raw) throw new Error('SCREEN_CAPTURE_UNAVAILABLE: 无法获取屏幕内容')
      signal.throwIfAborted()
      if (geometry() !== layout)
        throw new Error('DESKTOP_OBSERVATION_STALE: 观察期间控制权发生变化，请重新观察')
      const observationId = randomUUID()
      this.screenObservations.set(observationId, {
        owner,
        createdAt: Date.now(),
        geometry: layout,
        displayId: raw.displayId,
        bounds: raw.bounds,
        width: raw.width,
        height: raw.height,
      })
      while (this.screenObservations.size > 16)
        this.screenObservations.delete(this.screenObservations.keys().next().value!)
      return {
        success: true,
        observationId,
        screenshots: [
          {
            index: 0,
            dataUri: raw.dataUrl,
            coordinateContext: {
              observationId,
              ...(reference ? { referenceObservationId: String(input.observationId) } : {}),
              displayId: raw.displayId,
              coordinateSpace: 'screenshot',
              sourceCoordinateSpace: 'desktop-dip',
              screenshotWidth: raw.width,
              screenshotHeight: raw.height,
              bounds: raw.bounds,
              workArea: raw.workArea,
              scaleFactor: raw.scaleFactor,
            },
          },
        ],
        message:
          __t('electron.ui.capabilityProvider', '已截取屏幕 ({0}x{1})。', [raw.width, raw.height]) +
          __t(
            'electron.ui.capabilityProvider',
            '如需点击截图位置，请使用coordinateSpace=screenshot、displayId={0}、',
            [raw.displayId],
          ) +
          `screenshotWidth=${raw.width}、screenshotHeight=${raw.height}。`,
      }
    }
    if (operation === 'clipboardRead') return readClipboard()
    if (operation === 'clipboardWrite') {
      await writeClipboard(String(input.text ?? ''))
      return { success: true }
    }
    if (operation === 'activeWindow')
      return process.platform === 'win32' ? windowsDesktop.active() : getActiveWindow()
    if (operation === 'listWindows') return listWindows()
    if (operation === 'activateWindow')
      return desktopControl.mutate(caller, async (actionSignal) => {
        const target = String(input.target ?? '')
        const windows = await windowsDesktop.windows()
        const exact = windows.filter(
          (window) => window.windowId === target || window.title === target,
        )
        const matches = exact.length
          ? exact
          : windows.filter((window) => window.title.toLowerCase().includes(target.toLowerCase()))
        if (!target || matches.length !== 1)
          throw new Error('WINDOW_AMBIGUOUS: 请使用窗口列表中的 windowId 指定唯一窗口')
        const result = await windowsDesktop.request<{ title: string }>(
          'activate',
          { windowId: matches[0]!.windowId },
          actionSignal,
        )
        return result.title
      })
    if (operation === 'applicationLaunch') {
      return desktopControl.mutate(caller, async (actionSignal) => {
        actionSignal.throwIfAborted()
        const result = await launchApplication(
          String(input.appName ?? input.app_name ?? ''),
          undefined,
          actionSignal,
        )
        actionSignal.throwIfAborted()
        return result
      })
    }
    if (operation === 'mousePosition') return mousePosition()
    if (operation === 'mouseAction' || operation === 'keyboardAction') {
      const action = String(input.action ?? '')
      if (action === 'notification') {
        if (isApplicationFocused()) return { success: true, suppressed: true }
        const { Notification } = await import('electron')
        new Notification({
          title: String(input.title ?? input.text ?? 'infOS 提醒'),
          body: String(input.message ?? ''),
        }).show()
        return { success: true }
      }
      const elements = ['invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse']
      const mouse = [
        'wait',
        'move',
        'click',
        'double_click',
        'right_click',
        'drag',
        'scroll',
        'mouse_down',
        'mouse_up',
      ]
      const keyboard = ['type', 'hotkey', 'key_down', 'key_up']
      if (![...elements, ...mouse, ...keyboard].includes(action))
        throw new Error('DESKTOP_ACTION_UNSUPPORTED: 不支持的桌面操作')
      if (elements.includes(action) && !input.elementId)
        throw new Error('DESKTOP_ELEMENT_REQUIRED: 请提供本次观察中的 elementId')
      if (input.elementId && !elements.includes(action) && action !== 'scroll')
        throw new Error('DESKTOP_ACTION_UNSUPPORTED: 该动作不能通过控件执行')
      if (typeof input.text === 'string' && input.text.length > 10_000)
        throw new Error('DESKTOP_TEXT_TOO_LONG: 单次输入最多一万字符，请分段处理')
      return desktopControl.execute(
        action === 'wait'
          ? 'wait'
          : input.elementId
            ? 'element'
            : keyboard.includes(action)
              ? 'keyboard'
              : 'mouse',
        input,
        caller,
      )
    }
    throw new Error(`CAPABILITY_OPERATION_UNSUPPORTED: ${operation}`)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.sessionId) return
      this.send({ type: 'heartbeat', nodeId: this.nodeId, sessionId: this.sessionId })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, RECONNECT_INTERVAL_MS)
  }

  private send(message: OutboundCapabilityMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ ...message, protocolVersion: 1 }))
    }
  }

  private credentialFile(): string {
    return path.join(app.getPath('userData'), DEVICE_CREDENTIAL_FILE)
  }

  private loadDeviceToken(endpoint: string): string {
    try {
      const file = this.credentialFile()
      if (!fs.existsSync(file)) return ''
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        endpoint?: string
        token?: string
        serverId?: string
        secret?: string
      }
      const legacy =
        !isRemoteConnection() && parsed.endpoint === `${DAEMON_HOST}:${CAPABILITY_PORT}`
      const sameServer =
        !isRemoteConnection() || parsed.serverId === clientConnection().current?.serverId
      if (!sameServer || (parsed.endpoint !== endpoint && !legacy)) return ''
      return parsed.secret
        ? clientConnection().revealSecret(parsed.secret)
        : !isRemoteConnection()
          ? (parsed.token ?? '')
          : ''
    } catch {
      return ''
    }
  }

  private saveDeviceToken(endpoint: string, token: string): void {
    try {
      fs.writeFileSync(
        this.credentialFile(),
        JSON.stringify(
          {
            version: 3,
            endpoint,
            serverId: isRemoteConnection() ? clientConnection().current?.serverId : 'local',
            secret: clientConnection().protectSecret(token),
          },
          null,
          2,
        ),
        { encoding: 'utf8', mode: 0o600 },
      )
      logger.info(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', '能力节点设备凭据已安全保存'),
      )
    } catch (error) {
      logger.warn(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', '保存能力节点设备凭据失败: {0}', [error]),
      )
    }
  }

  private loadOrCreateNodeId(): KernelNodeId {
    const file = path.join(app.getPath('userData'), NODE_ID_FILE)
    try {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
      if (existing) return existing as KernelNodeId
    } catch (error) {
      logger.warn(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', '读取 Node ID失败: {0}', [error]),
      )
    }
    const id = `electron:${randomUUID()}` as KernelNodeId
    try {
      fs.writeFileSync(file, id, 'utf8')
    } catch (error) {
      logger.warn(
        'CapabilityProvider',
        __t('electron.logs.capabilityProvider', '保存 Node ID失败: {0}', [error]),
      )
    }
    return id
  }
}

export const capabilityProvider = new ElectronCapabilityProvider()
