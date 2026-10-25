import { tokenCounter } from '../tokenizer/tokenCounter'
import { inspectAudio } from '@infos/shared'

/** 已知时长按音频预算估算；未知压缩音频采用低码率上界，避免漏计媒体。 */
function audioTokens(data: unknown, mime = ''): number {
  if (typeof data !== 'string' || !data.length) return 0
  const bytes = Buffer.from(data, 'base64')
  const duration = inspectAudio(bytes, mime)?.durationMs ?? (bytes.length / 500) * 1000
  return Math.ceil((duration / 1000) * 32)
}

/** 只估算 Provider 实际发送的输入；二进制与签名不能当作普通文本编码。 */
export function estimateInputPayloadTokens(payload: Record<string, unknown>): number {
  let imageTokens = 0
  let nativeAudioTokens = 0
  const serialized = JSON.stringify(payload, (key, value: unknown) => {
    if (key === 'encrypted_content' || key === 'signature' || key === 'thoughtSignature')
      return undefined
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const object = value as Record<string, unknown>
      if (object.type === 'reasoning.encrypted')
        return { type: object.type, id: object.id, index: object.index }
      if (object.type === 'image_url' || object.type === 'input_image') {
        imageTokens += 1024
        return { type: object.type, image: '[图片内容]' }
      }
      if (object.type === 'image' && object.source) {
        imageTokens += 1024
        return { type: 'image', image: '[图片内容]' }
      }
      if (key === 'inlineData') {
        if (String(object.mimeType).startsWith('audio/'))
          nativeAudioTokens += audioTokens(object.data, String(object.mimeType))
        else imageTokens += 1024
        return { mimeType: object.mimeType, data: '[媒体内容]' }
      }
      if (object.type === 'input_audio') {
        const audio = object.input_audio as { data?: string; mimeType?: string } | undefined
        nativeAudioTokens += audioTokens(audio?.data, audio?.mimeType)
        return { type: 'input_audio', audio: '[音频内容]' }
      }
    }
    return value
  })
  // 图片采用固定占位预估；各模型实际图像 Token 由上游决定。
  return tokenCounter.countTokens(serialized ?? '') + imageTokens + nativeAudioTokens
}
