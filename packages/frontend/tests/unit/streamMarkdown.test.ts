import { describe, expect, it } from 'vitest'
import type { SurfaceNodeId } from '@infos/shared'
import { StreamMarkdownSegmenter } from '../../src/compositor/markdownSegmentation'

const node = 'stream-test' as SurfaceNodeId
describe('增量 Markdown 分段', () => {
  it('CRLF 与含空行的块公式保持完整', () => {
    const parser = new StreamMarkdownSegmenter(node)
    const unclosed = '开头\r\n\r\n$$\r\nx+y\r\n\r\nz\r\n'
    const formula = '$$\r\nx+y\r\n\r\nz\r\n$$\r\n\r\n'
    const source = `${unclosed}$$\r\n\r\n后文\r\n\r\n尾部`
    for (let length = 1; length < unclosed.length; length++) {
      parser.update(unclosed.slice(0, length))
    }
    expect(parser.update(unclosed).find((block) => block.source.includes('x+y'))).toMatchObject({
      kind: 'markdown',
      stable: false,
    })
    for (let length = unclosed.length + 1; length <= source.length; length++) {
      const blocks = parser.update(source.slice(0, length))
      expect(blocks.map((block) => block.source).join('')).toBe(source.slice(0, length))
    }
    expect(parser.update(source).find((block) => block.source.includes('x+y'))).toMatchObject({
      kind: 'markdown',
      source: formula,
      stable: true,
    })
    expect(parser.update(source, true)).toMatchObject([
      { kind: 'markdown', source: '开头\r\n\r\n', stable: true },
      { kind: 'markdown', source: formula, stable: true },
      { kind: 'markdown', source: '后文\r\n\r\n', stable: true },
      { kind: 'markdown', source: '尾部', stable: true },
    ])
  })
  it('逐字输入不丢内容，稳定段落复用原对象', () => {
    const parser = new StreamMarkdownSegmenter(node)
    const source = '第一段\n\n第二段\n\n第三段\n\n尾部'
    for (let length = 1; length <= source.length; length++) {
      const blocks = parser.update(source.slice(0, length))
      expect(blocks.map((block) => block.source).join('')).toBe(source.slice(0, length))
    }
    const before = parser.update(source)
    const after = parser.update(`${source}继续输入`)
    expect(before[0]?.stable).toBe(true)
    expect(after[0]).toBe(before[0])
    expect(parser.update(`${source}继续输入`)).toBe(after)
  })

  it('跨增量的围栏与内部空行不能提前稳定，较短围栏不能关闭外层', () => {
    const parser = new StreamMarkdownSegmenter(node)
    const unclosed = '开头\n\n````text\n代码\n\n```\n仍在代码中\n'
    const code = '````text\n代码\n\n```\n仍在代码中\n````\n'
    const source = unclosed + '````\n\n结尾'
    for (let length = 1; length < unclosed.length; length++) {
      parser.update(unclosed.slice(0, length))
    }
    expect(
      parser.update(unclosed).find((block) => block.source.includes('````text')),
    ).toMatchObject({
      kind: 'markdown',
      stable: false,
    })
    for (let length = unclosed.length + 1; length <= source.length; length++) {
      const blocks = parser.update(source.slice(0, length))
      expect(blocks.map((block) => block.source).join('')).toBe(source.slice(0, length))
    }
    expect(parser.update(source).find((block) => block.source.includes('````text'))).toMatchObject({
      kind: 'markdown',
      source: code,
      stable: true,
    })
    expect(parser.update(source, true).filter((block) => block.source.trim())).toMatchObject([
      { kind: 'markdown', source: '开头\n\n', stable: true },
      { kind: 'markdown', source: code, stable: true },
      { kind: 'markdown', source: '结尾', stable: true },
    ])
  })

  it('闭合 HTML 内部空行保持完整，源文本改写会丢弃旧游标', () => {
    const parser = new StreamMarkdownSegmenter(node)
    const source = '开头\n\n<div>\n内部\n\n<div>嵌套</div>\n</div>\n\n尾部\n\n'
    for (let length = 1; length <= source.length; length++) parser.update(source.slice(0, length))
    const blocks = parser.update(source)
    expect(blocks.filter((block) => block.source.includes('<div>'))).toHaveLength(1)
    expect(
      parser
        .update('替换后的正文')
        .map((block) => block.source)
        .join(''),
    ).toBe('替换后的正文')
    expect(parser.update('')).toEqual([])
  })

  it('Mermaid 只在闭合稳定后升级，提交后保留图表及两侧正文', () => {
    const parser = new StreamMarkdownSegmenter(node)
    expect(
      parser
        .update('说明\n\n```mermaid\ngraph TD\nA-->B')
        .some((block) => block.kind === 'mermaid'),
    ).toBe(false)
    const source = '说明\n\n```mermaid\ngraph TD\nA-->B\n```\n\n结尾'
    expect(parser.update(source).find((block) => block.kind === 'mermaid')?.source).toBe(
      'graph TD\nA-->B',
    )
    expect(parser.update(source, true).filter((block) => block.source.trim())).toMatchObject([
      { kind: 'markdown', source: '说明\n\n', stable: true },
      { kind: 'mermaid', source: 'graph TD\nA-->B', stable: true },
      { kind: 'markdown', source: '结尾', stable: true },
    ])
  })
})
