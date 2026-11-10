import { powerMonitor } from 'electron'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { windowsDesktop } from '../windowsDesktop'
import { getBackendOrigin } from '../clientConnection'
import { getClientCredential } from '../../utils/clientCredential'
import { PerceptionCoordinator, type PerceptionSample, type WakeKind } from './perceptionCoordinator'
import { perceptionControl } from './perceptionState'
import { capturePerceptionImage } from './perceptionImage'
import {mediaFrom,sensitiveWindow} from './perceptionFilter'
import {ensureVisionHelper} from '../windowsVisionHelper'
import {visionCacheDir} from '../desktopOcr'

let serial = Date.now() * 1000
let busy = false
let controller = new AbortController()
let failures = 0
let nextAttempt = 0
let nextWindows = 0
let lastWindow = ''
let imageBusy = false
export async function deliverPerceptionImages(): Promise<void> {
  if (imageBusy || !perceptionCoordinator.canSample()) return
  imageBusy = true
  try {
    const response = await perceptionRequest('/image') as {data: Array<{id: string; generation: number}>}
    for (const item of response.data.slice(0, 4)) {
      const windowId = perceptionCoordinator.target()?.windowId ?? ''
      const frame = windowId && item.generation === perceptionControl.state().generation ? await capturePerceptionImage(windowId, controller.signal) : undefined
      const image = frame?.image.resize({width: Math.min(1280, frame.image.getSize().width), quality: 'good'})
      await perceptionRequest('/image', {id: item.id, generation: item.generation, ...(image && item.generation === perceptionControl.state().generation ? { image: {mimeType: 'image/jpeg', data: image.toJPEG(75).toString('base64')} } : {})})
    }
  } catch { /* 图片请求独立失败，不阻塞文字聊天。 */ }
  finally { imageBusy = false }
}
const wakeListeners = new Set<(kind: WakeKind) => void>()
const sampleListeners = new Set<(sample: PerceptionSample, generation: number) => void>()
export const perceptionCoordinator = new PerceptionCoordinator(() => perceptionControl.state(), kind => { for (const fn of wakeListeners) fn(kind) })
export function onPerceptionWake(fn: (kind: WakeKind) => void): void { wakeListeners.add(fn) }
export function wakePerception(kind: WakeKind): void {
  const state = perceptionControl.state()
  if (!state.collecting || !state.settings.proactive) return
  void (async () => {
    await samplePerception(true)
    if (state.generation !== perceptionControl.state().generation) return
    await publishSnapshot()
    await perceptionRequest('/wake', {id: randomUUID(), kind, expiresAt: Date.now() + 45_000, level: state.settings.proactiveLevel}, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]))
  })().catch(() => {})
}
onPerceptionWake(wakePerception)
export function onPerceptionSample(fn: (sample: PerceptionSample, generation: number) => void): void { sampleListeners.add(fn) }

export async function perceptionRequest(route: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${getBackendOrigin()}/api/scheduler/proactive/watch-along${route}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: signal ?? AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getClientCredential()}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error('PERCEPTION_REQUEST_FAILED') }
  return response.json()
}
async function publishSnapshot(): Promise<void> {
  const state = perceptionControl.state()
  await perceptionRequest('/snapshot', { sequence: ++serial, generation: state.generation, expiresAt: Date.now() + 12_000, snapshot: perceptionCoordinator.snapshot() }).catch(() => {})
}
export function invalidatePerceptionSamples(): void {
  controller.abort(); controller = new AbortController()
  perceptionCoordinator.clear(); nextWindows = 0; lastWindow = ''
  void publishSnapshot()
}
export async function samplePerception(background = false): Promise<void> {
  const state = perceptionControl.state()
  if (!perceptionCoordinator.canSample() || busy || Date.now() < nextAttempt) return
  busy = true
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6000)])
  try {
    const active=await windowsDesktop.active()
    perceptionControl.setReason('sensitive-target',!!active&&sensitiveWindow(active,state.settings))
    if(state.generation!==perceptionControl.state().generation || !perceptionCoordinator.canSample())return
    const sample = await windowsDesktop.request<PerceptionSample>('perception', { background: String(background) }, signal)
    if(!background)delete sample.processes
    if (state.settings.windowTitles) {
      try {
        const helper=await ensureVisionHelper(visionCacheDir())
        const raw=await windowsDesktop.request<string>('mediaTitles',{helper},signal)
        sample.media=raw.split('\n').map(line=>line.split('\t')).filter(([source,title])=>source&&title).map(([source,title,status,type])=>({source:source!,title:title!,playing:status==='playing',type:type??''}))
        // AppUserModelId 不是 PID；只接受唯一、明确的程序名匹配，否则回退窗口标题。
        if(sample.active && !sensitiveWindow(sample.active,state.settings)) {
          const processName=sample.active.processName
          const titles=sample.media.filter(row=>mediaFrom(row.source,processName))
          if(titles.length===1){sample.mediaTitle=titles[0]!.title;sample.mediaPlaying=titles[0]!.playing;sample.mediaType=titles[0]!.type}
        }
      } catch { /* 旧版 Windows 或媒体不公开标题时沿用窗口标题。 */ }
    }
    signal.throwIfAborted()
    if (state.generation !== perceptionControl.state().generation) return
    // 先收下当前状态再判断回来了，叫醒时快照才不是空的。
    perceptionCoordinator.accept(sample, state.generation, performance.now())
    perceptionCoordinator.activity(powerMonitor.getSystemIdleTime() * 1000)
    if (sample.active?.windowId !== lastWindow || Date.now() >= nextWindows) {
      // 后台窗口只留下过滤后的程序名；原始列表不进入缓存。
      const windows = await windowsDesktop.request<Array<{ processName: string }>>('windows', {}, signal)
      sample.processes = [...new Set([...(sample.processes??[]),...windows.map(window => window.processName)])].slice(0, 30)
      perceptionCoordinator.accept(sample, state.generation, performance.now())
      nextWindows = Date.now() + 30_000; lastWindow = sample.active?.windowId ?? ''
    }
    for (const fn of sampleListeners) fn(sample, state.generation)
    failures = 0
    await publishSnapshot()
  } catch { nextAttempt = Date.now() + Math.min(60_000, 4000 * 2 ** Math.min(4, failures++)) }
  finally { busy = false }
}
