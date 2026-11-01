import { z } from 'zod'
import { REASONING_EFFORT_VALUES } from '@infos/shared'

export const assistantGenerationSchema = z
  .object({
    temperature: z.number().finite().min(0).max(2).optional(),
    topP: z.number().finite().min(0).max(1).optional(),
    maxTokens: z.number().int().min(1).max(262144).optional(),
    reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
  })
  .strict()

export const llmCallOptionsSchema = assistantGenerationSchema
  .extend({
    timeoutMs: z.number().int().min(30000).max(600000).optional(),
  })
  .strict()
export type LlmCallOptions = z.infer<typeof llmCallOptionsSchema>

export const assistantSettingsSchema = z
  .object({
    providerId: z
      .union([z.literal(''), z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/)])
      .default(''),
    model: z.string().trim().max(200).default(''),
    generation: assistantGenerationSchema.default({}),
    contextScope: z.enum(['canvas', 'selection']).default('canvas'),
    historyMessages: z.number().int().min(0).max(40).default(12),
    contextCharacters: z.number().int().min(4000).max(64000).default(64000),
    timeoutSeconds: z.number().int().min(30).max(600).default(600),
    instructions: z.string().trim().max(8000).default(''),
  })
  .strict()
export type AssistantSettings = z.infer<typeof assistantSettingsSchema>
export interface AssistantSettingsRecord {
  revision: number
  settings: AssistantSettings
}
export const defaultAssistantSettings = (): AssistantSettings => assistantSettingsSchema.parse({})

/** 留空的参数不发送，让宿主模型或供应商沿用自己的默认配置。 */
export function assistantCallOptions(settings: AssistantSettings): LlmCallOptions {
  return { ...settings.generation, timeoutMs: settings.timeoutSeconds * 1000 }
}

/** 独立助手使用现有 Chat Completions 协议，配置字段在边界转换。 */
export function assistantRequestParameters(
  settings: AssistantSettings,
  modelId = '',
): Record<string, unknown> {
  const { temperature, topP, maxTokens, reasoningEffort } = settings.generation
  const limitField = /^(?:o\d|gpt-[56])(?:[.-]|$)/i.test(modelId)
    ? 'max_completion_tokens'
    : 'max_tokens'
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    ...(maxTokens === undefined ? {} : { [limitField]: maxTokens }),
    ...(reasoningEffort === undefined
      ? {}
      : { reasoning_effort: reasoningEffort === 'off' ? 'none' : reasoningEffort }),
  }
}
