import { ref } from 'vue'
import { getLocale, onLocaleChange, translate, type AppLocale } from '@infos/shared/i18n'
import { ensureLocaleCatalogs } from '@infos/shared/i18n/catalogLoaders'
import { createClientLanguage, LANGUAGE_STORAGE_KEY } from '@infos/shared/i18n/client'
import '@infos/shared/i18n/catalogs/frontend'

const nativeBridge = typeof window === 'undefined' ? undefined : window.electron
let initialLanguageReady: Promise<unknown> = Promise.resolve()

// 通过方法访问浏览器存储，使禁用存储时仍可探测系统语言。
const clientLanguage = createClientLanguage({
  preferredLanguages: () => {
    if (typeof navigator === 'undefined') return []
    return navigator.languages?.length ? navigator.languages : [navigator.language]
  },
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  },
  bridge: nativeBridge && {
    embedded: nativeBridge.embedded,
    toastOverlay: nativeBridge.toastOverlay,
    on: nativeBridge.on,
    // 记下启动时的原生语言查询，首屏词库等它返回后再装配。
    invoke: (channel, ...args) => {
      const result = nativeBridge.invoke(channel, ...args)
      if (channel === 'i18n:get-language') initialLanguageReady = result.catch(() => undefined)
      return result
    },
  },
})
export const appLocale = ref<AppLocale>(getLocale())
function applyLocale(value: AppLocale): void {
  appLocale.value = value
  if (typeof document !== 'undefined') document.documentElement.lang = value
}
/** 目标语言词库装配完成后再切换界面语言，期间继续显示旧语言，避免闪现原文。 */
function switchLocale(value: AppLocale): void {
  const loading = ensureLocaleCatalogs(value)
  if (!loading) applyLocale(value)
  else
    void loading.then(() => {
      // 装配期间可能再次切换，只应用仍为当前值的语言。
      if (getLocale() === value) applyLocale(value)
    })
}

/** 先等原生初始语言，再持续追踪词库等待期间的语言变化。 */
export async function loadActiveLocaleCatalogs(): Promise<void> {
  await initialLanguageReady
  for (;;) {
    const language = getLocale()
    await ensureLocaleCatalogs(language)
    if (getLocale() !== language) continue
    // 加载失败也应用目标语言，由翻译运行时回退原文，不反复重试阻塞启动。
    applyLocale(language)
    return
  }
}
applyLocale(getLocale())
onLocaleChange(switchLocale)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null)
      clientLanguage.receiveStorage(event.newValue)
  })
  window.addEventListener('languagechange', () => clientLanguage.refreshAutomatic())
}

/** 在渲染、计算属性中读取语言，使文案随语言切换更新。 */
export function t(scope: string, source: string, parameters: readonly unknown[] = []): string {
  return translate(scope, source, parameters, appLocale.value)
}
export function getDisplayLocale(): AppLocale {
  return appLocale.value
}
export function applyLanguage(value: unknown): AppLocale {
  return clientLanguage.apply(value)
}
export const getLanguageRevision = () => clientLanguage.revision
export const restoreLanguage = (value: unknown, revision: number): void =>
  clientLanguage.restore(value, revision)
