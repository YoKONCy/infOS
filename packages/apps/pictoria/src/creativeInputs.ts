export const referencePurposes = ['subject', 'style', 'composition', 'scene', 'costume'] as const
export type ReferencePurpose = (typeof referencePurposes)[number]
export interface ReferenceUse {
  field: string
  assetId: string
  purpose: ReferencePurpose
}
export interface VideoContinuation {
  version: 1
  source: { assetId: string }
  sourceItemId: string
  sourceName: string
  sourceTime: number
  sourceDuration: number
  frame: { assetId: string }
}
interface InputSchema {
  properties?: Record<string, { type?: string; enum?: unknown[]; maxLength?: number }>
}
export function referencePromptField(schema: InputSchema): string | undefined {
  return Object.entries(schema.properties ?? {}).find(
    ([name, field]) =>
      /^(prompt|instruction|instructions|text)$/i.test(name) &&
      field.type === 'string' &&
      !field.enum,
  )?.[0]
}
const purposeInstructions: Record<ReferencePurpose, string> = {
  subject: '主体身份：参考主体外观与身份，不照搬背景、服装或构图。',
  style: '视觉风格：参考色彩、光照与绘制风格，不复制人物身份或画面内容。',
  composition: '构图：参考机位、布局与主体位置，不替换本次要求中的主体。',
  scene: '场景：参考环境与空间，不把图中的其他人物带入。',
  costume: '服装：参考衣着与配饰，不改变本次指定的主体身份。',
}
/** 用途只作用于本次实际引用；保留原文和图片顺序，不修改供应商协议。 */
export function applyReferenceUses(
  schema: InputSchema,
  inputs: Record<string, unknown>,
  uses: readonly ReferenceUse[] = [],
) {
  const promptField = referencePromptField(schema)
  const instructions: string[] = []
  for (const [name, value] of Object.entries(inputs)) {
    const references = Array.isArray(value) ? value : [value]
    references.forEach((reference, index) => {
      if (
        !reference ||
        typeof reference !== 'object' ||
        !('assetId' in reference) ||
        typeof reference.assetId !== 'string'
      )
        return
      const use = uses.find((entry) => entry.field === name && entry.assetId === reference.assetId)
      if (use && referencePurposes.includes(use.purpose))
        instructions.push(`${name} 第 ${index + 1} 张参考图：${purposeInstructions[use.purpose]}`)
    })
  }
  if (!instructions.length) return inputs
  if (!promptField || typeof inputs[promptField] !== 'string')
    throw new Error('REFERENCE_PURPOSE_PROMPT_REQUIRED')
  return {
    ...inputs,
    [promptField]: `${inputs[promptField]}\n\n【本次参考图用途】\n${instructions.join('\n')}`,
  }
}
/** 只有步骤明确声明起始帧字段时才开放接续，不能由图片数量猜测能力。 */
export function videoStartField(schema: InputSchema & Record<string, unknown>): string | undefined {
  const capability = schema['x-pictoria-video'] as { startFrameField?: unknown } | undefined
  if (!capability || typeof capability.startFrameField !== 'string') return
  return schema.properties?.[capability.startFrameField] ? capability.startFrameField : undefined
}
