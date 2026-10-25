import { t } from '../i18n'

/** 生成真正的 PCM16 WAV；不把浏览器录音仅改扩展名后冒充 WAV。 */
export function pcm16Wave(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((value, index) => {
    const sample = Math.max(-1, Math.min(1, value))
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  })
  return buffer
}

/** 短录音在本地转换为单声道 24kHz，输出保持各 Gemini 兼容服务可识别。 */
export async function recordingWave(audio: ArrayBuffer, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  const decoder = new AudioContext()
  try {
    const decoded = await decoder.decodeAudioData(audio.slice(0))
    signal.throwIfAborted()
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 125)
      throw new Error(t('ui.audio-input', '录音时长无效，请重新录制'))
    const target = new OfflineAudioContext(1, Math.ceil(decoded.duration * 24000), 24000)
    const source = target.createBufferSource()
    source.buffer = decoded
    source.connect(target.destination)
    source.start()
    const normalized = await target.startRendering()
    signal.throwIfAborted()
    return pcm16Wave(normalized.getChannelData(0), 24000)
  } finally {
    await decoder.close().catch(() => {})
  }
}
