/** 不依赖 Vue、Electron 或服务端的共用翻译运行时。 */
export const SUPPORTED_LOCALES = ['zh-CN', 'zh-TW', 'en-US'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: AppLocale = 'en-US'
export const LANGUAGE_CONFIG_KEY = 'user.language'
export const LANGUAGE_OPTIONS = [
  { label: '简体中文', value: 'zh-CN' },
  { label: '繁體中文', value: 'zh-TW' },
  { label: 'English', value: 'en-US' },
] as const

type Messages = Readonly<Record<string, string>>
const catalogs = new Map<string, Partial<Record<AppLocale, Messages>>>()
const listeners = new Set<(locale: AppLocale) => void>()
let diagnosticPatterns: Array<{
  scope: string
  source: string
  pattern: RegExp
  indices: number[]
}> | null = null
let locale: AppLocale = DEFAULT_LOCALE

/** 识别单个语言标记；无法识别时保留空值，供偏好列表继续查找。 */
export function matchLocale(value: unknown): AppLocale | null {
  if (typeof value !== 'string') return null
  const language = value
    .split(',')[0]!
    .split(';')[0]!
    .trim()
    .split(/[.@]/)[0]!
    .replaceAll('_', '-')
    .toLowerCase()
  if (/^zh(?:-|$)/.test(language)) {
    const parts = language.split('-')
    if (parts.includes('hant')) return 'zh-TW'
    if (parts.includes('hans')) return 'zh-CN'
    return parts.some((part) => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-TW' : 'zh-CN'
  }
  if (/^en(?:-|$)/.test(language)) return 'en-US'
  return null
}

/** 按系统给出的优先级选择首个受支持语言，不把未知语言误判为中文。 */
export function resolvePreferredLocale(values: readonly string[]): AppLocale {
  for (const value of values) {
    for (const item of value.split(',')) {
      if (/;\s*q=0(?:\.0*)?\s*(?:;|$)/i.test(item)) continue
      const language = matchLocale(item)
      if (language) return language
    }
  }
  return DEFAULT_LOCALE
}

export function normalizeLocale(value: unknown): AppLocale {
  return typeof value === 'string' ? resolvePreferredLocale([value]) : DEFAULT_LOCALE
}

/** Node 与脚本入口的环境语言；显式覆盖优先于系统提供的区域信息。 */
export function resolveEnvironmentLocale(
  environment: Readonly<Record<string, string | undefined>>,
  systemLocale: string,
): AppLocale {
  if (environment.INFOS_LANGUAGE?.trim()) return normalizeLocale(environment.INFOS_LANGUAGE)
  return resolvePreferredLocale([
    environment.LC_ALL || environment.LC_MESSAGES || environment.LANG || '',
    systemLocale,
  ])
}

export function getLocale(): AppLocale {
  return locale
}

export function setLocale(value: unknown): AppLocale {
  const next = normalizeLocale(value)
  if (next === locale) return locale
  locale = next
  for (const listener of listeners) listener(next)
  return locale
}

export function onLocaleChange(listener: (locale: AppLocale) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function registerCatalog(scope: string, language: AppLocale, messages: Messages): void {
  const entry = catalogs.get(scope) ?? {}
  entry[language] = messages
  catalogs.set(scope, entry)
  if (scope.startsWith('errors.')) diagnosticPatterns = null
}

/** 只在日志/错误展示边界使用；内部异常原文与错误码保持不变。 */
export function translateDiagnostic(source: string, language: AppLocale = locale): string {
  if (language === 'zh-CN' || !source || source.length > 20_000) return source
  const scopes = [...catalogs.keys()].filter((scope) => scope.startsWith('errors.'))
  // 前端按需装配时可能不注册与原文相同的简中词库，此时以目标语言词库的原文键匹配。
  const sourceKeys = (scope: string) =>
    catalogs.get(scope)?.['zh-CN'] ?? catalogs.get(scope)?.[language]
  for (const scope of scopes)
    if (sourceKeys(scope)?.[source] !== undefined) return translate(scope, source, [], language)
  diagnosticPatterns ??= scopes.flatMap((scope) =>
    Object.keys(sourceKeys(scope) ?? {})
      .filter((text) => /\{\d+\}/.test(text))
      .map((text) => {
        const indices: number[] = []
        const pattern = text
          .split(/(\{\d+\})/g)
          .map((part) => {
            const match = /^\{(\d+)\}$/.exec(part)
            if (match) {
              indices.push(Number(match[1]))
              return '([\\s\\S]*?)'
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          })
          .join('')
        return { scope, source: text, pattern: new RegExp(`^${pattern}$`), indices }
      }),
  )
  for (const entry of diagnosticPatterns) {
    const match = entry.pattern.exec(source)
    if (!match) continue
    const parameters: unknown[] = []
    entry.indices.forEach((index, position) => {
      parameters[index] = match[position + 1]
    })
    return translate(entry.scope, entry.source, parameters, language)
  }
  return source
}

/** 原文只作稳定查询键；参数最后插入，绝不翻译用户数据或重新解释其中的占位符。 */
export function translate(
  scope: string,
  source: string,
  parameters: readonly unknown[] = [],
  language: AppLocale = locale,
): string {
  const entry = catalogs.get(scope)
  const text =
    entry?.[language]?.[source] ??
    entry?.['en-US']?.[source] ??
    entry?.['zh-CN']?.[source] ??
    source
  return text.replace(/\{(\d+)\}/g, (token, index: string) =>
    Number(index) < parameters.length ? String(parameters[Number(index)] ?? '') : token,
  )
}
