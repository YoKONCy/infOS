import { ref } from 'vue'
import zhInterface from '../../shared/src/i18n/locales/zh-CN/site/interface.json'
import zhCharacters from '../../shared/src/i18n/locales/zh-CN/site/characters.json'
import twInterface from '../../shared/src/i18n/locales/zh-TW/site/interface.json'
import twCharacters from '../../shared/src/i18n/locales/zh-TW/site/characters.json'
import enInterface from '../../shared/src/i18n/locales/en-US/site/interface.json'
import enCharacters from '../../shared/src/i18n/locales/en-US/site/characters.json'
import jaInterface from '../../shared/src/i18n/locales/ja-JP/site/interface.json'
import jaCharacters from '../../shared/src/i18n/locales/ja-JP/site/characters.json'

export const languages = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
] as const

export type SiteLocale = (typeof languages)[number]['value']
const storageKey = 'pero-site-language'
const catalogs: Record<SiteLocale, Readonly<Record<string, string>>> = {
  'zh-CN': { ...zhInterface, ...zhCharacters },
  'zh-TW': { ...twInterface, ...twCharacters },
  'en-US': { ...enInterface, ...enCharacters },
  'ja-JP': { ...jaInterface, ...jaCharacters },
}

function matchLocale(value: string): SiteLocale | null {
  const parts = value.replaceAll('_', '-').toLowerCase().split('-')
  if (parts[0] === 'zh') {
    if (parts.includes('hant')) return 'zh-TW'
    if (parts.includes('hans')) return 'zh-CN'
    return parts.some((part) => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-TW' : 'zh-CN'
  }
  if (parts[0] === 'en') return 'en-US'
  if (parts[0] === 'ja') return 'ja-JP'
  return null
}

function automaticLocale(): SiteLocale {
  for (const language of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const matched = matchLocale(language)
    if (matched) return matched
  }
  return 'en-US'
}

function storedLocale(): SiteLocale | null {
  try {
    const value = localStorage.getItem(storageKey)
    return languages.find((language) => language.value === value)?.value ?? null
  } catch {
    return null
  }
}

export const locale = ref<SiteLocale>(storedLocale() ?? automaticLocale())
let explicit = storedLocale() !== null

export function setLocale(value: string): void {
  const next = languages.find((language) => language.value === value)?.value
  if (!next) return
  explicit = true
  locale.value = next
  try {
    localStorage.setItem(storageKey, next)
  } catch {
    // 浏览器限制存储时，本次访问仍可切换语言。
  }
}

export function t(source: string, parameters: readonly (string | number)[] = []): string {
  const text = catalogs[locale.value][source] ?? catalogs['en-US'][source] ?? source
  return text.replace(/\{(\d+)\}/g, (token, index: string) =>
    Number(index) < parameters.length ? String(parameters[Number(index)]) : token,
  )
}

window.addEventListener('storage', (event) => {
  if (event.key !== storageKey) return
  const value = languages.find((language) => language.value === event.newValue)?.value
  explicit = !!value
  locale.value = value ?? automaticLocale()
})
window.addEventListener('languagechange', () => {
  if (!explicit) locale.value = automaticLocale()
})
