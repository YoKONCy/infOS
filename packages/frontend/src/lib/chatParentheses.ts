interface TextRun {
  node: Text
  start: number
  end: number
}

interface TextRange {
  start: number
  end: number
}

const BLOCK_ELEMENT =
  /^(?:P|DIV|PRE|BLOCKQUOTE|H[1-6]|UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|DL|DT|DD|HR)$/
const PROTECTED_CONTENT =
  'code, pre, a, button, svg, math, .katex, .chat-math-block, .chat-xml-inline'

/** 按括号类型配对，嵌套范围只绘制最外层；不跨换行或容器边界匹配。 */
function parentheticalRanges(text: string): TextRange[] {
  const stack: Array<{ open: string; start: number }> = []
  const ranges: TextRange[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === '\n' || char === '\r') {
      stack.length = 0
    } else if (char === '（' || char === '(') {
      stack.push({ open: char, start: index })
    } else if (char === '）' || char === ')') {
      const previous = stack.at(-1)
      if (previous?.open === (char === '）' ? '（' : '(')) {
        stack.pop()
        ranges.push({ start: previous.start, end: index + 1 })
      } else {
        stack.length = 0
      }
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end)
  const outermost: TextRange[] = []
  let coveredUntil = -1
  for (const range of ranges) {
    if (range.start < coveredUntil) continue
    outermost.push(range)
    coveredUntil = range.end
  }
  return outermost
}

/** 逐个文本片段着色，保留加粗、引号、资源链接等原有 DOM 与事件边界。 */
function decorateRuns(runs: TextRun[], text: string): void {
  const ranges = parentheticalRanges(text)
  let rangeIndex = 0
  for (const run of runs) {
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= run.start) rangeIndex++
    if (!ranges[rangeIndex] || ranges[rangeIndex]!.start >= run.end) continue
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (let index = rangeIndex; index < ranges.length && ranges[index]!.start < run.end; index++) {
      const range = ranges[index]!
      const start = Math.max(run.start, range.start) - run.start
      const end = Math.min(run.end, range.end) - run.start
      if (cursor < start) fragment.append(run.node.data.slice(cursor, start))
      const span = document.createElement('span')
      span.className = 'chat-parenthetical'
      span.textContent = run.node.data.slice(start, end)
      fragment.append(span)
      cursor = end
    }
    if (cursor < run.node.length) fragment.append(run.node.data.slice(cursor))
    run.node.replaceWith(fragment)
  }
}

/** 只修饰正文中的中英文圆括号；受保护的行内节点作为整体跨过，不读取其内部括号。 */
export function decorateChatParentheses(root: DocumentFragment): void {
  let runs: TextRun[] = []
  let pieces: string[] = []
  let length = 0
  const flush = () => {
    if (runs.length) decorateRuns(runs, pieces.join(''))
    runs = []
    pieces = []
    length = 0
  }
  // 空节点作为块结束标记，避免深层行内 HTML 递归耗尽调用栈。
  const pending: Array<Node | null> = [root]
  while (pending.length) {
    const node = pending.pop()
    if (!node) {
      flush()
    } else if (node instanceof Text) {
      runs.push({ node, start: length, end: length + node.length })
      pieces.push(node.data)
      length += node.length
    } else if (node instanceof Element) {
      const block = BLOCK_ELEMENT.test(node.tagName)
      if (block || node.tagName === 'BR') flush()
      if (node.matches(PROTECTED_CONTENT)) {
        if (!block) {
          pieces.push('\uFFFC')
          length++
        }
        continue
      }
      if (node.tagName === 'BR') continue
      if (block) pending.push(null)
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        pending.push(node.childNodes[index]!)
    } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        pending.push(node.childNodes[index]!)
    }
  }
  flush()
}
