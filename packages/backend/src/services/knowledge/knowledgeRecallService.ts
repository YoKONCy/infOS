import { z } from 'zod'
import type { KnowledgeRecallSettings } from '@infos/shared'
import type { ConfigRepository } from '../../repositories/config.repo'
import type { FactsRepository } from '../../repositories/facts.repo'
import type { KnowledgeRepository } from '../../repositories/knowledge.repo'
import type { KnowledgeIndex } from './knowledgeIndex'
import { fitKnowledgeText } from './knowledgeText'
import { tokenCounter } from '../tokenizer/tokenCounter'
import { createLogger } from '../../lib/logger'
import { t } from '../../lib/i18n'

export const KNOWLEDGE_RECALL_CONFIG_KEY = 'knowledge.recall'
export const knowledgeRecallSettingsSchema = z
  .object({
    documentAutoRecall: z.boolean(),
    factAutoRecall: z.boolean(),
  })
  .strict()
const defaults: KnowledgeRecallSettings = { documentAutoRecall: false, factAutoRecall: false }
const logger = createLogger('KnowledgeRecall')
const xml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
const field = (value: string, tokens: number) => xml(fitKnowledgeText(value, tokens))

/** 条目感知的工具提示与本轮资料召回；不进入事件记忆检索、学习或反馈链。 */
export class KnowledgeRecallService {
  constructor(
    private readonly config: Pick<ConfigRepository, 'get' | 'set'>,
    private readonly documents: Pick<KnowledgeRepository, 'hasReadyParts'>,
    private readonly index: Pick<KnowledgeIndex, 'search'>,
    private readonly facts: Pick<FactsRepository, 'hasActiveFacts' | 'recall'>,
  ) {}

  async settings(): Promise<KnowledgeRecallSettings> {
    try {
      const parsed = knowledgeRecallSettingsSchema.safeParse(
        JSON.parse((await this.config.get(KNOWLEDGE_RECALL_CONFIG_KEY)) ?? '{}'),
      )
      return parsed.success ? parsed.data : { ...defaults }
    } catch {
      return { ...defaults }
    }
  }

  async saveSettings(input: KnowledgeRecallSettings): Promise<KnowledgeRecallSettings> {
    const settings = knowledgeRecallSettingsSchema.parse(input)
    await this.config.set(KNOWLEDGE_RECALL_CONFIG_KEY, JSON.stringify(settings))
    return settings
  }

  description(name: string, description: string): string | undefined {
    if (name === 'search_knowledge')
      return this.documents.hasReadyParts()
        ? `${description} 库内有用户资料，相关主题可查询参考。`
        : undefined
    if (name === 'query_facts' && this.facts.hasActiveFacts())
      return `${description} 库内有已记录的事实，相关人物或项目可查询参考。`
    return description
  }

  tools<T extends { name: string; description: string }>(definitions: T[]): T[] {
    return definitions.flatMap((tool) => {
      const description = this.description(tool.name, tool.description)
      return description === undefined ? [] : [{ ...tool, description }]
    })
  }

  async recall(
    query: string,
    allowed: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<{
    knowledge: string
    facts: string
    documentHits: number
    factHits: number
  }> {
    const settings = await this.settings()
    const text = query.trim().slice(0, 800)
    const result = { knowledge: '', facts: '', documentHits: 0, factHits: 0 }
    if (!text) return result
    signal?.throwIfAborted()
    const documents = async () => {
      if (
        !settings.documentAutoRecall ||
        !allowed.has('search_knowledge') ||
        !this.documents.hasReadyParts()
      )
        return
      try {
        const input = { keywords: [text], limit: 3 }
        let found
        try {
          const timeout = AbortSignal.timeout(2500)
          found = await this.index.search(
            input,
            signal ? AbortSignal.any([signal, timeout]) : timeout,
            { minVectorScore: 0.55 },
          )
        } catch {
          signal?.throwIfAborted()
          // 自动语义召回超时后仍可使用本地文本结果，不阻塞正常对话。
          found = await this.index.search(input, signal, { vector: false })
        }
        for (const hit of found.items) {
          const entry = `<document id="${xml(hit.documentId)}" part_id="${xml(hit.id)}" revision="${hit.revision}" title="${field(hit.documentTitle, 60)}" source="${field(hit.source, 80)}">${field(hit.summary, 150)}</document>`
          if (tokenCounter.countTokens(result.knowledge + entry + '\n') > 1000) break
          result.knowledge += entry + '\n'
          result.documentHits++
        }
      } catch (cause) {
        signal?.throwIfAborted()
        logger.warn(t('logs.knowledge-recall', '文档知识自动召回失败，已继续对话'), cause)
      }
    }
    const facts = async () => {
      if (!settings.factAutoRecall || !allowed.has('query_facts') || !this.facts.hasActiveFacts())
        return
      try {
        for (const fact of this.facts.recall(text, 4)) {
          const entry = `<fact id="${xml(fact.id)}" object="${field(fact.objectName, 60)}" observed_at="${xml(fact.observedAt)}" source="${field(fact.source ?? '', 60)}">${field(fact.statement, 120)}</fact>`
          if (tokenCounter.countTokens(result.facts + entry + '\n') > 650) break
          result.facts += entry + '\n'
          result.factHits++
        }
      } catch (cause) {
        signal?.throwIfAborted()
        logger.warn(t('logs.knowledge-recall', '事实自动召回失败，已继续对话'), cause)
      }
    }
    await Promise.all([documents(), facts()])
    signal?.throwIfAborted()
    return result
  }
}
