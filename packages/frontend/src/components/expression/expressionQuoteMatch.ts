/**
 * 在 Markdown 渲染后的文本里定位被批注的句子。
 *
 * 选中文字（selection.toString）和渲染结果之间的空白并不一致：跨段时多出换行，
 * 行内元素之间可能少空格，所以比较时忽略全部空白，再映射回原文本节点。
 */
const IGNORED = /[\s​-‍﻿]/
const SKIPPED_PARENTS = 'button, script, style, .katex-mathml, [aria-hidden="true"]'

/** 回复正文的容器；工具卡片、思考块不算正文。 */
export const REPLY_TEXT_SELECTOR = '.surface-markdown-block'

interface TextPoint {
  node: Text
  offset: number
}

export function stripQuoteSpace(text: string): string {
  let result = ''
  for (const char of text) if (!IGNORED.test(char)) result += char
  return result
}

function collectText(containers: Iterable<Element>): { text: string; points: TextPoint[] } {
  let text = ''
  const points: TextPoint[] = []
  for (const container of containers) {
    const walker = container.ownerDocument.createTreeWalker(container, 4 /* SHOW_TEXT */)
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
      if (node.parentElement?.closest(SKIPPED_PARENTS)) continue
      const value = node.data
      for (let offset = 0; offset < value.length; offset++) {
        const char = value[offset]!
        if (IGNORED.test(char)) continue
        text += char
        points.push({ node, offset })
      }
    }
  }
  return { text, points }
}

/** 返回 quote 第一次出现的位置；匹配不到（消息改过、公式等）返回 null。 */
export function locateQuote(root: Element, quote: string): Range | null {
  const target = stripQuoteSpace(quote)
  if (!target) return null
  const { text, points } = collectText(root.querySelectorAll(REPLY_TEXT_SELECTOR))
  const start = text.indexOf(target)
  if (start < 0) return null
  const first = points[start]!
  const last = points[start + target.length - 1]!
  const range = root.ownerDocument.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset + 1)
  return range
}

/** 管理页展示原消息片段：quote 前后各留一段；找不到 quote 时取开头。 */
export function snippetAround(
  content: string,
  quote: string,
  context = 120,
): { before: string; match: string; after: string } {
  const plain = content.trim()
  const index = quote ? plain.indexOf(quote) : -1
  if (index < 0) {
    const limit = context * 3
    return {
      before: plain.length > limit ? `${plain.slice(0, limit)}…` : plain,
      match: '',
      after: '',
    }
  }
  const from = Math.max(0, index - context)
  const to = Math.min(plain.length, index + quote.length + context)
  return {
    before: `${from > 0 ? '…' : ''}${plain.slice(from, index)}`,
    match: quote,
    after: `${plain.slice(index + quote.length, to)}${to < plain.length ? '…' : ''}`,
  }
}
