export const REASONING_EFFORT_VALUES = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number]

/** 模型设置页和会话快捷设置共用相同的档位与兼容规则。 */
export function usesReasoningLevels(modelId: string): boolean {
  return /gemini[-_ ]?4(?:[._ /-]|$)/i.test(modelId)
}

export function normalizeReasoningEffort(
  modelId: string,
  effort?: ReasoningEffort | null,
): ReasoningEffort | undefined {
  if (!effort || !REASONING_EFFORT_VALUES.includes(effort)) return undefined
  if (!usesReasoningLevels(modelId)) return effort
  return effort === 'off' ? 'low' : effort === 'xhigh' || effort === 'max' ? 'high' : effort
}

export function reasoningEffortOptions(modelId: string, defaultLabel = '默认（不传）') {
  return [
    { label: defaultLabel, value: '' },
    { label: '关闭', value: 'off' },
    { label: 'Low', value: 'low' },
    { label: 'Medium', value: 'medium' },
    { label: 'High', value: 'high' },
    { label: 'XHigh', value: 'xhigh' },
    { label: 'Max', value: 'max' },
  ].filter(
    (option) => !usesReasoningLevels(modelId) || !['off', 'xhigh', 'max'].includes(option.value),
  )
}

export interface ThreadModelSettings {
  threadId: string
  modelConfigId: number | null
  reasoningEffort: ReasoningEffort | null
  effective: {
    name: string
    modelId: string
    reasoningEffort: ReasoningEffort | null
    enableVision: boolean
    enableAudioInput: boolean
    nativeAudioAvailable?: boolean
  }
  models: Array<{
    id: number
    name: string
    modelId: string
    reasoningEffort: ReasoningEffort | null
  }>
}
