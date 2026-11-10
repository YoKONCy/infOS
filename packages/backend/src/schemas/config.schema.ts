/**
 * 配置 API 请求校验
 *
 * @module packages/backend/src/schemas/config.schema
 */

import { z } from 'zod'
import { validHomeSettings } from '../services/home/homeSettingsSchema'
import { homeMessage } from '../services/home/homeErrors'
import { LANGUAGE_CONFIG_KEY, SUPPORTED_LOCALES } from '@infos/shared/i18n'
import {
  EMBEDDING_ENABLED_KEY,
  isMemoryBackgroundSwitchKey,
  WHOLESOME_MODE_KEY,
  ASSISTANT_PREFILL_KEY,
  DYNAMIC_CONTEXT_DEPTH_KEY,
  isAssistantPrefillConfig,
} from '@infos/shared'

/** 单项设置、批量设置和整份配置导入共用同一份预填充校验。 */
export function validAssistantPrefillSetting(value: string): boolean {
  try {
    return isAssistantPrefillConfig(JSON.parse(value))
  } catch {
    return false
  }
}

/** 获取配置 */
export const getConfigSchema = z.object({
  key: z.string().min(1),
})

/** 设置配置 */
export const setConfigSchema = z
  .object({
    key: z.string().min(1),
    value: z.string(),
  })
  .refine(({ key, value }) => validHomeSettings(key, value), {
    error: () => homeMessage('HOME_INVALID'),
  })
  .refine(
    ({ key, value }) =>
      key !== LANGUAGE_CONFIG_KEY || (SUPPORTED_LOCALES as readonly string[]).includes(value),
    { message: '仅支持简体中文、繁體中文和 English' },
  )
  .refine(
    ({ key, value }) =>
      (!isMemoryBackgroundSwitchKey(key) && ![EMBEDDING_ENABLED_KEY, WHOLESOME_MODE_KEY].includes(key)) ||
      value === 'true' ||
      value === 'false',
    { message: '开关配置必须为 true 或 false' },
  )
  .refine(
    ({ key, value }) => key !== ASSISTANT_PREFILL_KEY || validAssistantPrefillSetting(value),
    { message: '预填充配置无效，正文最多 8000 个字符' },
  )
  .refine(
    ({ key, value }) => key !== DYNAMIC_CONTEXT_DEPTH_KEY || value === '0' || value === '1',
    { message: '动态填充深度只能为 0 或 1' },
  )

/** 批量获取配置 */
export const batchGetConfigSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(50),
})
