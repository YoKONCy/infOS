import type { ModelConfigItem } from '../api/modules/modelApi'
import { t } from '../i18n/index'

export type ModelEditorPayload = Omit<ModelConfigItem, 'id'>
export type ModelEditorErrors = Record<string, string>

/** 保存前收敛表单值；空白可选参数表示不传，非法数值仍明确报错。 */
export function prepareModelPayload(
  form: Omit<ModelEditorPayload, 'apiKey'> & { apiKey?: string },
): {
  payload: ModelEditorPayload
  errors: ModelEditorErrors
} {
  const errors: ModelEditorErrors = {}
  const modelId = form.modelId.trim()
  const name = form.name.trim() || modelId.slice(0, 100)
  if (!modelId) errors.modelId = t('ui.settings', '请填写模型 ID')
  if (name.length > 100) errors.name = t('ui.settings', '模型名称不能超过 100 个字符')
  const numberValue = (
    field: 'temperature' | 'topP' | 'maxTokens' | 'contextWindowTokens' | 'maxReActTurns',
    min: number,
    max: number,
    integer: boolean,
  ): number | null => {
    const value: unknown = form[field]
    if (value == null || (typeof value === 'string' && !value.trim())) return null
    const numeric =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (
      !Number.isFinite(numeric) ||
      numeric < min ||
      numeric > max ||
      (integer && !Number.isSafeInteger(numeric))
    ) {
      errors[field] = t('ui.settings', '请检查{0}的数值', [modelEditorFieldLabel(field)])
      return null
    }
    return numeric
  }
  return {
    payload: {
      name,
      modelId,
      provider: form.provider.trim(),
      providerConnectionId: form.providerConnectionId?.trim() || null,
      connectionOverride: form.connectionOverride,
      connectionProtocol: form.connectionProtocol,
      connectionAuthMode: form.connectionAuthMode,
      apiBase: form.apiBase?.trim() || '',
      apiKey: form.connectionAuthMode === 'none' ? '' : form.apiKey?.trim() || '',
      temperature: numberValue('temperature', 0, 2, false),
      topP: numberValue('topP', 0, 1, false),
      maxTokens: numberValue('maxTokens', 1, Number.MAX_SAFE_INTEGER, true),
      contextWindowTokens: numberValue('contextWindowTokens', 1, Number.MAX_SAFE_INTEGER, true),
      maxReActTurns: numberValue('maxReActTurns', 1, Number.MAX_SAFE_INTEGER, true),
      reasoningEffort: form.reasoningEffort || null,
      returnNativeReasoning: form.returnNativeReasoning,
      wireApi: form.wireApi,
      reasoningDialect: form.reasoningDialect,
      assistantPrefill: form.assistantPrefill,
      stream: form.stream,
      enableVision: form.enableVision,
      enableAudioInput: form.enableAudioInput,
    },
    errors,
  }
}

/** 校验错误使用界面字段名；不展示请求正文或密钥。 */
export function modelEditorFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    name: t('ui.settings', '模型名称'),
    modelId: t('ui.settings', '模型 ID'),
    provider: t('ui.settings', '品牌模板'),
    providerConnectionId: t('ui.settings', '服务商连接'),
    connectionOverride: t('ui.settings', '自定义此模型的连接'),
    connectionProtocol: t('ui.settings', '协议格式'),
    connectionAuthMode: t('ui.settings', '认证方式'),
    apiBase: t('ui.settings', 'API 地址'),
    apiKey: 'API Key',
    temperature: t('ui.settings', '温度 Temperature'),
    topP: 'Top P',
    maxTokens: t('ui.settings', '最大输出 Token'),
    contextWindowTokens: t('ui.settings', '上下文窗口 Token'),
    maxReActTurns: t('ui.settings', '最大轮次'),
    reasoningEffort: t('ui.settings', '思考等级'),
    returnNativeReasoning: t('ui.settings', '显示原生思考'),
    wireApi: 'Wire API',
    reasoningDialect: t('ui.settings', '思考兼容模式'),
    assistantPrefill: t('ui.settings', '回答预填充能力'),
    stream: t('ui.settings', '流式输出'),
    enableVision: t('ui.settings', '图片视觉 (Vision)'),
    enableAudioInput: t('ui.settings', '音频输入 (Audio)'),
  }
  return labels[field] ?? t('ui.settings', '请求参数')
}
