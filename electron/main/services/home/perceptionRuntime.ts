import { app, BrowserWindow, ipcMain, powerMonitor, screen, type WebContents } from 'electron'
import type { PerceptionAction } from '@infos/shared'
import { perceptionControl } from './perceptionState'
import { homeSettings } from './homeSettings'
import { desktopControl } from '../desktopControl'
import { stopDesktopObservations } from '../desktopObservationLifecycle'
import { earsService, setPerceptionAudioTarget } from '../ears/earsRuntime'
import { companionService } from '../companion/companionRuntime'
import { environmentEvents, interruptEnvironment } from './environmentRuntime'
import { getBackendOrigin } from '../clientConnection'
import { getClientCredential } from '../../utils/clientCredential'
import { deliverPerceptionImages, invalidatePerceptionSamples, onPerceptionSample, perceptionCoordinator, perceptionRequest, samplePerception } from './perceptionSampling'
import { cleanupPerceptionMedia } from './perceptionCleanup'
import { configurePerceptionTray, refreshPerceptionTray } from '../tray'
import type { PerceptionSample, PerceptionWindow } from './perceptionCoordinator'

let sequence = Date.now() * 1000
const processGeneration = sequence
let initialized = false
let heartbeat: ReturnType<typeof setInterval> | undefined
let previousSettings = ''

