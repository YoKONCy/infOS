import { t as __t } from '../utils/i18n'
import { app, BrowserWindow, globalShortcut, powerMonitor } from 'electron'
import path from 'node:path'
import type { DesktopControlSettings, DesktopControlState } from '@infos/shared'
import { windowsDesktop } from './windowsDesktop'
import { waitForDesktopIdle } from './desktopIdle'
import {
  captureObservation,
  displayGeometry,
  type Observation,
  type ObserveHost,
} from './desktopObserve'
import {
  confirmAfterApproval,
  currentWindow,
  mouseArguments,
  sameWindow,
  settleAndRecapture,
} from './desktopActionFollowUp'
import { logger } from '../utils/logger'
import { settingsSigner, type SettingsSigner } from './settingsSigner'
import { DesktopControlSettingsFile } from './desktopControlSettings'
import { desktopVisionSettings } from './desktopVisionSettings'
import { stopDesktopObservations } from './desktopObservationLifecycle'
import { perceptionControl } from './home/perceptionState'
import { watchShortcutCapture } from './desktopShortcutCapture'
import { askDesktopGuard, beginDispatch } from './desktopControlGuard'
import type { DesktopActionGuard } from './desktopControlGuard'
export type { DesktopActionGuard, DesktopGuardOutcome } from './desktopControlGuard'

export interface DesktopCaller {
  agentId?: string
  threadId?: string
  taskId?: string
  /** 家的声明与授权所用的任务 ID（普通回合为 pairId）。 */
  homeTaskId?: string
  /** 会话执行模式（后端附带，模型参数不能覆盖）；manual 时每个动作都要用户点一次。 */
  executionMode?: string
  signal?: AbortSignal
}
/** 桌面控制只串行化具体动作，模型思考期间不占用系统输入。 */
export class DesktopControl {
  private readonly settingsFile: DesktopControlSettingsFile
  constructor(signer: SettingsSigner = settingsSigner) {
    this.settingsFile = new DesktopControlSettingsFile(signer, () => this.file())
  }
  private file(): string {
    return path.join(app.getPath('userData'), 'desktop-control.json')
  }
  private settings: DesktopControlSettings = { enabled: false, stopShortcut: 'Control+Alt+Escape' }
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
  private guard?: DesktopActionGuard
  /** 当前暂停只针对输入（只读观察照常）。 */
  private inputOnlyPause = false

