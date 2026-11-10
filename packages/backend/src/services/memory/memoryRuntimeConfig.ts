import { z } from 'zod'
import type { ConfigRepository } from '../../repositories/config.repo'

/** 主 Agent 记忆运行配置的唯一 KV 键。 */
export const MEMORY_RUNTIME_CONFIG_KEY = 'memory.runtime'

/** 记忆注入上限的可配置范围；更大的需求可设为 0（不限）。 */
export const MAX_MEMORY_TOKEN_BUDGET = 32_000

const channelConfigSchema = z.object({
  /** 主线历史正文的 Token 预算。 */
  historyTokenBudget: z.number().int().min(1024).max(262144).default(16384),
  /** 侧会话沿用的完整对话轮次配置。 */
  contextPairs: z.number().int().min(1).max(100).default(20),
  /** 是否在该通道自动注入 EventNote RAG。 */
  enableAutoRag: z.boolean(),
  /** 自动 RAG 的相关事件召回数量，不包含固定补充项。 */
  retrievalLimit: z.number().int().min(1).max(30),
  /**
   * 自动注入记忆的专属 Token 上限，含直接命中与固定补充；0 表示不限。
   * 超出时按优先级保留完整事件，不截断单条正文。
   */
  memoryTokenBudget: z.number().int().min(0).max(MAX_MEMORY_TOKEN_BUDGET),
})

/** 基础管线（未开启 SA-PPR）的相关度门槛；高级管线仍由 advanced.minScore 控制。 */
const basicConfigSchema = z.object({
  /**
   * 开启后候选必须有相关证据才注入：向量余弦达到 minSimilarity，或事件标签/正文与查询有文字重合；
   * 不足 top_k 时少放，直接前驱限额为 ceil(top_k / 2)。关闭即回到旧行为（按 top_k 补满）。
   */
  enableRelevanceGate: z.boolean(),
  /** 查询向量与事件向量的余弦相似度下限，独立于高级管线的混合分数。 */
  minSimilarity: z.number().min(-1).max(1),
})

const advancedConfigSchema = z.object({
  /** 自动 RAG 使用 TriviumDB 认知管线和 SA-PPR，主动查询仍使用确定性 BFS。 */
  enableSaPpr: z.boolean(),
  expandDepth: z.number().int().min(1).max(6),
  teleportAlpha: z.number().min(0).max(1),
  minScore: z.number().min(-1).max(1),
  enableFista: z.boolean(),
  enableDpp: z.boolean(),
  enableContextRnn: z.boolean(),
  enableLeiden: z.boolean(),
  enableFeedback: z.boolean(),
})

/** 核心记忆中管理的主 Agent 记忆运行配置。Social 应用配置不属于此合同。 */
const memoryRuntimeConfigShape = z
  .object({
    channels: z.object({
      desktop: channelConfigSchema,
      group: channelConfigSchema,
    }),
    basic: basicConfigSchema,
    advanced: advancedConfigSchema,
  })
  .transform((config) => {
    if (!config.advanced.enableSaPpr)
      return {
        ...config,
        advanced: {
          ...config.advanced,
          enableFista: false,
          enableDpp: false,
          enableContextRnn: false,
          enableLeiden: false,
          enableFeedback: false,
        },
      }
    return {
      ...config,
      advanced: {
        ...config.advanced,
        enableFeedback: config.advanced.enableContextRnn && config.advanced.enableFeedback,
      },
    }
  })

/** 读取与保存共用：先补齐旧版本缺失字段，再做严格校验。 */
export const memoryRuntimeConfigSchema = z.preprocess(
  (value) => migrateLegacyConfig(value),
  memoryRuntimeConfigShape,
)

export type MemoryRuntimeConfig = z.infer<typeof memoryRuntimeConfigShape>

/** RNN 是高级检索的可选子模块，不能独立于高级管线运行。 */
export function isContextRnnEnabled(advanced: MemoryRuntimeConfig['advanced']): boolean {
  return advanced.enableSaPpr && advanced.enableContextRnn
}

export function isContextRnnFeedbackEnabled(advanced: MemoryRuntimeConfig['advanced']): boolean {
  return isContextRnnEnabled(advanced) && advanced.enableFeedback
}

