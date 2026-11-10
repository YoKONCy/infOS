/**
 * 表达调教里规则块的读写。
 *
 * 规则就是预设组件 components/expression/ 下的那几份，这里直接改「提示词」页手里的同一份草稿，
 * 所以两边永远同步。预设发布是整份发布的：保存前先和正在生效的版本比一遍，
 * 草稿里还有别的改动时交给用户决定，不悄悄带上。
 */
import { computed, ref, watch } from 'vue'
import type { PromptBundle, PromptDocument } from '@infos/shared'
import { t as __t } from '../../i18n/index'
import { promptApi } from '../../api/modules/promptApi'
import type { usePromptWorkspace } from '../../composables/dashboard/usePromptWorkspace'

export type ExpressionWorkspace = Pick<
  ReturnType<typeof usePromptWorkspace>,
  'view' | 'bundle' | 'busy' | 'error' | 'issues' | 'save' | 'confirm' | 'displayBuiltinName'
>

export type RuleKey = 'thinking'

/** 和预设「infOS 默认」里的区块同序。 */
export const RULE_KEYS: readonly RuleKey[] = ['thinking']

export const ruleDocumentId = (key: RuleKey) => `components/expression/${key}`

/** 只数她读到的字：去掉注释和程序用的条件标记。 */
export function countRuleChars(body: string): number {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{#[\s\S]*?#\}/g, '')
    .replace(/\{%[\s\S]*?%\}/g, '')
    .replace(/\s+/g, ' ')
    .trim().length
}

const VALUE_TOKENS: ReadonlyArray<[string, string]> = [
  ['owner_appellation', '〔你的称呼〕'],
  ['owner_name', '〔你的名字〕'],
  ['agent_name', '〔她的名字〕'],
]
const CONDITION_LABELS: ReadonlyArray<[string, string]> = [
  ["interaction_mode != 'minimal'", '不是极简模式时'],
  ["channel != 'social' and not realm_execution and interaction_mode != 'minimal'", '聊天和工作模式下'],
  ["channel != 'social' and not realm_execution", '不在社交频道和据点执行时'],
]
const CONDITION_END = '〔条件内容到此为止〕'
const conditionStart = (label: string) => `〔下面只在${label}发送〕`

/** 整份正文外面那层条件：只有它包住全部内容时才算，中间配对的不算。 */
function splitWrapper(body: string): { head: string; inner: string; tail: string } {
  const match = /^(\{%\s*if\s[^%]*%\}\r?\n)([\s\S]*)(\r?\n\{%\s*endif\s*%\})$/.exec(body)
  if (!match) return { head: '', inner: body, tail: '' }
  let depth = 0
  for (const tag of match[2]!.matchAll(/\{%\s*(if|endif)\b[^%]*%\}/g)) {
    depth += tag[1] === 'if' ? 1 : -1
    if (depth < 0) return { head: '', inner: body, tail: '' }
  }
  return depth === 0
    ? { head: match[1]!, inner: match[2]!, tail: match[3]! }
    : { head: '', inner: body, tail: '' }
}

/** 编辑框里显示的文字：外层条件藏起来，占位符和中间的条件换成看得懂的说法。 */
export function ruleBodyToText(body: string): string {
  let text = splitWrapper(body).inner
  for (const [name, token] of VALUE_TOKENS)
    text = text.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g'), token)
  for (const [condition, label] of CONDITION_LABELS)
    text = text.split(`{% if ${condition} %}`).join(conditionStart(label))
  return text.split('{% endif %}').join(CONDITION_END)
}

/** 把编辑框的文字换回正文，外层条件沿用 previous 里的。 */
export function ruleTextToBody(text: string, previous: string): string {
  const { head, tail } = splitWrapper(previous)
  let inner = text
  for (const [name, token] of VALUE_TOKENS) inner = inner.split(token).join(`{{ ${name} }}`)
  for (const [condition, label] of CONDITION_LABELS)
    inner = inner.split(conditionStart(label)).join(`{% if ${condition} %}`)
  return head + inner.split(CONDITION_END).join('{% endif %}') + tail
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  )
}

/**
 * 这份正文和正在生效的版本是否不同。
 * 旧版本里存的是当时的内置原文，程序升级后读取时会自动换成新的，这种差别不算用户的改动。
 */
export function documentChanged(
  current: PromptDocument,
  released: PromptDocument | undefined,
  original: PromptDocument | undefined,
): boolean {
  const isOriginal = Boolean(original && stable(current) === stable(original))
  if (!released) return !isOriginal
  if (stable(current) === stable(released)) return false
  return !(
    isOriginal &&
    released.builtin !== false &&
    released.builtinBodyHash !== original?.builtinBodyHash
  )
}

export interface OtherChange {
  id: string
  name: string
}

