import { app } from 'electron'
import {
  getLocale,
  setLocale,
  translate,
  matchLocale,
  normalizeLocale,
  resolveEnvironmentLocale,
  resolvePreferredLocale,
  type AppLocale,
} from '../../../packages/shared/src/i18n'
import '../../../packages/shared/src/i18n/catalogs/electron'

let preference: AppLocale | null = null
let initialization: Promise<AppLocale> | undefined
const environmentLocale = () =>
  resolveEnvironmentLocale(process.env, Intl.DateTimeFormat().resolvedOptions().locale)
setLocale(environmentLocale())

function automaticLocale(): AppLocale {
  if (process.env.INFOS_LANGUAGE?.trim()) return normalizeLocale(process.env.INFOS_LANGUAGE)
  try {
    // 使用界面语言偏好，而不是日期、数字所用的区域格式。
    const languages = app.getPreferredSystemLanguages()
    return resolvePreferredLocale(languages.length ? languages : [app.getLocale()])
  } catch {
    return environmentLocale()
  }
}

/** IPC 注册阶段恢复明确保存的偏好；首次启动等待原生语言 API 就绪。 */
export function restoreDesktopLanguage(value: unknown): void {
  preference = matchLocale(value)
  setLocale(preference ?? environmentLocale())
}

export function initializeDesktopLanguage(): Promise<AppLocale> {
  initialization ??= app.whenReady().then(() => setLocale(preference ?? automaticLocale()))
  return initialization.then(() => {
    if (!preference) setLocale(automaticLocale())
    return getLocale()
  })
}

export function applyDesktopLanguage(value: unknown): AppLocale {
  preference = value == null ? null : normalizeLocale(value)
  return setLocale(preference ?? automaticLocale())
}

export { getLocale, setLocale }
export const t = translate