/** 同时遵守 Thread Policy 与通道级自动 RAG 开关。 */
export function shouldRunAutoRag(
  policyEnabled: boolean,
  channelConfig: MemoryRuntimeConfig['channels'][keyof MemoryRuntimeConfig['channels']] | undefined,
): boolean {
  return policyEnabled && channelConfig?.enableAutoRag !== false
}

export const DEFAULT_MEMORY_RUNTIME_CONFIG: MemoryRuntimeConfig = {
  channels: {
    desktop: {
      historyTokenBudget: 16384, contextPairs: 20, enableAutoRag: true,
      retrievalLimit: 8, memoryTokenBudget: 2000,
    },
    group: {
      historyTokenBudget: 16384, contextPairs: 20, enableAutoRag: true,
      retrievalLimit: 3, memoryTokenBudget: 1000,
    },
  },
  // 门槛默认开启并取保守值 0.2：主流中文 embedding 中明显无关的文本余弦通常低于此值，
  // 相关文本普遍更高；基线偏高的模型（如 e5 系列）上它几乎不排除任何候选，宁可少滤也不误删。
  basic: { enableRelevanceGate: true, minSimilarity: 0.2 },
  advanced: {
    enableSaPpr: false,
    expandDepth: 2,
    teleportAlpha: 0.15,
    minScore: 0.1,
    enableFista: false,
    enableDpp: false,
    enableContextRnn: false,
    enableLeiden: false,
    enableFeedback: false,
  },
}

/** 将旧版消息条数合同迁移为对话轮次合同；数值保持不变，尊重用户此前填写的窗口规模。 */
function migrateLegacyConfig(stored: unknown): unknown {
  if (!stored || typeof stored !== 'object') return stored
  const root = structuredClone(stored) as Record<string, unknown>
  if (!root.channels || typeof root.channels !== 'object') return root
  const channels = root.channels as Record<string, unknown>
  delete channels.companion
  for (const channelName of ['desktop', 'group']) {
    const channel = channels[channelName]
    if (!channel || typeof channel !== 'object') continue
    const values = channel as Record<string, unknown>
    if (values.contextPairs === undefined && typeof values.contextMessages === 'number') {
      values.contextPairs = values.contextMessages
    }
    if (values.enableAutoRag === undefined) {
      values.enableAutoRag = values.retrievalLimit !== 0
    }
    if (values.retrievalLimit === 0) {
      values.retrievalLimit =
        DEFAULT_MEMORY_RUNTIME_CONFIG.channels[
          channelName as keyof MemoryRuntimeConfig['channels']
        ].retrievalLimit
    }
    if (typeof values.memoryTokenBudget !== 'number') {
      values.memoryTokenBudget =
        DEFAULT_MEMORY_RUNTIME_CONFIG.channels[
          channelName as keyof MemoryRuntimeConfig['channels']
        ].memoryTokenBudget
    }
    delete values.contextMessages
  }
  delete root.scorerBatchSize
  delete root.retrievalMinScore
  const advanced =
    root.advanced && typeof root.advanced === 'object'
      ? (root.advanced as Record<string, unknown>)
      : {}
  const basic =
    root.basic && typeof root.basic === 'object' ? (root.basic as Record<string, unknown>) : {}
  root.basic = { ...structuredClone(DEFAULT_MEMORY_RUNTIME_CONFIG.basic), ...basic }
  root.advanced = {
    ...structuredClone(DEFAULT_MEMORY_RUNTIME_CONFIG.advanced),
    ...advanced,
  }
  return root
}

/** 从 ConfigRepository 读取并校验配置；缺失或损坏时返回安全默认值。 */
export async function loadMemoryRuntimeConfig(
  configRepo: Pick<ConfigRepository, 'get'>,
): Promise<MemoryRuntimeConfig> {
  const raw = await configRepo.get(MEMORY_RUNTIME_CONFIG_KEY)
  let stored: unknown
  if (raw) {
    try {
      stored = JSON.parse(raw)
    } catch {
      stored = undefined
    }
  }
  const parsed = memoryRuntimeConfigSchema.safeParse(stored)
  return parsed.success ? parsed.data : structuredClone(DEFAULT_MEMORY_RUNTIME_CONFIG)
}
