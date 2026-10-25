/** 语音调度合同：连接、协议、模型、声音预设与角色绑定分别管理。 */
export type TtsAdapterId =
  | 'edge_tts'
  | 'openai'
  | 'mimo'
  | 'bailian'
  | 'minimax'
  | 'stepfun'
  | 'custom'
export type TtsAudioFormat = 'mp3' | 'wav' | 'flac' | 'opus' | 'aac' | 'pcm'
export type TtsValue = null | boolean | number | string | TtsValue[] | { [key: string]: TtsValue }

export interface TtsHttpProfile {
  path: string
  method: 'POST' | 'GET'
  headers?: Record<string, string>
  query?: Record<string, string>
  bodyType: 'json' | 'form' | 'multipart' | 'xml'
  /** 完整变量 {{text}} 保留原始类型；字符串内插值按请求体类型转义。 */
  body: TtsValue
  response: {
    mode: 'binary' | 'json' | 'sse'
    encoding?: 'base64' | 'hex' | 'url'
    audioPath?: string
    format: TtsAudioFormat
    sampleRate?: number
    sampleRatePath?: string
    successPath?: string
    successValue?: TtsValue
    errorPath?: string
    /** 适用于最终包包含完整音频的接口，避免重复拼接。 */
    chunkMode?: 'append' | 'replace'
  }
}
export interface TtsConnection {
  id: string
  name: string
  apiBase: string
  apiKey: string
  headers: Record<string, string>
  timeoutMs: number
}
export interface TtsApiProfile {
  id: string
  adapter: TtsAdapterId
  custom?: TtsHttpProfile
}
export interface TtsModel {
  id: string
  connectionId: string
  profileId: string
  modelId: string
  maxChars?: number
}
export interface TtsVoicePreset {
  id: string
  name: string
  modelId: string
  voice: string
  format: TtsAudioFormat
  speed: number
  rate: string
  pitch: string
  language: string
  instructions: string
  emotion: string
  referenceAssetId?: string
  referenceText: string
  /** 厂商扩展字段；不覆盖调度生成的身份、文本或凭据。 */
  extra: Record<string, TtsValue>
}
export interface TtsWorkspace {
  version: 1
  enabled: boolean
  connections: TtsConnection[]
  profiles: TtsApiProfile[]
  models: TtsModel[]
  presets: TtsVoicePreset[]
  defaultPresetId: string
  bindings: Record<string, string>
}
export interface TtsSynthesisInput {
  text: string
  agentId?: string
  presetId?: string
  voice?: string
  speed?: number | string
  pitch?: string
  format?: TtsAudioFormat
  instructions?: string
  emotion?: string
}
export interface TtsAdapterDescription {
  id: TtsAdapterId
  apiBase: string
  models: string[]
  voice: string
  formats: TtsAudioFormat[]
  instructions: boolean
  emotion: boolean
  reference: boolean
}

/** 预设只声明已实现的 HTTP 合成合同；模型与音色 ID 始终允许手动填写。 */
export const TTS_ADAPTERS: TtsAdapterDescription[] = [
  {
    id: 'edge_tts',
    apiBase: '',
    models: [],
    voice: 'zh-CN-XiaoyiNeural',
    formats: ['mp3'],
    instructions: false,
    emotion: false,
    reference: false,
  },
  {
    id: 'openai',
    apiBase: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    voice: 'shimmer',
    formats: ['mp3', 'wav', 'flac', 'opus', 'aac', 'pcm'],
    instructions: true,
    emotion: false,
    reference: false,
  },
  {
    id: 'mimo',
    apiBase: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone'],
    voice: 'mimo_default',
    formats: ['wav', 'pcm'],
    instructions: true,
    emotion: false,
    reference: true,
  },
  {
    id: 'bailian',
    apiBase: 'https://dashscope.aliyuncs.com/api/v1',
    models: ['qwen3-tts-flash'],
    voice: 'Cherry',
    formats: ['wav'],
    instructions: false,
    emotion: false,
    reference: false,
  },
  {
    id: 'minimax',
    apiBase: 'https://api.minimax.cn/v1',
    models: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo'],
    voice: 'female-shaonv',
    formats: ['mp3', 'wav', 'flac'],
    instructions: false,
    emotion: true,
    reference: false,
  },
  {
    id: 'stepfun',
    apiBase: 'https://api.stepfun.ai/v1',
    models: ['stepaudio-3-tts', 'stepaudio-2.5-tts'],
    voice: 'zixinnansheng',
    formats: ['mp3', 'wav', 'flac', 'opus', 'pcm'],
    instructions: true,
    emotion: false,
    reference: false,
  },
  {
    id: 'custom',
    apiBase: '',
    models: [],
    voice: '',
    formats: ['mp3', 'wav', 'flac', 'opus', 'aac', 'pcm'],
    instructions: true,
    emotion: true,
    reference: true,
  },
]

export function createTtsPreset(
  id: string,
  modelId: string,
  adapter: TtsAdapterId,
): TtsVoicePreset {
  const description = TTS_ADAPTERS.find((item) => item.id === adapter)!
  return {
    id,
    modelId,
    name: adapter,
    voice: description.voice,
    format: description.formats[0]!,
    speed: 1,
    rate: '+25%',
    pitch: '+5Hz',
    language: '',
    instructions: '',
    emotion: '',
    referenceText: '',
    extra: {},
  }
}

export function createTtsWorkspace(): TtsWorkspace {
  return {
    version: 1,
    enabled: true,
    connections: [
      { id: 'edge', name: 'Edge TTS', apiBase: '', apiKey: '', headers: {}, timeoutMs: 60000 },
    ],
    profiles: [{ id: 'edge', adapter: 'edge_tts' }],
    models: [{ id: 'edge', connectionId: 'edge', profileId: 'edge', modelId: '' }],
    presets: [createTtsPreset('edge', 'edge', 'edge_tts')],
    defaultPresetId: 'edge',
    bindings: {},
  }
}
