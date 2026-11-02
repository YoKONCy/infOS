/**
 * Markdown-it CJK（中日韩）文本及标点增强强调插件
 *
 * 彻底解决 CommonMark 规范在中文排版中的历史痛点：
 * 1. 星号/下划线内部带有首尾空格无法渲染加粗（如 ** text **）
 * 2. 强调标记内部紧贴全角成对标点导致边界判定失效（如 **“xxx”**、**《xxx》**、**（xxx）**）
 * 3. 强调文本末尾紧贴标点符号且紧随汉字导致右侧定界符失效（如 **一气呵成！**的本领）
 *
 * @module packages/wiki/.vitepress/plugins/cjkFriendlyEmphasis
 */

import type MarkdownIt from 'markdown-it'

/** 成对出现的标点符号清单（开括号/开引号, 闭括号/闭引号） */
const PUNCT_PAIRS: [string, string][] = [
  ['“', '”'],
  ['‘', '’'],
  ['《', '》'],
  ['（', '）'],
  ['【', '】'],
  ['『', '』'],
  ['「', '」'],
  ['"', '"'],
  ["'", "'"],
  ['(', ')'],
  ['[', ']']
]

/** 常见的末尾标点符号（在紧接文字时容易破坏 Markdown 右边界判定） */
const TRAILING_PUNCTS = ['！', '!', '？', '?', '。', '，', ',', '；', ';', '、', '…', '~', '～']

/**
 * 注册 CJK 友好强调处理插件
 *
 * @param md Markdown-it 实例
 */
export function cjkFriendlyEmphasis(md: MarkdownIt): void {
  // 在 block 规则之后、inline 规则之前挂载处理
  // 此时所有代码块（```fence / code_block）已被独立切分，只对普通行内段落生效
  md.core.ruler.after('block', 'cjk_friendly_emphasis', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline') continue

      // 步骤 1：保护行内代码 `...`，避免正则误伤代码段内的星号
      const inlineCodes: string[] = []
      // 占位符避开强调符，并确保不会与原文内容冲突。
      let codeMarker = '\uE000'
      while (token.content.includes(codeMarker)) codeMarker += '\uE000'
      let text = token.content.replace(/`([^`]+)`/g, (match) => {
        inlineCodes.push(match)
        return `${codeMarker}${inlineCodes.length - 1}\uE001`
      })

      // 步骤 2：修复强调符（** 或 __）内部包含两端空格的情况
      // 例如：** “像列任务清单一样一气呵成” ** -> **“像列任务清单一样一气呵成”**
      text = text.replace(/\*\*([ \t]+)([^\n*]+?)([ \t]+)\*\*/g, '**$2**')
      text = text.replace(/__([ \t]+)([^\n_]+?)([ \t]+)__/g, '__$2__')

      // 步骤 3：修复强调标记内部紧贴成对标点的情况
      // 例如：**“像列任务清单一样一气呵成”** -> “**像列任务清单一样一气呵成**”
      for (const [openP, closeP] of PUNCT_PAIRS) {
        const escOpen = openP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const escClose = closeP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

        // 处理 ** 加粗
        const regexDouble = new RegExp(`\\*\\*${escOpen}(.+?)${escClose}\\*\\*`, 'g')
        text = text.replace(regexDouble, `${openP}**$1**${closeP}`)

        // 处理 __ 加粗
        const regexUnderline = new RegExp(`__${escOpen}(.+?)${escClose}__`, 'g')
        text = text.replace(regexUnderline, `${openP}__$1__${closeP}`)
      }

      // 步骤 4：修复单边残留空格情况（如 ** text** 或 **text **）
      text = text.replace(/\*\*([ \t]+)([^\n*]+?)\*\*/g, '**$2**')
      text = text.replace(/\*\*([^\n*]+?)([ \t]+)\*\*/g, '**$1**')
      text = text.replace(/__([ \t]+)([^\n_]+?)__/g, '__$2__')
      text = text.replace(/__([^\n_]+?)([ \t]+)__/g, '__$1__')

      // 步骤 5：修复末尾紧贴标点且后面紧接汉字/字母的情况
      // 例如：**一气呵成！**的本领 -> **一气呵成**！的本领
      for (const p of TRAILING_PUNCTS) {
        const escP = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regexDouble = new RegExp(`\\*\\*([^\n*]+?)${escP}\\*\\*(?=[\\u4e00-\\u9fa5a-zA-Z0-9])`, 'g')
        text = text.replace(regexDouble, `**$1**${p}`)

        const regexUnderline = new RegExp(`__([^\n_]+?)${escP}__(?=[\\u4e00-\\u9fa5a-zA-Z0-9])`, 'g')
        text = text.replace(regexUnderline, `__$1__${p}`)
      }

      // 步骤 6：还原被保护的行内代码块
      text = text.replace(new RegExp(`${codeMarker}(\\d+)\uE001`, 'g'), (_, index) => inlineCodes[Number(index)])

      token.content = text
    }
  })
}
