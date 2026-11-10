import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Plugin } from 'vite'
import ts from 'typescript'
import { t as __t } from './i18n.mjs'

/**
 * 前端词库按语言拆分。
 *
 * `packages/shared/src/i18n/catalogs/frontend.ts` 以静态 import 同步注册三种语言；
 * 该文件由上游持续追加词条，因此不直接改写源码，而是在前端构建时把它转换为：
 * 入口只登记按语言加载器，每种语言的 JSON 与注册调用进入独立虚拟模块（独立分块）。
 * 简中词库若全部为“原文 → 原文”则不生成分块，`translate` 直接回退原文即可。
 *
 * 文件结构超出约定（只允许词库 import、注册函数 import、注册调用和注释）时构建直接失败，
 * 避免上游调整写法后静默丢失词条。后端、Electron 主进程与单元测试不经过此插件，行为不变。
 */

const LOCALES = ['zh-CN', 'zh-TW', 'en-US'] as const
type Locale = (typeof LOCALES)[number]
const VIRTUAL_PREFIX = 'virtual:infos-frontend-catalog/'
const RESOLVED_PREFIX = '\0infos-frontend-catalog/'
const TARGET = /[\\/]packages[\\/]shared[\\/]src[\\/]i18n[\\/]catalogs[\\/]frontend\.ts$/

export interface CatalogRegistration {
  scope: string
  locale: Locale
  /** 相对 catalogs 目录的 JSON 路径 */
  file: string
}

export interface FrontendCatalogSplit {
  registrations: CatalogRegistration[]
  /** 简中是否全部为原文映射，可以不装配 */
  identityZhCn: boolean
  entry: string
  modules: Partial<Record<Locale, string>>
}

const posix = (path: string) => path.replace(/\\/g, '/')

