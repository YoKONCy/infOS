import type {
  TtsAdapterId,
  TtsConnection,
  TtsModel,
  TtsApiProfile,
  TtsVoicePreset,
  TtsHttpProfile,
  TtsValue,
} from '@infos/shared'
import { executeTtsHttp, ttsConfigFailure, ttsFailure } from './ttsHttp'

export interface TtsAdapterContext {
  text: string
  connection: TtsConnection
  model: TtsModel
  profile: TtsApiProfile
  preset: TtsVoicePreset
  reference?: { bytes: Buffer; mimeType: string }
  signal: AbortSignal
}
export interface TtsAdapter {
  id: TtsAdapterId
  synthesize(context: TtsAdapterContext): Promise<{ audio: ArrayBuffer; mimeType: string }>
}

/** 适配器仅负责协议；解析预设、限流、取消和配置快照由调度层统一处理。 */
export class TtsAdapterRegistry {
  private adapters = new Map<TtsAdapterId, TtsAdapter>()
  register(adapter: TtsAdapter): void {
    if (this.adapters.has(adapter.id)) throw ttsConfigFailure()
    this.adapters.set(adapter.id, adapter)
  }
  get(id: TtsAdapterId): TtsAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw ttsConfigFailure()
    return adapter
  }
}

function extraBody(extra: Record<string, TtsValue>, reserved: string[]): Record<string, TtsValue> {
  if (reserved.some((key) => Object.hasOwn(extra, key))) throw ttsConfigFailure()
  return extra
}

function httpProfile(ctx: TtsAdapterContext): TtsHttpProfile {
  const { model, preset: p, profile, reference } = ctx
  const response: TtsHttpProfile['response'] = {
    mode: 'binary',
    format: p.format,
    sampleRate: 24000,
  }
  const base = { method: 'POST' as const, bodyType: 'json' as const, response }
  const extra = p.extra
  if (['stepfun', 'minimax'].includes(profile.adapter) && (p.speed < 0.5 || p.speed > 2))
    throw ttsConfigFailure()
  switch (profile.adapter) {
    case 'openai': {
      if (p.instructions && /^tts-1(?:-hd)?$/.test(model.modelId)) throw ttsConfigFailure()
      return {
        ...base,
        path: '/audio/speech',
        body: {
          ...extraBody(extra, [
            'model',
            'input',
            'voice',
            'instructions',
            'speed',
            'response_format',
            'stream_format',
          ]),
          model: model.modelId,
          input: ctx.text,
          voice: p.voice,
          speed: p.speed,
          response_format: p.format,
          ...(p.instructions ? { instructions: p.instructions } : {}),
        },
      }
    }
    case 'stepfun':
      return {
        ...base,
        path: '/audio/speech',
        body: {
          ...extraBody(extra, [
            'model',
            'input',
            'voice',
            'instruction',
            'speed',
            'response_format',
            'stream_format',
            'return_url',
            'sample_rate',
          ]),
          model: model.modelId,
          input: ctx.text,
          voice: p.voice,
          speed: p.speed,
          response_format: p.format,
          sample_rate: 24000,
          ...(p.language ? { language: p.language } : {}),
          ...(p.instructions ? { instruction: p.instructions } : {}),
        },
      }
    case 'mimo': {
      const cloning = model.modelId.endsWith('-voiceclone')
      const design = model.modelId.endsWith('-voicedesign')
      if (
        (cloning && !reference) ||
        (design && !p.instructions.trim()) ||
        !['wav', 'pcm'].includes(p.format)
      )
        throw ttsConfigFailure()
      const voice = cloning
        ? `data:${reference!.mimeType};base64,${reference!.bytes.toString('base64')}`
        : p.voice
      if (cloning && voice.length > 10 * 1024 * 1024) throw ttsConfigFailure()
      return {
        ...base,
        path: '/chat/completions',
        body: {
          ...extraBody(extra, ['model', 'messages', 'audio', 'stream']),
          model: model.modelId,
          messages: [
            ...(p.instructions ? [{ role: 'user', content: p.instructions }] : []),
            { role: 'assistant', content: ctx.text },
          ],
          audio: { format: p.format === 'pcm' ? 'pcm16' : 'wav', ...(!design ? { voice } : {}) },
          stream: false,
        },
        response: {
          mode: 'json',
          encoding: 'base64',
          audioPath: 'choices[0].message.audio.data',
          errorPath: 'error',
          format: p.format,
          sampleRate: 24000,
        },
      }
    }
    case 'bailian':
      if (p.instructions || p.format !== 'wav') throw ttsConfigFailure()
      return {
        ...base,
        path: '/services/aigc/multimodal-generation/generation',
        body: {
          ...extraBody(extra, ['model', 'input', 'stream']),
          model: model.modelId,
          input: {
            text: ctx.text,
            voice: p.voice,
            ...(p.language ? { language_type: p.language } : {}),
          },
        },
        response: {
          mode: 'json',
          encoding: 'url',
          audioPath: 'output.audio.url',
          errorPath: 'code',
          format: 'wav',
        },
      }
    case 'minimax':
      if (!['mp3', 'wav', 'flac'].includes(p.format)) throw ttsConfigFailure()
      return {
        ...base,
        path: '/t2a_v2',
        body: {
          ...extraBody(extra, [
            'model',
            'text',
            'stream',
            'voice_setting',
            'audio_setting',
            'output_format',
          ]),
          model: model.modelId,
          text: ctx.text,
          stream: false,
          output_format: 'hex',
          voice_setting: {
            voice_id: p.voice,
            speed: p.speed,
            ...(p.emotion ? { emotion: p.emotion } : {}),
          },
          audio_setting: { format: p.format, sample_rate: 24000 },
        },
        response: {
          mode: 'json',
          encoding: 'hex',
          audioPath: 'data.audio',
          format: p.format,
          successPath: 'base_resp.status_code',
          successValue: 0,
        },
      }
    case 'custom':
      if (!profile.custom) throw ttsConfigFailure()
      return profile.custom
    default:
      throw ttsConfigFailure()
  }
}

