import {
  matchLocale,
  normalizeLocale,
  resolvePreferredLocale,
  setLocale,
  type AppLocale,
} from './index'

interface ClientLanguageOptions {
  preferredLanguages: () => readonly string[]
  storage?: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
  }
  bridge?: {
    embedded?: boolean
    toastOverlay?: boolean
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
    on?: (channel: string, listener: (value: unknown) => void) => unknown
  }
}

export const LANGUAGE_STORAGE_KEY = 'infos.language'

/** 启动探测只改变当前语言，只有明确偏好才写入缓存；晚到的恢复结果不能覆盖新选择。 */
export function createClientLanguage(options: ClientLanguageOptions) {
  let preference: AppLocale | null = null
  let revision = 0
  const automaticLocale = () => resolvePreferredLocale(options.preferredLanguages())
  try {
    preference = matchLocale(options.storage?.getItem(LANGUAGE_STORAGE_KEY))
  } catch {
    /* 私密浏览模式使用内存偏好。 */
  }
  setLocale(preference ?? automaticLocale())

  const bridge = options.bridge
  function readNativeLanguage(): void {
    const requestedRevision = revision
    void bridge
      ?.invoke?.('i18n:get-language')
      .then((value) => {
        if (revision === requestedRevision && typeof value === 'string') setLocale(value)
      })
      .catch(() => {
        /* 独立浏览器和子应用无需宿主连接。 */
      })
  }
  bridge?.on?.('i18n:changed', (value) => {
    revision++
    if (typeof value === 'string') setLocale(value)
  })
  readNativeLanguage()

  function apply(value: unknown): AppLocale {
    preference = value == null ? null : normalizeLocale(value)
    const requestedRevision = ++revision
    const language = setLocale(preference ?? automaticLocale())
    try {
      if (preference) options.storage?.setItem(LANGUAGE_STORAGE_KEY, preference)
      else options.storage?.removeItem(LANGUAGE_STORAGE_KEY)
    } catch {
      /* 缓存不可写时不阻止语言切换和服务端保存。 */
    }
    if (!bridge?.embedded && !bridge?.toastOverlay)
      void bridge
        ?.invoke?.('i18n:set-language', preference)
        .then((value) => {
          if (revision === requestedRevision && typeof value === 'string') setLocale(value)
        })
        .catch(() => {
          /* 服务端仍保留已保存的偏好，下次连接时恢复。 */
        })
    return language
  }

  return {
    get revision() {
      return revision
    },
    apply,
    restore(value: unknown, requestedRevision: number): void {
      if (revision === requestedRevision) apply(value)
    },
    receiveStorage(value: unknown): void {
      revision++
      preference = matchLocale(value)
      setLocale(preference ?? automaticLocale())
    },
    refreshAutomatic(): void {
      if (preference) return
      setLocale(automaticLocale())
      readNativeLanguage()
    },
  }
}
