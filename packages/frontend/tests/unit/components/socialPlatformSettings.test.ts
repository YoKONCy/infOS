// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TelegramSettings from '@infos/frontend/components/social/platforms/TelegramSettings.vue'
import DiscordSettings from '@infos/frontend/components/social/platforms/DiscordSettings.vue'
import WeixinSettings from '@infos/frontend/components/social/platforms/WeixinSettings.vue'
import PlatformOwnerSettings from '@infos/frontend/components/social/platforms/PlatformOwnerSettings.vue'
import SocialTab from '@infos/frontend/components/dashboard/tabs/SocialTab.vue'
import SocialDataSettings from '@infos/frontend/components/social/SocialDataSettings.vue'
import { socialApi, type SocialConnection } from '@infos/frontend/api/modules/socialApi'

vi.mock('@infos/frontend/api/modules/socialApi', () => ({
  socialApi: {
    getConnectionManagement: vi.fn(),
    manageConnection: vi.fn(),
    saveConnectionOwner: vi.fn(),
    getConnections: vi.fn(),
    getPlatforms: vi.fn(),
    enablePlatform: vi.fn(),
    getAgentConfig: vi.fn(),
    getContacts: vi.fn(),
    getProjection: vi.fn(),
    clearData: vi.fn(),
  },
}))
vi.mock('@infos/frontend/stores', () => ({
  useAgentStore: () => ({
    agents: [{ id: 'pero', name: 'Pero' }],
    enabledAgents: [{ id: 'pero', name: 'Pero' }],
    fetchAgents: vi.fn(),
  }),
  useNotificationStore: () => ({ toast: vi.fn() }),
  useCompositorStore: () => ({ replaceProjection: vi.fn() }),
}))
vi.mock('@infos/frontend/composables/social/useSocialConnectionStatus', async () => {
  const { ref } = await import('vue')
  return {
    useSocialConnectionStatus: () => ({
      adapters: ref([]),
      connected: ref(false),
      error: ref(''),
      refresh: vi.fn(),
    }),
  }
})
const wrappers: Array<ReturnType<typeof mount>> = []
const track = <T extends ReturnType<typeof mount>>(wrapper: T): T => {
  wrappers.push(wrapper)
  return wrapper
}
const connection = (platform: string): SocialConnection => ({
  id: `${platform}-connection`,
  adapter: {
    weixin: 'weixin-ilink',
    telegram: 'telegram-bot',
    discord: 'discord-bot',
    qq: 'napcat',
  }[platform]!,
  platform,
  name: platform,
  accounts: [],
  capabilities: [],
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(socialApi.getConnectionManagement).mockResolvedValue({
    data: { accounts: [] },
  } as never)
  vi.mocked(socialApi.manageConnection).mockResolvedValue({ data: { accounts: [] } } as never)
  vi.mocked(socialApi.getConnections).mockResolvedValue({
    data: { connections: [connection('qq')] },
  } as never)
  vi.mocked(socialApi.getPlatforms).mockResolvedValue({
    data: {
      platforms: ['qq', 'weixin', 'telegram', 'discord'].map((p) => ({
        type: connection(p).adapter,
        platform: p,
      })),
    },
  } as never)
  vi.mocked(socialApi.getAgentConfig).mockResolvedValue({ data: { agentId: 'pero' } } as never)
  vi.mocked(socialApi.getContacts).mockResolvedValue({ data: { contacts: [] } } as never)
  vi.mocked(socialApi.getProjection).mockResolvedValue({} as never)
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe('各平台独立的账号接入', () => {
  it('Telegram 提交私密 Token 与自身的群聊选项，成功后清空输入', async () => {
    const wrapper = track(
      mount(TelegramSettings, { props: { connection: connection('telegram'), enabling: false } }),
    )
    await flushPromises()
    expect(wrapper.text()).toContain('@BotFather')
    expect(wrapper.text()).not.toContain('Message Content Intent')
    await wrapper.get('input[type="password"]').setValue('  TEST_PRIVATE_TOKEN  ')
    await wrapper.get('[role="switch"]').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(socialApi.manageConnection).toHaveBeenCalledWith(
      'telegram-connection',
      'account_add',
      { token: 'TEST_PRIVATE_TOKEN', fullGroupMessages: true },
      expect.any(AbortSignal),
    )
    expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('')
  })
  it('Discord 使用独立的消息内容权限，并只向 Discord 连接提交', async () => {
    const wrapper = track(
      mount(DiscordSettings, { props: { connection: connection('discord'), enabling: false } }),
    )
    await flushPromises()
    expect(wrapper.text()).toContain('Message Content Intent')
    expect(wrapper.text()).not.toContain('@BotFather')
    await wrapper.get('input[type="password"]').setValue('DISCORD_TEST_TOKEN')
    await wrapper.get('[role="switch"]').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(socialApi.manageConnection).toHaveBeenCalledWith(
      'discord-connection',
      'account_add',
      { token: 'DISCORD_TEST_TOKEN', fullGroupMessages: true },
      expect.any(AbortSignal),
    )
  })
  it('Token 提交失败时保留输入供修改，并显示失败信息', async () => {
    vi.mocked(socialApi.manageConnection).mockRejectedValueOnce(new Error('连接操作失败'))
    const wrapper = track(
      mount(TelegramSettings, { props: { connection: connection('telegram'), enabling: false } }),
    )
    await flushPromises()
    await wrapper.get('input[type="password"]').setValue('TEST_TOKEN')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('连接操作失败')
    expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe(
      'TEST_TOKEN',
    )
  })
  it('微信只有扫码流程，二维码过期后不再展示可扫码图片', async () => {
    vi.mocked(socialApi.manageConnection).mockResolvedValueOnce({
      data: {
        accounts: [],
        login: { id: 'login', qrText: 'https://example.test/qr', status: 'wait' },
      },
    } as never)
    const wrapper = track(
      mount(WeixinSettings, { props: { connection: connection('weixin'), enabling: false } }),
    )
    await flushPromises()
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    expect(wrapper.find('[role="switch"]').exists()).toBe(false)
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('获取登录二维码'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(true)
    vi.mocked(socialApi.manageConnection).mockResolvedValueOnce({
      data: {
        accounts: [],
        login: { id: 'login', qrText: 'https://example.test/qr', status: 'expired' },
      },
    } as never)
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('二维码已过期')
  })
  it('微信验证码绑定当前登录流程，提交后清空验证码', async () => {
    vi.mocked(socialApi.getConnectionManagement).mockResolvedValueOnce({
      data: {
        accounts: [],
        login: { id: 'verify-session', qrText: 'qr', status: 'need_verifycode' },
      },
    } as never)
    const wrapper = track(
      mount(WeixinSettings, { props: { connection: connection('weixin'), enabling: false } }),
    )
    await flushPromises()
    await wrapper.get('input[autocomplete="one-time-code"]').setValue('123456')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(socialApi.manageConnection).toHaveBeenCalledWith(
      'weixin-connection',
      'login_verify',
      { loginId: 'verify-session', code: '123456' },
      expect.any(AbortSignal),
    )
  })
  it('卸载平台页取消请求并停止后续轮询', async () => {
    const wrapper = track(
      mount(TelegramSettings, { props: { connection: connection('telegram'), enabling: false } }),
    )
    await flushPromises()
    const signal = vi.mocked(socialApi.getConnectionManagement).mock.calls[0]![1]!
    wrapper.unmount()
    wrappers.splice(wrappers.indexOf(wrapper), 1)
    expect(signal.aborted).toBe(true)
    const count = vi.mocked(socialApi.getConnectionManagement).mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(socialApi.getConnectionManagement).toHaveBeenCalledTimes(count)
  })
  it('添加账号后，迟到的旧查询不会覆盖新的账号状态', async () => {
    let completeOld!: (value: unknown) => void
    vi.mocked(socialApi.getConnectionManagement).mockReturnValueOnce(
      new Promise((resolve) => {
        completeOld = resolve
      }) as never,
    )
    vi.mocked(socialApi.manageConnection).mockResolvedValueOnce({
      data: { accounts: [{ id: 'new-bot', name: '新账号', connected: true }] },
    } as never)
    const wrapper = track(
      mount(TelegramSettings, { props: { connection: connection('telegram'), enabling: false } }),
    )
    await wrapper.get('input[type="password"]').setValue('TEST_TOKEN')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    completeOld({ data: { accounts: [] } })
    await flushPromises()
    expect(wrapper.text()).toContain('新账号')
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })
  it('主人身份保存到所属平台的连接，不更新其他平台', async () => {
    const wrapper = track(
      mount(PlatformOwnerSettings, {
        props: { connection: connection('discord'), label: '主人 Discord User ID', hint: '' },
      }),
    )
    await wrapper.get('input').setValue('123456789012345678')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(socialApi.saveConnectionOwner).toHaveBeenCalledWith(
      'discord-connection',
      '123456789012345678',
    )
  })
})

describe('社交平台与功能层级', () => {
  it('未启用平台也有独立入口；切换不自动启用平台，不泄漏 QQ 专属功能', async () => {
    const wrapper = track(
      mount(SocialTab, {
        global: {
          stubs: {
            QqSettings: true,
            SocialCommonSettings: true,
            AccountStickers: true,
            StatusCardDesigner: true,
          },
        },
      }),
    )
    await flushPromises()
    expect(wrapper.findAll('[data-platform]')).toHaveLength(4)
    await wrapper.get('[data-platform="weixin"]').trigger('click')
    await flushPromises()
    expect(socialApi.enablePlatform).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('扫码连接微信')
    expect(wrapper.text()).not.toContain('收藏表情')
    expect(wrapper.text()).not.toContain('状态卡片')
    expect(wrapper.text()).not.toContain('Message Content Intent')
    await wrapper.get('[data-platform="telegram"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('@BotFather')
    expect(wrapper.text()).not.toContain('扫码连接微信')
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('启用 Telegram'))!
      .trigger('click')
    await flushPromises()
    expect(socialApi.enablePlatform).toHaveBeenCalledWith('telegram-bot')
    await wrapper.get('[data-platform="discord"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('服务器与频道授权')
    expect(wrapper.text()).not.toContain('@BotFather')
  })
  it('联系人仅显示当前平台，同号联系人不会串入', async () => {
    vi.mocked(socialApi.getContacts).mockResolvedValue({
      data: {
        contacts: [
          {
            platform: 'qq',
            userId: 'same-id',
            displayName: 'QQ 联系人',
            impression: '',
            updatedAt: '',
          },
          {
            platform: 'telegram',
            userId: 'same-id',
            displayName: 'TG 联系人',
            impression: '',
            updatedAt: '',
          },
        ],
      },
    } as never)
    const wrapper = track(
      mount(SocialDataSettings, {
        props: {
          agentId: 'pero',
          agentName: 'Pero',
          section: 'contacts',
          platform: 'telegram',
          connections: [connection('telegram')],
        },
      }),
    )
    await flushPromises()
    expect(wrapper.text()).toContain('TG 联系人')
    expect(wrapper.text()).not.toContain('QQ 联系人')
  })
  it('微信会话清理只提供私聊，不显示跨平台全量清理操作', async () => {
    const wrapper = track(
      mount(SocialDataSettings, {
        props: {
          agentId: 'pero',
          agentName: 'Pero',
          section: 'data',
          platform: 'weixin',
          connections: [connection('weixin')],
          allowGroups: false,
        },
        global: { stubs: { PDialog: true } },
      }),
    )
    await flushPromises()
    expect(wrapper.find('option[value="group"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('彻底清除社交数据')
    expect(wrapper.text()).not.toContain('全部聊天记录')
    expect(wrapper.text()).toContain('当前平台的会话数据')
  })
  it('清理提交保留当前平台和账号范围，不把微信会话提交为其他平台', async () => {
    const wrapper = track(
      mount(SocialDataSettings, {
        props: {
          agentId: 'pero',
          agentName: 'Pero',
          section: 'data',
          platform: 'weixin',
          connections: [connection('weixin')],
          allowGroups: false,
        },
        global: { stubs: { PDialog: true } },
      }),
    )
    await flushPromises()
    await wrapper.get('input[placeholder="平台账号标识"]').setValue('weixin-bot-id')
    await wrapper.get('input[placeholder="用户或会话标识"]').setValue('contact-id')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '选择清理')!
      .trigger('click')
    wrapper.findComponent({ name: 'PDialog' }).vm.$emit('confirm')
    await flushPromises()
    expect(socialApi.clearData).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'weixin',
        accountId: 'weixin-bot-id',
        channelType: 'private',
        channelId: 'contact-id',
        scope: 'channel',
      }),
    )
  })
})
