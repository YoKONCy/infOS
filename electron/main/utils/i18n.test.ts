import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  ready: vi.fn<() => Promise<void>>(),
  languages: vi.fn<() => string[]>(),
  locale: vi.fn<() => string>(),
}))
vi.mock('electron', () => ({
  app: {
    whenReady: native.ready,
    getPreferredSystemLanguages: native.languages,
    getLocale: native.locale,
  },
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('INFOS_LANGUAGE', undefined)
  native.ready.mockResolvedValue(undefined)
  native.languages.mockReturnValue(['en-GB'])
  native.locale.mockReturnValue('zh-CN')
})
afterEach(() => vi.unstubAllEnvs())

describe('Electron 原生语言初始化', () => {
  it('等待 ready 后按原生界面偏好选择，不被 Chromium 区域语言覆盖', async () => {
    let ready!: () => void
    native.ready.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve
      }),
    )
    native.languages.mockReturnValue(['ja-JP', 'zh-Hant-HK', 'en-US'])
    const language = await import('./i18n')
    const pending = language.initializeDesktopLanguage()
    expect(native.languages).not.toHaveBeenCalled()
    ready()
    expect(await pending).toBe('zh-TW')
  })

  it('手动保存的语言在系统偏好变化及重复读取后保持优先', async () => {
    const language = await import('./i18n')
    language.restoreDesktopLanguage('zh-CN')
    expect(await language.initializeDesktopLanguage()).toBe('zh-CN')
    native.languages.mockReturnValue(['zh-Hant-TW'])
    expect(await language.initializeDesktopLanguage()).toBe('zh-CN')
    expect(language.applyDesktopLanguage(null)).toBe('zh-TW')
  })

  it('不支持的原生偏好回退英文，不使用中文区域格式代替界面偏好', async () => {
    native.languages.mockReturnValue(['fr-FR', 'ja-JP'])
    const language = await import('./i18n')
    language.restoreDesktopLanguage('INVALID_CACHE')
    expect(await language.initializeDesktopLanguage()).toBe('en-US')
  })

  it('环境显式覆盖可用于部署，保存的用户选择仍具有最高优先级', async () => {
    vi.stubEnv('INFOS_LANGUAGE', 'zh-TW')
    const language = await import('./i18n')
    expect(await language.initializeDesktopLanguage()).toBe('zh-TW')
    language.applyDesktopLanguage('en-US')
    expect(await language.initializeDesktopLanguage()).toBe('en-US')
  })
})
