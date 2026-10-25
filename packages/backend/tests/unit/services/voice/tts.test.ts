import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { AssetFileAuthority } from '../../../../src/kernel/assetFileAuthority'
import {
  createTtsWorkspace,
  createTtsPreset,
  TTS_ADAPTERS,
  type TtsAdapterId,
  type TtsWorkspace,
  type TtsHttpProfile,
} from '@infos/shared'
import { TtsService } from '../../../../src/services/voice/ttsService'
import { TtsAdapterRegistry } from '../../../../src/services/voice/ttsAdapters'
import {
  executeTtsHttp,
  playableAudio,
  renderTtsTemplate,
} from '../../../../src/services/voice/ttsHttp'
import { parseTtsWorkspace } from '../../../../src/services/voice/ttsSchema'
import { createVoiceRouter } from '../../../../src/routers/voice.router'
import { createTtsCapabilityInvoke } from '../../../../src/services/voice/ttsCapability'

const edge = vi.hoisted(() => ({ metadata: vi.fn(), stream: vi.fn(), close: vi.fn() }))
vi.mock('msedge-tts', () => ({
  MsEdgeTTS: class {
    setMetadata = edge.metadata
    toStream = edge.stream
    close = edge.close
  },
  OUTPUT_FORMAT: { AUDIO_24KHZ_96KBITRATE_MONO_MP3: 'mp3' },
}))
const audio = Buffer.from(playableAudio(Buffer.alloc(16), 'pcm', 24000).audio)
const audioResponse = () => new Response(audio, { headers: { 'Content-Type': 'audio/wav' } })
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function workspace(adapter: TtsAdapterId): TtsWorkspace {
  const value = createTtsWorkspace()
  const description = TTS_ADAPTERS.find((item) => item.id === adapter)!
  value.connections[0] = {
    id: 'edge',
    name: adapter,
    apiBase: description.apiBase || 'http://tts.example/v1',
    apiKey: 'secret-key',
    headers: {},
    timeoutMs: 1000,
  }
  value.profiles[0] = { id: 'edge', adapter }
  value.models[0]!.modelId = description.models[0] ?? 'custom-model'
  value.presets[0] = createTtsPreset('edge', 'edge', adapter)
  return value
}
async function service(config = createTtsWorkspace(), registry?: TtsAdapterRegistry) {
  let persisted = JSON.stringify(config)
  const store = {
    get: vi.fn(async () => persisted),
    set: vi.fn(async (_key: string, value: string) => {
      persisted = value
    }),
  }
  const instance = new TtsService(undefined, registry)
  await instance.loadWorkspace(store)
  return { instance, store }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('统一 TTS 调度与内置适配器', () => {
  it('Capability 使用信封角色并透传取消，不信任输入中的角色归属', async () => {
    const synthesize = vi.fn(async (_request: unknown) => ({
      audio: audio.buffer,
      mimeType: 'audio/wav',
    }))
    const controller = new AbortController()
    const invoke = createTtsCapabilityInvoke({ synthesize } as never)
    await invoke(
      {
        principalId: 'pero',
        payload: { operation: 'generate', input: { text: '你好', agentId: 'other-agent' } },
      } as never,
      controller.signal,
    )
    const request = synthesize.mock.calls[0]?.[0] as unknown as {
      agentId: string
      signal: AbortSignal
    }
    expect(request.agentId).toBe('pero')
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })
  it('参考音频上传、持久资源恢复与 MiMo 克隆请求形成闭环', async () => {
    const config = workspace('mimo')
    config.models[0]!.modelId = 'mimo-v2.5-tts-voiceclone'
    const { instance } = await service(config)
    const tempRoot = path.resolve(process.env.INFOS_TEST_TEMP_ROOT!)
    const root = await mkdtemp(path.join(tempRoot, 'tts-reference-'))
    const relative = path.relative(tempRoot, root)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('TEMP_PATH_INVALID')
    const records = new Map<string, unknown>()
    const repository = {
      save: async (asset: { assetId: string }, storageRef: string) => {
        records.set(asset.assetId, { asset, storageRef })
      },
      find: async (id: string) => records.get(id),
    }
    try {
      instance.configureReferences({
        root,
        authority: new AssetFileAuthority(),
        repository: repository as never,
      })
      const result = await instance.saveReference(
        new File([audio], '参考.wav', { type: 'audio/wav' }),
      )
      config.presets[0]!.referenceAssetId = result.assetId
      await instance.saveWorkspace(config)
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse({ choices: [{ message: { audio: { data: audio.toString('base64') } } }] }),
      )
      vi.stubGlobal('fetch', fetcher)
      await instance.synthesize({ text: '你好' })
      expect(JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).audio.voice).toBe(
        `data:audio/wav;base64,${audio.toString('base64')}`,
      )
      await expect(
        instance.saveReference(new File(['错误文本'], '假.wav', { type: 'audio/wav' })),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('Edge 通过相同注册入口发声并关闭连接，输入先进行 XML 转义', async () => {
    edge.metadata.mockResolvedValue(undefined)
    edge.stream.mockReturnValue({ audioStream: Readable.from([Buffer.from('ID3音频')]) })
    const { instance } = await service()
    const result = await instance.synthesize({ text: '你好 & <朋友>' })
    expect(result.mimeType).toBe('audio/mpeg')
    expect(edge.stream).toHaveBeenCalledWith(
      '你好 &amp; &lt;朋友&gt;',
      expect.objectContaining({ rate: '+25%' }),
    )
    expect(edge.close).toHaveBeenCalled()
  })
  it.each(['mimo', 'bailian', 'minimax', 'stepfun', 'openai'] as const)(
    '%s 使用各自请求和响应合同',
    async (adapter) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        adapter === 'mimo'
          ? jsonResponse({ choices: [{ message: { audio: { data: audio.toString('base64') } } }] })
          : adapter === 'minimax'
            ? jsonResponse({
                base_resp: { status_code: 0 },
                data: { audio: audio.toString('hex') },
              })
            : adapter === 'bailian'
              ? jsonResponse({ output: { audio: { url: 'https://download.example/result.wav' } } })
              : audioResponse(),
      )
      if (adapter === 'bailian')
        fetcher
          .mockResolvedValueOnce(
            jsonResponse({ output: { audio: { url: 'https://download.example/result.wav' } } }),
          )
          .mockResolvedValueOnce(audioResponse())
      vi.stubGlobal('fetch', fetcher)
      const config = workspace(adapter)
      if (adapter === 'mimo' || adapter === 'stepfun' || adapter === 'openai')
        config.presets[0]!.instructions = '温柔地说'
      const { instance } = await service(config)
      const result = await instance.synthesize({ text: '你好，（轻声）{{apiKey}}。' })
      expect(result.mimeType).toBe('audio/wav')
      const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
      const body = JSON.parse(String(options.body))
      expect(url.pathname).toContain(
        adapter === 'mimo'
          ? '/chat/completions'
          : adapter === 'bailian'
            ? '/multimodal-generation/generation'
            : adapter === 'minimax'
              ? '/t2a_v2'
              : '/audio/speech',
      )
      if (adapter === 'mimo')
        expect(body.messages).toEqual([
          { role: 'user', content: '温柔地说' },
          { role: 'assistant', content: '你好，（轻声）{{apiKey}}。' },
        ])
      if (adapter === 'stepfun') expect(body.instruction).toBe('温柔地说')
      if (adapter === 'openai') expect(body.instructions).toBe('温柔地说')
      if (adapter === 'minimax') expect(body.voice_setting.voice_id).toBe(config.presets[0]!.voice)
      if (adapter === 'bailian') expect(fetcher.mock.calls[1]?.[1]).not.toHaveProperty('headers')
    },
  )
  it('MiMo VoiceDesign 不传预置音色，缺少描述时明确失败', async () => {
    const config = workspace('mimo')
    config.models[0]!.modelId = 'mimo-v2.5-tts-voicedesign'
    const { instance } = await service(config)
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ choices: [{ message: { audio: { data: audio.toString('base64') } } }] }),
    )
    vi.stubGlobal('fetch', fetcher)
    await expect(instance.synthesize({ text: '你好' })).rejects.toThrow()
    config.presets[0]!.instructions = '清澈的女声'
    await instance.saveWorkspace(config)
    await instance.synthesize({ text: '你好' })
    const options = fetcher.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(options.body)).audio).not.toHaveProperty('voice')
  })
  it('MiMo 克隆仅从上传资源读取参考，不能缺省使用其他音色', async () => {
    const config = workspace('mimo')
    config.models[0]!.modelId = 'mimo-v2.5-tts-voiceclone'
    const { instance } = await service(config)
    await expect(instance.synthesize({ text: '你好' })).rejects.toThrow()
  })
  it('关闭时拒绝所有合成，未知 Provider 不回退 Edge', async () => {
    const config = createTtsWorkspace()
    config.enabled = false
    const { instance } = await service(config)
    expect(instance.isAvailable).toBe(false)
    await expect(instance.synthesize({ text: '你好' })).rejects.toThrow()
    config.enabled = true
    await instance.saveWorkspace(config)
    await expect(instance.synthesize({ text: '你好', provider: 'local' })).rejects.toThrow()
    expect(edge.stream).not.toHaveBeenCalled()
  })
  it('旧 OpenAI 配置保留模型、格式、速度和声音', () => {
    const instance = new TtsService({
      provider: 'openai',
      apiKey: 'old',
      voice: 'nova',
      speed: 1.4,
      format: 'opus',
    })
    expect(instance.getWorkspace().models[0]?.modelId).toBe('tts-1')
    expect(instance.getWorkspace().presets[0]).toMatchObject({
      voice: 'nova',
      speed: 1.4,
      format: 'opus',
    })
    instance.updateConfig({ voice: 'alloy' })
    expect(instance.getWorkspace().connections[0]?.apiKey).toBe('old')
    expect(instance.getWorkspace().presets[0]).not.toHaveProperty('apiKey')
  })
  it('角色绑定与全局默认分别解析，HTTP 路由传递 presetId 和 agentId', async () => {
    const config = workspace('stepfun')
    config.presets.push({ ...config.presets[0]!, id: 'agent-voice', voice: 'agent-speaker' })
    config.bindings.pero = 'agent-voice'
    const { instance } = await service(config)
    const fetcher = vi.fn<typeof fetch>(async () => audioResponse())
    vi.stubGlobal('fetch', fetcher)
    const router = createVoiceRouter({ ttsService: instance, asrService: {} as never })
    const result = await router.request('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好', agentId: 'pero' }),
    })
    expect(result.status).toBe(200)
    expect(JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).voice).toBe(
      'agent-speaker',
    )
    await instance.synthesize({ text: '你好' })
    expect(JSON.parse(String((fetcher.mock.calls[1]?.[1] as RequestInit).body)).voice).toBe(
      'zixinnansheng',
    )
  })
  it('配置保存失败保留旧快照且不通知热更新', async () => {
    const { instance, store } = await service()
    const changed = vi.fn()
    instance.onConfigChanged(changed)
    const config = instance.getWorkspace()
    config.enabled = false
    store.set.mockRejectedValueOnce(new Error('存储不可用'))
    await expect(instance.saveWorkspace(config)).rejects.toThrow('存储不可用')
    expect(instance.isAvailable).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  })
  it('排队请求固定原快照，取消排队不占用并发槽', async () => {
    const registry = new TtsAdapterRegistry()
    const finishes: Array<() => void> = []
    const received: string[] = []
    registry.register({
      id: 'edge_tts',
      synthesize: async (ctx) => {
        received.push(ctx.preset.voice)
        await new Promise<void>((resolve) => finishes.push(resolve))
        return { audio: audio.buffer as ArrayBuffer, mimeType: 'audio/wav' }
      },
    })
    const { instance } = await service(createTtsWorkspace(), registry)
    const first = instance.synthesize({ text: '一' })
    const second = instance.synthesize({ text: '二' })
    const controller = new AbortController()
    const cancelled = instance.synthesize({ text: '三', signal: controller.signal })
    const rejected = expect(cancelled).rejects.toThrow()
    const fourth = instance.synthesize({ text: '四' })
    await vi.waitFor(() => expect(received).toHaveLength(2))
    controller.abort()
    await rejected
    const next = instance.getWorkspace()
    next.presets[0]!.voice = 'changed'
    await instance.saveWorkspace(next)
    finishes.shift()!()
    await first
    await vi.waitFor(() => expect(received).toHaveLength(3))
    expect(received[2]).toBe('zh-CN-XiaoyiNeural')
    finishes.shift()!()
    finishes.shift()!()
    await Promise.all([second, fourth])
  })
  it('上游不响应时仍受统一超时控制', async () => {
    vi.useFakeTimers()
    const registry = new TtsAdapterRegistry()
    registry.register({ id: 'stepfun', synthesize: () => new Promise(() => undefined) })
    const { instance } = await service(workspace('stepfun'), registry)
    const result = expect(instance.synthesize({ text: '你好' })).rejects.toThrow(
      '语音合成已取消或超时',
    )
    await vi.advanceTimersByTimeAsync(1001)
    await result
  })
})

