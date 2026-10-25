import { t as __t } from '../../i18n/index'
import { clientFetch } from '../transport'
/**
 * Voice API 模块 — 语音 TTS/ASR
 *
 * 对接后端 /api/voice/* 路由。
 * 注：TTS 返回二进制音频, ASR 接收二进制音频 → 不走 apiClient 信封。
 *
 * @module packages/frontend/src/api/modules/voiceApi
 */

import { apiClient } from '../client'
import { getBaseUrl } from '../transportUtils'
import { requestApiBinary } from '../transport'
import type { TtsWorkspace, TtsSynthesisInput } from '@infos/shared'

/** ASR 识别结果 */
export interface AsrResult {
  text: string
  language?: string
  confidence?: number
  durationMs?: number
}

/** 语音服务状态 */
export interface VoiceStatus {
  tts: { available: boolean }
  asr: { available: boolean }
}

export const voiceApi = {
  getTtsConfig: () => apiClient.get<TtsWorkspace>('/voice/tts/config'),
  saveTtsConfig: (config: TtsWorkspace) => apiClient.put<TtsWorkspace>('/voice/tts/config', config),
  uploadTtsReference: async (file: File): Promise<{ assetId: string; name: string }> => {
    const body = new FormData()
    body.set('audio', file)
    const response = await clientFetch(`${getBaseUrl()}/api/voice/tts/references`, {
      method: 'POST',
      body,
    })
    const result = await response.json()
    if (!response.ok || result.code !== 'OK')
      throw new Error(result.message ?? __t('ui.tts', '参考音频上传失败'))
    return result.data
  },
  /**
   * TTS 合成 — 返回 ArrayBuffer 音频数据
   */
  synthesize: async (params: TtsSynthesisInput, signal?: AbortSignal): Promise<ArrayBuffer> => {
    return requestApiBinary('/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    })
  },

  /**
   * ASR 语音识别 — 发送 ArrayBuffer 音频, 返回识别文本
   *
   * 使用 application/octet-stream 直接发送二进制流,
   * 避免 FormData 的额外开销。
   */
  recognize: async (
    audioData: ArrayBuffer,
    mimeType = 'audio/webm',
    signal?: AbortSignal,
  ): Promise<AsrResult> => {
    const res = await clientFetch(`${getBaseUrl()}/api/voice/asr`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      body: audioData,
      signal,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({
        get message() {
          return __t('ui.modules', '语音识别失败')
        },
      }))
      throw new Error(err.message || `ASR 请求失败: ${res.status}`)
    }

    const json = await res.json()
    return json.data as AsrResult
  },

  /** 获取语音服务状态 */
  getStatus: () => apiClient.get<VoiceStatus>('/voice/status'),
}
