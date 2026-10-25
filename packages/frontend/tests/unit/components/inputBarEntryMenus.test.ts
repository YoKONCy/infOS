// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import InputBar from '../../../src/components/chat/InputBar.vue'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  upload: vi.fn(),
  recognize: vi.fn(),
  getTools: vi.fn(),
  remove: vi.fn(),
  getModelSettings: vi.fn(),
  getVoiceStatus: vi.fn(),
  wave: vi.fn(),
  capture: undefined as any,
  onAudio: undefined as any,
  thread: {} as Record<string, unknown>,
  agent: {} as Record<string, unknown>,
}))
vi.mock('../../../src/lib/recordingAudio', () => ({ recordingWave: mocks.wave }))
vi.mock('../../../src/composables/audio/useAudioCapture', async () => {
  const { ref } = await import('vue')
  return {
    useAudioCapture: (onAudio: any) => {
      let controller = new AbortController()
      mocks.onAudio = onAudio
      const capture = {
        isRecording: ref(false),
        recognizing: ref(false),
        preparing: ref(false),
        audioLevel: ref(0.1),
        elapsedMs: ref(1500),
        error: ref(''),
        setMode: vi.fn(async (mode: string) => {
          controller.abort()
          controller = new AbortController()
          capture.isRecording.value = false
          capture.recognizing.value = false
          capture.error.value = ''
          if (mode === 'off') controller.abort()
        }),
        pttDown: vi.fn(() => {
          capture.isRecording.value = true
        }),
        pttUp: vi.fn(async () => {
          capture.isRecording.value = false
          capture.recognizing.value = true
          try {
            await onAudio({ audio: new ArrayBuffer(12), mimeType: 'audio/webm' }, controller.signal)
          } finally {
            capture.recognizing.value = false
          }
        }),
      }
      mocks.capture = capture
      return capture
    },
  }
})
vi.mock('../../../src/stores', () => ({
  useAgentStore: () => mocks.agent,
  useThreadStore: () => mocks.thread,
  useNotificationStore: () => ({ toast: mocks.toast }),
}))
vi.mock('../../../src/api/modules/attachmentsApi', () => ({
  attachmentsApi: {
    capabilities: async () => ({ data: { pdf: true, maxPdfBytes: 10_000_000 } }),
    upload: mocks.upload,
    removeUnbound: mocks.remove,
  },
}))
vi.mock('../../../src/api/modules/configApi', () => ({
  configApi: {
    get: async () => ({ data: { value: '1' } }),
    batch: async () => ({ data: {} }),
  },
}))
vi.mock('../../../src/api/modules/modelApi', () => ({
  modelApi: {
    getById: async () => ({ data: { enableVision: true, enableAudioInput: true } }),
  },
}))
vi.mock('../../../src/api/modules/voiceApi', () => ({
  voiceApi: {
    getStatus: mocks.getVoiceStatus,
    recognize: mocks.recognize,
  },
}))
vi.mock('../../../src/api/modules/threadsApi', () => ({
  threadsApi: {
    getTools: mocks.getTools,
    getModelSettings: mocks.getModelSettings,
    previewTokenBudget: async () => ({ data: null }),
  },
}))