/** 不依赖界面在线；网络失败时服务端许可自行过期。本地撤销立即完成。 */
async function sendPermit(): Promise<void> {
  const state = perceptionControl.state()
  const hardStopped = state.settings.hardStopped
  const companionAllowed = !state.disabledReasons.some((reason) => ['hard-stopped', 'paused', 'locked', 'suspended'].includes(reason))
  try {
    const response = await fetch(`${getBackendOrigin()}/api/scheduler/proactive/watch-along/permit`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getClientCredential()}` },
      body: JSON.stringify({ sequence: ++sequence, generation: processGeneration + state.generation, expiresAt: Date.now() + 15_000, hardStopped, companionAllowed }),
    })
    await response.body?.cancel()
  } catch { /* 失联时不续期，后端按期限停止。 */ }
}

function publish(): void {
  refreshPerceptionTray()
  const state = perceptionControl.state()
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed()) window.webContents.send('desktop-home:perception-state', state)
}

/** 录音目标只在这里决定：常驻开着才按前台程序录。 */
function applyPerceptionAudio(sample: PerceptionSample): void {
  // 手动陪看时耳朵归它：换目标会把它的录音一起停掉。
  if (companionService.summary()) return
  const state = perceptionControl.state()
  const target = state.collecting ? perceptionCoordinator.recordingTarget(sample, state.settings) : null
  const recording = setPerceptionAudioTarget(target ?? undefined)
  if (recording) earsService.acquire('perception')
  else earsService.release('perception')
}
/** 聊天窗看不到：最小化了，或别的程序全屏盖住了屏幕。这时她说的话要另外弹出来。 */
function chatHidden(active: PerceptionWindow | null): boolean {
  const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed())
  if (windows.length && windows.every(window => window.isMinimized() || !window.isVisible())) return true
  if (!active || windows.some(window => window.getNativeWindowHandle().readBigInt64LE().toString() === active.windowId)) return false
  const box = active.bounds
  return screen.getAllDisplays().some(display => {
    const area = screen.dipToScreenRect(null, display.bounds)
    return box.x <= area.x + 8 && box.y <= area.y + 8 && box.x + box.width >= area.x + area.width - 8 && box.y + box.height >= area.y + area.height - 8
  })
}

export function registerPerceptionIpc(assertTrusted: (sender: WebContents) => void): void {
  if (initialized) return
  initialized = true
  configurePerceptionTray({stop:()=>{perceptionControl.action({type:'stop-all'})}})
  cleanupPerceptionMedia()
  const cleanup = setInterval(cleanupPerceptionMedia, 30 * 60_000)
  cleanup.unref?.()
  previousSettings = JSON.stringify(homeSettings.section('perception'))
  onPerceptionSample(sample => {
    applyPerceptionAudio(sample)
    perceptionControl.updateDetails({chatHidden: chatHidden(sample.active)})
  })
  earsService.on('line', line => {
    if (line.target) perceptionCoordinator.heard(line.text, line.target, perceptionControl.state().generation)
  })
  perceptionControl.onInvalidate(() => {
    invalidatePerceptionSamples()
    setPerceptionAudioTarget(undefined)
    // 代次变化只丢弃待交付内容；实际停止按限制原因区分，不打断手动陪看。
    interruptEnvironment()
    environmentEvents.clear()
    const state = perceptionControl.state()
    if (state.settings.hardStopped) {
      desktopControl.pause('已停止桌面操作')
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send('pet-controls:action', { action: 'stop-speech' })
    }
    if (state.disabledReasons.some(reason => ['hard-stopped', 'locked', 'suspended', 'desktop-disabled', 'desktop-unavailable'].includes(reason))) {
      stopDesktopObservations('已停止桌面操作')
      companionService.stopAll()
      earsService.stopAll()
    }
    earsService.transcript.clear()
    publish()
    void sendPermit()
  })
  const refresh = () => {
    const desktop = desktopControl.snapshot()
    perceptionControl.setReason('desktop-disabled', !desktopControl.configuration().enabled)
    perceptionControl.setReason('desktop-unavailable', desktop.phase === 'unavailable')
    publish()
    void sendPermit()
    void perceptionRequest(`/counts?level=${perceptionControl.state().settings.proactiveLevel}`).then(value => {
      perceptionControl.updateDetails({counts: (value as {data: import('@infos/shared').PerceptionState['counts']}).data})
      publish()
    }).catch(() => {})
  }
  for (const [event, reason, active] of [
    ['lock-screen', 'locked', true], ['unlock-screen', 'locked', false],
    ['suspend', 'suspended', true], ['resume', 'suspended', false],
  ] as const) (powerMonitor as unknown as NodeJS.EventEmitter).on(event, () => {
    if (active) perceptionCoordinator.markAbsent()
    perceptionControl.setReason(reason, active)
  })
  homeSettings.onChange((settings) => {
    const next = JSON.stringify(settings.perception)
    if (next !== previousSettings) {
      const previous = JSON.parse(previousSettings)
      previousSettings = next
      if (previous.sound && !settings.perception.sound) earsService.release('perception')
      if (previous.watchAlong && !settings.perception.watchAlong) companionService.stopAll()
      perceptionControl.invalidate()
    }
  })
  ipcMain.handle('desktop-home:perception-get', (event) => {
    assertTrusted(event.sender)
    return perceptionControl.state()
  })
  ipcMain.handle('desktop-home:perception-action', async (event, action: PerceptionAction) => {
    assertTrusted(event.sender)
    if(!action||typeof action!=='object')throw new Error('PERCEPTION_ACTION_INVALID')
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('PERCEPTION_FORBIDDEN')
    const result = perceptionControl.action(action)
    if (action.type === 'resume' && !result.disabledReasons.some((reason) => reason !== 'disabled'))
      desktopControl.resume()
    return result
  })
  ipcMain.handle('desktop-home:perception-snapshot', async (event) => {
    assertTrusted(event.sender)
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('PERCEPTION_FORBIDDEN')
    await samplePerception(true)
    return perceptionCoordinator.snapshot()
  })
  perceptionControl.setReason('locked', powerMonitor.getSystemIdleState(1) === 'locked')
  refresh()
  heartbeat = setInterval(refresh, 5000)
  heartbeat.unref?.()
  const sampling = setInterval(() => void samplePerception(), 4000)
  const images = setInterval(() => void deliverPerceptionImages(), 1000)
  images.unref?.()
  sampling.unref?.()
  app.once('before-quit', () => {
    clearInterval(heartbeat)
    clearInterval(sampling)
    clearInterval(images)
    clearInterval(cleanup)
    perceptionControl.setReason('desktop-unavailable', true)
  })
}
