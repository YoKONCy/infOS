/**
 * 预填充续写判定
 *
 * 预填充只在上游真的“接着末尾 assistant 继续写”时才能拼回正文前。若预填充以未闭合的
 * 思考标签结尾（如 `<selfMinding>`），把它拼回一份并非续写的完整答案，会让整轮可见回复
 * 被思考过滤器吞进思考块。这里在拼回前等待证据：
 *
 * - 出现对应的关闭标签 → 上游确实在续写，拼回预填充；
 * - 上游自己从思考开标签重新开头 → 视为重新生成，不再重复拼回；
 * - 直到流结束或转入工具调用都没有关闭标签 → 上游没有按续写协议走，原样作为正文发布。
 *
 * 不以思考标签结尾的普通文本预填充没有吞答风险，保持旧行为：首段正文到达时直接拼回。
 */

const THINKING_TAG = /<(selfMinding|think|thinking|thought)(?:\s[^>]*)?>/gi

/** 预填充末尾仍未闭合的思考标签名（小写）；没有则返回 undefined。 */
export function unclosedThinkingTag(prefill: string): string | undefined {
  let last: { tag: string; end: number } | undefined
  for (const match of prefill.matchAll(THINKING_TAG))
    last = { tag: match[1]!.toLowerCase(), end: match.index! + match[0].length }
  if (!last) return undefined
  return prefill.slice(last.end).toLowerCase().includes(`</${last.tag}>`) ? undefined : last.tag
}

/** none：无预填充；plain：普通文本已拼回；continued：确认续写；restarted/ignored：未续写，未拼回。 */
export type PrefillOutcome = 'none' | 'pending' | 'plain' | 'continued' | 'restarted' | 'ignored'

export class PrefillContinuationGate {
  private buffer = ''
  private state: PrefillOutcome
  private readonly tag?: string

  constructor(private readonly prefill: string) {
    this.tag = prefill ? unclosedThinkingTag(prefill) : undefined
    this.state = prefill ? 'pending' : 'none'
  }

  get outcome(): PrefillOutcome {
    return this.state
  }

  /** 是否仍有尚未发布的上游正文。 */
  get hasBuffered(): boolean {
    return this.buffer.length > 0
  }

  /** 输入上游正文片段，返回可交给下游过滤器的文本；判定未完成时暂存。 */
  push(chunk: string): string {
    if (!chunk) return ''
    if (this.state !== 'pending') return chunk
    if (!this.tag) {
      this.state = 'plain'
      return this.prefill + chunk
    }
    this.buffer += chunk
    if (!new RegExp(`</${this.tag}\\s*>`, 'i').test(this.buffer)) return ''
    return this.release(true)
  }

  /**
   * 工具参数开始生成时调用。尚无暂存正文时沿用原行为拼回预填充，使工具调用消息与请求一致；
   * 已有暂存正文的交给 finish() 按未续写发布。
   */
  startToolCall(): string {
    if (this.state !== 'pending' || this.buffer) return ''
    this.state = 'plain'
    return this.prefill
  }

  /** 流结束、转入工具调用或中断时调用；未见关闭标签即按“未续写”发布暂存正文。 */
  finish(): string {
    if (this.state !== 'pending' || !this.buffer) return ''
    return this.release(false)
  }

  private release(closed: boolean): string {
    const text = this.buffer
    this.buffer = ''
    // 上游从思考开标签重新开头，说明它没有把预填充当成自己的开头。
    if (/^\s*<(selfMinding|think|thinking|thought)(?:\s[^>]*)?>/i.test(text)) {
      this.state = 'restarted'
      return text
    }
    this.state = closed ? 'continued' : 'ignored'
    return closed ? this.prefill + text : text
  }
}

/** 非流式整段回复的同一判定；纯工具调用沿用原行为拼回预填充，空回复不拼回。 */
export function completePrefilledContent(
  prefill: string,
  content: string,
  hasToolCalls = false,
): string {
  const gate = new PrefillContinuationGate(prefill)
  const text = gate.push(content)
  return text + (hasToolCalls ? gate.startToolCall() : '') + gate.finish()
}
