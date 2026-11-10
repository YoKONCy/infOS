/**
 * NIT Stream Filter — 流式过滤器
 *
 * 从 SSE 流中实时拦截 <nit> 脚本块：
 * 1. 在流式推送时隐藏 <nit>...</nit> 内容（用户不可见）
 * 2. 收集完整 NIT 脚本块供后续执行
 * 3. 正常文本透传
 *
 * 统一 NIT 流式过滤与 Thinking 块过滤。
 *
 * @module packages/backend/src/nit/streamFilter
 */

/** NIT 流式过滤器 */
export class NitStreamFilter {
  /** 内部缓冲区 */
  private buffer = ''
  /** 是否在 <nit> 块内 */
  private inNitBlock = false
  /** 收集到的 NIT 脚本块 */
  private collectedScripts: string[] = []
  /** 当前块的内容 */
  private currentScript = ''

  /** 开始标签 */
  private readonly START_TAG = '<nit>'
  /** 结束标签 */
  private readonly END_TAG = '</nit>'

  /**
   * 处理流式文本块
   *
   * @returns 应该发送给用户的安全文本 (NIT 块被过滤)
   */
  filter(chunk: string): string {
    this.buffer += chunk
    let output = ''

    while (this.buffer.length > 0) {
      if (!this.inNitBlock) {
        // 查找 <nit> 开始
        const startIdx = this.buffer.indexOf(this.START_TAG)

        if (startIdx === -1) {
          // 没有开始标签 → 输出安全部分 (保留末尾以防截断)
          const safeLen = this.buffer.length - this.START_TAG.length
          if (safeLen > 0) {
            output += this.buffer.slice(0, safeLen)
            this.buffer = this.buffer.slice(safeLen)
          }
          return output
        }

        // 输出 <nit> 之前的文本
        output += this.buffer.slice(0, startIdx)
        // 跳过 <nit> 标签
        this.buffer = this.buffer.slice(startIdx + this.START_TAG.length)
        this.inNitBlock = true
        this.currentScript = ''
      } else {
        // 在 NIT 块内，查找 </nit>
        const endIdx = this.buffer.indexOf(this.END_TAG)

        if (endIdx === -1) {
          const keepLen = this.END_TAG.length - 1
          if (this.buffer.length > keepLen) {
            this.currentScript += this.buffer.slice(0, this.buffer.length - keepLen)
            this.buffer = this.buffer.slice(this.buffer.length - keepLen)
          }
          return output
        }

        // 收集完整脚本
        this.currentScript += this.buffer.slice(0, endIdx)
        this.collectedScripts.push(this.currentScript.trim())
        this.currentScript = ''

        // 跳过 </nit>
        this.buffer = this.buffer.slice(endIdx + this.END_TAG.length)
        this.inNitBlock = false
      }
    }

    return output
  }

  /** 刷新缓冲区 (流结束时调用) */
  flush(): string {
    let result = ''
    if (!this.inNitBlock) {
      result = this.buffer
    } else {
      // 未闭合的 NIT 块，丢弃
      this.currentScript += this.buffer
      if (this.currentScript.trim()) {
        this.collectedScripts.push(this.currentScript.trim())
      }
    }
    this.buffer = ''
    this.currentScript = ''
    return result
  }

  /** 获取收集到的所有 NIT 脚本 */
  getCollectedScripts(): string[] {
    return this.collectedScripts
  }

  /** 是否有收集到的脚本 */
  hasScripts(): boolean {
    return this.collectedScripts.length > 0
  }

  /** 重置 */
  reset(): void {
    this.buffer = ''
    this.inNitBlock = false
    this.collectedScripts = []
    this.currentScript = ''
  }
}

/**
 * Thinking 块流式过滤器
 *
 * 解析 `<innerVoice>...</innerVoice>` 碎碎念块，兼容 selfMinding（用户预填充常用）和旧 think / thinking / thought 标签。
 *
 * 流式处理要点：
 * - 标签可能跨 chunk 拆分，保留可能尚未完整的开始标签
 * - 块内内容通过独立事件发送，不混入可见正文
 * - 未闭合的块在 flush 时结束，内容仍保留在碎碎念中
 */
export type ThinkingStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'start' }
  | { type: 'delta'; delta: string }
  | { type: 'end' }

type ThinkingTag = 'innervoice' | 'selfminding' | 'think' | 'thinking' | 'thought'

export class ThinkingStreamFilter {
  private buffer = ''
  private activeTag: ThinkingTag | null = null
  private events: ThinkingStreamEvent[] = []
  private pendingDelta = ''
  private readonly START_TAG = /<(innerVoice|selfMinding|think|thinking|thought)(?:\s[^>]*)?>/i
  private readonly PARTIAL_TAG_RESERVE = '<selfMinding>'.length - 1

  private pushDelta(delta: string, force = false): void {
    this.pendingDelta += delta
    if (
      this.pendingDelta &&
      (force || this.pendingDelta.length >= 24 || /[。！？!?；;：:\n]$/.test(this.pendingDelta))
    ) {
      this.events.push({ type: 'delta', delta: this.pendingDelta })
      this.pendingDelta = ''
    }
  }

  private pushText(text: string): void {
    if (text) this.events.push({ type: 'text', text })
  }

  filter(chunk: string): string {
    this.buffer += chunk
    let output = ''

    while (this.buffer.length > 0) {
      if (!this.activeTag) {
        const start = this.START_TAG.exec(this.buffer)
        if (!start || start.index === undefined) {
          let safeLen = this.buffer.length - this.PARTIAL_TAG_RESERVE
          // 带属性的开始标签也可能跨块，不能提前把标签前半段发到正文。
          const tagStart = this.buffer.lastIndexOf('<')
          if (
            tagStart >= 0 &&
            /^<(innerVoice|selfMinding|think|thinking|thought)\s[^>]*$/i.test(this.buffer.slice(tagStart))
          )
            safeLen = Math.min(safeLen, tagStart)
          if (safeLen > 0) {
            const text = this.buffer.slice(0, safeLen)
            output += text
            this.pushText(text)
            this.buffer = this.buffer.slice(safeLen)
          }
          return output
        }
        const prefix = this.buffer.slice(0, start.index)
        output += prefix
        this.pushText(prefix)
        this.buffer = this.buffer.slice(start.index + start[0].length)
        this.activeTag = start[1]!.toLowerCase() as ThinkingTag
        this.events.push({ type: 'start' })
      } else {
        const endTag = `</${this.activeTag}>`
        const endIdx = this.buffer.toLowerCase().indexOf(endTag)
        if (endIdx !== -1) {
          this.pushDelta(this.buffer.slice(0, endIdx), true)
          this.buffer = this.buffer.slice(endIdx + endTag.length)
          this.activeTag = null
          this.events.push({ type: 'end' })
          continue
        }
        const safeLen = this.buffer.length - (endTag.length - 1)
        if (safeLen > 0) {
          this.pushDelta(this.buffer.slice(0, safeLen))
          this.buffer = this.buffer.slice(safeLen)
        }
        return output
      }
    }

    return output
  }

  flush(): string {
    const result = this.activeTag ? '' : this.buffer
    if (!this.activeTag) this.pushText(result)
    else {
      this.pushDelta(this.buffer, true)
      this.events.push({ type: 'end' })
    }
    this.buffer = ''
    this.activeTag = null
    this.pendingDelta = ''
    return result
  }

  drainEvents(): ThinkingStreamEvent[] {
    const events = this.events
    this.events = []
    return events
  }
}
