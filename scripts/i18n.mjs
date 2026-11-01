import fs from 'node:fs'

// 脚本不能依赖应用先编译；语言归一规则与共享运行时保持一致。
const explicitLanguage = process.env.INFOS_LANGUAGE?.trim()
const languages = explicitLanguage
  ? [explicitLanguage]
  : [
      process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '',
      Intl.DateTimeFormat().resolvedOptions().locale,
    ]
let locale = 'en-US'
selectLanguage: for (const language of languages) {
  for (const item of language.split(',')) {
    if (/;\s*q=0(?:\.0*)?\s*(?:;|$)/i.test(item)) continue
    const tag = item.split(';')[0].trim().split(/[.@]/)[0].replaceAll('_', '-').toLowerCase()
    if (/^zh(?:-|$)/.test(tag)) {
      const parts = tag.split('-')
      locale = parts.includes('hant')
        ? 'zh-TW'
        : parts.includes('hans')
          ? 'zh-CN'
          : parts.some((part) => ['tw', 'hk', 'mo'].includes(part))
            ? 'zh-TW'
            : 'zh-CN'
      break selectLanguage
    }
    if (/^en(?:-|$)/.test(tag)) break selectLanguage
  }
}
const catalogs = new Map()

function catalog(scope, language) {
  const key = `${scope}:${language}`
  if (!catalogs.has(key)) {
    let messages = {}
    try {
      const resource = new URL(
        `../packages/shared/src/i18n/locales/${language}/${scope.replaceAll('.', '/')}.json`,
        import.meta.url,
      )
      messages = JSON.parse(fs.readFileSync(resource, 'utf8'))
    } catch {
      /* 当前语言缺失时继续查找英文与简中资源。 */
    }
    catalogs.set(key, messages)
  }
  return catalogs.get(key)
}

/** 开发脚本直接读取分类资源，无需先构建应用。 */
export function t(scope, source, parameters = []) {
  if (!/^scripts\.[a-z0-9-]+$/.test(scope)) return source
  const text =
    catalog(scope, locale)[source] ??
    catalog(scope, 'en-US')[source] ??
    catalog(scope, 'zh-CN')[source] ??
    source
  return text.replace(/\{(\d+)\}/g, (token, index) =>
    Number(index) < parameters.length ? String(parameters[Number(index)] ?? '') : token,
  )
}
