import type { TokenUsagePurpose } from '@infos/shared'
import type { UsageInfo } from './types'

export interface LlmUsageAttempt {
  id: string
  startedAt: number
  finishedAt: number
  provider: string
  modelId: string
  agentId?: string
  channel?: string
  threadId?: string
  applicationId?: string
  executionId?: string
  step?: number
  promptHash?: string
  prefixHash?: string
  toolsHash?: string
  purpose: TokenUsagePurpose
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  usage?: UsageInfo
}

/** 缺失与非法计数保留为空，不能伪装成供应商回传的零。 */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** 中转的同义计数字段只取一个，不能把缓存明细重复累加。 */
export function reportedCacheUsage(
  raw: Record<string, unknown>,
  preferredDetails: 'prompt_tokens_details' | 'input_tokens_details' = 'prompt_tokens_details',
): { cachedRead: number | undefined; cachedWrite: number | undefined } {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const details = record(raw[preferredDetails])
  const other = record(
    raw[
      preferredDetails === 'prompt_tokens_details'
        ? 'input_tokens_details'
        : 'prompt_tokens_details'
    ],
  )
  const first = (...values: unknown[]) =>
    values.map(tokenCount).find((value) => value !== undefined)
  const sum = (value: unknown, names: string[]) => {
    const parts = record(value)
    const present = names.filter((name) => parts[name] !== undefined)
    if (!present.length || present.some((name) => tokenCount(parts[name]) === undefined)) return
    return tokenCount(present.reduce((total, name) => total + (parts[name] as number), 0))
  }
  return {
    cachedRead: first(
      details.cached_tokens,
      other.cached_tokens,
      raw.cached_tokens,
      raw.cache_read_input_tokens,
      raw.prompt_cache_hit_tokens,
    ),
    cachedWrite: first(
      details.cache_write_tokens,
      other.cache_write_tokens,
      details.cached_creation_tokens,
      other.cached_creation_tokens,
      details.cache_creation_input_tokens,
      other.cache_creation_input_tokens,
      raw.cache_write_tokens,
      raw.cache_creation_input_tokens,
      sum(details.cache_write_tokens_details, ['ttl_30m_tokens', 'ttl_12h_tokens']),
      sum(other.cache_write_tokens_details, ['ttl_30m_tokens', 'ttl_12h_tokens']),
      sum(details.cache_creation, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']),
      sum(other.cache_creation, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']),
      sum(raw.cache_creation, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']),
      sum(raw, ['claude_cache_creation_5_m_tokens', 'claude_cache_creation_1_h_tokens']),
    ),
  }
}

/** DeepSeek 的未命中量不是写入量；仅在两项均上报且总输入缺失时补全输入。 */
export function reportedCacheInput(raw: Record<string, unknown>): number | undefined {
  const hit = tokenCount(raw.prompt_cache_hit_tokens)
  const miss = tokenCount(raw.prompt_cache_miss_tokens)
  return hit !== undefined && miss !== undefined ? tokenCount(hit + miss) : undefined
}

export function normalizeTokenUsage(values: {
  input: unknown
  output: unknown
  total?: unknown
  cachedRead?: unknown
  cachedWrite?: unknown
  reasoning?: unknown
}): UsageInfo | undefined {
  const input = tokenCount(values.input)
  const output = tokenCount(values.output)
  const total = tokenCount(values.total)
  if (input === undefined && output === undefined && total === undefined) return undefined
  return {
    promptTokens: input ?? 0,
    completionTokens: output ?? 0,
    totalTokens: Math.max(total ?? 0, (input ?? 0) + (output ?? 0)),
    inputReported: input !== undefined,
    outputReported: output !== undefined,
    cachedReadTokens: tokenCount(values.cachedRead),
    cachedWriteTokens: tokenCount(values.cachedWrite),
    reasoningTokens: tokenCount(values.reasoning),
  }
}
