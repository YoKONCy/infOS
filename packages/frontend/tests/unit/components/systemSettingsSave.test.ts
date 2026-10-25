// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UserSettingsTab from '@infos/frontend/components/dashboard/tabs/UserSettingsTab.vue'
import AssistantPrefillSettings from '@infos/frontend/components/dashboard/AssistantPrefillSettings.vue'
import WholesomeModeSettings from '@infos/frontend/components/dashboard/WholesomeModeSettings.vue'
import WeatherCard from '@infos/frontend/components/weather/WeatherCard.vue'
import { PSelect } from '@infos/frontend/components/pixel'
import { applyLanguage } from '@infos/frontend/i18n'
import { ASSISTANT_PREFILL_KEY, WHOLESOME_MODE_KEY } from '@infos/shared'

const mocks = vi.hoisted(() => ({
  batch: vi.fn(),
  batchSet: vi.fn(),
  backgroundSave: vi.fn(),
  weatherSave: vi.fn(),
  toast: vi.fn(),
  refresh: { value: 0 },
}))
vi.mock('@infos/frontend/api/modules/configApi', () => ({
  configApi: { batch: mocks.batch, batchSet: mocks.batchSet },
}))
vi.mock('@infos/frontend/composables/dashboard', () => ({
  useDashboardContext: () => ({ refreshKey: mocks.refresh }),
}))
vi.mock('@infos/frontend/stores', () => ({ useNotificationStore: () => ({ toast: mocks.toast }) }))
vi.mock('@infos/frontend/services/ui/uiSound', () => ({ uiSound: { play: vi.fn() } }))
vi.mock('@infos/frontend/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock('@infos/frontend/composables/main/useMainNav', () => ({
  useMainNav: () => ({ theme: ref('dark'), setTheme: vi.fn() }),
}))
vi.mock('@infos/frontend/composables/ui/useSensoryPreferences', () => ({
  useSensoryPreferences: () => ({ motionLevel: ref('full'), soundEffects: ref(true) }),
}))
vi.mock('@infos/frontend/composables/ui/useAppBackground', () => ({
  APP_BACKGROUND_PRESETS: [],
  useAppBackground: () => ({
    imageUrl: ref(''),
    loaded: ref(true),
    busy: ref(false),
    selectedPreset: ref('default'),
    presets: ref([]),
    settings: ref({ enabled: false }),
    hasImage: ref(false),
    style: ref({}),
    load: vi.fn(),
    captureSave: () => mocks.backgroundSave,
  }),
}))
vi.mock('@infos/frontend/composables/useWeather', () => ({
  useWeather: () => {
    const status = ref({ query: '长沙', snapshot: null, refreshing: false })
    return {
      status,
      loaded: ref(true),
      saving: ref(false),
      error: ref(''),
      setLocation: async (location: string) => {
        mocks.weatherSave(location)
        status.value.query = location
        return true
      },
    }
  },
}))

