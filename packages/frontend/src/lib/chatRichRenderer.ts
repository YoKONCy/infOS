import { t as __t, getDisplayLocale } from '../i18n/index'
/**
 * chatRichRenderer — 前端领域模块
 *
 * 集中管理该领域的数据转换、状态边界与外部交互。
 * 调用方依赖这里的稳定契约，不直接耦合底层传输或运行时实现。
 */
import DOMPurify from 'dompurify'
import { decorateChatParentheses } from './chatParentheses'
import { isResourceLink, isFileReference } from './resourceLinks'
import { Marked, Renderer } from 'marked'
import katex from 'katex'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerLanguage('text', plaintext)
hljs.registerLanguage('powershell', powershell)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)

const renderer = new Renderer()

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

renderer.code = ({ text, lang }) => {
  const language = (lang || 'text').trim().split(/\s+/)[0]?.toLowerCase() || 'text'
  if (language === 'peromath') return renderMath(text.trim(), true)
  const highlighted =
    text.length <= 32_000 && hljs.getLanguage(language)
      ? hljs.highlight(text, { language, ignoreIllegals: true }).value
      : escapeHtml(text)
  return __t(
    'ui.chatRichRenderer',
    '<div class="chat-code-block"><div class="chat-code-head"><span>{0}</span><button type="button" data-copy-code>复制</button></div><pre><code class="hljs language-{1}">{2}</code></pre></div>',
    [escapeHtml(language.toUpperCase()), escapeHtml(language), highlighted],
  )
}

let parsingLinkLabel = false
renderer.codespan = ({ text }) =>
  !parsingLinkLabel && isFileReference(text)
    ? `<a href="#" class="chat-resource-chip" data-resource-source="${escapeHtml(text)}"><code>${escapeHtml(text)}</code><span aria-hidden="true">↗</span></a>`
    : `<code>${escapeHtml(text)}</code>`

