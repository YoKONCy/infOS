// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createTtsWorkspace } from '@infos/shared'
import TtsSettings from '@infos/frontend/components/voice/TtsSettings.vue'

const api = vi.hoisted(() => ({
  getTtsConfig: vi.fn(),
  saveTtsConfig: vi.fn(),
  synthesize: vi.fn(),
  uploadTtsReference: vi.fn(),
}))
vi.mock('@infos/frontend/api/modules/voiceApi', () => ({ voiceApi: api }))
vi.mock('@infos/frontend/composables/dashboard', () => ({
  useDashboardContext: () => ({ activeAgentId: { value: 'pero' }, refreshKey: { value: 0 } }),
}))
const wrappers: ReturnType<typeof mount>[] = []
const stubs = {
  PCard: { template: '<section><slot /></section>' },
  PButton: { template: '<button><slot /></button>' },
  PInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  PSelect: {
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in options" :key="item.value" :value="item.value">{{ item.label }}</option></select>',
  },
  PSwitch: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
  PixelIcon: true,
}
async function setup() {
  api.getTtsConfig.mockResolvedValue({ data: createTtsWorkspace() })
  api.saveTtsConfig.mockImplementation(async (config) => ({
    data: JSON.parse(JSON.stringify(config)),
  }))
  const wrapper = mount(TtsSettings, { global: { stubs } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
function button(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((item) => item.text() === text)!
}
afterEach(() => {
  wrappers.splice(0).forEach((item) => item.unmount())
  vi.resetAllMocks()
})

describe('语音预设配置闭环', () => {
  it('加载不自动写入；新增 MiMo、设置默认与角色绑定作为一次配置保存', async () => {
    const wrapper = await setup()
    expect(api.saveTtsConfig).not.toHaveBeenCalled()
    await wrapper.find('aside select').setValue('mimo')
    expect(wrapper.text()).toContain('MiMo V2.5')
    await button(wrapper, '设为默认').trigger('click')
    const currentPreset = wrapper.findAll('select').at(-1)!
    const id = currentPreset.findAll('option').at(-1)!.attributes('value')!
    await currentPreset.setValue(id)
    await button(wrapper, '保存配置').trigger('click')
    await flushPromises()
    const saved = api.saveTtsConfig.mock.calls[0]![0]
    expect(saved.defaultPresetId).toBe(id)
    expect(saved.bindings.pero).toBe(id)
    expect(saved.profiles.find((item: { id: string }) => item.id === id).adapter).toBe('mimo')
  })
  it('MiMo 克隆使用上传资源 ID，上传过程不写入客户端路径', async () => {
    const wrapper = await setup()
    await wrapper.find('aside select').setValue('mimo')
    const model = wrapper.find('input[list]')
    await model.setValue('mimo-v2.5-tts-voiceclone')
    const file = new File(['RIFF'], '参考.wav', { type: 'audio/wav' })
    api.uploadTtsReference.mockResolvedValue({
      assetId: '29a65902-23b0-4ce9-a274-b013fdf46fb2',
      name: '参考.wav',
    })
    const picker = wrapper.get('input[type="file"]')
    Object.defineProperty(picker.element, 'files', { value: [file], configurable: true })
    await picker.trigger('change')
    await flushPromises()
    await button(wrapper, '保存配置').trigger('click')
    await flushPromises()
    const saved = api.saveTtsConfig.mock.calls[0]![0]
    expect(saved.presets.at(-1).referenceAssetId).toBe('29a65902-23b0-4ce9-a274-b013fdf46fb2')
    expect(JSON.stringify(saved)).not.toContain('参考.wav')
    expect(api.uploadTtsReference).toHaveBeenCalledWith(file)
  })
  it('自定义字段 JSON 错误阻止保存和试听', async () => {
    const wrapper = await setup()
    await wrapper.find('aside select').setValue('custom')
    await wrapper.get('textarea[aria-label="自定义协议配置"]').setValue('{invalid')
    await button(wrapper, '保存并试听').trigger('click')
    await flushPromises()
    expect(api.saveTtsConfig).not.toHaveBeenCalled()
    expect(api.synthesize).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('JSON 格式无效')
  })
  it('先保存再合成选中预设，离开组件取消未完成试听', async () => {
    const wrapper = await setup()
    api.synthesize.mockImplementation(() => new Promise(() => undefined))
    await button(wrapper, '保存并试听').trigger('click')
    await flushPromises()
    const call = api.synthesize.mock.calls[0]!
    expect(api.saveTtsConfig).toHaveBeenCalledOnce()
    expect(call[0].presetId).toBe('edge')
    wrapper.unmount()
    expect(call[1].aborted).toBe(true)
  })
  it('切换服务立即更新右侧，返回时保留配置，不重复创建、不自动保存或合成', async () => {
    const wrapper = await setup()
    expect((wrapper.get('aside select').element as HTMLSelectElement).value).toBe('edge_tts')
    await wrapper.get('aside select').setValue('minimax')
    expect(wrapper.get('.tts-brand-title').text()).toBe('MiniMax')
    expect((wrapper.get('input[list]').element as HTMLInputElement).value).toBe('speech-2.8-hd')
    const key = wrapper
      .findAll('label')
      .find((item) => item.text() === 'API Key')!
      .get('input')
    await key.setValue('minimax-key')
    await wrapper.get('aside select').setValue('mimo')
    expect(wrapper.get('.tts-brand-title').text()).toBe('MiMo V2.5')
    await wrapper.get('aside select').setValue('edge_tts')
    expect(wrapper.get('.tts-brand-title').text()).toBe('Edge TTS')
    expect(wrapper.find('input[list]').exists()).toBe(false)
    await wrapper.get('aside select').setValue('minimax')
    expect(wrapper.findAll('.tts-list button')).toHaveLength(1)
    expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe(
      'minimax-key',
    )
    expect(api.saveTtsConfig).not.toHaveBeenCalled()
    expect(api.synthesize).not.toHaveBeenCalled()
    await button(wrapper, '保存配置').trigger('click')
    await flushPromises()
    expect(api.saveTtsConfig.mock.calls[0]![0].presets).toHaveLength(3)
    expect(api.saveTtsConfig.mock.calls[0]![0].defaultPresetId).toBe('edge')
  })
  it('同类多预设可切换，跨服务返回打开上次选中的预设', async () => {
    const wrapper = await setup()
    await wrapper.get('aside select').setValue('minimax')
    const first = wrapper.findAll('.tts-list button')[0]!
    await button(wrapper, '添加预设').trigger('click')
    expect(wrapper.findAll('.tts-list button')).toHaveLength(2)
    await wrapper.get('input[type="password"]').setValue('second-key')
    await first.trigger('click')
    expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('')
    await wrapper.findAll('.tts-list button')[1]!.trigger('click')
    await wrapper.get('aside select').setValue('edge_tts')
    await wrapper.get('aside select').setValue('minimax')
    expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe(
      'second-key',
    )
    expect(wrapper.findAll('.tts-list button')[1]!.attributes('aria-pressed')).toBe('true')
  })
  it('服务切换取消旧试听，旧请求晚到失败不能打断新的试听', async () => {
    const wrapper = await setup()
    let rejectOld!: (error: Error) => void
    api.synthesize.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOld = reject
        }),
    )
    await button(wrapper, '保存并试听').trigger('click')
    await flushPromises()
    const oldSignal = api.synthesize.mock.calls[0]![1] as AbortSignal
    await wrapper.get('aside select').setValue('minimax')
    expect(oldSignal.aborted).toBe(true)
    api.synthesize.mockImplementationOnce(() => new Promise(() => undefined))
    await button(wrapper, '保存并试听').trigger('click')
    await flushPromises()
    const nextSignal = api.synthesize.mock.calls[1]![1] as AbortSignal
    rejectOld(new Error('旧请求失败'))
    await flushPromises()
    expect(nextSignal.aborted).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
})