let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  })
  mocks.getModelSettings.mockResolvedValue({
    data: {
      effective: { enableVision: true, enableAudioInput: false, nativeAudioAvailable: false },
    },
  })
  mocks.getVoiceStatus.mockResolvedValue({ data: { asr: { available: false } } })
  mocks.wave.mockResolvedValue(new ArrayBuffer(48))
  mocks.remove.mockResolvedValue(undefined)
  mocks.upload.mockImplementation(async (file: File, threadId: string) => ({
    data: {
      id: `upload:${file.name}`,
      threadId,
      messageId: null,
      kind: file.type.startsWith('audio/') ? 'audio' : 'file',
      originalName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      status: 'uploaded',
      contextPolicy: 'once',
      contextMode: file.type.startsWith('audio/') ? 'inline' : 'reference',
    },
  }))
  mocks.getTools.mockResolvedValue({
    data: { tools: [], disabledTools: [], interactionMode: 'chat', executionMode: 'manual' },
  })
  mocks.thread = reactive({
    threadId: 'thread',
    agentId: 'pero',
    interactionMode: 'chat',
    executionMode: 'manual',
    isGenerating: false,
    isLoadingHistory: false,
    liveContextBudget: null,
  })
  mocks.agent = reactive({
    activeAgentId: 'pero',
    agents: [],
    currentAgent: { id: 'pero', name: 'Pero' },
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function input(compact = false) {
  wrapper = mount(InputBar, {
    props: { compact },
    attachTo: document.body,
    global: {
      stubs: {
        PixelIcon: true,
        ThreadModelControls: true,
        RuntimeDebugToggle: true,
        ResourceAudioPlayer: true,
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('输入栏合并入口', () => {
  it('工具视窗自动分区、聚合同包，搜索时保持相对顺序', async () => {
    const item = (name: string, packageId?: string, enabled = true, locked = false) => ({
      name,
      label: name,
      description: '功能',
      packageId,
      enabled,
      userEnabled: enabled,
      modeAllowed: true,
      locked,
    })
    mocks.getTools.mockResolvedValue({
      data: {
        tools: [
          item('write_file', 'files'),
          item('z_disabled', 'files', false),
          item('finish_task', undefined, true, true),
          item('get_system_info'),
          item('read_file', 'files'),
          item('ask_user', undefined, true, true),
          item('get_file_info', 'files'),
        ],
        disabledTools: ['z_disabled'],
        interactionMode: 'work',
        executionMode: 'manual',
      },
    })
    const view = await input()
    await view.get('button[title="管理本会话可用工具"]').trigger('click')
    await flushPromises()
    const labels = () => view.findAll('.tool-manager__meta > strong').map((label) => label.text())
    expect(labels()).toEqual([
      'ask_user',
      'finish_task',
      'get_file_info',
      'read_file',
      'write_file',
      'get_system_info',
      'z_disabled',
    ])
    await view.get('.tool-manager__search input').setValue('file')
    expect(labels()).toEqual(['get_file_info', 'read_file', 'write_file'])
  })

  it('所有文件共用一个不限制类型的多选选择器', async () => {
    const view = await input()
    const files = view.findAll('input[type="file"]')
    expect(files).toHaveLength(1)
    expect(files[0]!.attributes('accept')).toBeUndefined()
    expect(files[0]!.attributes('multiple')).toBeDefined()
    expect(view.text()).not.toContain('添加图片')
    const click = vi.spyOn(files[0]!.element as HTMLInputElement, 'click')
    await view.get('button[title="添加文件"]').trigger('click')
    expect(click).toHaveBeenCalledOnce()
  })
  it('选择、拖入和粘贴未知文件都进入同一上传流程', async () => {
    const view = await input()
    const files = [
      new File(['zip'], '资源.zip', { type: 'application/zip' }),
      new File(['bin'], '数据.custom'),
      new File(['text'], '样本.unknown'),
    ]
    Object.defineProperty(view.get('input[type="file"]').element, 'files', {
      configurable: true,
      value: [files[0]],
    })
    await view.get('input[type="file"]').trigger('change')
    await flushPromises()
    await view
      .get('.deck')
      .trigger('drop', { dataTransfer: { types: ['Files'], files: [files[1]], items: [] } })
    await flushPromises()
    await view.get('textarea').trigger('paste', { clipboardData: { files: [files[2]] } })
    await flushPromises()
    expect(mocks.upload.mock.calls.map((call) => call[0])).toEqual(files)
    for (const call of mocks.upload.mock.calls)
      expect(call.slice(1)).toEqual(['thread', { referenceOnly: true }])
    expect(view.findAll('.attachment-card')).toHaveLength(3)
    expect(view.text()).toContain('已保存原件，可按需读取')
  })
  it('拖入批次排队期间切换会话，旧上传清理且剩余文件不进入新会话', async () => {
    let finish!: (value: unknown) => void
    mocks.upload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const view = await input()
    await view.get('.deck').trigger('drop', {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['1'], 'first.bin'), new File(['2'], 'second.bin')],
        items: [],
      },
    })
    await flushPromises()
    mocks.thread.threadId = 'other'
    await flushPromises()
    finish({
      data: {
        id: 'old-upload',
        threadId: 'thread',
        messageId: null,
        kind: 'file',
        status: 'uploaded',
      },
    })
    await flushPromises()
    expect(mocks.upload).toHaveBeenCalledOnce()
    expect(mocks.remove).toHaveBeenCalledWith('old-upload')
    expect(view.findAll('.attachment-card')).toHaveLength(0)
  })

  it('模型卡片未开启音频时禁用原音入口', async () => {
    const view = await input()
    await view.get('button[aria-label="图片与语音输入"]').trigger('click')
    await flushPromises()
    const menu = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="图片与语音输入"]',
    )!
    expect(menu.textContent).toContain('语音转写')
    expect(menu.textContent).toContain('原生音频')
    expect((menu.querySelector('[data-audio-input="native"]') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(menu.textContent).toContain('请在 Gemini 模型卡片中手动开启音频输入')
    expect(mocks.capture.pttDown).not.toHaveBeenCalled()
    expect(mocks.recognize).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(view.find('.audio-hud').exists()).toBe(false)
  })

  it('转写入口仍执行既有能力校验', async () => {
    const view = await input()
    await view.get('button[aria-label="图片与语音输入"]').trigger('click')
    await flushPromises()
    ;(document.querySelector('[data-audio-input="asr"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(view.get('.audio-hud').text()).toContain('语音转文字服务尚未启用')
    expect(mocks.capture.pttDown).not.toHaveBeenCalled()
  })

  it('原音录制停止后转换并上传为可试听草稿，不自动发送', async () => {
    mocks.getModelSettings.mockResolvedValue({
      data: {
        effective: { enableVision: true, enableAudioInput: true, nativeAudioAvailable: true },
      },
    })
    const view = await input()
    await view.get('.record-btn').trigger('click')
    await flushPromises()
    expect(mocks.capture.pttDown).toHaveBeenCalledOnce()
    expect(view.get('.audio-hud').text()).toContain('正在录音')
    await view.get('.audio-hud__stop').trigger('click')
    await flushPromises()
    expect(mocks.wave).toHaveBeenCalledOnce()
    expect(mocks.upload).toHaveBeenCalledOnce()
    const [file, thread, options] = mocks.upload.mock.calls[0]!
    expect(file.type).toBe('audio/wav')
    expect(file.name).toMatch(/\.wav$/)
    expect(thread).toBe('thread')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(view.find('.attachment-card--audio').exists()).toBe(true)
    expect(view.text()).toContain('Gemini 将直接听取原音')
    expect(mocks.recognize).not.toHaveBeenCalled()
    expect(view.emitted('send')).toBeUndefined()
  })

  it('切换会话中止尚未完成的转写，旧结果不进入新输入框', async () => {
    mocks.getVoiceStatus.mockResolvedValue({ data: { asr: { available: true } } })
    let resolve!: (value: unknown) => void
    mocks.recognize.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const view = await input()
    await view.get('button[aria-label="图片与语音输入"]').trigger('click')
    await flushPromises()
    ;(document.querySelector('[data-audio-input="asr"]') as HTMLButtonElement).click()
    await flushPromises()
    await view.get('.audio-hud__stop').trigger('click')
    await flushPromises()
    const signal = mocks.recognize.mock.calls[0]![2] as AbortSignal
    mocks.thread.threadId = 'other'
    await flushPromises()
    expect(signal.aborted).toBe(true)
    resolve({ text: '旧会话的转写' })
    await flushPromises()
    expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('')
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('新会话的录音按钮在创建会话后按实际能力使用已有 ASR', async () => {
    mocks.thread.threadId = ''
    mocks.thread.createNewThread = vi.fn(async () => {
      mocks.thread.threadId = 'new-thread'
    })
    mocks.getVoiceStatus.mockResolvedValue({ data: { asr: { available: true } } })
    mocks.recognize.mockResolvedValue({ text: '可编辑的语音文字' })
    const view = await input()
    await view.get('.record-btn').trigger('click')
    await flushPromises()
    expect(mocks.capture.pttDown).toHaveBeenCalledOnce()
    await view.get('.audio-hud__stop').trigger('click')
    await flushPromises()
    expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('可编辑的语音文字')
    expect(mocks.wave).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('窄工作区弹层挂载在 body，Escape 和 Thread 切换均会收起', async () => {
    const view = await input(true)
    const toggle = view.get('button[aria-label="图片与语音输入"]')
    await toggle.trigger('click')
    await flushPromises()
    const menu = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="图片与语音输入"]',
    )!
    expect(view.element.contains(menu)).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(menu.style.display).toBe('none')
    await toggle.trigger('click')
    await flushPromises()
    mocks.thread.threadId = 'another-thread'
    await flushPromises()
    expect(menu.style.display).toBe('none')
  })
})