// 嵌套在强调或表格中的本地图片不直接加载设备路径，仍提供统一的可点击资源入口。
renderer.image = ({ href, text }) => {
  const image = /^https?:\/\//i.test(href)
    ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" referrerpolicy="no-referrer">`
    : escapeHtml(text || href)
  if (parsingLinkLabel) return image
  if (isResourceLink(href) || /^https?:\/\//i.test(href))
    return `<a href="#" class="chat-resource-chip" data-resource-source="${escapeHtml(href)}">${image}<span aria-hidden="true">↗</span></a>`
  return escapeHtml(text)
}

const SAFE_INLINE_HTML =
  /^<\/?(?:span|mark|small|kbd|sub|sup|u|s|b|i|strong|em)(?:\s[^>]*)?>$|^<br\s*\/?>$/i

/** 安全行内HTML交给DOMPurify净化后渲染；其他HTML/XML继续显示为源码。 */
renderer.html = ({ text }) =>
  SAFE_INLINE_HTML.test(text.trim())
    ? text
    : `<code class="chat-xml-inline">${highlightXml(escapeHtml(text))}</code>`

renderer.link = function ({ href, title, tokens }) {
  // Marked 注册时会复制渲染器，parser 属于本次回调的 this。
  const previous = parsingLinkLabel
  let label: string
  try {
    parsingLinkLabel = true
    label = this.parser.parseInline(tokens)
  } finally {
    parsingLinkLabel = previous
  }
  if (isResourceLink(href))
    return `<a href="#" class="chat-resource-chip" data-resource-source="${escapeHtml(href)}">${label}<span aria-hidden="true">↗</span></a>`
  const safeHref = /^(https?:|mailto:)/i.test(href) ? href : '#'
  const external = /^https?:/i.test(safeHref)
  return `<a href="${escapeHtml(safeHref)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}${external ? '<span class="chat-link-mark">↗</span>' : ''}</a>`
}

const marked = new Marked({
  renderer,
  breaks: true,
  gfm: true,
  tokenizer: {
    // 聊天中的波浪号原样显示；返回 undefined 禁用删除线，false 会回退到默认解析。
    del: () => undefined,
  },
})
const RICH_TEXT_CACHE_LIMIT = 500
const RICH_TEXT_CACHE_MAX_SOURCE_LENGTH = 64_000
const richTextCache = new Map<string, string>()
const RICH_TEXT_CACHE_CHAR_BUDGET = 4_000_000
let richTextCacheChars = 0

export interface ChatRichRenderOptions {
  cache?: boolean
}

function readRichTextCache(source: string): string | undefined {
  const cached = richTextCache.get(source)
  if (cached === undefined) return undefined
  richTextCache.delete(source)
  richTextCache.set(source, cached)
  return cached
}

function writeRichTextCache(source: string, html: string): void {
  const previous = richTextCache.get(source)
  if (previous !== undefined) richTextCacheChars -= source.length + previous.length
  richTextCache.set(source, html)
  richTextCacheChars += source.length + html.length
  while (
    richTextCache.size > RICH_TEXT_CACHE_LIMIT ||
    richTextCacheChars > RICH_TEXT_CACHE_CHAR_BUDGET
  ) {
    const oldest = richTextCache.keys().next().value!
    richTextCacheChars -= oldest.length + richTextCache.get(oldest)!.length
    richTextCache.delete(oldest)
  }
}

interface ProtectedMath {
  placeholder: string
  html: string
}

/** 渲染聊天富文本，并在最终进入 v-html 前执行白名单净化。 */
export function renderChatRichText(source: string, options: ChatRichRenderOptions = {}): string {
  if (!source.trim()) return ''
  const cacheEnabled = options.cache !== false && source.length <= RICH_TEXT_CACHE_MAX_SOURCE_LENGTH
  const cacheKey = `${getDisplayLocale()}\u0000${source}`
  const cached = cacheEnabled ? readRichTextCache(cacheKey) : undefined
  if (cached !== undefined) return cached
  const inlineMath: ProtectedMath[] = []
  // 兼容清理模型偶发复述的旧版内部历史标签。该标签在名称后使用逗号，
  // 不是合法 HTML 语法，因此精确移除不会影响 span、details 等正常 HTML 渲染。
  const visibleSource = stripLeakedConversationMetadata(source)
  // 有些模型会把整份回复包进 ```markdown 围栏；这表示需要渲染的文档而非代码示例。
  // 仅当该围栏覆盖整个回复时解包，嵌入正文的 markdown 代码示例仍按源码展示。
  const markdownSource = unwrapWholeMarkdownFence(visibleSource)
  // 模型流式输出常会为整段 Markdown 追加缩进；标题行有四个空格时会被 CommonMark 误判为代码。
  // 仅在 fenced code block 外归一化标题行，保留真实代码的原始缩进。
  const normalizedSource = normalizeMarkdownHeadings(markdownSource)
  // 块公式先转换为独立 fenced token，让 Marked 按块级节点处理，避免 <p><div> 非法嵌套。
  const blockProtected = normalizedSource.replace(
    /(^|\n)[ \t]*\$\$[ \t]*(?:\n|$)([\s\S]*?)(?:\n|^)[ \t]*\$\$[ \t]*(?=\n|$)/g,
    (_match, leading: string, formula: string) => {
      return `${leading}\n\n\`\`\`peromath\n${formula.trim()}\n\`\`\`\n\n`
    },
  )
  const protectedSource = protectInlineMath(blockProtected, inlineMath)
  let html = marked.parse(protectedSource) as string
  for (const item of inlineMath) html = html.replaceAll(item.placeholder, item.html)

  const sanitized = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel', 'data-copy-code', 'data-resource-source'],
    ADD_TAGS: ['annotation', 'math', 'semantics'],
  })
  const rendered = decorateTextNodes(sanitized)
  if (cacheEnabled) writeRichTextCache(cacheKey, rendered)
  return rendered
}

function stripLeakedConversationMetadata(source: string): string {
  return source.replace(
    /<([\p{L}\p{N}_-]+),\s*time=\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?>/gu,
    '',
  )
}

function unwrapWholeMarkdownFence(source: string): string {
  const match = source.match(/^\s*```(?:markdown|md)\s*\n([\s\S]*?)\n?```\s*$/i)
  return match?.[1] ?? source
}

