import { ref } from 'vue'
import { getLocale, onLocaleChange, translate } from '@infos/shared/i18n'
import { createClientLanguage, LANGUAGE_STORAGE_KEY } from '@infos/shared/i18n/client'
import '@infos/shared/i18n/catalogs/arca'

const bridge = (
  window as unknown as {
    electron?: {
      embedded?: boolean
      invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
      on?: (channel: string, listener: (value: unknown) => void) => unknown
    }
  }
).electron
const clientLanguage = createClientLanguage({
  preferredLanguages: () =>
    navigator.languages?.length ? navigator.languages : [navigator.language],
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  },
  bridge,
})
const locale = ref(getLocale())
document.documentElement.lang = locale.value
onLocaleChange((value) => {
  locale.value = value
  document.documentElement.lang = value
})
window.addEventListener('storage', (event) => {
  if (event.key === LANGUAGE_STORAGE_KEY || event.key === null)
    clientLanguage.receiveStorage(event.newValue)
})
window.addEventListener('languagechange', () => clientLanguage.refreshAutomatic())
export function t(scope: string, source: string, parameters: readonly unknown[] = []): string {
  return translate(scope, source, parameters, locale.value)
}
