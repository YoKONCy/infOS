import type { TtsAdapterId, TtsVoicePreset, TtsWorkspace } from '@infos/shared'
import { resolveModelBrand, resolveProviderBrand, type ModelBrandId } from './modelBrands'

const adapterBrands: Record<TtsAdapterId, ModelBrandId | undefined> = {
  edge_tts: 'microsoft',
  openai: 'openai',
  mimo: 'mimo',
  bailian: 'bailian',
  minimax: 'minimax',
  stepfun: 'stepfun',
  custom: undefined,
}

/** 适配器选择展示协议品牌；模型与连接仍按各自身份识别。 */
export function ttsAdapterBrand(adapter: TtsAdapterId): ModelBrandId | undefined {
  return adapterBrands[adapter]
}

export function ttsPresetBrand(
  workspace: TtsWorkspace,
  preset: TtsVoicePreset,
): ModelBrandId | undefined {
  const model = workspace.models.find((item) => item.id === preset.modelId)
  const profile = workspace.profiles.find((item) => item.id === model?.profileId)
  if (profile?.adapter === 'edge_tts') return 'microsoft'
  // 未知模型使用真实服务商标识，避免将第三方兼容协议误标成 OpenAI。
  const connection = workspace.connections.find((item) => item.id === model?.connectionId)
  return (
    resolveModelBrand(model?.modelId) ?? resolveProviderBrand(profile?.adapter, connection?.apiBase)
  )
}