function normalizeMarkdownHeadings(source: string): string {
  let insideFence = false
  return source
    .split('\n')
    .map((line) => {
      // 围栏本身和围栏内内容必须原样保留，防止代码示例被错误改写。
      if (/^[ \t]*(```|~~~)/.test(line)) {
        insideFence = !insideFence
        return line
      }
      if (insideFence) return line
      // ATX 标题最多允许 3 个前导空格；模型多缩进时去掉额外缩进以恢复标题语义。
      return line.replace(/^[ \t]{4,}(?=#{1,6}(?:[ \t]+|$))/, '')
    })
    .join('\n')
}

function protectInlineMath(source: string, output: ProtectedMath[]): string {
  return source.replace(/(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, (_match, formula: string) => {
    const placeholder = `PEROCHATINLINEMATH${output.length}TOKEN`
    output.push({ placeholder, html: renderMath(formula.trim(), false) })
    return placeholder
  })
}

function renderMath(formula: string, displayMode: boolean): string {
  let rendered: string
  try {
    rendered = katex.renderToString(formula, { displayMode, throwOnError: false, strict: false })
  } catch {
    rendered = `<code>${escapeHtml(formula)}</code>`
  }
  return displayMode
    ? `<div class="chat-math-block"><span class="chat-math-label">FORMULA</span>${rendered}</div>`
    : `<span class="chat-math-inline">${rendered}</span>`
}

function highlightXml(escaped: string): string {
  return escaped
    .replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="chat-xml-tag">$2</span>')
    .replace(
      /([\w:-]+)(=)(&quot;.*?&quot;|&#039;.*?&#039;)/g,
      '<span class="chat-xml-attr">$1</span>$2<span class="chat-xml-value">$3</span>',
    )
}

/** 只装饰普通文本节点，跳过代码、链接、公式和 XML，避免语义规则互相破坏。 */
function decorateTextNodes(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)

  for (const node of nodes) {
    const parent = node.parentElement
    if (
      !parent ||
      parent.closest('code, pre, a, .katex, .chat-math-block, .chat-xml-inline, button')
    )
      continue
    const fragment = htmlReferenceFragment(node.data) ?? quoteFragment(node.data)
    if (fragment) node.replaceWith(fragment)
  }
  decorateChatParentheses(template.content)
  return template.innerHTML
}

/** 普通正文中的已知文件名可打开；代码块、已有链接与公式不参与识别。 */
function htmlReferenceFragment(text: string): DocumentFragment | null {
  const pattern =
    /(?:^|(?<=[\s（("“「]))(?:workspace:|[a-z]:[\\/]|\.\.?\/)?[\p{L}\p{N}_][\p{L}\p{N}_./\\:-]*\.[a-z\d]{1,12}(?=$|[\s，。！？、）)"”」])/giu
  const matches = [...text.matchAll(pattern)].filter((match) => isFileReference(match[0]))
  if (!matches.length) return null
  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const match of matches) {
    const start = match.index!
    const leading = text.slice(cursor, start)
    fragment.append(quoteFragment(leading) ?? document.createTextNode(leading))
    const link = document.createElement('a')
    link.href = '#'
    link.className = 'chat-resource-chip'
    link.dataset.resourceSource = match[0]
    link.textContent = match[0] + ' ↗'
    fragment.append(link)
    cursor = start + match[0].length
  }
  const trailing = text.slice(cursor)
  fragment.append(quoteFragment(trailing) ?? document.createTextNode(trailing))
  return fragment
}

function quoteFragment(text: string): DocumentFragment | null {
  const patterns = [
    { type: 'corner-double', regex: /『[^』\n]+』/g },
    { type: 'corner', regex: /「[^」\n]+」/g },
    { type: 'cn-double', regex: /“[^”\n]+”/g },
    { type: 'cn-single', regex: /‘[^’\n]+’/g },
    { type: 'en-double', regex: /"[^"\n]+"/g },
    { type: 'en-single', regex: /'[^'\n]+'/g },
  ]
  const matches: Array<{ start: number; end: number; type: string; value: string }> = []
  const occupied = new Set<number>()
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if ([...Array(end - start).keys()].some((offset) => occupied.has(start + offset))) continue
      for (let i = start; i < end; i++) occupied.add(i)
      matches.push({ start, end, type: pattern.type, value: match[0] })
    }
  }
  if (matches.length === 0) return null
  matches.sort((a, b) => a.start - b.start)
  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) fragment.append(text.slice(cursor, match.start))
    const span = document.createElement('span')
    const type =
      match.type === 'en-double' && /[\u3400-\u9fff]/.test(match.value) ? 'cn-double' : match.type
    span.className = `chat-quote chat-quote-${type}`
    span.textContent = match.value
    fragment.append(span)
    cursor = match.end
  }
  if (cursor < text.length) fragment.append(text.slice(cursor))
  return fragment
}
