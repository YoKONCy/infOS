import { afterEach, describe, expect, it } from 'vitest'
import { getLocale, setLocale } from '../src/i18n'
import { createClientLanguage, LANGUAGE_STORAGE_KEY } from '../src/i18n/client'

afterEach(() => setLocale('zh-CN'))

function languageStorage(initial?: string) {
  const values = new Map<string, string>(initial ? [[LANGUAGE_STORAGE_KEY, initial]] : [])
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

describe('客户端语言初始化与偏好', () => {
  it('自动识别不写成固定偏好，系统语言改变后可以重新识别', () => {
    const storage = languageStorage()
    let languages = ['ja-JP', 'zh-Hant-TW']
    const client = createClientLanguage({ storage, preferredLanguages: () => languages })
    expect(getLocale()).toBe('zh-TW')
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull()
    languages = ['en-GB']
    client.refreshAutomatic()
    expect(getLocale()).toBe('en-US')
  })

  it('保存的偏好优先于系统，清除偏好后恢复自动选择', () => {
    const storage = languageStorage('zh-CN')
    const client = createClientLanguage({ storage, preferredLanguages: () => ['en-US'] })
    expect(getLocale()).toBe('zh-CN')
    client.refreshAutomatic()
    expect(getLocale()).toBe('zh-CN')
    client.apply(null)
    expect(getLocale()).toBe('en-US')
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull()
  })

  it('存储不可读写时仍能使用系统语言和手动选择', () => {
    const storage = {
      getItem: () => {
        throw new Error('STORAGE_UNAVAILABLE')
      },
      setItem: () => {
        throw new Error('STORAGE_UNAVAILABLE')
      },
      removeItem: () => {
        throw new Error('STORAGE_UNAVAILABLE')
      },
    }
    const client = createClientLanguage({ storage, preferredLanguages: () => ['zh-HK'] })
    expect(getLocale()).toBe('zh-TW')
    client.apply('en-US')
    expect(getLocale()).toBe('en-US')
  })

  it('晚到的原生启动响应不能覆盖已切换的语言', async () => {
    let resolveNative!: (value: unknown) => void
    const pendingNative = new Promise<unknown>((resolve) => {
      resolveNative = resolve
    })
    const client = createClientLanguage({
      preferredLanguages: () => ['en-US'],
      bridge: {
        invoke: (channel) =>
          channel === 'i18n:get-language' ? pendingNative : Promise.resolve('zh-TW'),
      },
    })
    client.apply('zh-TW')
    resolveNative('zh-CN')
    await pendingNative
    expect(getLocale()).toBe('zh-TW')
  })

  it('晚到的服务端恢复不能覆盖新选择，未配置时清除旧自动缓存', () => {
    const storage = languageStorage('zh-CN')
    const client = createClientLanguage({ storage, preferredLanguages: () => ['en-US'] })
    client.restore(null, client.revision)
    expect(getLocale()).toBe('en-US')
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull()
    const requestedRevision = client.revision
    client.apply('zh-TW')
    client.restore('zh-CN', requestedRevision)
    expect(getLocale()).toBe('zh-TW')
  })

  it('宿主新广播优先于启动响应，嵌入窗口只读取宿主配置', async () => {
    let receive!: (value: unknown) => void
    let resolveNative!: (value: unknown) => void
    const channels: string[] = []
    const pendingNative = new Promise<unknown>((resolve) => {
      resolveNative = resolve
    })
    const client = createClientLanguage({
      preferredLanguages: () => ['en-US'],
      bridge: {
        embedded: true,
        invoke: (channel) => {
          channels.push(channel)
          return pendingNative
        },
        on: (_channel, listener) => {
          receive = listener
        },
      },
    })
    client.receiveStorage(null)
    receive('zh-TW')
    resolveNative('zh-CN')
    await pendingNative
    expect(getLocale()).toBe('zh-TW')
    client.apply('en-US')
    expect(channels).toEqual(['i18n:get-language'])
  })
})
