import type { PromptDocument } from '@infos/shared'
import { promptFingerprint } from '../llm/promptCache'

// 只登记已经确认的历史内置原文；不能根据关键字或 builtin 标记猜测用户是否改写过。
const legacyBodies: Record<string, readonly string[]> = {
  'slots/800_pet_state': ['55b2e7a610ceceaadc408f70fe28d2306dbc71629d6e385b627630c6d9fec8fc'],
  'components/abilities/interaction_mode': [
    'bc44ea018a8fbb68c2d6b877d7c96069d2a9fe713888bf863c8f4849e628d97f',
  ],
  'components/state/turn_context': [
    'ad6124337c958adcbaddcf0aacf94570ea9607e354459881731c2c1cb0a16a83',
  ],
  'components/output/output_constraint': [
    'e565322797295df1ad7c05db8bb20a1cbe7097026c15f229cf69ec4d227bfaec',
    'edfec3d206fa6b20f4adb66cd2ccc646de46ecb4af15cba29917b6f21402b9ae',
  ],
  'apps/social/social_rules': ['02fc8edf9ebb6cd959581c856d42305029246cf2adf4e011026b4b9390cc6232'],
  'tasks/runtime/memory.extract': [
    '7641bba723653536e3bfc33ad57511e72eff318b5c2912a03e8570585fd15791',
  ],
  'tasks/runtime/memory.reflect': [
    '8186d4daf1157cef0110410244783640188742d5754bc7538f6d62420e8b71cd',
  ],
}

export function builtinBodyHash(body: string): string {
  return promptFingerprint(body.replaceAll('\r\n', '\n'))
}

/** 原样内置正文跟随安装版本更新；用户正文、名称、开关、角色和历史发布原件保持原样。 */
export function synchronizeBuiltinDocument(
  document: PromptDocument,
  original: PromptDocument,
): void {
  if (document.builtin === false || !original.builtin || document.id !== original.id) return
  const currentHash = builtinBodyHash(document.body)
  const sourceHash = builtinBodyHash(original.body)
  const unchanged = document.builtinBodyHash
    ? currentHash === document.builtinBodyHash
    : legacyBodies[document.id]?.includes(currentHash)
  if (currentHash === sourceHash || unchanged) {
    document.body = original.body
    document.variables = [...original.variables]
    document.builtinBodyHash = sourceHash
  }
}
