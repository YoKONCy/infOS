/**
 * @file 环境事件的采样与接线。
 *
 * - 每 5 秒采样一次，只记两个布尔值：是否空闲（系统无输入时长）、前台是否有别的程序全屏；
 *   不记录窗口名称、画面或用户输入；
 * - 任务完成由界面转告（界面从后端的任务推送得知），后端在附带给她时再核对任务归属；
 * - 事件只在用户下次说话时由界面取走、随消息发给后端；这里没有任何主动触发模型的路径；
 * - 总开关关闭、桌面操作关闭、锁屏或休眠时不采样，恢复后重新起算。
 *
 * @platform ELECTRON
 * @see environmentEvents.ts 信箱
 */

import { app, ipcMain, powerMonitor, screen, type WebContents } from 'electron'
import type { DesktopEnvironmentEvent } from '@infos/shared'
import { windowsDesktop } from '../windowsDesktop'
import { desktopControl } from '../desktopControl'
import { onDesktopObservationStop } from '../desktopObservationLifecycle'
import { homeSettings } from './homeSettings'
import { EnvironmentEvents } from './environmentEvents'
import { perceptionControl } from './perceptionState'
import { wakePerception } from './perceptionSampling'

const SAMPLE_INTERVAL_MS = 5000
/** 窗口与屏幕边界的容差（物理像素）；普通最大化窗口会超出屏幕约 8 像素，不算全屏。 */
const FULLSCREEN_TOLERANCE = 2

export const environmentEvents = new EnvironmentEvents(() => homeSettings.section('environment'))

let locked = false
let running = false
let epoch = 0
let timer: ReturnType<typeof setInterval> | undefined

function observing(): boolean {
  return (
    !locked && perceptionControl.state().collecting && homeSettings.section('environment').enabled && desktopControl.configuration().enabled
  )
}

/** 观察中断：丢弃基线，并让正在进行的采样作废。 */
export function interruptEnvironment(): void {
  epoch++
  environmentEvents.resetBaseline()
}

async function fullscreenActive(): Promise<boolean> {
  const active = await windowsDesktop.active()
  // 桌面本身（explorer 的桌面窗口）铺满屏幕，不算全屏；infOS 自己的窗口也不算。
  if (!active || active.pid === process.pid || /^explorer$/i.test(active.processName)) return false
  return screen.getAllDisplays().some((display) => {
    const bounds = screen.dipToScreenRect(null, display.bounds)
    return (
      Math.abs(active.bounds.x - bounds.x) <= FULLSCREEN_TOLERANCE &&
      Math.abs(active.bounds.y - bounds.y) <= FULLSCREEN_TOLERANCE &&
      Math.abs(active.bounds.width - bounds.width) <= FULLSCREEN_TOLERANCE &&
      Math.abs(active.bounds.height - bounds.height) <= FULLSCREEN_TOLERANCE
    )
  })
}

async function sample(): Promise<void> {
  if (!observing()) {
    interruptEnvironment()
    return
  }
  if (running) return
  running = true
  const generation = epoch
  try {
    const settings = homeSettings.section('environment')
    if (settings.idle)
      environmentEvents.changed(
        'idle',
        powerMonitor.getSystemIdleTime() >= settings.idleMinutes * 60,
      )
    if (settings.fullscreen && process.platform === 'win32') {
      const fullscreen = await fullscreenActive()
      if (observing() && generation === epoch) environmentEvents.changed('fullscreen', fullscreen)
    }
  } catch {
    /* 观察暂时不可用时不猜测状态，下次采样再试。 */
  } finally {
    running = false
  }
}

let initialized = false
/** 启动采样（幂等）。总开关关闭时采样会立即返回，不启动桌面组件。 */
export function initializeEnvironmentEvents(): void {
  if (initialized) return
  initialized = true
  homeSettings.onChange(() => environmentEvents.applySettings())
  // 桌面暂停、断线、锁屏、退出：重新起算，不把中断本身当成变化。
  onDesktopObservationStop(() => interruptEnvironment())
  const pause = (value: boolean) => () => {
    locked = value
    interruptEnvironment()
  }
  powerMonitor.on('lock-screen', pause(true))
  powerMonitor.on('unlock-screen', pause(false))
  powerMonitor.on('suspend', pause(true))
  powerMonitor.on('resume', pause(false))
  timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS)
  timer.unref?.()
  app.once('before-quit', () => {
    clearInterval(timer)
    environmentEvents.clear()
  })
}

const AGENT_ID = /^[\w:.-]{1,200}$/

/** 界面在用户发消息前取走；总开关关闭时返回空。 */
export function takeEnvironmentEvents(agentId: unknown): DesktopEnvironmentEvent[] {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return []
  return environmentEvents.take(agentId)
}

/** 界面转告：infOS 启动的后台任务完成。 */
export function recordEnvironmentTask(input: unknown): void {
  if (!input || typeof input !== 'object') return
  const { agentId, taskId } = input as Record<string, unknown>
  if (typeof agentId === 'string' && typeof taskId === 'string') {
    environmentEvents.taskCompleted(agentId, taskId)
    wakePerception('task-completed')
  }
}

export function registerEnvironmentIpc(assertTrusted: (sender: WebContents) => void): void {
  initializeEnvironmentEvents()
  ipcMain.handle('desktop-home:environment-take', (event, agentId: unknown) => {
    assertTrusted(event.sender)
    return takeEnvironmentEvents(agentId)
  })
  ipcMain.handle('desktop-home:environment-task', (event, input: unknown) => {
    assertTrusted(event.sender)
    recordEnvironmentTask(input)
  })
}
