// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { ThreadModelSettings } from '@infos/shared'
import { reasoningEffortOptions, normalizeReasoningEffort } from '@infos/shared'
import ThreadModelControls from '../../../src/components/chat/ThreadModelControls.vue'
import { setLocale } from '@infos/shared/i18n'

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), toast: vi.fn() }))
vi.mock('../../../src/api/modules/threadsApi', () => ({
  threadsApi: { getModelSettings: mocks.get, updateModelSettings: mocks.update },
}))
vi.mock('../../../src/stores/useNotificationStore', () => ({
  useNotificationStore: () => ({ toast: mocks.toast }),
}))
const wrappers: VueWrapper[] = []
const settings = (
  threadId: string,
  effort: ThreadModelSettings['reasoningEffort'] = null,
): ThreadModelSettings => ({
  threadId,
  modelConfigId: null,
  reasoningEffort: effort,
  effective: {
    name: '主用',
    modelId: 'gpt-test',
    reasoningEffort: effort ?? 'low',
    enableVision: false,
    enableAudioInput: false,
  },
  models: [{ id: 2, name: '备用', modelId: 'claude-test', reasoningEffort: 'medium' }],
})
async function setup(modelId = 'gpt-test') {
  mocks.get.mockImplementation(async (id: string) => {
    const value = settings(id)
    value.effective.modelId = modelId
    return { data: value }
  })
  const wrapper = mount(ThreadModelControls, {
    attachTo: document.body,
    props: { threadId: 'a' },
    global: { stubs: { BrandIcon: true, PixelIcon: true } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
  vi.clearAllMocks()
  setLocale('zh-CN')
})

describe('输入栏会话模型快捷配置', () => {
  it('跟随时展示实际档位，选择极致后同步图形与标签并仍发送标准档位值', async () => {
    const wrapper = await setup()
    const trigger = wrapper.get('button[aria-label="本会话思考强度"]')
    expect(trigger.text()).toContain('跟随')
    expect(trigger.text()).toContain('轻量')
    expect(trigger.find('[data-effort-glyph="low"]').exists()).toBe(true)
    await trigger.trigger('click')
    await flushPromises()
    const inherit = document.querySelector<HTMLButtonElement>('[data-effort-value=""]')!
    expect(inherit.textContent).toContain('当前生效：轻量')
    expect(inherit.getAttribute('aria-pressed')).toBe('true')
    const max = document.querySelector<HTMLButtonElement>('[data-effort-value="max"]')!
    expect(max.textContent).toContain('极致')
    expect(max.querySelector('[data-effort-glyph="max"]')).not.toBeNull()
    expect(max.querySelectorAll('rect.is-lit')).toHaveLength(5)
    expect(
      document.querySelector('[data-effort-value="low"]')!.querySelectorAll('rect.is-lit'),
    ).toHaveLength(1)
    expect(
      document
        .querySelector('[data-effort-value="off"]')!
        .querySelector('[data-effort-glyph="off"]'),
    ).not.toBeNull()
    mocks.update.mockResolvedValue({ data: settings('a', 'max') })
    max.click()
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith('a', { modelConfigId: null, reasoningEffort: 'max' })
    expect(trigger.text()).toContain('极致')
    expect(trigger.text()).not.toContain('跟随')
    expect(trigger.find('[data-effort-glyph="max"]').exists()).toBe(true)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('按模型支持范围显示档位，切换语言后同步用途说明与生效摘要', async () => {
    const wrapper = await setup('gemini-4-argon')
    const trigger = wrapper.get('button[aria-label="本会话思考强度"]')
    await trigger.trigger('click')
    await flushPromises()
    expect(
      [...document.querySelectorAll('[data-effort-value]')].map((row) =>
        row.getAttribute('data-effort-value'),
      ),
    ).toEqual(['', 'low', 'medium', 'high'])
    setLocale('en-US')
    await flushPromises()
    expect(trigger.text()).toContain('Inherit')
    expect(trigger.text()).toContain('Light')
    expect(document.querySelector('[data-effort-value=""]')!.textContent).toContain(
      'Currently effective: Light',
    )
    expect(document.querySelector('[data-effort-value="medium"]')!.textContent).toContain(
      'Moderate reasoning',
    )
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('保存当前会话模型，强度随有效配置增强', async () => {
    const wrapper = await setup()
    mocks.update.mockResolvedValue({ data: { ...settings('a', 'max'), modelConfigId: 2 } })
    await wrapper.get('button[aria-label="本会话模型"]').trigger('click')
    document.querySelector<HTMLButtonElement>('[data-model-value="2"]')!.click()
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith('a', { modelConfigId: 2, reasoningEffort: null })
    expect(wrapper.get('.thread-model-controls').attributes('data-effort')).toBe('5')
    expect(wrapper.emitted('busy')).toContainEqual([true])
  })

  it('旧会话的迟到响应不会覆盖新会话', async () => {
    const wrapper = await setup()
    let finish!: (value: { data: ThreadModelSettings }) => void
    mocks.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await wrapper.get('button[aria-label="本会话思考强度"]').trigger('click')
    document.querySelector<HTMLButtonElement>('[data-effort-value="max"]')!.click()
    await wrapper.setProps({ threadId: 'b' })
    await flushPromises()
    finish({ data: settings('a', 'max') })
    await flushPromises()
    expect(wrapper.emitted('changed')?.at(-1)?.[0]).toMatchObject({ threadId: 'b' })
    expect(wrapper.get('.thread-model-controls').attributes('data-effort')).toBe('1')
  })

  it('与模型设置页共用档位，Gemini 4 自动校正旧强度', () => {
    expect(reasoningEffortOptions('gpt-test').map((item) => item.value)).toEqual([
      '',
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(reasoningEffortOptions('[渠道]gemini-4-argon').map((item) => item.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
    ])
    expect(normalizeReasoningEffort('gemini-4-argon', 'max')).toBe('high')
    expect(normalizeReasoningEffort('gemini-4-argon', 'off')).toBe('low')
  })

  it('菜单互斥，支持键盘打开、选中项聚焦与 Escape 收起', async () => {
    const wrapper = await setup()
    const model = wrapper.get('button[aria-label="本会话模型"]')
    const effort = wrapper.get('button[aria-label="本会话思考强度"]')
    await model.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(model.attributes('aria-expanded')).toBe('true')
    expect(document.activeElement?.getAttribute('data-model-value')).toBe('')
    expect(document.querySelector('[data-model-value="2"]')?.textContent).toContain('claude-test')
    await effort.trigger('click')
    await flushPromises()
    expect(model.attributes('aria-expanded')).toBe('false')
    expect(effort.attributes('aria-expanded')).toBe('true')
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await flushPromises()
    expect(effort.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(effort.element)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('禁用和切换会话时收起菜单，禁用期间无法重新展开', async () => {
    const wrapper = await setup()
    const trigger = wrapper.get('button[aria-label="本会话模型"]')
    await trigger.trigger('click')
    await wrapper.setProps({ disabled: true })
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect((trigger.element as HTMLButtonElement).disabled).toBe(true)
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await wrapper.setProps({ disabled: false })
    await flushPromises()
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    await wrapper.setProps({ threadId: 'b' })
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
