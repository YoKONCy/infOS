import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectAudio, nativeAudioEnabled, nativeAudioMime } from '@infos/shared'
import { GeminiProvider } from '@infos/backend/services/llm/providers/geminiProvider'
import { LlmService } from '@infos/backend/services/llm/llmService'
import { estimateInputPayloadTokens } from '@infos/backend/services/llm/inputTokens'
import { persistentWorkMessage } from '@infos/backend/services/context/workContext'
import { auditModelRequestMessages } from '@infos/backend/services/prompt/requestCompiler'
import type { ChatMessage } from '@infos/backend/services/llm/types'
import { AppError } from '@infos/backend/lib/appError'

function wave(seconds = 1) {
  const result = Buffer.alloc(44 + 48000 * seconds)
  result.write('RIFF')
  result.writeUInt32LE(result.length - 8, 4)
  result.write('WAVEfmt ', 8)
  result.writeUInt32LE(16, 16)
  result.writeUInt16LE(1, 20)
  result.writeUInt16LE(1, 22)
  result.writeUInt32LE(24000, 24)
  result.writeUInt32LE(48000, 28)
  result.writeUInt16LE(2, 32)
  result.writeUInt16LE(16, 34)
  result.write('data', 36)
  result.writeUInt32LE(result.length - 44, 40)
  return result
}
const bytes = wave()
const messages: ChatMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: '听一听这段原音' },
      {
        type: 'input_audio',
        input_audio: {
          data: bytes.toString('base64'),
          format: 'wav',
          mimeType: 'audio/wav',
          durationMs: 1000,
        },
      },
    ],
  },
]
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Gemini 原生音频兼容层', () => {
  it('只通过手动音频开关和连接协议判断，不按模型名称自动开启', () => {
    expect(nativeAudioEnabled({ provider: 'gemini', modelId: 'any' } as never)).toBe(false)
    expect(
      nativeAudioEnabled({ provider: 'custom', protocol: 'gemini', enableAudioInput: true }),
    ).toBe(true)
    expect(nativeAudioEnabled({ provider: 'openai', enableAudioInput: true })).toBe(false)
    expect(nativeAudioMime('audio/x-wav;codec=pcm')).toBe('audio/wav')
    expect(nativeAudioMime('audio/mp4')).toBe('audio/m4a')
  })
  it('元信息来自真实 WAV 数据，伪装的后缀不会被识别为有效音频', () => {
    expect(inspectAudio(bytes, 'application/octet-stream', 'record.wav')).toEqual({
      mimeType: 'audio/wav',
      sampleRate: 24000,
      channels: 1,
      durationMs: 1000,
    })
    expect(inspectAudio(Buffer.from('不是音频的假 WAV 文件'), 'audio/wav', 'fake.wav')).toBeNull()
    const truncated = bytes.subarray(0, 46)
    expect(inspectAudio(truncated, 'audio/wav')).toBeNull()
  })
  it('原音、文本和工具回合一起通过自定义 Gemini 基址完整发送', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: '已听取原音' }] } }] }),
        ),
      )
    vi.stubGlobal('fetch', fetch)
    const provider = new GeminiProvider({
      apiBase: 'https://proxy.example/gemini/v1beta',
      apiKey: 'test',
      modelId: 'custom-gemini',
    })
    const history: ChatMessage[] = [
      ...messages,
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', content: '工具结果', toolCallId: 'call', name: 'read_file' },
    ]
    await provider.chat(history, {})
    expect(fetch.mock.calls[0]![0]).toContain(
      'proxy.example/gemini/v1beta/models/custom-gemini:generateContent',
    )
    const body = JSON.parse(fetch.mock.calls[0]![1].body)
    expect(body.contents[0].parts[1]).toEqual({
      inlineData: { mimeType: 'audio/wav', data: bytes.toString('base64') },
    })
    expect(JSON.stringify(body)).toContain('工具结果')
    expect(JSON.stringify(body)).not.toContain('durationMs')
  })
  it('不支持的格式明确报错，音频不再静默丢弃', () => {
    const provider = new GeminiProvider({ apiKey: '', modelId: 'gemini', apiBase: 'https://test' })
    expect(() =>
      provider.getInputTokenPayload(
        [
          {
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: 'YWJj', format: 'exe' } }],
          },
        ],
        {},
      ),
    ).toThrow()
  })
  it('主模型未开启音频时不发出请求，也不自动改走其他协议', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      new LlmService().chat(
        { provider: 'gemini', apiKey: '', modelId: 'gemini', enableAudioInput: false },
        messages,
      ),
    ).rejects.toThrow('手动开启')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('携带原音时回退链只尝试手动开启音频的 Gemini 连接', async () => {
    const service = new LlmService()
    const create = vi.spyOn(service, 'createProvider').mockImplementation(
      (config) =>
        ({
          chat: async () => {
            if (config.modelId === 'primary')
              throw new AppError('LLM_ERROR', { message: '无效模型', data: { retryable: false } })
            return {
              choices: [
                { message: { role: 'assistant', content: '已听取原音' }, finishReason: 'stop' },
              ],
            }
          },
        }) as never,
    )
    await service.chat(
      {
        provider: 'gemini',
        modelId: 'primary',
        apiKey: '',
        enableAudioInput: true,
        fallbackModels: [
          { provider: 'openai', modelId: 'wrong-protocol', apiKey: '', enableAudioInput: true },
          { provider: 'gemini', modelId: 'disabled-audio', apiKey: '', enableAudioInput: false },
          {
            provider: 'custom',
            protocol: 'gemini',
            modelId: 'compatible',
            apiKey: '',
            enableAudioInput: true,
          },
        ],
      },
      messages,
    )
    expect(create.mock.calls.map(([config]) => config.modelId)).toEqual([
      'primary',
      'primary',
      'compatible',
    ])
  })
  it('多段原音合计超限在请求前拒绝', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const data = Buffer.alloc(7 * 1024 * 1024).toString('base64')
    const content = [0, 1].map(() => ({
      type: 'input_audio' as const,
      input_audio: { format: 'wav', data },
    }))
    await expect(
      new LlmService().chat(
        { provider: 'gemini', modelId: 'gemini', apiKey: '', enableAudioInput: true },
        [{ role: 'user', content }],
      ),
    ).rejects.toThrow('12MB')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('音频预算按时长计入；历史工作副本和审计不重复保存媒体字节', () => {
    const provider = new GeminiProvider({ apiKey: '', modelId: 'gemini', apiBase: 'https://test' })
    const short = estimateInputPayloadTokens(provider.getInputTokenPayload(messages, {}))
    const long = estimateInputPayloadTokens(
      provider.getInputTokenPayload(
        [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { format: 'wav', data: wave(10).toString('base64') },
              },
            ],
          },
        ],
        {},
      ),
    )
    expect(long).toBeGreaterThan(short + 200)
    expect(JSON.stringify(auditModelRequestMessages(messages))).not.toContain(
      bytes.toString('base64'),
    )
    expect(JSON.stringify(persistentWorkMessage(messages[0]!))).not.toContain(
      bytes.toString('base64'),
    )
  })
})
