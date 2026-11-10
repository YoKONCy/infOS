import { Tiktoken } from 'tiktoken/lite'
import o200kBase from 'tiktoken/encoders/o200k_base'
import type { ContextTokenizer } from '@infos/shared'

/** 后端统一使用的本地 o200k_base Tokenizer。 */
export class O200kTokenCounter implements ContextTokenizer {
  readonly tokenizerId = 'o200k_base'
  private readonly encoder = new Tiktoken(
    o200kBase.bpe_ranks,
    o200kBase.special_tokens,
    o200kBase.pat_str,
  )

  // 缓存精确文本的计数，复用每轮重复的模板、工具定义与历史消息。
  // 同时限制条目数和字符总量，超大文本直接计算，避免计数缓存反过来抬高内存。
  private readonly counts = new Map<string, number>()
  private cachedCharacters = 0
  private readonly maxCachedCharacters = 65_536
  private readonly maxCachedEntries = 256

  countTokens(content: string): number {
    if (!content) return 0
    const cached = this.counts.get(content)
    if (cached !== undefined) {
      this.counts.delete(content)
      this.counts.set(content, cached)
      return cached
    }
    const count = this.encoder.encode_ordinary(content).length
    if (content.length > this.maxCachedCharacters) return count
    while (
      this.counts.size >= this.maxCachedEntries ||
      this.cachedCharacters + content.length > this.maxCachedCharacters
    ) {
      const oldest = this.counts.keys().next().value!
      this.counts.delete(oldest)
      this.cachedCharacters -= oldest.length
    }
    this.counts.set(content, count)
    this.cachedCharacters += content.length
    return count
  }

  countMessages(messages: ReadonlyArray<{ role: string; content: unknown }>): number {
    return messages.reduce((total, message) => {
      const content =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      return total + this.countTokens(message.role) + this.countTokens(content ?? '')
    }, 0)
  }
}

/** 单例复用词表与 WASM 实例，避免每次计数重复初始化。 */
export const tokenCounter = new O200kTokenCounter()