/** 除 exceptId 之外，current 和正在生效的版本有哪些不同。 */
export function listOtherChanges(
  current: PromptBundle,
  released: PromptBundle,
  defaults: PromptBundle,
  exceptId: string,
  nameOf: (item: { id: string; name: string; builtin?: boolean }) => string,
): OtherChange[] {
  const changes: OtherChange[] = []
  const documents = new Map(released.documents.map((item) => [item.id, item]))
  const originals = new Map(defaults.documents.map((item) => [item.id, item]))
  for (const item of current.documents) {
    const before = documents.get(item.id)
    documents.delete(item.id)
    if (item.id !== exceptId && documentChanged(item, before, originals.get(item.id)))
      changes.push({ id: item.id, name: nameOf(item) })
  }
  for (const item of documents.values())
    if (item.id !== exceptId) changes.push({ id: item.id, name: nameOf(item) })
  const frameworks = new Map(released.frameworks.map((item) => [item.id, item]))
  const defaultFrameworks = new Map(defaults.frameworks.map((item) => [item.id, item]))
  for (const item of current.frameworks) {
    const before = frameworks.get(item.id)
    frameworks.delete(item.id)
    const baseline = before ?? defaultFrameworks.get(item.id)
    if (!baseline || stable(baseline) !== stable(item))
      changes.push({ id: item.id, name: nameOf(item) })
  }
  for (const item of frameworks.values()) changes.push({ id: item.id, name: nameOf(item) })
  if (stable(current.assignments) !== stable(released.assignments))
    changes.push({ id: 'assignments', name: __t('ui.settings', '指派') })
  return changes
}

export function useExpressionRules(workspace: ExpressionWorkspace) {
  const released = ref<PromptBundle | null>(null)
  const pending = ref<{ documentId: string; others: OtherChange[] } | null>(null)
  const checking = ref(false)

  async function refreshReleased(): Promise<PromptBundle | null> {
    const id = workspace.view.value?.activeReleaseId
    if (!id) return null
    const response = await promptApi.version(id)
    released.value = response.data?.bundle ?? null
    return released.value
  }
  watch(
    () => workspace.view.value?.activeReleaseId,
    () => void refreshReleased().catch(() => undefined),
    { immediate: true },
  )

  const documentOf = (id: string) => workspace.bundle.value.documents.find((item) => item.id === id)
  const originalOf = (id: string) =>
    workspace.view.value?.defaults.documents.find((item) => item.id === id)

  /** 这块有没有还没生效的改动。 */
  function hasChanges(id: string): boolean {
    const current = documentOf(id)
    if (!current || !released.value) return false
    return documentChanged(
      current,
      released.value.documents.find((item) => item.id === id),
      originalOf(id),
    )
  }
  /** 这块在预设「infOS 默认」里对应的区块。 */
  const presetBlock = (id: string) =>
    workspace.bundle.value.frameworks
      .find((item) => item.id === 'builtin.main')
      ?.blocks.find((item) => item.source === id)
  const hasPreset = computed(() =>
    workspace.bundle.value.frameworks.some((item) => item.id === 'builtin.main'),
  )
  const isDefault = (id: string) => documentOf(id)?.body === originalOf(id)?.body

  async function commit(publish: boolean): Promise<void> {
    pending.value = null
    await workspace.save(publish)
  }

  /** 点一次保存：没有别的改动就直接发布；有就先问。 */
  async function saveRule(id: string): Promise<void> {
    const view = workspace.view.value
    if (!view || workspace.busy.value || checking.value) return
    checking.value = true
    workspace.error.value = ''
    try {
      const latest = await refreshReleased()
      if (!latest) throw new Error(__t('ui.chat', '读取失败'))
      const others = listOtherChanges(
        workspace.bundle.value,
        latest,
        view.defaults,
        id,
        workspace.displayBuiltinName,
      )
      if (others.length) pending.value = { documentId: id, others }
      else await commit(true)
    } catch (error) {
      workspace.error.value = error instanceof Error ? error.message : String(error)
    } finally {
      checking.value = false
    }
  }

  function restoreDefault(id: string): void {
    const original = originalOf(id)
    if (!original) return
    workspace.confirm(
      __t('ui.chat', '恢复默认'),
      __t('ui.chat', '这一块会换回默认内容，并在下一轮生效。'),
      () => {
        const documents = workspace.bundle.value.documents
        const index = documents.findIndex((item) => item.id === id)
        if (index < 0) return
        documents.splice(index, 1, JSON.parse(JSON.stringify(original)) as PromptDocument)
        void saveRule(id)
      },
    )
  }

  const blocked = computed(() => workspace.busy.value || checking.value)
  return {
    pending,
    blocked,
    documentOf,
    presetBlock,
    hasPreset,
    hasChanges,
    isDefault,
    saveRule,
    restoreDefault,
    publishAll: () => commit(true),
    saveDraftOnly: () => commit(false),
    cancelPending: () => {
      pending.value = null
    },
  }
}