  /** 接入阶段 2 护栏。 */
  setGuard(guard: DesktopActionGuard | undefined): void {
    this.guard = guard
  }

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    this.reloadSettings()
    try {
      this.registerShortcut(this.settings.stopShortcut)
    } catch {
      this.state = { ...this.state, phase: 'paused', reason: '停止快捷键已被占用，请在设置中更换' }
    }
    windowsDesktop.on('activity', this.onActivity)
    windowsDesktop.on('unavailable', this.onUnavailable)
    windowsDesktop.on('preparing', this.onPreparing)
    powerMonitor.on('lock-screen', this.onSuspend)
    powerMonitor.on('suspend', this.onSuspend)
    powerMonitor.on('unlock-screen', this.onResume)
    powerMonitor.on('resume', this.onResume)
  }

  snapshot(): DesktopControlState {
    const preparing = windowsDesktop.preparing ? { preparing: true } : {}
    return {
      ...this.state,
      stopShortcut: this.settings.stopShortcut,
      enabled: this.settings.enabled,
      ...preparing,
    }
  }
  configuration(): DesktopControlSettings {
    this.refreshSettings()
    return { ...this.settings }
  }

  disconnect(): void {
    stopDesktopObservations('设备连接已断开，请重新连接后继续')
    // 断线属于完全停止：已有的「只暂停输入」也升级，观察不能再自行开始。
    this.inputOnlyPause = false
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
      const cleanup = watchShortcutCapture(owner, () => this.setShortcutCapturing(owner, false))
      this.shortcutCapture = { owner, cleanup }
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
    this.refreshSettings()
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
    this.settingsFile.write(next)
    this.settings = next
    perceptionControl.setReason('desktop-disabled', !next.enabled)
    if (!next.enabled) this.pause('桌面操作已关闭')
    this.publish()
    return this.configuration()
  }

  /**
   * 完全停止：停止快捷键、总开关关闭、锁屏休眠、断线、组件断开、退出、用户点「停止」。
   * 输入与只读观察（盯窗口、耳朵、陪看）一起停，需要用户手动继续。
   */
  pause(reason = '桌面操作已暂停'): DesktopControlState {
    stopDesktopObservations(reason)
    this.inputOnlyPause = false
    return this.halt(reason)
  }

  /**
   * 只暂停输入：用户接管、执行中断、结果不确定。作废可操作观察、松开按键，
   * 但只读观察照常进行（例如陪看时碰一下鼠标不会断掉）。已经完全停止时保持完全停止。
   */
  pauseInput(reason: string): DesktopControlState {
    // 已经完全停止或组件已断开时保持原状：不能把「完全停止 / 不可用」降级成「只暂停输入」。
    if (this.state.phase === 'unavailable') return this.snapshot()
    if (this.state.phase === 'idle' || this.state.phase === 'running') this.inputOnlyPause = true
    return this.halt(reason)
  }

  private halt(reason: string): DesktopControlState {
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
    this.inputOnlyPause = false
    this.observations.clear()
    this.publish()
    return this.snapshot()
  }

  private owner(caller: DesktopCaller): string {
    return `${caller.agentId ?? 'system'}:${caller.taskId ?? caller.threadId ?? 'desktop'}`
  }
  /** act 要求控制权未变且可操作；view 仅校验归属、期限和显示器布局。 */
  private reference(id: unknown, caller: DesktopCaller, purpose: 'act' | 'view' = 'act') {
    const observation = this.observations.get(String(id ?? ''))
    // 整屏观察、切换前台失败、目标权限更高等“只供查看”的观察，按原因给出稳定错误码。
    if (purpose === 'act' && observation?.blocked && observation.owner === this.owner(caller))
      throw new Error(observation.blocked)
    if (
      !observation ||
      observation.owner !== this.owner(caller) ||
      (purpose === 'act' && (observation.epoch !== this.state.epoch || !observation.actionable)) ||
      Date.now() - observation.createdAt > desktopVisionSettings.get().observationTtlSec * 1000 ||
      observation.geometry !== displayGeometry()
    )
      throw new Error('DESKTOP_OBSERVATION_STALE: 请先观察桌面，再引用本次 observationId 操作')
    return observation
  }
  /** 持续只读观察也复用完整的桌面能力门控；purpose 为 observe 时只暂停输入不影响观察。 */
  assertAvailable(signal?: AbortSignal, purpose: 'act' | 'observe' = 'act'): void {
    this.refreshSettings()
    if (perceptionControl.state().settings.hardStopped) throw new Error(__t('errors.electron', 'PERCEPTION_STOPPED: 感知已全部停止，请在界面点击恢复'))
    if (signal?.aborted) throw new Error('DESKTOP_CANCELLED: 桌面操作已取消')
    if (!this.settings.enabled) throw new Error('DESKTOP_DISABLED: 桌面操作未开启')
    if (this.shortcutCapture) throw new Error('DESKTOP_WAITING: 正在录入停止快捷键')
    if (this.suspended) throw new Error('DESKTOP_WAITING: 电脑已锁定或休眠，请唤醒后继续')
    if (
      this.state.phase === 'unavailable' ||
      (this.state.phase === 'paused' && (purpose === 'act' || !this.inputOnlyPause))
    )
      throw new Error(`DESKTOP_WAITING: ${this.state.reason ?? '请在主应用中继续桌面操作'}`)
    if (process.platform !== 'win32')
      throw new Error('DESKTOP_PLATFORM_UNSUPPORTED: 受控桌面操作目前支持 Windows')
  }

  private serial<T>(caller: DesktopCaller, action: () => Promise<T>, readOnly = false): Promise<T> {
    const epoch = this.state.epoch
    const pending = this.queue.then(async () => {
      this.assertAvailable(caller.signal, readOnly ? 'observe' : 'act')
      // 只读观察不依赖排队前的画面，控制权变化后照常截取当前画面。
      if (!readOnly && epoch !== this.state.epoch)
        throw new Error('DESKTOP_OBSERVATION_STALE: 用户操作后需要重新观察')
      return action()
    })
    this.queue = pending.catch(() => {})
    return pending
  }

  observe(input: Record<string, unknown>, caller: DesktopCaller): Promise<unknown> {
    return this.serial(caller, () => captureObservation(this.observeHost, input, caller), true)
  }

  /** 观察模块（desktopObserve.ts）需要的能力。 */
  private readonly observeHost: ObserveHost = {
    epoch: () => this.state.epoch,
    geometry: () => displayGeometry(),
    owner: (caller) => this.owner(caller),
    reference: (id, caller, purpose) => this.reference(id, caller, purpose),
    register: (observation) => {
      this.observations.set(observation.id, observation)
      while (this.observations.size > 16)
        this.observations.delete(this.observations.keys().next().value!)
    },
    waitUntilIdle: (caller) => this.waitUntilIdle(caller),
  }

  execute(
    operation: 'mouse' | 'keyboard' | 'element' | 'wait',
    input: Record<string, unknown>,
    caller: DesktopCaller,
  ): Promise<unknown> {
    return this.serial(caller, async () => {
      const observation = this.reference(input.observationId, caller)
      const current = await currentWindow(observation)
      if (!sameWindow(current, observation.window))
        throw new Error('DESKTOP_OBSERVATION_STALE: 目标窗口已变化，请重新观察')
      const approval = await askDesktopGuard(
        this.guard,
        caller,
        operation,
        input,
        observation,
        current,
      )
      if (!windowsDesktop.monitor)
        throw new Error('DESKTOP_INPUT_MONITOR_UNAVAILABLE: 用户接管监听不可用')
      await this.waitUntilIdle(caller)
      if (
        operation === 'element' &&
        !observation.elements.some((element) => element.id === input.elementId)
      )
        throw new Error('DESKTOP_ELEMENT_STALE: 控件不属于本次观察，请重新观察')
      this.assertAvailable(caller.signal)
      // 刚弹过审批框：用户点按钮会让 epoch 变化，改为核对窗口与画面，没变就直接执行。
      if (approval?.prompted) await confirmAfterApproval(observation, caller.signal)
      else if (observation.epoch !== this.state.epoch)
        throw new Error('DESKTOP_OBSERVATION_STALE: 用户操作后需要重新观察')
      await beginDispatch(approval, () => this.assertAvailable(caller.signal))
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
        if (operation === 'mouse') Object.assign(args, await mouseArguments(observation, input))
        if (input.action === 'key_down' || input.action === 'mouse_down') {
          this.heldInputs = true
          clearTimeout(this.holdExpiry)
          this.holdExpiry = setTimeout(() => {
            this.heldInputs = false
          }, 2100)
        }
        const receipt = await windowsDesktop.request(operation, args, controller.signal)
        dispatched = operation !== 'wait'
        void approval?.complete?.('success')
        // 动作已发出：之后只是读画面，用户动鼠标只让画面标注为可能变化，不再当作接管。
        this.active = undefined
        if (this.state.phase === 'running') this.state = { ...this.state, phase: 'idle' }
        const { next, settle } = await settleAndRecapture(
          this.observeHost,
          observation,
          input,
          caller,
        )
        return {
          ...next,
          actionReceipt: receipt,
          settle,
          message: __t(
            'electron.ui.desktopControl',
            '动作已发送，以下是操作后画面。请检查结果后再继续。',
          ),
        }
      } catch (error) {
        if (!dispatched) void approval?.complete?.('failed', String(error).slice(0, 200))
        await windowsDesktop.release()
        this.heldInputs = false
        if (controller.signal.aborted && this.state.phase === 'running')
          this.pauseInput('桌面执行已中断，请检查当前界面后继续')
        if (dispatched || (error as { dispatched?: boolean })?.dispatched === true) {
          this.pauseInput('动作已发送，结果尚未确认，请核验后继续')
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
        if (controller.signal.aborted && this.state.phase === 'running')
          this.pauseInput('桌面执行已中断，请检查当前界面后继续')
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
    windowsDesktop.off('preparing', this.onPreparing)
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
    // 空闲时用户操作只让依赖旧画面的注入操作失效（epoch 变化），已有观察仍可用于局部放大等只读观察。
    if (this.active || this.heldInputs || this.state.phase === 'running')
      this.pauseInput('你已接管电脑，桌面任务已暂停')
    else this.state.epoch++
  }
  private readonly onUnavailable = (reason: string) => {
    perceptionControl.setReason('desktop-unavailable', true)
    logger.warn(
      'DesktopControl',
      __t('electron.logs.desktopControl', 'Windows 桌面组件已断开：{0}', [reason]),
    )
    this.pause('桌面组件已断开，请检查后继续')
    this.state = { ...this.state, phase: 'unavailable', reason: '桌面组件已断开，请检查后继续' }
    this.publish()
  }
  /** 首次编译桥接 C# 时通知界面显示「正在准备桌面组件」。 */
  private readonly onPreparing = () => this.publish()
  private readonly onSuspend = () => {
    this.suspended = true
    this.pause('电脑已锁定或休眠')
  }
  private readonly onResume = () => {
    this.suspended = false
    this.publish()
  }
  private refreshSettings(): void {
    if (this.settingsFile.changed()) this.reloadSettings()
  }
  private reloadSettings(): void {
    const wasEnabled = this.settings.enabled
    this.settings = this.settingsFile.load(this.settings)
    if (wasEnabled && !this.settings.enabled) this.pause('桌面操作已关闭')
  }
  private registerShortcut(shortcut: string): void {
    if (shortcut === this.boundShortcut && globalShortcut.isRegistered(shortcut)) return
    if (!globalShortcut.register(shortcut, () => {
      try { perceptionControl.action({ type: 'stop-all' }) }
      finally { this.pause('已停止桌面操作') }
    }))
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
