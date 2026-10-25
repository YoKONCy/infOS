/** 原件可独立保存；单轮内联音频另设预算，为提示词和其他媒体预留空间。 */
export const MAX_NATIVE_AUDIO_BYTES = 12 * 1024 * 1024
export const MAX_AUDIO_RECORDING_MS = 120_000
export const GEMINI_AUDIO_MIME_TYPES = [
  'audio/wav',
  'audio/mpeg',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/m4a',
  'audio/webm',
] as const

export interface AudioMetadata {
  mimeType: string
  durationMs?: number
  sampleRate?: number
  channels?: number
}

const aliases: Record<string, string> = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-flac': 'audio/flac',
  'audio/x-aiff': 'audio/aiff',
  'audio/mp4': 'audio/m4a',
  'audio/x-m4a': 'audio/m4a',
  'audio/opus': 'audio/ogg',
}
const extensions: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/m4a',
  webm: 'audio/webm',
}
export function nativeAudioMime(mime: string, name = ''): string | null {
  const hint = mime.toLowerCase().split(';')[0]?.trim() ?? ''
  const value = aliases[hint] ?? hint
  if ((GEMINI_AUDIO_MIME_TYPES as readonly string[]).includes(value)) return value
  if (hint && hint !== 'application/octet-stream') return null
  return extensions[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? null
}

/** 能力由模型卡片手动开启；自定义服务商可复用 Gemini 协议。 */
export function nativeAudioEnabled(
  config?: { enableAudioInput?: boolean; protocol?: string; provider?: string } | null,
): boolean {
  return config?.enableAudioInput === true && (config.protocol ?? config.provider) === 'gemini'
}

/** 校验真实容器头；WAV 元信息从文件读取，不采信客户端上报的时长。 */
export function inspectAudio(bytes: Uint8Array, declared: string, name = ''): AudioMetadata | null {
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 12) return null
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') {
    let rate = 0,
      channels = 0,
      byteRate = 0,
      dataBytes = 0
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const size = view.getUint32(offset + 4, true)
      if (size > bytes.length - offset - 8) return null
      if (text(offset, 4) === 'fmt ' && size >= 16) {
        channels = view.getUint16(offset + 10, true)
        rate = view.getUint32(offset + 12, true)
        byteRate = view.getUint32(offset + 16, true)
      }
      if (text(offset, 4) === 'data') dataBytes += size
      offset += 8 + size + (size % 2)
    }
    if (!rate || !channels || !byteRate || !dataBytes) return null
    return {
      mimeType: 'audio/wav',
      sampleRate: rate,
      channels,
      durationMs: Math.ceil((dataBytes / byteRate) * 1000),
    }
  }
  if (text(0, 4) === 'fLaC') return { mimeType: 'audio/flac' }
  if (text(0, 4) === 'OggS') return { mimeType: 'audio/ogg' }
  if (text(0, 3) === 'ID3') return { mimeType: 'audio/mpeg' }
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return { mimeType: (bytes[1]! & 0xf6) === 0xf0 ? 'audio/aac' : 'audio/mpeg' }
  }
  if (text(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(text(8, 4)))
    return { mimeType: 'audio/aiff' }
  if (text(4, 4) === 'ftyp' && nativeAudioMime(declared, name) === 'audio/m4a')
    return { mimeType: 'audio/m4a' }
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3 &&
    nativeAudioMime(declared, name) === 'audio/webm'
  )
    return { mimeType: 'audio/webm' }
  return null
}
