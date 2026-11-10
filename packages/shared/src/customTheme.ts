/**
 * 自定义主题 — 主题包结构、清单归一化与 CSS 资源地址改写
 *
 * 一个主题是 `@data/themes/<id>/` 下的文件夹：
 * - `theme.json`：名称、作者、说明，以及可选的适用模式（light / dark）
 * - `theme.css`：覆盖 tokens.css / ui-tokens.css 中的 CSS 变量，也可以写普通样式
 * - 图片、字体等资源文件，在 theme.css 中用相对路径引用
 *
 * 主题只是样式，不运行脚本。
 */

export type CustomThemeMode = 'light' | 'dark'

export interface CustomThemeManifest {
  name: string
  description: string
  author: string
  version: string
  /** 主题适用的明暗模式；选用时切换到该模式。不填表示跟随当前模式。 */
  mode?: CustomThemeMode
}

export interface CustomThemeSummary extends CustomThemeManifest {
  /** 主题文件夹名。 */
  id: string
}

export interface CustomThemeLibrary {
  /** 主题文件夹在服务端的实际位置，用于提示用户放置主题。 */
  folder: string
  themes: CustomThemeSummary[]
}

export const CUSTOM_THEME_MANIFEST = 'theme.json'
export const CUSTOM_THEME_STYLESHEET = 'theme.css'

export const CUSTOM_THEME_LIMITS = {
  /** 导入的 ZIP 大小。 */
  archive: 20 * 1024 * 1024,
  /** 解压后的总大小。 */
  expanded: 64 * 1024 * 1024,
  /** 主题文件夹内的文件数（导入与写入共用）。 */
  files: 500,
  /** 角色用 shell_theme write 以 base64 传入的单个资源文件（解码后）。 */
  asset: 2 * 1024 * 1024,
  manifest: 64 * 1024,
  stylesheet: 1024 * 1024,
  name: 100,
  description: 500,
  author: 100,
  version: 40,
} as const

/** 主题文件夹中允许读取的文件类型；不开放 SVG、HTML、脚本等可执行内容。 */
export const CUSTOM_THEME_FILE_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

/** 主题 ID 即文件夹名：小写字母、数字、下划线和连字符。 */
export function isCustomThemeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
}

/** 把任意名称收敛为主题 ID；无法得到合法 ID 时返回空字符串。 */
export function toCustomThemeId(value: string): string {
  const id = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 64)
  return isCustomThemeId(id) ? id : ''
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

/** 归一化 theme.json；名称为空时用主题 ID 代替。 */
export function normalizeCustomThemeManifest(value: unknown, id: string): CustomThemeManifest {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const mode = source.mode === 'light' || source.mode === 'dark' ? source.mode : undefined
  return {
    name: text(source.name, CUSTOM_THEME_LIMITS.name) || id,
    description: text(source.description, CUSTOM_THEME_LIMITS.description),
    author: text(source.author, CUSTOM_THEME_LIMITS.author),
    version: text(source.version, CUSTOM_THEME_LIMITS.version),
    ...(mode ? { mode } : {}),
  }
}

/**
 * 把 theme.css 中的相对 `url(...)` 改写为可访问的地址。
 * 绝对地址（http、https、data、blob、以 / 或 # 开头）保持不变；
 * 含 `..` 的路径无法指向主题文件夹内的文件，改写为空地址。
 */
export function rewriteCustomThemeUrls(css: string, resolve: (path: string) => string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi, (match, _quote: string, raw: string) => {
    const value = raw.trim()
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value)) return match
    const path = value.replace(/^\.\//, '').split(/[?#]/)[0]!
    if (!path || path.split('/').some((part) => part === '..' || part === '.' || !part))
      return 'url("")'
    return `url(${JSON.stringify(resolve(path))})`
  })
}
