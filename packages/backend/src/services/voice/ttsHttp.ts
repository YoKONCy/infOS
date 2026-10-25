import type { TtsAudioFormat, TtsHttpProfile, TtsValue } from '@infos/shared'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'

const MAX_AUDIO = 32 * 1024 * 1024
const MAX_EVENT = 12 * 1024 * 1024
export const ttsFailure = () =>
  new AppError('EXTERNAL_ERROR', { message: t('server.tts', '语音服务返回无效音频或错误结果') })
export const ttsConfigFailure = () =>
  new AppError('CONFIG_ERROR', { message: t('server.tts', '语音配置不完整或参数不受支持') })
const httpFailure = (status: number) =>
  new AppError('EXTERNAL_ERROR', {
    message: t('server.tts', '语音服务请求失败（HTTP {0}）', [status]),
    data: { status },
  })

export function fieldAt(input: unknown, path: string): unknown {
  if (!path || !/^[\w-]+(?:\[\d+\]|\.[\w-]+)*$/.test(path)) return undefined
  let value = input
  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key)
    )
      return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** 变量先按值替换，再序列化 JSON；不会将用户文本作为模板再次求值。 */
export function renderTtsTemplate(
  value: TtsValue,
  variables: Record<string, TtsValue>,
  escape: (value: string) => string = (value) => value,
): TtsValue {
  if (typeof value === 'string') {
    const exact = /^\{\{([\w]+)\}\}$/.exec(value)
    if (exact) {
      if (!Object.hasOwn(variables, exact[1]!)) throw ttsConfigFailure()
      const found = variables[exact[1]!]!
      return typeof found === 'string' ? escape(found) : found
    }
    return value.replace(/\{\{([\w]+)\}\}/g, (_, key: string) => {
      if (!Object.hasOwn(variables, key)) throw ttsConfigFailure()
      return escape(String(variables[key] ?? ''))
    })
  }
  if (Array.isArray(value)) return value.map((item) => renderTtsTemplate(item, variables, escape))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTtsTemplate(item, variables, escape)]),
    )
  return value
}

function httpUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw ttsConfigFailure()
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw ttsConfigFailure()
  return url
}

export async function readTtsBytes(response: Response, limit = MAX_AUDIO): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel()
    throw httpFailure(response.status)
  }
  const chunks: Buffer[] = []
  let size = 0
  if (!response.body) throw ttsFailure()
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw ttsFailure()
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function decodeAudio(value: unknown, encoding: 'base64' | 'hex'): Buffer {
  if (typeof value !== 'string') throw ttsFailure()
  const raw = value.replace(/^data:audio\/[\w.+-]+;base64,/, '').replace(/\s/g, '')
  if (
    !raw ||
    (encoding === 'hex'
      ? !/^(?:[\da-f]{2})+$/i.test(raw)
      : !/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 === 1)
  )
    throw ttsFailure()
  const bytes = Buffer.from(raw, encoding)
  if (!bytes.length || bytes.length > MAX_AUDIO) throw ttsFailure()
  return bytes
}