describe('自定义请求与返回字段', () => {
  const base: TtsHttpProfile = {
    path: '/tts/{{voice}}',
    method: 'POST',
    bodyType: 'json',
    body: { content: '{{text}}', speed: '{{speed}}' },
    response: { mode: 'json', encoding: 'base64', audioPath: 'result[0].sound', format: 'wav' },
  }
  const execute = (profile: TtsHttpProfile) =>
    executeTtsHttp({
      base: 'http://tts.example/v1',
      key: 'secret',
      headers: {},
      profile,
      variables: { text: '引号"与{{apiKey}}', speed: 1.25, voice: 'voice/a', apiKey: 'secret' },
      signal: new AbortController().signal,
    })
  it('按类型传值、路径编码，用户文本不递归执行插值', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ result: [{ sound: audio.toString('base64') }] }),
    )
    vi.stubGlobal('fetch', fetcher)
    await execute(base)
    const [url, request] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.pathname).toBe('/v1/tts/voice%2Fa')
    expect(JSON.parse(String(request.body))).toEqual({ content: '引号"与{{apiKey}}', speed: 1.25 })
    expect(renderTtsTemplate('{{speed}}', { speed: 1.25 })).toBe(1.25)
  })
  it('SSE 在任意字节边界和 CRLF 分界下正确拼接', async () => {
    const text = `data: {"audio":"${audio.subarray(0, 20).toString('base64')}"}\r\n\r\ndata: {"audio":"${audio.subarray(20).toString('base64')}"}\r\n\r\ndata: [DONE]\r\n\r\n`
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of Buffer.from(text)) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })),
    )
    const result = await execute({
      ...base,
      response: { mode: 'sse', encoding: 'base64', audioPath: 'audio', format: 'wav' },
    })
    expect(Buffer.from(result.audio)).toEqual(audio)
  })
  it('最终聚合音频使用 replace，避免末包重播', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            `data: {"audio":"${audio.toString('hex')}"}\n\ndata: {"audio":"${audio.toString('hex')}"}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    )
    const result = await execute({
      ...base,
      response: {
        mode: 'sse',
        encoding: 'hex',
        audioPath: 'audio',
        format: 'wav',
        chunkMode: 'replace',
      },
    })
    expect(result.audio.byteLength).toBe(audio.length)
  })
  it('已有音频后收到 SSE 错误事件时也不能交付半截结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            `data: {"audio":"${audio.toString('base64')}"}\n\nevent: error\ndata: {"message":"失败"}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    )
    await expect(
      execute({
        ...base,
        response: { mode: 'sse', encoding: 'base64', audioPath: 'audio', format: 'wav' },
      }),
    ).rejects.toThrow()
  })
  it('独立下载不带 API 密钥，且拒绝非 HTTP 地址', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/audio' }))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://cdn2.example/audio' } }),
      )
      .mockResolvedValueOnce(audioResponse())
    vi.stubGlobal('fetch', fetcher)
    await execute({
      ...base,
      response: { mode: 'json', encoding: 'url', audioPath: 'url', format: 'wav' },
    })
    expect(fetcher.mock.calls[1]?.[1]).not.toHaveProperty('headers')
    expect(fetcher.mock.calls[2]?.[1]).not.toHaveProperty('headers')
    fetcher.mockResolvedValueOnce(jsonResponse({ url: 'file:///secret' }))
    await expect(
      execute({
        ...base,
        response: { mode: 'json', encoding: 'url', audioPath: 'url', format: 'wav' },
      }),
    ).rejects.toThrow()
  })
  it('XML 指导文本按值转义；multipart 参考音频转成文件', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => audioResponse())
    vi.stubGlobal('fetch', fetcher)
    await execute({
      ...base,
      bodyType: 'xml',
      body: '<speak>{{text}}</speak>',
      response: { mode: 'binary', format: 'wav' },
    })
    expect(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).toContain('&quot;')
    await executeTtsHttp({
      base: 'http://tts.example',
      key: '',
      headers: {},
      profile: {
        ...base,
        path: '/tts',
        bodyType: 'multipart',
        body: { audio: '{{referenceAudio}}' },
        response: { mode: 'binary', format: 'wav' },
      },
      variables: { referenceAudio: `data:audio/wav;base64,${audio.toString('base64')}` },
      signal: new AbortController().signal,
    })
    const body = (fetcher.mock.calls[1]?.[1] as RequestInit).body as FormData
    expect(body.get('audio')).toBeInstanceOf(File)
  })
  it('HTTP 200 的业务错误、非法 Base64、伪音频均明确失败', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ status: 9, result: [{ sound: audio.toString('base64') }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ result: [{ sound: '###' }] }))
      .mockResolvedValueOnce(jsonResponse({ message: '错误' }))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      execute({ ...base, response: { ...base.response, successPath: 'status', successValue: 0 } }),
    ).rejects.toThrow()
    await expect(execute(base)).rejects.toThrow()
    await expect(
      execute({ ...base, response: { mode: 'binary', format: 'mp3' } }),
    ).rejects.toThrow()
  })
  it('PCM 转换成带真实采样率的 WAV', () => {
    const result = playableAudio(Buffer.alloc(20), 'pcm', 16000)
    expect(result.mimeType).toBe('audio/wav')
    expect(Buffer.from(result.audio).readUInt32LE(24)).toBe(16000)
  })
  it('保存时拒绝断裂引用、原型路径和不完整自定义合同', () => {
    const config = workspace('custom')
    expect(() => parseTtsWorkspace(config)).toThrow()
    config.profiles[0]!.custom = base
    expect(() => parseTtsWorkspace(config)).not.toThrow()
    config.bindings.agent = 'missing'
    expect(() => parseTtsWorkspace(config)).toThrow()
    delete config.bindings.agent
    config.presets[0]!.extra = JSON.parse('{"__proto__":{}}')
    expect(() => parseTtsWorkspace(config)).toThrow()
  })
})
