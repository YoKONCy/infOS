import { t as __t } from './i18n'
/**
 * Social Scorer Service — 社交记忆图谱引擎
 *
 * 将社交平台高频消息炼化为 TriviumDB 图谱节点，
 * 采用 PEDSA 理性轨道 (RAG-less) 架构：
 * - **不做向量化** (零 Embedding API 开销)
 * - **不走 Reflection 管道** (无 tagger/consolidator)
 * - 检索靠 BM25 + 关键词 AC 自动机 + 图谱扩散
 *
 * 数据写入 social.tdb (物理隔离):
 * - Event 节点: 零向量 + 摘要 payload + BM25 文本索引
 * - Feature 节点: 关键词 + AC 自动机索引
 * - Feature→Event 边: memory_edge
 * - Feature→Feature 边: representation / equality (本体关联)
 *
 * 动态门控 (D50):
 * - 默认 200 条未总结消息触发
 * - 未总结正文达到 50k Token 时提前触发（应对长消息场景）
 *
 * @module packages/apps/social/runtime/socialScorer
 */

import type { TriviumDB } from 'triviumdb'
import type { SocialStoragePort } from '@infos/shared'
import type {
  LlmService,
  MdpEngine,
  MemoryStoreRegistry,
  ModelConfig,
} from '@infos/backend/applicationHostAbi'
import { createLogger, parseLlmJson, tokenCounter } from '@infos/backend/applicationHostAbi'
import { socialDelay, socialFailure } from './socialRecovery'

const logger = createLogger('SocialScorer')

// ─────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────

export interface SocialScorerConfig {
  /** 默认消息数触发阈值 */
  messageThreshold: number
  /** Token 触发阈值；保留旧字段名兼容现有配置。 */
  charThreshold: number
  /** 每次拉取的最大消息数 */
  batchLimit: number
  /** 最大重试次数 */
  maxRetries: number
}

const DEFAULT_CONFIG: SocialScorerConfig = {
  messageThreshold: 200,
  charThreshold: 50_000,
  batchLimit: 200,
  maxRetries: 3,
}

// ─────────────────────────────────────────────
// LLM 输出结构 (PEDSA 简化格式)
// ─────────────────────────────────────────────

/** 事件节点 */
interface PedsaEvent {
  summary: string
  features: string[]
}

/** 本体关联更新 */
interface OntologyUpdate {
  source: string
  target: string
  relation: 'representation' | 'equality'
  strength: number
}

/** LLM 完整输出 */
interface SocialScorerOutput {
  new_event: PedsaEvent
  ontology_updates: OntologyUpdate[]
}

// ─────────────────────────────────────────────
// ID 生成 (确定性哈希)
// ─────────────────────────────────────────────

/**
 * FNV-1a 哈希函数 → 生成 TriviumDB 节点 ID
 *
 * Feature 节点使用关键词哈希 → 同一关键词总是映射到同一 ID。
 * Event 节点使用时间戳 + 计数器。
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5 // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0 // FNV prime, 保持 u32
  }
  // 避免与 Event ID 冲突，Feature ID 固定在高位区间
  return (hash | 0x80000000) >>> 0 // 确保最高位为 1
}

/** Event ID 计数器 (低位区间，不会与 Feature 冲突) */
let eventIdCounter = 0