/** 返回下载独立执行，不继承 API 凭据；重定向逐跳校验协议。 */
async function downloadAudio(value: unknown, signal: AbortSignal): Promise<Buffer> {
  if (typeof value !== 'string') throw ttsFailure()
  let url = httpUrl(value)
  for (let i = 0; i < 5; ++i) {
    const response = await fetch(url, { signal, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw ttsFailure()
      url = httpUrl(new URL(location, url).href)
    } else return readTtsBytes(response)
  }
  throw ttsFailure()
}

export function playableAudio(
  bytes: Buffer,
  format: TtsAudioFormat,
  sampleRate = 24000,
): { audio: ArrayBuffer; mimeType: string } {
  if (!bytes.length || bytes.length > MAX_AUDIO) throw ttsFailure()
  // 按文件签名识别封装，避免把上游 JSON 错误或 WAV 当作 MP3 保存。
  let detected: TtsAudioFormat | undefined
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE')
    detected = 'wav'
  else if (bytes.subarray(0, 4).toString() === 'OggS') detected = 'opus'
  else if (bytes.subarray(0, 4).toString() === 'fLaC') detected = 'flac'
  else if (
    bytes.subarray(0, 3).toString() === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0)
  )
    detected = 'mp3'
  else if (bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) detected = 'aac'
  if (detected) format = detected
  else if (format !== 'pcm') throw ttsFailure()
  if (format === 'pcm') {
    const prefix = bytes.subarray(0, 64).toString('utf8').trimStart()
    let json = false
    if (/^[{[]/.test(prefix)) {
      try {
        JSON.parse(bytes.toString('utf8'))
        json = true
      } catch {
        /* 波形恰好以标点字节开头时仍按音频处理。 */
      }
    }
    if (
      json ||
      /^<(?:!doctype|html|\?xml)\b/i.test(prefix) ||
      bytes.length % 2 ||
      !Number.isInteger(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000
    )
      throw ttsFailure()
    const header = Buffer.alloc(44)
    header.write('RIFF')
    header.writeUInt32LE(bytes.length + 36, 4)
    header.write('WAVEfmt ', 8)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(bytes.length, 40)
    bytes = Buffer.concat([header, bytes])
    format = 'wav'
  }
  const mime = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    opus: 'audio/ogg',
    aac: 'audio/aac',
  }
  return { audio: new Uint8Array(bytes).buffer, mimeType: mime[format] }
}

/** 首版公共 HTTP 执行器：接收完整结果或聚合 SSE，再交给已有 Audio Asset 链路。 */
export async function executeTtsHttp(input: {
  base: string
  key: string
  headers: Record<string, string>
  profile: TtsHttpProfile
  variables: Record<string, TtsValue>
  signal: AbortSignal
  literalBody?: boolean
}): Promise<{ audio: ArrayBuffer; mimeType: string }> {
  const { profile, variables, signal } = input
  const path = String(renderTtsTemplate(profile.path, variables, encodeURIComponent))
  const url = /^https?:\/\//i.test(path)
    ? httpUrl(path)
    : httpUrl(`${input.base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`)
  const renderFields = (fields: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        String(renderTtsTemplate(value, variables)),
      ]),
    )
  for (const [key, value] of Object.entries(renderFields(profile.query)))
    url.searchParams.set(key, value)
  const headers = new Headers({
    ...(input.key ? { Authorization: `Bearer ${input.key}` } : {}),
    ...input.headers,
    ...renderFields(profile.headers),
  })
  const xmlEscape = (value: string) =>
    value.replace(
      /[<>&"']/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
    )
  const rendered = input.literalBody
    ? profile.body
    : renderTtsTemplate(profile.body, variables, profile.bodyType === 'xml' ? xmlEscape : undefined)
  let body: string | URLSearchParams | FormData | undefined
  if (profile.method !== 'GET') {
    if (profile.bodyType === 'json') {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(rendered)
    } else if (profile.bodyType === 'xml') {
      headers.set('Content-Type', 'application/ssml+xml')
      body = String(rendered)
    } else {
      if (!rendered || typeof rendered !== 'object' || Array.isArray(rendered))
        throw ttsConfigFailure()
      if (profile.bodyType === 'form') {
        headers.set('Content-Type', 'application/x-www-form-urlencoded')
        body = new URLSearchParams(
          Object.entries(rendered).map(([key, value]): [string, string] => [
            key,
            typeof value === 'object' ? JSON.stringify(value) : String(value),
          ]),
        )
      } else {
        headers.delete('Content-Type')
        const form = new FormData()
        for (const [key, value] of Object.entries(rendered)) {
          if (typeof value === 'string' && value.startsWith('data:audio/')) {
            const match = /^data:(audio\/[\w.+-]+);base64,(.+)$/.exec(value)
            if (!match) throw ttsConfigFailure()
            form.set(
              key,
              new Blob([new Uint8Array(decodeAudio(match[2], 'base64'))], { type: match[1] }),
              'reference.audio',
            )
          } else form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
        }
        body = form
      }
    }
  }
  const response = await fetch(url, {
    method: profile.method,
    headers,
    body,
    signal,
    redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw httpFailure(response.status)
  }
  const descriptor = profile.response
  if (descriptor.mode === 'binary') {
    if (/json|text\/|html/.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel()
      throw ttsFailure()
    }
    return playableAudio(await readTtsBytes(response), descriptor.format, descriptor.sampleRate)
  }
  const validate = (value: unknown) => {
    if (descriptor.successPath) {
      const status = fieldAt(value, descriptor.successPath)
      if (
        status === undefined ||
        JSON.stringify(status) !== JSON.stringify(descriptor.successValue)
      )
        throw ttsFailure()
    }
    if (descriptor.errorPath && fieldAt(value, descriptor.errorPath)) throw ttsFailure()
  }
  if (descriptor.mode === 'json') {
    let value: unknown
    try {
      value = JSON.parse((await readTtsBytes(response, MAX_AUDIO * 2)).toString())
    } catch {
      throw ttsFailure()
    }
    validate(value)
    const audio = fieldAt(value, descriptor.audioPath!)
    const bytes =
      descriptor.encoding === 'url'
        ? await downloadAudio(audio, signal)
        : decodeAudio(audio, descriptor.encoding!)
    const rate = descriptor.sampleRatePath
      ? Number(fieldAt(value, descriptor.sampleRatePath))
      : descriptor.sampleRate
    return playableAudio(bytes, descriptor.format, rate)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel()
    throw ttsFailure()
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = '',
    size = 0,
    total = 0
  let chunks: Buffer[] = []
  let rate = descriptor.sampleRate
  const event = (block: string) => {
    const eventType = block
      .split('\n')
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim()
    if (eventType === 'error' || eventType?.endsWith('.error')) throw ttsFailure()
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      throw ttsFailure()
    }
    const type = fieldAt(value, 'type')
    if (typeof type === 'string' && (type === 'error' || type.endsWith('.error')))
      throw ttsFailure()
    validate(value)
    const encoded = fieldAt(value, descriptor.audioPath!)
    if (encoded === undefined || encoded === null || encoded === '') return
    const bytes = decodeAudio(encoded, descriptor.encoding as 'base64' | 'hex')
    if (descriptor.chunkMode === 'replace') {
      chunks = []
      size = 0
    }
    chunks.push(bytes)
    size += bytes.length
    if (size > MAX_AUDIO) throw ttsFailure()
    if (descriptor.sampleRatePath && fieldAt(value, descriptor.sampleRatePath) !== undefined)
      rate = Number(fieldAt(value, descriptor.sampleRatePath))
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      total += value?.byteLength ?? 0
      if (total > MAX_AUDIO * 3) throw ttsFailure()
      pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        event(pending.slice(0, boundary))
        pending = pending.slice(boundary + 2)
      }
      if (pending.length > MAX_EVENT) throw ttsFailure()
      if (done) {
        if (pending.trim()) event(pending)
        break
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return playableAudio(Buffer.concat(chunks), descriptor.format, rate)
}
