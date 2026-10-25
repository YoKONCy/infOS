import { nativeAudioMime, MAX_NATIVE_AUDIO_BYTES } from '@infos/shared'
import { AppError } from '../../lib/appError'
import type { ContentPart } from './types'
import { t } from '../../lib/i18n'

/** 音频兼容扩展以 Gemini inlineData 为输出契约，支持同协议的自定义 API 基址。 */
export function geminiAudioPart(part: Extract<ContentPart, { type: 'input_audio' }>) {
  const input = part.input_audio
  const mimeType = nativeAudioMime(input.mimeType ?? '', `audio.${input.format}`)
  if (
    !mimeType ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) ||
    !input.data.length ||
    input.data.length % 4 !== 0
  )
    throw new AppError('BAD_REQUEST', {
      message: t('server.audio-input', '音频格式或编码无效，请重新上传'),
    })
  const bytes = Buffer.byteLength(input.data, 'base64')
  if (bytes > MAX_NATIVE_AUDIO_BYTES)
    throw new AppError('PAYLOAD_TOO_LARGE', {
      message: t('server.audio-input', '单轮原生音频不能超过 12MB'),
    })
  return { inlineData: { mimeType, data: input.data } }
}
