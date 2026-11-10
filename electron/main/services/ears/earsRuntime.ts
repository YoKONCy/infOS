/**
 * @file 耳朵的实际接线：Electron 的 utilityProcess、录音窗口、net.fetch 下载、infOS 自己出声的判断。
 *
 * @platform ELECTRON
 * @see earsService.ts
 */

import { t as __t } from '../../utils/i18n'
import path from 'node:path'
import { app, net, utilityProcess, webContents } from 'electron'
import { desktopControl } from '../desktopControl'
import { homeSettings } from '../home/homeSettings'
import { EarsCapture } from './earsCapture'
import { EarsCaptureSelect } from './earsCaptureSelect'
import { ensureLoopbackHelper, loopbackSupport, ProcessLoopbackCapture } from './earsLoopback'
import { EarsModel } from './earsModel'
import { EarsService, type WorkerLike } from './earsService'
import type { EarsWorkerEvent, EarsWorkerRequest } from './earsWorker'
import type { PerceptionWindow } from '../home/perceptionCoordinator'
import { perceptionControl } from '../home/perceptionState'
import { sensitiveWindow } from '../home/perceptionFilter'

let recordingTarget: PerceptionWindow | undefined
/** 换录音目标；返回现在能不能按这个目标录。不支持时不录，绝不悄悄退回整机。 */
export function setPerceptionAudioTarget(target?: PerceptionWindow): boolean {
  const state = perceptionControl.state()
  if (target && (!support.supported || earsCapture.coolingDown || !homeSettings.section('ears').enabled || sensitiveWindow(target, state.settings))) target = undefined
  if (recordingTarget?.processGeneration === target?.processGeneration && recordingTarget?.windowId === target?.windowId) return !!target
  earsService.stopAll(); earsService.transcript.clear()
  recordingTarget = target
  earsCapture.setTarget(target ? new ProcessLoopbackCapture({
    helper: () => ensureLoopbackHelper(path.join(app.getPath('userData'), 'desktop-bridge')),
    excludePid: target.pid, includeTarget: true,
  }) : undefined)
  return !!target
}

const systemCapture = new EarsCapture()
const support = loopbackSupport()

/** 录音方式：默认按进程排除 infOS 自己的声音，不支持或失败时退回整机录音 + 整段丢弃。 */
export const earsCapture = new EarsCaptureSelect({
  system: systemCapture,
  process: support.supported
    ? new ProcessLoopbackCapture({
        helper: () => ensureLoopbackHelper(path.join(app.getPath('userData'), 'desktop-bridge')),
        excludePid: process.pid,
      })
    : undefined,
  unsupported: support.supported ? undefined : support.reason,
  preferred: () => homeSettings.section('ears').selfExclusion,
  onChange: () => earsService.emit('status'),
})

export const earsModel = new EarsModel(
  homeSettings,
  () => app.getPath('userData'),
  (url, init) => net.fetch(url, init),
  () => earsService.emit('status'),
)

function createWorker(): WorkerLike {
  const child = utilityProcess.fork(path.join(__dirname, 'earsWorker.js'), [], {
    serviceName: 'infOS ears',
    stdio: 'ignore',
  })
  return {
    postMessage: (message: EarsWorkerRequest) => child.postMessage(message),
    on: ((event: 'message' | 'exit', listener: (value: never) => void) => {
      if (event === 'message')
        child.on('message', (message: EarsWorkerEvent) => listener(message as never))
      else child.on('exit', (code: number) => listener(code as never))
    }) as WorkerLike['on'],
    kill: () => {
      child.kill()
    },
  }
}

/** infOS 自己的窗口（不含录音页）此刻是否在出声。已按进程排除时不需要丢弃，直接返回 false。 */
function selfAudible(): boolean {
  if (earsCapture.selfExcluded) return false
  const own = systemCapture.contents
  return webContents
    .getAllWebContents()
    .some(
      (contents) => contents !== own && !contents.isDestroyed() && contents.isCurrentlyAudible(),
    )
}

export const earsService = new EarsService({
  // 「允许她听」是总闸；「平时也听」只决定后台要不要主动录，由感知协调器处理。
  settings: () => homeSettings.section('ears'),
  model: earsModel,
  capture: earsCapture,
  createWorker,
  selfAudible,
  target: () => recordingTarget ? { windowId: recordingTarget.windowId, processGeneration: recordingTarget.processGeneration } : undefined,
  // 与盯窗口同一道门：总开关关闭、完全停止、锁屏或断线时不继续录音；只暂停输入时照常听。
  allowed: () => {
    try {
      desktopControl.assertAvailable(undefined, 'observe')
      return true
    } catch {
      return false
    }
  },
})

// 设置里关掉耳朵立刻停；改了静音阈值即时生效。
homeSettings.onChange((settings) => {
  if (!settings.ears.enabled && earsService.listening)
    earsService.stopAll(
      `EARS_DISABLED: ${__t('electron.ui.desktopControl', '用户在设置里关掉了耳朵')}`,
    )
  earsService.setThreshold(settings.ears.silenceThreshold)
})