const wrappers: Array<ReturnType<typeof mount>> = []
const stubs = {
  WeatherCard: true,
  DesktopControlSettings: true,
  CompletionAlertSettings: true,
  UserAvatarSettings: true,
  AppWallpaper: true,
}
beforeEach(() => {
  vi.clearAllMocks()
  applyLanguage('zh-CN')
  mocks.batch.mockResolvedValue({
    data: {
      'owner.name': '主人',
      'owner.persona': '原人设',
      [ASSISTANT_PREFILL_KEY]: '{"enabled":false,"content":"原开头"}',
    },
  })
  mocks.batchSet.mockResolvedValue({})
  mocks.backgroundSave.mockResolvedValue(undefined)
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  applyLanguage('zh-CN')
})
async function create() {
  const wrapper = mount(UserSettingsTab, { global: { stubs } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
function saved(index = 0): Record<string, string> {
  return Object.fromEntries(
    mocks.batchSet.mock.calls[index]![0].map((item: { key: string; value: string }) => [
      item.key,
      item.value,
    ]),
  )
}
function persona(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('textarea[placeholder="介绍你的称呼、兴趣和偏好…"]')
}

describe('系统设定按整页保存', () => {
  it('修改人设后切换语言，立即提交人设及其他设置，加载和文本输入不自动写入', async () => {
    const wrapper = await create()
    expect(mocks.batchSet).not.toHaveBeenCalled()
    await persona(wrapper).setValue('尚未单独保存的人设')
    expect(mocks.batchSet).not.toHaveBeenCalled()
    const language = wrapper
      .findAllComponents(PSelect)
      .find((select) =>
        (select.props('options') as Array<{ value: string }>).some(
          (option: { value: string }) => option.value === 'en-US',
        ),
      )!
    language.vm.$emit('update:modelValue', 'en-US')
    language.vm.$emit('change', 'en-US')
    await flushPromises()
    expect(saved()).toMatchObject({
      'owner.persona': '尚未单独保存的人设',
      'user.language': 'en-US',
      [WHOLESOME_MODE_KEY]: 'true',
    })
    expect(mocks.backgroundSave).toHaveBeenCalledTimes(1)
  })

  it('切换健全模式与持续预填充都保存整页，包括未保存的预填充正文', async () => {
    const wrapper = await create()
    await persona(wrapper).setValue('共同保存的人设')
    await wrapper.findComponent(AssistantPrefillSettings).get('textarea').setValue('新的回答开头')
    await wrapper.findComponent(WholesomeModeSettings).get('button[role="switch"]').trigger('click')
    await flushPromises()
    expect(saved()).toMatchObject({
      'owner.persona': '共同保存的人设',
      [WHOLESOME_MODE_KEY]: 'false',
    })
    expect(JSON.parse(saved()[ASSISTANT_PREFILL_KEY]!)).toMatchObject({ content: '新的回答开头' })
    wrapper
      .findComponent(AssistantPrefillSettings)
      .findComponent(PSelect)
      .vm.$emit('update:modelValue', 'continuous')
    await flushPromises()
    expect(JSON.parse(saved(1)[ASSISTANT_PREFILL_KEY]!)).toMatchObject({
      content: '新的回答开头',
      mode: 'continuous',
    })
  })

  it('文本附近的保存按钮同样提交其他区域草稿，失败后保留文本可重试', async () => {
    const wrapper = await create()
    await persona(wrapper).setValue('保留这份草稿')
    await wrapper.findComponent(AssistantPrefillSettings).get('textarea').setValue('开头也一起保存')
    mocks.batchSet.mockRejectedValueOnce(new Error('模拟写入失败'))
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '保存')!
      .trigger('click')
    await flushPromises()
    expect((persona(wrapper).element as HTMLTextAreaElement).value).toBe('保留这份草稿')
    expect(wrapper.text()).toContain('保存失败，请稍后重试')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '重试')!
      .trigger('click')
    await flushPromises()
    expect(saved(1)['owner.persona']).toBe('保留这份草稿')
    expect(JSON.parse(saved(1)[ASSISTANT_PREFILL_KEY]!).content).toBe('开头也一起保存')
  })

  it('读取失败时不允许把默认值覆盖服务端，重试读取成功后才开放提交', async () => {
    mocks.batch.mockRejectedValueOnce(new Error('模拟断线'))
    const wrapper = await create()
    expect(
      wrapper.findComponent(WholesomeModeSettings).get('button').attributes('disabled'),
    ).toBeDefined()
    expect(mocks.batchSet).not.toHaveBeenCalled()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '重试')!
      .trigger('click')
    await flushPromises()
    expect(
      wrapper.findComponent(WholesomeModeSettings).get('button').attributes('disabled'),
    ).toBeUndefined()
    expect((persona(wrapper).element as HTMLTextAreaElement).value).toBe('原人设')
  })

  it('天气草稿参与其他区域的即时保存，天气保存按钮也提交人设草稿', async () => {
    const wrapper = mount(UserSettingsTab, { global: { stubs: { ...stubs, WeatherCard: false } } })
    wrappers.push(wrapper)
    await flushPromises()
    await wrapper.findComponent(WeatherCard).get('input').setValue('上海')
    await persona(wrapper).setValue('和城市一起提交')
    await wrapper.findComponent(WholesomeModeSettings).get('button[role="switch"]').trigger('click')
    await flushPromises()
    expect(mocks.weatherSave).toHaveBeenCalledWith('上海')
    expect(saved()['owner.persona']).toBe('和城市一起提交')
    await persona(wrapper).setValue('由天气保存入口提交')
    await wrapper.findComponent(WeatherCard).get('form').trigger('submit')
    await flushPromises()
    expect(saved(1)['owner.persona']).toBe('由天气保存入口提交')
    expect(mocks.weatherSave).toHaveBeenCalledTimes(1)
  })
})
