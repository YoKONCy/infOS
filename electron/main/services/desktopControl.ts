import { t as __t } from '../utils/i18n'
import { app, BrowserWindow, globalShortcut, powerMonitor, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DesktopControlSettings,
  DesktopControlState,
  DesktopElementInfo,
  DesktopWindowInfo,
} from '@infos/shared'
import { windowsDesktop } from './windowsDesktop'
import { captureScreen } from './desktopAwareness'
import { resolveDesktopPoint } from './desktopCoordinates'
import { mapScreenshotRegion, screenshotMaxWidth } from './screenshotGeometry'
import { waitForDesktopIdle } from './desktopIdle'
import { logger } from '../utils/logger'

export interface DesktopCaller {
  agentId?: string
  threadId?: string
  taskId?: string
  signal?: AbortSignal
}
interface Observation {
  id: string
  owner: string
  epoch: number
  createdAt: number
  window: DesktopWindowInfo
  elements: DesktopElementInfo[]
  displayId: string
  geometry: string
  bounds: { x: number; y: number; width: number; height: number }
  width: number
  height: number
}

/** 桌面控制只串行化具体动作，模型思考期间不占用系统输入。 */
class DesktopControl {
  private settings: DesktopControlSettings = { enabled: true, stopShortcut: 'Control+Alt+Escape' }
  private state: DesktopControlState = {
    phase: 'idle',
    epoch: 1,
    stopShortcut: this.settings.stopShortcut,
  }
  private readonly observations = new Map<string, Observation>()
  private queue: Promise<unknown> = Promise.resolve()
  private active?: AbortController
  private initialized = false
  private suspended = false
  private boundShortcut = ''
  private heldInputs = false
  private holdExpiry?: ReturnType<typeof setTimeout>
  private shortcutCapture?: { owner: Electron.WebContents; cleanup: () => void }

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as DesktopControlSettings
      this.settings = {
        enabled: saved.enabled !== false,
        stopShortcut: saved.stopShortcut || this.settings.stopShortcut,
      }
    } catch {
      /* 首次启动使用默认配置。 */
    }
    try {
      this.registerShortcut(this.settings.stopShortcut)
    } catch {
      this.state = { ...this.state, phase: 'paused', reason: '停止快捷键已被占用，请在设置中更换' }
    }
    windowsDesktop.on('activity', this.onActivity)
    windowsDesktop.on('unavailable', this.onUnavailable)
    powerMonitor.on('lock-screen', this.onSuspend)
    powerMonitor.on('suspend', this.onSuspend)
    powerMonitor.on('unlock-screen', this.onResume)
    powerMonitor.on('resume', this.onResume)
  }

  snapshot(): DesktopControlState {
    return { ...this.state, stopShortcut: this.settings.stopShortcut }
  }
  configuration(): DesktopControlSettings {
    return { ...this.settings }
  }

  disconnect(): void {
    if (this.active || this.observations.size || this.heldInputs || this.state.agentId) {
      this.pause('设备连接已断开，请重新连接后继续')
    } else {
      this.observations.clear()
      this.state.epoch++
    }
  }

  setShortcutCapturing(owner: Electron.WebContents, active: boolean): void {
    if (active) {
      if (this.shortcutCapture?.owner === owner) return
      if (this.shortcutCapture) throw new Error('另一个窗口正在录入快捷键')
      const win = BrowserWindow.fromWebContents(owner)
      if (!win?.isFocused()) throw new Error('请在当前窗口录入快捷键')
      const finish = () => this.setShortcutCapturing(owner, false)
      owner.once('destroyed', finish)
      owner.once('did-start-loading', finish)
      win.once('blur', finish)
      this.shortcutCapture = {
        owner,
        cleanup: () => {
          owner.removeListener('destroyed', finish)
          owner.removeListener('did-start-loading', finish)
          win.removeListener('blur', finish)
        },
      }
      if (this.boundShortcut) globalShortcut.unregister(this.boundShortcut)
      this.boundShortcut = ''
    } else if (this.shortcutCapture?.owner === owner) {
      this.shortcutCapture.cleanup()
      this.shortcutCapture = undefined
      try {
        this.registerShortcut(this.settings.stopShortcut)
      } catch {
        this.pause('停止快捷键无法注册，请重新设置')
      }
    }
  }

  update(patch: Partial<DesktopControlSettings>): DesktopControlSettings {
    const next = { ...this.settings }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (patch.stopShortcut !== undefined) {
      if (
        typeof patch.stopShortcut !== 'string' ||
        !patch.stopShortcut.trim() ||
        patch.stopShortcut.length > 100
      )
        throw new Error('请设置有效的停止快捷键')
      next.stopShortcut = patch.stopShortcut.trim()
    }
    if (!this.shortcutCapture) this.registerShortcut(next.stopShortcut)
    fs.writeFileSync(this.file(), JSON.stringify(next, null, 2), 'utf8')
    this.settings = next
    if (!next.enabled) this.pause('桌面操作已关闭')
    this.publish()
    return this.configuration()
  }

  pause(reason = '桌面操作已暂停'): DesktopControlState {
    this.state = { ...this.state, phase: 'paused', epoch: this.state.epoch + 1, reason }
    this.observations.clear()
    this.active?.abort(reason)
    clearTimeout(this.holdExpiry)
    this.heldInputs = false
    if (process.platform === 'win32') void windowsDesktop.release()
    this.publish()
    return this.snapshot()
  }

  resume(): DesktopControlState {
    if (!this.settings.enabled) throw new Error('请先开启桌面操作')
    if (this.suspended) throw new Error('请先解锁并唤醒电脑')
    if (this.active) throw new Error('正在清理上一次操作，请稍后继续')
    if (this.shortcutCapture) throw new Error('请先完成停止快捷键录入')
    if (!globalShortcut.isRegistered(this.settings.stopShortcut))
      this.registerShortcut(this.settings.stopShortcut)
    this.state = {
      phase: 'idle',
      epoch: this.state.epoch + 1,
      stopShortcut: this.settings.stopShortcut,
    }
    this.observations.clear()
    this.publish()
    return this.snapshot()
  }

  private owner(caller: DesktopCaller): string {
    return `${caller.agentId ?? 'system'}:${caller.taskId ?? caller.threadId ?? 'desktop'}`
  }
  private reference(id: unknown, caller: DesktopCaller): Observation {
    const observation = this.observations.get(String(id ?? ''))
    if (
      !observation ||
      observation.owner !== this.owner(caller) ||
      observation.epoch !== this.state.epoch ||
      Date.now() - observation.createdAt > 120_000 ||
      observation.geometry !== this.geometry()
    )
      throw new Error('DESKTOP_OBSERVATION_STALE: 请先观察桌面，再引用本次 observationId 操作')
    return observation
  }
  private geometry(): string {
    return JSON.stringify(
      screen.getAllDisplays().map((display) => [display.id, display.bounds, display.scaleFactor]),
    )
  }
  private assertAvailable(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('DESKTOP_CANCELLED: 桌面操作已取消')
    if (!this.settings.enabled) throw new Error('DESKTOP_DISABLED: 桌面操作未开启')
    if (this.shortcutCapture) throw new Error('DESKTOP_WAITING: 正在录入停止快捷键')
    if (this.suspended) throw new Error('DESKTOP_WAITING: 电脑已锁定或休眠，请唤醒后继续')
    if (this.state.phase === 'paused' || this.state.phase === 'unavailable')
      throw new Error(`DESKTOP_WAITING: ${this.state.reason ?? '请在主应用中继续桌面操作'}`)
    if (process.platform !== 'win32')
      throw new Error('DESKTOP_PLATFORM_UNSUPPORTED: 受控桌面操作目前支持 Windows')
  }

  private serial<T>(caller: DesktopCaller, action: () => Promise<T>): Promise<T> {
    const epoch = this.state.epoch
    const pending = this.queue.then(async () => {
      this.assertAvailable(caller.signal)
      if (epoch !== this.state.epoch)
        throw new Error('DESKTOP_OBSERVATION_STALE: 用户操作后需要重新观察')
      return action()
    })
    this.queue = pending.catch(() => {})
    return pending
  }

  observe(input: Record<string, unknown>, caller: DesktopCaller): Promise<unknown> {
    return this.serial(caller, () => this.capture(input, caller))
  }

  private async capture(input: Record<string, unknown>, caller: DesktopCaller): Promise<unknown> {
    const epoch = this.state.epoch
    const geometry = this.geometry()
    const maxWidth = screenshotMaxWidth(input.maxWidth)
    if (input.region !== undefined && !input.observationId)
      throw new Error(
        __t('errors.electron', 'SCREENSHOT_REFERENCE_REQUIRED: 区域截图需要有效的参考截图编号'),
      )
    const reference =
      input.region !== undefined ? this.reference(input.observationId, caller) : undefined
    const region = reference
      ? mapScreenshotRegion(input.region, reference, reference.bounds)
      : undefined
    if (
      reference &&
      ((input.windowId !== undefined && input.windowId !== reference.window.windowId) ||
        (input.displayId !== undefined && String(input.displayId) !== reference.displayId))
    )
      throw new Error('DESKTOP_OBSERVATION_STALE: 目标窗口已变化，请重新观察')
    await windowsDesktop.start()
    const info = await windowsDesktop.observe(
      reference?.window.windowId ??
        (typeof input.windowId === 'string' ? input.windowId : undefined),
      input.includeElements === true,
      caller.signal,
    )
    if (
      reference &&
      (info.window.pid !== reference.window.pid ||
        JSON.stringify(info.window.bounds) !== JSON.stringify(reference.window.bounds))
    )
      throw new Error('DESKTOP_OBSERVATION_STALE: 目标窗口已变化，请重新观察')
    const display =
      reference || input.displayId != null
        ? screen
            .getAllDisplays()
            .find(
              (candidate) =>
                String(candidate.id) === String(reference?.displayId ?? input.displayId),
            )
        : screen.getDisplayMatching(screen.screenToDipRect(null, info.window.bounds))
    if (!display) throw new Error('DESKTOP_DISPLAY_NOT_FOUND: 目标显示器已断开')
    const crop =
      region ?? (input.windowId ? screen.screenToDipRect(null, info.window.bounds) : undefined)
    const raw = await captureScreen(maxWidth, {
      displayId: String(display.id),
      bounds: crop,
    })
    if (!raw) throw new Error('SCREEN_CAPTURE_UNAVAILABLE: 无法获取屏幕内容')
    if (epoch !== this.state.epoch || caller.signal?.aborted)
      throw new Error('DESKTOP_OBSERVATION_STALE: 观察期间控制权发生变化，请重新观察')
    const current = await windowsDesktop.request<DesktopWindowInfo>(
      'window',
      { windowId: info.window.windowId },
      caller.signal,
    )
    if (
      epoch !== this.state.epoch ||
      geometry !== this.geometry() ||
      current.pid !== info.window.pid ||
      JSON.stringify(current.bounds) !== JSON.stringify(info.window.bounds)
    )
      throw new Error('DESKTOP_OBSERVATION_STALE: 截图期间窗口发生移动，请重新观察')
    // 复查窗口不能再次枚举控件，否则会清空本次观察的控件引用。
    const observation: Observation = {
      id: randomUUID(),
      owner: this.owner(caller),
      epoch,
      createdAt: Date.now(),
      window: info.window,
      elements: info.elements,
      displayId: raw.displayId,
      geometry,
      bounds: raw.bounds,
      width: raw.width,
      height: raw.height,
    }
    this.observations.set(observation.id, observation)
    while (this.observations.size > 16)
      this.observations.delete(this.observations.keys().next().value!)
    return {
      success: true,
      observationId: observation.id,
      window: info.window,
      elements: info.elements,
      screenshots: [
        {
          index: 0,
          dataUri: raw.dataUrl,
          coordinateContext: {
            observationId: observation.id,
            ...(reference ? { referenceObservationId: reference.id } : {}),
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
      message: __t(
        'electron.ui.desktopControl',
        '已观察桌面。操作时引用 observationId；坐标以本次截图为准。',
      ),
    }
  }

  execute(
    operation: 'mouse' | 'keyboard' | 'element' | 'wait',
    input: Record<string, unknown>,
    caller: DesktopCaller,
  ): Promise<unknown> {
    return this.serial(caller, async () => {
      const observation = this.reference(input.observationId, caller)
      const current = await windowsDesktop
        .windows()
        .then((windows) =>
          windows.find((window) => window.windowId === observation.window.windowId),
        )
      if (
        !current ||
        current.pid !== observation.window.pid ||
        JSON.stringify(current.bounds) !== JSON.stringify(observation.window.bounds)
      )
        throw new Error('DESKTOP_OBSERVATION_STALE: 目标窗口已变化，请重新观察')
      if (!windowsDesktop.monitor)
        throw new Error('DESKTOP_INPUT_MONITOR_UNAVAILABLE: 用户接管监听不可用')
      await this.waitUntilIdle(caller)
      if (
        operation === 'element' &&
        !observation.elements.some((element) => element.id === input.elementId)
      )
        throw new Error('DESKTOP_ELEMENT_STALE: 控件不属于本次观察，请重新观察')
      this.assertAvailable(caller.signal)
      if (observation.epoch !== this.state.epoch)
        throw new Error('DESKTOP_OBSERVATION_STALE: 用户操作后需要重新观察')
      const controller = new AbortController()
      this.active = controller
      const cancel = () => controller.abort(caller.signal?.reason)
      caller.signal?.addEventListener('abort', cancel, { once: true })
      if (caller.signal?.aborted) cancel()
      this.state = {
        ...this.state,
        phase: 'running',
        reason: undefined,
        agentId: caller.agentId,
        threadId: caller.threadId,
        taskId: caller.taskId,
        targetTitle: current.title,
      }
      this.publish()
      this.observations.clear()
      let dispatched = false
      try {
        const args = { ...input, windowId: current.windowId }
        if (operation === 'element')
          Object.assign(args, {
            expectedElement: observation.elements.find((element) => element.id === input.elementId),
          })
        if (operation === 'mouse') {
          const display = { id: observation.displayId, bounds: observation.bounds, scaleFactor: 1 }
          const point = (x: unknown, y: unknown) =>
            resolveDesktopPoint(
              {
                x,
                y,
                coordinateSpace: input.coordinateSpace ?? 'screenshot',
                screenshotWidth: observation.width,
                screenshotHeight: observation.height,
              },
              display,
              (value) =>
                screen.dipToScreenPoint({ x: Math.round(value.x), y: Math.round(value.y) }),
            )
          const start =
            input.action === 'mouse_up'
              ? await windowsDesktop.request<{ x: number; y: number }>('position')
              : point(input.x, input.y)
          Object.assign(args, start)
          if (input.action === 'drag') {
            const end = point(input.x2, input.y2)
            Object.assign(args, { x2: end.x, y2: end.y })
          }
        }
        if (input.action === 'key_down' || input.action === 'mouse_down') {
          this.heldInputs = true
          clearTimeout(this.holdExpiry)
          this.holdExpiry = setTimeout(() => {
            this.heldInputs = false
          }, 2100)
        }
        const receipt = await windowsDesktop.request(operation, args, controller.signal)
        dispatched = operation !== 'wait'
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', aborted)
            resolve()
          }
          const aborted = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', aborted)
            reject(new Error('DESKTOP_CANCELLED: 桌面操作已暂停'))
          }
          const timer = setTimeout(done, 200)
          controller.signal.addEventListener('abort', aborted, { once: true })
          if (controller.signal.aborted) aborted()
        })
        const next = (await this.capture(
          { includeElements: input.includeElements === true },
          { ...caller, signal: controller.signal },
        )) as Record<string, unknown>
        return {
          ...next,
          actionReceipt: receipt,
          message: __t(
            'electron.ui.desktopControl',
            '动作已发送，以下是操作后画面。请检查结果后再继续。',
          ),
        }
      } catch (error) {
        await windowsDesktop.release()
        this.heldInputs = false
        if (controller.signal.aborted && this.state.phase !== 'paused')
          this.pause('桌面执行已中断，请检查当前界面后继续')
        if (dispatched || (error as { dispatched?: boolean })?.dispatched === true) {
          this.pause('动作已发送，结果尚未确认，请核验后继续')
          throw new Error(
            `DESKTOP_RESULT_UNCERTAIN: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if (
          (error as { dispatched?: boolean })?.dispatched === false &&
          error instanceof Error &&
          error.message.startsWith('DESKTOP_FOCUS_CHANGED:')
        )
          throw new Error('DESKTOP_OBSERVATION_STALE: 前台窗口已变化，请重新观察或激活目标窗口')
        throw error
      } finally {
        caller.signal?.removeEventListener('abort', cancel)
        this.active = undefined
        if (this.state.phase === 'running') this.state = { ...this.state, phase: 'idle' }
        this.publish()
      }
    })
  }

  mutate<T>(caller: DesktopCaller, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.serial(caller, async () => {
      await windowsDesktop.start()
      this.assertAvailable(caller.signal)
      if (!windowsDesktop.monitor)
        throw new Error('DESKTOP_INPUT_MONITOR_UNAVAILABLE: 用户接管监听不可用')
      await this.waitUntilIdle(caller)
      const controller = new AbortController()
      this.active = controller
      const cancel = () => controller.abort(caller.signal?.reason)
      caller.signal?.addEventListener('abort', cancel, { once: true })
      if (caller.signal?.aborted) cancel()
      this.observations.clear()
      this.state = {
        ...this.state,
        phase: 'running',
        agentId: caller.agentId,
        taskId: caller.taskId,
        threadId: caller.threadId,
      }
      this.publish()
      try {
        controller.signal.throwIfAborted()
        return await action(controller.signal)
      } catch (error) {
        if (controller.signal.aborted && this.state.phase !== 'paused')
          this.pause('桌面执行已中断，请检查当前界面后继续')
        throw error
      } finally {
        caller.signal?.removeEventListener('abort', cancel)
        this.active = undefined
        if (this.state.phase === 'running') this.state = { ...this.state, phase: 'idle' }
        this.publish()
      }
    })
  }

  async stop(): Promise<void> {
    this.pause('桌面客户端正在退出')
    this.shortcutCapture?.cleanup()
    this.shortcutCapture = undefined
    globalShortcut.unregister(this.boundShortcut)
    this.boundShortcut = ''
    windowsDesktop.off('activity', this.onActivity)
    windowsDesktop.off('unavailable', this.onUnavailable)
    powerMonitor.removeListener('lock-screen', this.onSuspend)
    powerMonitor.removeListener('suspend', this.onSuspend)
    powerMonitor.removeListener('unlock-screen', this.onResume)
    powerMonitor.removeListener('resume', this.onResume)
    await windowsDesktop.stop()
    this.initialized = false
  }

  private waitUntilIdle(caller: DesktopCaller): Promise<void> {
    return waitForDesktopIdle(
      () => Date.now() - windowsDesktop.lastActivityAt,
      () => {
        this.assertAvailable(caller.signal)
        if (!windowsDesktop.monitor)
          throw new Error('DESKTOP_INPUT_MONITOR_UNAVAILABLE: 用户接管监听不可用')
      },
      caller.signal,
    )
  }

  private readonly onActivity = () => {
    this.observations.clear()
    if (this.active || this.heldInputs || this.state.phase === 'running')
      this.pause('你已接管电脑，桌面任务已暂停')
    else this.state.epoch++
  }
  private readonly onUnavailable = (reason: string) => {
    logger.warn(
      'DesktopControl',
      __t('electron.logs.desktopControl', 'Windows 桌面组件已断开：{0}', [reason]),
    )
    this.pause('桌面组件已断开，请检查后继续')
    this.state = { ...this.state, phase: 'unavailable', reason: '桌面组件已断开，请检查后继续' }
    this.publish()
  }
  private readonly onSuspend = () => {
    this.suspended = true
    this.pause('电脑已锁定或休眠')
  }
  private readonly onResume = () => {
    this.suspended = false
    this.publish()
  }
  private file(): string {
    return path.join(app.getPath('userData'), 'desktop-control.json')
  }
  private registerShortcut(shortcut: string): void {
    if (shortcut === this.boundShortcut && globalShortcut.isRegistered(shortcut)) return
    if (!globalShortcut.register(shortcut, () => this.pause('已停止桌面操作')))
      throw new Error('停止快捷键已被占用，请更换绑定')
    if (this.boundShortcut) globalShortcut.unregister(this.boundShortcut)
    this.boundShortcut = shortcut
  }
  private publish(): void {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send('desktop-control:changed', this.snapshot())
  }
}

export const desktopControl = new DesktopControl()
