import type { PromptBundle, PromptDocument, PromptFramework, PromptPreset } from '@infos/shared'
import { promptFormat } from '@infos/shared'
import { t } from '../i18n'
import { isPromptBundle } from './promptDraft'

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const calls = () => /(\bcomponent\s*\(\s*)(['"])([^'"]+)\2(\s*\))/g
const tr = (message: string, values: readonly unknown[] = []) =>
  t('ui.prompt-presets', message, values)

function rewrite(body: string, resolve: (key: string) => string): string {
  // HTML 注释与运行时一致不参与引用解析，保留说明里的示例原文。
  return body
    .split(/(<!--[\s\S]*?-->)/g)
    .map((part) =>
      part.startsWith('<!--')
        ? part
        : part.replace(
            calls(),
            (_match, before: string, quote: string, key: string, after: string) =>
              `${before}${quote}${resolve(key)}${quote}${after}`,
          ),
    )
    .join('')
}
function references(body: string): string[] {
  const content = body.replace(/<!--[\s\S]*?-->/g, '')
  const matches = [...content.matchAll(calls())]
  if (/\bcomponent\s*\(/.test(content.replace(calls(), '')))
    throw new Error(tr('包含动态组件引用，请改用固定组件 ID，或导出完整工作区备份'))
  return matches.map((match) => match[3]!)
}
function frameworkText(item: PromptFramework): string[] {
  return [...item.bindings, ...item.blocks].flatMap((entry) => [
    entry.template ?? '',
    entry.when ?? '',
  ])
}
function mapFramework(item: PromptFramework, resolve: (key: string) => string): PromptFramework {
  const result = copy(item)
  result.format = promptFormat(item)
  for (const entry of [...result.bindings, ...result.blocks]) {
    if (entry.source) entry.source = resolve(entry.source)
    if (entry.template !== undefined) entry.template = rewrite(entry.template, resolve)
    if (entry.when !== undefined) entry.when = rewrite(entry.when, resolve)
  }
  if (result.overrides)
    result.overrides = Object.fromEntries(
      Object.entries(result.overrides).map(([key, value]) => [resolve(key), resolve(value)]),
    )
  return result
}

/** 递归打包静态依赖，统一短名引用；不夹带其他框架、指派和运行时变量。 */
export function createPromptPreset(bundle: PromptBundle, frameworkId: string): PromptPreset {
  const framework = bundle.frameworks.find((item) => item.id === frameworkId)
  if (!framework) throw new Error(tr('请选择要导出的框架'))
  const documents = new Map(bundle.documents.map((item) => [item.id, item]))
  const selected = new Map<string, PromptDocument>()
  const resolve = (key: string): string => {
    if (documents.has(key)) return key
    const block = framework.blocks.find((entry) => entry.id === key && entry.source)
    if (block?.source && documents.has(block.source)) return block.source
    const matches = bundle.documents.filter((entry) => entry.id.split('/').at(-1) === key)
    if (matches.length === 1) return matches[0]!.id
    throw new Error(tr('无法打包组件引用：{0}，请使用完整组件 ID', [key]))
  }
  const visit = (key: string) => {
    const id = resolve(key)
    if (selected.has(id)) return
    const item = documents.get(id)!
    selected.set(id, copy(item))
    for (const dependency of references(item.body)) visit(dependency)
  }
  for (const entry of [...framework.bindings, ...framework.blocks])
    if (entry.source) visit(entry.source)
  for (const key of frameworkText(framework).flatMap(references)) visit(key)
  for (const [from, to] of Object.entries(framework.overrides ?? {})) {
    visit(from)
    visit(to)
  }
  return {
    format: 'infos-prompt-preset',
    version: 1,
    name: framework.name,
    exportedAt: new Date().toISOString(),
    framework: mapFramework(framework, resolve),
    documents: [...selected.values()].map((item) => ({
      ...item,
      body: rewrite(item.body, resolve),
    })),
  }
}

export function parsePromptPreset(value: unknown): PromptPreset {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(tr('不是有效的 infOS 提示词预设'))
  const input = value as Record<string, unknown>
  if (input.format !== 'infos-prompt-preset' || input.version !== 1)
    throw new Error(tr('不支持此预设格式或版本'))
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 100 ||
    typeof input.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(input.exportedAt)) ||
    !isPromptBundle({ documents: input.documents, frameworks: [input.framework], assignments: [] })
  )
    throw new Error(tr('不是有效的 infOS 提示词预设'))
  const result = copy(input) as unknown as PromptPreset
  const ids = result.documents.map((item) => item.id)
  if (ids.length > 500 || new Set(ids).size !== ids.length)
    throw new Error(tr('预设中的组件 ID 重复或数量超过限制'))
  // 重新遍历引用，拒绝缺少依赖的文件，避免导入后意外使用本地同名正文。
  const normalized = createPromptPreset(
    { documents: result.documents, frameworks: [result.framework], assignments: [] },
    result.framework.id,
  )
  return { ...normalized, name: result.name, exportedAt: result.exportedAt }
}

/** 每次导入分配独立命名空间，同时改写所有组件调用及替换关系。 */
export function preparePromptPreset(
  preset: PromptPreset,
  namespace: string,
): {
  framework: PromptFramework
  documents: PromptDocument[]
} {
  const names = new Map(
    preset.documents.map((item, index) => [item.id, `custom/preset/${namespace}/${index}`]),
  )
  const resolve = (key: string) => {
    const value = names.get(key)
    if (!value) throw new Error(tr('无法打包组件引用：{0}，请使用完整组件 ID', [key]))
    return value
  }
  const framework = mapFramework(preset.framework, resolve)
  framework.id = `custom.framework.${namespace}`
  framework.name = preset.name.trim()
  framework.builtin = false
  const documents = preset.documents.map((item) => {
    const result = {
      ...copy(item),
      id: resolve(item.id),
      builtin: false,
      body: rewrite(item.body, resolve),
    }
    delete result.builtinBodyHash
    return result
  })
  return { framework, documents }
}