function nextEventId(): number {
  // 使用 timestamp (秒) * 1000 + 计数器，保证唯一
  const base = Math.floor(Date.now() / 1000)
  return (base * 1000 + (eventIdCounter++ % 1000)) >>> 0
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

export class SocialScorerService {
  private controllers = new Map<string, AbortController>()
  cancel(agentId: string): void {
    this.controllers.get(agentId)?.abort(new Error('社交记忆已清理'))
  }
  private config: SocialScorerConfig
  /** 零向量缓存 (避免每次分配) */
  private zeroVector: number[] = []

  constructor(
    private socialMessageRepo: SocialStoragePort,
    private storeRegistry: MemoryStoreRegistry,
    private llmService: LlmService,
    private getModelConfig: () => Promise<ModelConfig | null>,
    private mdpEngine: MdpEngine,
    /** Agent 管理器（可选注入，用于按 agentId 读取该角色的称呼） */
    private agentManager?: { getOwnerAppellation(agentId: string): string },
    config?: Partial<SocialScorerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 检查动态门控并触发炼化
   *
   * 条件 (OR):
   * - 消息数 >= messageThreshold (默认 200)
   * - 未总结正文 Token >= charThreshold（默认 50k）
   */
  async shouldProcess(agentId: string): Promise<boolean> {
    if (this.socialMessageRepo.memoryBackground?.enabled === false) return false
    if (!(await this.socialMessageRepo.memoryAvailable(agentId)) || !(await this.getModelConfig()))
      return false
    const stats = await this.socialMessageRepo.getUnsummarizedStats(agentId)
    if (!stats.count) return false
    if (stats.count >= this.config.messageThreshold) return true
    const messages = await this.socialMessageRepo.getUnsummarized(agentId, this.config.batchLimit)
    return (
      tokenCounter.countMessages(
        messages.map((message) => ({ role: 'user', content: message.content })),
      ) >= this.config.charThreshold
    )
  }

  async checkAndProcess(agentId: string, signal?: AbortSignal): Promise<void> {
    if (this.socialMessageRepo.memoryBackground?.enabled === false) return
    signal?.throwIfAborted()
    const stats = await this.socialMessageRepo.getUnsummarizedStats(agentId)
    if (stats.count === 0) return

    const messages = await this.socialMessageRepo.getUnsummarized(agentId, this.config.batchLimit)
    const totalTokens = tokenCounter.countMessages(
      messages.map((message) => ({ role: 'user', content: message.content })),
    )

    const messageTriggered = stats.count >= this.config.messageThreshold
    const tokenTriggered = totalTokens >= this.config.charThreshold

    if (!messageTriggered && !tokenTriggered) {
      logger.debug(
        __t('apps.social.logs', '[{0}] 社交记忆未达门控: ', [agentId]) +
          __t('apps.social.logs', '{0}/{1} 条, ', [stats.count, this.config.messageThreshold]) +
          `${totalTokens}/${this.config.charThreshold} Token`,
      )
      return
    }

    const reason = tokenTriggered
      ? `Token 溢出 (${totalTokens} >= ${this.config.charThreshold})`
      : `消息数达标 (${stats.count} >= ${this.config.messageThreshold})`

    logger.info(__t('apps.social.logs', '[{0}] 触发社交记忆炼化: {1}', [agentId, reason]))
    await this.processBatch(agentId, signal)
  }

  /**
   * 执行一批社交消息的图谱炼化
   *
   * 流程:
   * 1. 拉取 batchLimit 条未总结消息
   * 2. LLM → PEDSA 简化格式 (new_event + ontology_updates)
   * 3. 写入 social.tdb:
   *    - Event 节点 (零向量 + payload)
   *    - Feature 节点 (indexKeyword)
   *    - Feature→Event 边 + Feature→Feature 边
   *    - BM25 文本索引
   * 4. 标记原始消息为已总结
   */
  async processBatch(agentId: string, cancellation?: AbortSignal): Promise<void> {
    if (this.socialMessageRepo.memoryBackground?.enabled === false) return
    if (this.controllers.has(agentId)) return
    if (!(await this.socialMessageRepo.memoryAvailable(agentId))) return
    const version = await this.socialMessageRepo.getDataVersion(agentId)
    const controller = new AbortController()
    this.controllers.set(agentId, controller)
    const signal = AbortSignal.any([
      controller.signal,
      ...(cancellation ? [cancellation] : []),
      ...(this.socialMessageRepo.memoryBackground
        ? [this.socialMessageRepo.memoryBackground.signal]
        : []),
    ])
    try {
      const promptSnapshot = this.mdpEngine.capturePromptSnapshot?.()
      const messages = await this.socialMessageRepo.getUnsummarized(agentId, this.config.batchLimit)

      if (messages.length === 0) {
        logger.debug(__t('apps.social.logs', '[{0}] 无未总结社交消息', [agentId]))
        return
      }

      logger.info(
        __t('apps.social.logs', '[{0}] 开始炼化 {1} 条社交消息', [agentId, messages.length]),
      )

      // 格式化对话上下文
      const chatText = messages
        .map(
          (m) =>
            `[平台:${m.platform} 账号:${m.accountId} 会话:${m.channelType}:${m.channelId} 发送者:${m.senderId}] ${m.senderName ?? '未知'}: ${m.content}`,
        )
        .join('\n')

      const channelType = messages[0]?.channelType ?? 'group'
      const channelId = messages[0]?.channelId ?? '未知'
      const addresses = new Set(
        messages.map((m) => JSON.stringify([m.platform, m.accountId, m.channelType, m.channelId])),
      )
      const sessionName =
        addresses.size > 1
          ? '多个已标明来源的社交会话'
          : `${messages[0]?.platform} · ${channelType === 'private' ? '私聊' : '群聊'} ${channelId}`

      // 获取反思模型配置
      const modelConfig = await this.getModelConfig()
      if (!modelConfig) {
        logger.warn(__t('apps.social.logs', '未配置反思模型，跳过社交记忆炼化'))
        return
      }

      // 用户称呼：取该 Agent 的 agent.json owner_appellation（兜底"主人"），注入模板生成带称呼的示例/摘要
      const ownerAppellation = this.agentManager?.getOwnerAppellation(agentId) ?? '主人'
      // 渲染 MDP 模板（AIOS 第八阶段：模板已迁移到 apps/social/prompts/）
      const prompt = this.mdpEngine.render(
        'apps/social/tasks/social_segment_summarizer',
        {
          agent_id: agentId,
          channel: 'social',
          session_type: channelType,
          session_name: sessionName,
          chat_text: chatText,
          agent_name: agentId,
          owner_appellation: ownerAppellation,
        },
        promptSnapshot,
      )

      // LLM 调用
      const result = await this.callLlmWithRetry(modelConfig, prompt, signal)
      signal.throwIfAborted()
      if (
        version !== (await this.socialMessageRepo.getDataVersion(agentId)) ||
        !(await this.socialMessageRepo.memoryAvailable(agentId))
      )
        return
      signal.throwIfAborted()

      if (!result?.new_event?.summary) {
        logger.warn(__t('apps.social.logs', '[{0}] LLM 未返回有效事件', [agentId]))
        await this.socialMessageRepo.markSummarized(messages.map((m) => m.id))
        return
      }

      // 写入图谱
      const store = this.storeRegistry.getAgentStore(agentId, 'social')
      await this.writeToGraph(store, result, agentId)

      // 标记原始消息已总结
      await this.socialMessageRepo.markSummarized(messages.map((m) => m.id))

      logger.info(
        __t('apps.social.logs', '[{0}] 社交图谱已更新: ', [agentId]) +
          `"${result.new_event.summary.slice(0, 50)}" | ` +
          `features: [${result.new_event.features.join(', ')}] | ` +
          __t('apps.social.logs', 'ontology: {0} 条边', [result.ontology_updates?.length ?? 0]),
      )
    } catch (err) {
      if (signal.aborted) return
      logger.error(__t('apps.social.logs', '[{0}] 社交记忆炼化失败: {1}', [agentId, err]))
      throw err
    } finally {
      if (this.controllers.get(agentId) === controller) this.controllers.delete(agentId)
    }
  }

  // ── 图谱写入 ──

  /**
   * 将 PEDSA 格式的 LLM 输出写入 TriviumDB (social.tdb)
   */
  private async writeToGraph(
    store: TriviumDB,
    output: SocialScorerOutput,
    agentId: string,
  ): Promise<void> {
    const { new_event, ontology_updates } = output
    // 每次写入读取当前 Store 的真实维度，覆盖模型热切换后的零向量缓存。
    const dimension = store.dim()
    if (this.zeroVector.length !== dimension) this.zeroVector = new Array(dimension).fill(0)

    // 1. 写入 Event 节点
    const eventId = nextEventId()
    store.insertWithId(eventId, this.zeroVector, {
      type: 'event',
      content: new_event.summary,
      agentId,
      timestamp: Math.floor(Date.now() / 1000),
      features: new_event.features,
    })

    // BM25 文本索引
    store.indexText(eventId, new_event.summary)

    // 2. 注册 Feature 节点 + 建 Feature→Event 边
    for (const keyword of new_event.features) {
      const featureId = this.getOrCreateFeature(store, keyword)
      if (featureId < 0) continue // 停用词跳过

      // Feature → Event 边
      store.link(featureId, eventId, 'memory_edge', 1.0)
    }

    // 3. 写入本体关联 (Feature → Feature)
    if (ontology_updates?.length) {
      for (const update of ontology_updates) {
        const srcId = this.getOrCreateFeature(store, update.source)
        const tgtId = this.getOrCreateFeature(store, update.target)
        if (srcId < 0 || tgtId < 0) continue

        const strength = Math.max(0.1, Math.min(1.0, update.strength ?? 0.5))
        store.link(srcId, tgtId, update.relation ?? 'representation', strength)

        // equality 是双向的
        if (update.relation === 'equality') {
          store.link(tgtId, srcId, 'equality', 1.0)
        }
      }
    }

    // 4. 重编译 BM25 索引 (使 searchHybrid 生效)
    store.buildTextIndex()
  }

  /**
   * 获取或创建 Feature 节点
   *
   * 使用 FNV-1a 哈希生成确定性 ID:
   * 同一关键词始终映射到同一节点 → 自动聚合多次出现的关键词。
   */
  private getOrCreateFeature(store: TriviumDB, keyword: string): number {
    const normalized = keyword.toLowerCase().trim()
    if (normalized.length < 2) return -1 // 太短的词跳过

    const featureId = fnv1aHash(normalized)
    const existing = store.get(featureId)

    if (!existing) {
      // 首次出现：创建 Feature 节点
      store.insertWithId(featureId, this.zeroVector, {
        type: 'feature',
        content: normalized,
      })
      // AC 自动机关键词索引
      store.indexKeyword(featureId, normalized)
    }

    return featureId
  }

  // ── LLM 调用 ──

  /**
   * LLM 调用 (带重试)
   */
  private async callLlmWithRetry(
    modelConfig: ModelConfig,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SocialScorerOutput | null> {
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      signal?.throwIfAborted()
      try {
        const response = await this.llmService.chat(
          modelConfig,
          [{ role: 'user', content: prompt }],
          {
            responseFormat: { type: 'json_object' },
            signal,
            maxRetries: 0,
          },
        )

        const rawContent = response.choices?.[0]?.message?.content ?? ''
        const parsed = parseLlmJson<SocialScorerOutput>(rawContent)

        if (parsed?.new_event?.summary) return parsed

        logger.warn(__t('apps.social.logs', '[尝试 {0}] LLM 返回无效 JSON，重试', [attempt + 1]))
      } catch (err) {
        signal?.throwIfAborted()
        if (socialFailure(err).retryable && attempt < this.config.maxRetries - 1) {
          logger.warn(
            __t('apps.social.logs', '[尝试 {0}] LLM 调用失败: {1}，2 秒后重试', [attempt + 1, err]),
          )
          await socialDelay(2000, signal)
        } else {
          throw err
        }
      }
    }
    return null
  }
}
