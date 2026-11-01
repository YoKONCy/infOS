import type { CanvasItem, FieldSchema, ReferenceUse, Step } from '../types'
import { videoStartField, referencePromptField } from '../../../src/creativeInputs'
import { isAssetField, isAssetsField } from '../composables/useCanvasLinks'

export function continuationStep(step: Step): boolean {
  const name = videoStartField(step.inputSchema)
  const field = name && step.inputSchema.properties?.[name]
  return Boolean(
    step.available &&
    field &&
    (isAssetField(field) || isAssetsField(field)) &&
    referencePromptField(step.inputSchema),
  )
}
export function tailFrameTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('VIDEO_DURATION_INVALID')
  const last = Math.max(0, duration - 0.001)
  return [
    ...new Set(
      [1, 0.75, 0.5, 0.25, 0].map((offset) =>
        Math.max(0, last - Math.min(1, duration / 2) * offset),
      ),
    ),
  ]
}
function mediaEvent(video: HTMLVideoElement, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      video.removeEventListener(event, ready)
      video.removeEventListener('error', failed)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    const ready = () => finish()
    const failed = () => finish(new Error('VIDEO_DECODE_FAILED'))
    const aborted = () => finish(new DOMException('VIDEO_CANCELLED', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('VIDEO_DECODE_FAILED')), 20000)
    video.addEventListener(event, ready, { once: true })
    video.addEventListener('error', failed, { once: true })
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
export async function openFrameVideo(url: string, signal: AbortSignal): Promise<HTMLVideoElement> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  const ready = mediaEvent(video, 'loadedmetadata', signal)
  video.src = url
  video.load()
  try {
    await ready
    tailFrameTimes(video.duration)
    return video
  } catch (error) {
    releaseFrameVideo(video)
    throw error
  }
}
export function releaseFrameVideo(video: HTMLVideoElement) {
  video.pause()
  video.removeAttribute('src')
  video.load()
}
/** 在解码器完成定位后读取原始像素；不假定帧率，也不修改源视频。 */
export async function extractVideoFrame(
  video: HTMLVideoElement,
  time: number,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted()
  if (!Number.isFinite(time) || time < 0 || time >= video.duration)
    throw new Error('VIDEO_DURATION_INVALID')
  if (Math.abs(video.currentTime - time) > 0.0001) {
    const positioned = mediaEvent(video, 'seeked', signal)
    video.currentTime = time
    await positioned
  }
  if (video.readyState < 2) await mediaEvent(video, 'loadeddata', signal)
  signal.throwIfAborted()
  if (!video.videoWidth || !video.videoHeight || video.videoWidth * video.videoHeight > 64_000_000)
    throw new Error('VIDEO_DECODE_FAILED')
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('VIDEO_DECODE_FAILED')
  context.drawImage(video, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('VIDEO_DECODE_FAILED'))),
      'image/jpeg',
      0.94,
    ),
  )
}
export function continuationParameters(
  step: Step,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const start = videoStartField(step.inputSchema),
    prompt = referencePromptField(step.inputSchema)
  return Object.fromEntries(
    Object.entries(step.inputSchema.properties ?? {}).flatMap(([key, field]) => {
      if (
        key === start ||
        key === prompt ||
        isAssetField(field) ||
        isAssetsField(field) ||
        !['string', 'number', 'integer', 'boolean'].includes(field.type || '')
      )
        return []
      const candidate = source[key]
      const compatible =
        candidate !== undefined &&
        (!field.enum || field.enum.some((value) => Object.is(value, candidate))) &&
        (field.type !== 'integer' ||
          (typeof candidate === 'number' && Number.isInteger(candidate))) &&
        (field.type !== 'number' ||
          (typeof candidate === 'number' && Number.isFinite(candidate))) &&
        (field.type !== 'string' || typeof candidate === 'string') &&
        (field.type !== 'boolean' || typeof candidate === 'boolean') &&
        (typeof field.minimum !== 'number' ||
          (typeof candidate === 'number' && candidate >= field.minimum)) &&
        (typeof field.maximum !== 'number' ||
          (typeof candidate === 'number' && candidate <= field.maximum))
      const value = compatible ? candidate : field.default
      return value === undefined ? [] : [[key, value]]
    }),
  )
}
/** 只沿用真实输入中已标注的辅助图片，起始帧始终由本次选帧提供。 */
export function continuationReferences(
  step: Step,
  source: Record<string, unknown>,
  uses: readonly ReferenceUse[],
) {
  const inputs: Record<string, unknown> = {},
    retained: ReferenceUse[] = []
  const start = videoStartField(step.inputSchema)
  for (const [name, field] of Object.entries(step.inputSchema.properties ?? {})) {
    if (name === start || !(isAssetField(field) || isAssetsField(field))) continue
    const value = source[name]
    const references: unknown[] = Array.isArray(value) ? value : [value]
    const selected: Array<{ assetId: string }> = []
    for (const reference of references) {
      if (
        !reference ||
        typeof reference !== 'object' ||
        !('assetId' in reference) ||
        typeof reference.assetId !== 'string'
      )
        continue
      const use = uses.find(
        (entry) =>
          entry.field === name &&
          entry.assetId === reference.assetId &&
          ['subject', 'style', 'scene', 'costume'].includes(entry.purpose),
      )
      if (!use || selected.some((entry) => entry.assetId === use.assetId)) continue
      selected.push({ assetId: use.assetId })
      retained.push({ ...use })
    }
    if (selected.length) inputs[name] = isAssetsField(field) ? selected : selected[0]
  }
  return { inputs, uses: retained }
}
export function videoAncestors(items: readonly CanvasItem[], source: CanvasItem): CanvasItem[] {
  const seen = new Set<string>(),
    result: CanvasItem[] = []
  let current: CanvasItem | undefined = source
  while (current?.content.assetId && !seen.has(current.content.assetId)) {
    seen.add(current.content.assetId)
    result.unshift(current)
    const previous: string | undefined = current.content.continuation?.source.assetId
    current = previous ? items.find((item) => item.content.assetId === previous) : undefined
  }
  return result
}
export function continuationParameterFields(step?: Step): Array<[string, FieldSchema]> {
  if (!step) return []
  const start = videoStartField(step.inputSchema),
    prompt = referencePromptField(step.inputSchema)
  return Object.entries(step.inputSchema.properties ?? {}).filter(
    ([key, field]) =>
      key !== start &&
      key !== prompt &&
      (Boolean(field.enum) ||
        ['number', 'integer', 'boolean', 'string'].includes(field.type || '')),
  )
}
