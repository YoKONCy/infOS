import { ref } from 'vue'
import { getLocale, onLocaleChange, translate, type AppLocale } from '@infos/shared/i18n'
import { createClientLanguage, LANGUAGE_STORAGE_KEY } from '@infos/shared/i18n/client'
import '@infos/shared/i18n/catalogs/frontend'

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
  bridge: typeof window === 'undefined' ? undefined : window.electron,
})
export const appLocale = ref<AppLocale>(getLocale())
function applyLocale(value: AppLocale): void {
  appLocale.value = value
  if (typeof document !== 'undefined') document.documentElement.lang = value
}
applyLocale(getLocale())
onLocaleChange(applyLocale)
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
