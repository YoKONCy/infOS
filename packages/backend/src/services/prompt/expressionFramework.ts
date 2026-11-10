import type { PromptBundle, PromptFramework } from '@infos/shared'
import myPreset from './myPreset.json'
import myVariables from './myVariables.json'

type Block = PromptFramework['blocks'][number]

const block = (key: string, name: string, enabled = true): Block => ({
  id: `expression_${key}`,
  name,
  kind: 'template',
  role: 'system',
  enabled,
  source: `components/expression/${key}`,
})

export const isExpressionBlock = (item: Block): boolean =>
  Boolean(item.source?.startsWith('components/expression/'))

/** 默认框架在输出约定前加入手册和可编辑的表达规则。 */
export function withExpressionBlocks(blocks: Block[]): Block[] {
  const at = blocks.findIndex((item) => item.id === 'output_format')
  if (at < 0) return blocks
  return [
    ...blocks.slice(0, at),
    block('handbook', '表达·手册'),
    block('thinking', '表达规则'),
    blocks[at]!,
    ...blocks.slice(at + 1),
  ]
}

/** 「我的预设」：infOS 默认的副本，跟 infOS 默认一样享受缓存和本轮状态的处理。 */
export const MY_FRAMEWORK_ID = 'builtin.mine'
export const MY_FRAMEWORK_NAME = '我的预设'

interface MyPresetBlock {
  file: string
  name: string
  enabled?: boolean
}

/** 我的预设的区块，列在 myPreset.json 里（预设工作台改的就是它），按顺序放在输出格式前面。 */
export function withMyBlocks(blocks: Block[]): Block[] {
  const rest = blocks.filter((item) => !isExpressionBlock(item))
  const at = rest.findIndex((item) => item.id === 'output_format')
  if (at < 0) return blocks
  return [
    ...rest.slice(0, at),
    ...(myPreset as MyPresetBlock[]).map((item) => block(item.file, item.name, item.enabled !== false)),
    ...rest.slice(at),
  ]
}

interface MyVariable {
  name: string
  label: string
  value: string
}

/** 内置的固定变量，列在 myVariables.json 里（预设工作台登记）；同名时以程序自己算出的值为准。 */
export const MY_VARIABLES: readonly MyVariable[] = myVariables as MyVariable[]
export const myVariableValues = (): Record<string, string> =>
  Object.fromEntries(MY_VARIABLES.map((item) => [item.name, item.value]))

/** infOS 默认附带的「我的预设」：infOS 默认的副本，表达层区块按 myPreset.json 排。 */
export function myDefaultFramework(main: PromptFramework): PromptFramework {
  return {
    ...structuredClone(main),
    id: MY_FRAMEWORK_ID,
    name: MY_FRAMEWORK_NAME,
    blocks: withMyBlocks(main.blocks),
  }
}

/** 仅对原样默认布局补入表达区块，用户自定义的区块与指派原地保留。 */
export function migrateExpressionLayout(result: PromptBundle, defaults: PromptBundle): void {
  const main = result.frameworks.find((framework) => framework.id === 'builtin.main')
  const standard = defaults.frameworks.find((framework) => framework.id === 'builtin.main')
  if (main?.format === 'infos' && standard) {
    const previousBlocks = standard.blocks.filter((item) => !isExpressionBlock(item))
    const layout = (blocks: Block[]) => blocks.map((item) => [item.id, item.source, item.enabled])
    if (JSON.stringify(layout(main.blocks)) === JSON.stringify(layout(previousBlocks)))
      main.blocks = withExpressionBlocks(main.blocks)
  }
  if (!result.frameworks.some((framework) => framework.id === MY_FRAMEWORK_ID)) {
    const mine = defaults.frameworks.find((framework) => framework.id === MY_FRAMEWORK_ID)
    const documents = new Set(result.documents.map((document) => document.id))
    const sources = [...(mine?.bindings ?? []), ...(mine?.blocks ?? [])]
      .flatMap((item) => item.source ? [item.source] : [])
    if (mine && sources.every((source) => documents.has(source)))
      result.frameworks.push(structuredClone(mine))
  }
}