/** 解析 frontend.ts 并生成拆分后的入口与各语言模块源码。 */
export function splitFrontendCatalogs(
  source: string,
  catalogsDir: string,
  readJson: (file: string) => Record<string, string> = (file) =>
    JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>,
): FrontendCatalogSplit {
  const file = ts.createSourceFile(
    resolve(catalogsDir, 'frontend.ts'),
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  function failAt(position: number, message: string): never {
    const { line, character } = file.getLineAndCharacterOfPosition(position)
    throw new Error(`${posix(file.fileName)}:${line + 1}:${character + 1}: ${message}`)
  }
  function fail(node: ts.Node, message: string): never {
    return failAt(node.getStart(file), message)
  }
  // SourceFile 的解析诊断由 TypeScript 解析器提供，不容许错误恢复后的 AST 静默通过。
  const diagnostics = (
    file as ts.SourceFile & {
      parseDiagnostics: readonly ts.DiagnosticWithLocation[]
    }
  ).parseDiagnostics
  if (diagnostics.length) {
    const diagnostic = diagnostics[0]!
    failAt(
      diagnostic.start,
      __t('scripts.frontend-catalog-split', 'frontend.ts 语法错误: {0}', [
        ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      ]),
    )
  }
  const imports = new Map<string, { file: string; locale: Locale; node: ts.Node }>()
  const registerNames = new Set<string>()
  const bindings = new Set<string>()
  function addBinding(name: ts.Identifier): void {
    if (bindings.has(name.text))
      fail(
        name,
        __t('scripts.frontend-catalog-split', 'frontend.ts 重复引入标识符: {0}', [name.text]),
      )
    bindings.add(name.text)
  }
  // 只读取真实的语法节点；注释不进入 import 或注册表。
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const clause = statement.importClause
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !clause ||
      clause.isTypeOnly ||
      statement.attributes
    )
      fail(statement, __t('scripts.frontend-catalog-split', 'frontend.ts 含有不支持的 import 写法'))
    const specifier = statement.moduleSpecifier.text
    if (specifier === '../index' || specifier === '../index.ts') {
      if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings))
        fail(
          statement,
          __t('scripts.frontend-catalog-split', 'frontend.ts 只允许具名引入 registerCatalog'),
        )
      if (!clause.namedBindings.elements.length)
        fail(statement, __t('scripts.frontend-catalog-split', 'frontend.ts 未引入 registerCatalog'))
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly || (element.propertyName ?? element.name).text !== 'registerCatalog')
          fail(
            element,
            __t('scripts.frontend-catalog-split', 'frontend.ts 引入了无法识别的 i18n 成员: {0}', [
              element.getText(file),
            ]),
          )
        addBinding(element.name)
        registerNames.add(element.name.text)
      }
    } else {
      const match = /^\.\.\/locales\/(zh-CN|zh-TW|en-US)\/.+\.json$/.exec(specifier)
      if (!match || !clause.name || clause.namedBindings)
        fail(
          statement,
          __t('scripts.frontend-catalog-split', 'frontend.ts 只允许默认引入支持语言的 JSON 词库'),
        )
      addBinding(clause.name)
      imports.set(clause.name.text, {
        file: specifier,
        locale: match[1] as Locale,
        node: clause.name,
      })
    }
  }
  const registrations: CatalogRegistration[] = []
  const used = new Set<string>()
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) || ts.isEmptyStatement(statement)) continue
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
      fail(statement, __t('scripts.frontend-catalog-split', 'frontend.ts 含有拆分插件不支持的语句'))
    const call = statement.expression
    if (
      !ts.isIdentifier(call.expression) ||
      !registerNames.has(call.expression.text) ||
      call.questionDotToken ||
      call.typeArguments ||
      call.arguments.length !== 3
    )
      fail(
        call,
        __t(
          'scripts.frontend-catalog-split',
          'frontend.ts 含有拆分插件不支持的语句；只允许直接调用 registerCatalog',
        ),
      )
    const [scope, language, messages] = call.arguments
    if (
      !scope ||
      !ts.isStringLiteral(scope) ||
      !language ||
      !ts.isStringLiteral(language) ||
      !messages ||
      !ts.isIdentifier(messages)
    )
      fail(
        call,
        __t(
          'scripts.frontend-catalog-split',
          'frontend.ts 注册参数必须为两个字符串字面量和一个词库标识符',
        ),
      )
    const target = imports.get(messages.text)
    if (!target)
      fail(
        messages,
        __t('scripts.frontend-catalog-split', 'frontend.ts 注册了未知词库: {0}', [messages.text]),
      )
    if (target.locale !== language.text)
      fail(
        language,
        __t('scripts.frontend-catalog-split', 'frontend.ts 词库语言不一致: {0} {1} ← {2}', [
          scope.text,
          language.text,
          target.file,
        ]),
      )
    used.add(messages.text)
    registrations.push({ scope: scope.text, locale: target.locale, file: target.file })
  }
  for (const [name, imported] of imports)
    if (!used.has(name))
      fail(
        imported.node,
        __t('scripts.frontend-catalog-split', 'frontend.ts 有未注册的词库: {0}', [name]),
      )

  const identityZhCn = registrations
    .filter((item) => item.locale === 'zh-CN')
    .every((item) =>
      Object.entries(readJson(resolve(catalogsDir, item.file))).every(
        ([key, value]) => key === value,
      ),
    )
  const indexFile = posix(resolve(catalogsDir, '../index.ts'))
  const modules: Partial<Record<Locale, string>> = {}
  for (const locale of LOCALES) {
    if (locale === 'zh-CN' && identityZhCn) continue
    const items = registrations.filter((item) => item.locale === locale)
    if (!items.length) continue
    modules[locale] = [
      `import { registerCatalog } from ${JSON.stringify(indexFile)}`,
      ...items.map(
        (item, index) =>
          `import m${index} from ${JSON.stringify(posix(resolve(catalogsDir, item.file)))}`,
      ),
      ...items.map(
        (item, index) =>
          `registerCatalog(${JSON.stringify(item.scope)}, ${JSON.stringify(locale)}, m${index})`,
      ),
    ].join('\n')
  }
  const entry = [
    `import { registerCatalogLoader } from '../catalogLoaders'`,
    `registerCatalogLoader((language) => {`,
    `  switch (language) {`,
    ...Object.keys(modules).map(
      (locale) =>
        `    case ${JSON.stringify(locale)}:\n      return import(${JSON.stringify(VIRTUAL_PREFIX + locale)})`,
    ),
    `  }`,
    `  return undefined`,
    `})`,
  ].join('\n')
  return { registrations, identityZhCn, entry, modules }
}

/** 前端两种构建入口（Electron 渲染进程与浏览器/Docker）共用。 */
export function frontendCatalogSplitPlugin(): Plugin {
  let split: FrontendCatalogSplit | undefined
  return {
    name: 'infos-frontend-catalog-split',
    enforce: 'pre',
    resolveId(id) {
      return id.startsWith(VIRTUAL_PREFIX)
        ? RESOLVED_PREFIX + id.slice(VIRTUAL_PREFIX.length)
        : null
    },
    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null
      const locale = id.slice(RESOLVED_PREFIX.length) as Locale
      const code = split?.modules[locale]
      if (code === undefined)
        throw new Error(__t('scripts.frontend-catalog-split', '未知的前端词库分块: {0}', [locale]))
      return code
    },
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!TARGET.test(file)) return null
      const catalogsDir = dirname(file)
      split = splitFrontendCatalogs(code, catalogsDir)
      // 开发服务器下修改任一 JSON 时重新转换入口。
      for (const item of split.registrations) this.addWatchFile(resolve(catalogsDir, item.file))
      return { code: split.entry, map: null }
    },
  }
}