export function createTtsAdapterRegistry(): TtsAdapterRegistry {
  const registry = new TtsAdapterRegistry()
  registry.register({
    id: 'edge_tts',
    async synthesize({ text, preset, signal }) {
      const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
      const tts = new MsEdgeTTS()
      signal.throwIfAborted()
      const abort = () => tts.close()
      signal.addEventListener('abort', abort, { once: true })
      try {
        await tts.setMetadata(preset.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
        signal.throwIfAborted()
        const escaped = text.replace(
          /[<>&"']/g,
          (value) =>
            ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[value]!,
        )
        const { audioStream } = tts.toStream(escaped, { rate: preset.rate, pitch: preset.pitch })
        const stopStream = () => audioStream.destroy(new Error('TTS_CANCELLED'))
        signal.addEventListener('abort', stopStream, { once: true })
        const chunks: Buffer[] = []
        let size = 0
        try {
          for await (const chunk of audioStream) {
            signal.throwIfAborted()
            const bytes = Buffer.from(chunk)
            size += bytes.length
            if (size > 32 * 1024 * 1024) throw ttsFailure()
            chunks.push(bytes)
          }
        } finally {
          signal.removeEventListener('abort', stopStream)
          audioStream.destroy()
        }
        if (!size) throw ttsFailure()
        return { audio: new Uint8Array(Buffer.concat(chunks)).buffer, mimeType: 'audio/mpeg' }
      } finally {
        signal.removeEventListener('abort', abort)
        tts.close()
      }
    },
  })
  for (const id of ['openai', 'mimo', 'bailian', 'minimax', 'stepfun', 'custom'] as const) {
    registry.register({
      id,
      async synthesize(ctx) {
        const p = ctx.preset
        const referenceData = ctx.reference
          ? `data:${ctx.reference.mimeType};base64,${ctx.reference.bytes.toString('base64')}`
          : ''
        return executeTtsHttp({
          base: ctx.connection.apiBase,
          key: ctx.connection.apiKey,
          headers: ctx.connection.headers,
          profile: httpProfile(ctx),
          signal: ctx.signal,
          literalBody: ctx.profile.adapter !== 'custom',
          variables: {
            text: ctx.text,
            model: ctx.model.modelId,
            voice: p.voice,
            apiKey: ctx.connection.apiKey,
            speed: p.speed,
            rate: p.rate,
            pitch: p.pitch,
            format: p.format,
            language: p.language,
            instructions: p.instructions,
            emotion: p.emotion,
            referenceText: p.referenceText,
            referenceAudio: referenceData,
            extra: p.extra,
          },
        })
      },
    })
  }
  return registry
}
