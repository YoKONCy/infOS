import {
  resolveAssistantPrefillForChain,
  type AssistantPrefillSkipReason,
  type AssistantPrefillTarget,
} from '@infos/shared'
import { t } from '../i18n'

/** 模型卡片上的预填充能力选项；文案随语言切换重新读取。 */
export function assistantPrefillSupportOptions() {
  return [
    { value: 'auto', label: t('ui.settings', '自动判断（推荐）') },
    { value: 'supported', label: t('ui.settings', '支持，始终发送') },
    { value: 'unsupported', label: t('ui.settings', '不支持，从不发送') },
  ]
}

function skipReasonText(reason: AssistantPrefillSkipReason): string {
  switch (reason) {
    case 'user_disabled':
      return t('ui.settings', '已设置为不支持')
    case 'claude_thinking':
      return t('ui.settings', 'Claude 开启思考时不能预填充')
    case 'claude_prefill_removed':
      return t('ui.settings', '该 Claude 型号已不支持预填充')
    case 'gemini_unknown':
      return t('ui.settings', 'Gemini 接口没有可靠的续写约定')
    case 'openai_responses':
      return t('ui.settings', 'Responses 接口不保证续写')
    case 'openai_chat':
      return t('ui.settings', 'OpenAI 兼容接口不保证续写')
    case 'deepseek_no_beta':
      return t('ui.settings', 'DeepSeek 需使用 /beta 地址才支持前缀续写')
    case 'deepseek_thinking':
      return t('ui.settings', 'DeepSeek 思考模式未启用前缀续写')
    case 'fallback_unsupported':
      return t('ui.settings', '回退模型不支持相同的预填充方式')
  }
}

/** 按当前表单给出“实际会不会发送”的一句话结论；回退链在运行时另行检查。 */
export function assistantPrefillEffectText(target: AssistantPrefillTarget): string {
  const decision = resolveAssistantPrefillForChain([target])
  if (!decision.enabled)
    return t('ui.settings', '当前设置下不会发送预填充：{0}', [skipReasonText(decision.reason)])
  return decision.protocol === 'deepseek_prefix'
    ? t('ui.settings', '当前设置下会发送预填充（DeepSeek 前缀续写）')
    : t('ui.settings', '当前设置下会发送预填充')
}
