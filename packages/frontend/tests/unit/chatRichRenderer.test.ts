// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderChatRichText } from '../../src/lib/chatRichRenderer'

describe('chatRichRenderer', () => {
  it('应当保持块公式、标题和代码块为互不污染的同级结构', () => {
    const html = renderChatRichText(`$$
E = mc^2
$$

## 数学公式

正文包含 $a+b$。

\`\`\`python
print("你好")
\`\`\``)

    const root = document.createElement('div')
    root.innerHTML = html
    expect(root.querySelector('.chat-math-block')).not.toBeNull()
    expect(root.querySelector('h2')?.textContent).toBe('数学公式')
    expect(root.querySelector('.chat-code-block code')?.textContent).toContain('print("你好")')
    expect(root.querySelector('p .chat-math-block')).toBeNull()
    expect(root.textContent).not.toContain('%E')
  })

  it('应渲染安全行内HTML并净化危险属性', () => {
    const html = renderChatRichText(
      '<span style="color: #8A2BE2; text-shadow: 2px 2px 4px #00000055" onclick="alert(1)">标题</span>',
    )
    const root = document.createElement('div')
    root.innerHTML = html
    const span = root.querySelector('span')

    expect(span?.textContent).toBe('标题')
    expect(span?.getAttribute('style')).toContain('color')
    expect(span?.hasAttribute('onclick')).toBe(false)
    expect(root.querySelector('.chat-xml-inline')).toBeNull()
  })

  it('非白名单XML标签仍应显示为源码', () => {
    const html = renderChatRichText('<user id="1">内容</user>')
    const root = document.createElement('div')
    root.innerHTML = html

    expect(root.querySelector('.chat-xml-inline')).not.toBeNull()
    expect(root.querySelector('user')).toBeNull()
  })

  it('应清理模型复述的内部时间标签，同时保留正文样式', () => {
    const html = renderChatRichText(
      '<nana, time=2026-08-29 19:19:40>（眯到主人这话）“林小姐实在看不下去了”的嫌弃',
    )
    const root = document.createElement('div')
    root.innerHTML = html

    const quote = root.querySelector('.chat-quote-cn-double')
    expect(quote?.textContent).toBe('“林小姐实在看不下去了”')
    expect(root.querySelector('a')).toBeNull()
    expect(root.textContent).not.toContain('<nana, time=')
    expect(root.textContent).toContain('（眯到主人这话）')
  })

  it('清理内部时间标签不能影响正常HTML渲染', () => {
    const html = renderChatRichText(
      '<span class="speaker">正常HTML</span><br><mark>继续渲染</mark>',
    )
    const root = document.createElement('div')
    root.innerHTML = html

    expect(root.querySelector('span.speaker')?.textContent).toBe('正常HTML')
    expect(root.querySelector('mark')?.textContent).toBe('继续渲染')
    expect(root.querySelector('br')).not.toBeNull()
  })

  it('应当只保留无内容的复制标记，不把源码编码写进可见 DOM', () => {
    const html = renderChatRichText('```json\n{"状态":"正常"}\n```')
    const root = document.createElement('div')
    root.innerHTML = html
    const button = root.querySelector<HTMLButtonElement>('[data-copy-code]')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('data-copy-code')).toBe('')
    expect(root.textContent).not.toContain('%7B')
  })
})
