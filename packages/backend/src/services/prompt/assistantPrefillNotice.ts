import type { AssistantPrefillSkipReason } from '@infos/shared'
import { t as __t } from '../../lib/i18n'

/** 预填充跳过原因只在展示边界本地化；业务判断始终使用稳定的原因代码。 */
export function assistantPrefillSkipText(reason: AssistantPrefillSkipReason): string {
  switch (reason) {
    case 'user_disabled':
      return __t('server.agent', '模型设置为不支持预填充')
    case 'claude_thinking':
      return __t('server.agent', 'Claude 开启思考时不能预填充')
    case 'claude_prefill_removed':
      return __t('server.agent', '该 Claude 型号已不支持预填充')
    case 'gemini_unknown':
      return __t('server.agent', 'Gemini 接口没有可靠的续写约定')
    case 'openai_responses':
      return __t('server.agent', 'Responses 接口不保证续写')
    case 'openai_chat':
      return __t('server.agent', 'OpenAI 兼容接口不保证续写')
    case 'deepseek_no_beta':
      return __t('server.agent', 'DeepSeek 需使用 /beta 地址才支持前缀续写')
    case 'deepseek_thinking':
      return __t('server.agent', 'DeepSeek 思考模式未启用前缀续写')
    case 'fallback_unsupported':
      return __t('server.agent', '回退模型不支持相同的预填充方式')
  }
}
