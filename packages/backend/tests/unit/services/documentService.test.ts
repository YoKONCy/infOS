import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentService } from '@infos/backend/services/document/documentService'
import {
  documentInputSchema,
  workbookSchema,
} from '@infos/backend/services/document/documentSchema'
import {
  documentBlocks,
  markdownWorkbook,
} from '@infos/backend/services/document/documentRenderers'
import { VirtualWorkspace } from '@infos/backend/services/execution/virtualWorkspace'
import { ExecutionSessionManager } from '@infos/backend/services/execution/executionSession'
import {
  clearProductivityRuntime,
  setProductivityRuntime,
} from '@infos/backend/tools/productivityRuntimeHolder'
import { isToolAllowedInInteractionMode } from '@infos/backend/tools/interactionMode'
import { ToolRegistry, type ToolContext } from '@infos/backend/services/agent/toolRegistry'

let root: string
let service: DocumentService
const context: ToolContext = {
  source: 'desktop',
  channel: 'desktop',
  agentId: 'pero',
  sessionId: 'thread-doc',
  threadId: 'thread-doc',
  pairId: 'pair-doc',
  toolCallId: 'call-doc',
  interactionMode: 'work',
}
const fontPath = fileURLToPath(
  new URL('../../../src/assets/documents/document-font.woff2', import.meta.url),
)
const checkpoints = {
  captureToolMutation: vi.fn(async () => null),
  commit: vi.fn(async () => undefined),
}
const chromium = { available: () => false, render: vi.fn() }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'infos-document-'))
  setProductivityRuntime({
    sessions: new ExecutionSessionManager(),
    virtualWorkspace: new VirtualWorkspace(),
    workspace: { getWorkspaceRoot: () => root },
    terminals: {},
    approvalService: {},
  } as never)
  const resources = {
    readDocumentSource: async (_context: ToolContext, source: string) => ({
      bytes: await readFile(path.join(root, source)),
      name: path.basename(source),
      mimeType: 'text/markdown',
    }),
  }
  service = new DocumentService(
    resources as never,
    checkpoints as never,
    chromium as never,
    fontPath,
  )
  vi.clearAllMocks()
})

afterEach(async () => {
  clearProductivityRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('统一文档工具', () => {
  it('仅工作模式开放，聊天扩展标记也不能绕过', async () => {
    const registry = new ToolRegistry()
    registry.register(
      { name: 'document', description: '', parameters: {} },
      async () => '',
      undefined,
      { chatEnabled: true },
    )
    expect(isToolAllowedInInteractionMode('document', 'work', registry)).toBe(true)
    expect(isToolAllowedInInteractionMode('document', 'chat', registry)).toBe(false)
    expect(isToolAllowedInInteractionMode('document', 'minimal', registry)).toBe(false)
    await expect(
      service.execute({ action: 'capabilities' }, { ...context, interactionMode: 'chat' }),
    ).rejects.toThrow('工作模式')
  })

  it('能力列表按在线节点提供 Chromium，通用导出无需客户端', async () => {
    const result = await service.capabilities()
    expect(result.export).toEqual(expect.arrayContaining(['md', 'docx', 'xlsx', 'pdf']))
    expect(result.pdfEngines).toEqual(['pdfkit'])
    expect(result.read.ocr).toBe(false)
  })

  it('读取按字符分页并返回可靠的下一页位置', async () => {
    await writeFile(path.join(root, 'source.md'), '# 标题\n正文内容')
    expect(
      await service.execute({ action: 'read', source: 'source.md', offset: 2, limit: 4 }, context),
    ).toMatchObject({ markdown: '标题\n正', offset: 2, nextOffset: 6 })
    expect(
      await service.execute(
        { action: 'read', source: 'source.md', offset: 6, limit: 100 },
        context,
      ),
    ).toMatchObject({ nextOffset: null })
  })

  it('导出 Markdown 落入任务子目录并记录二进制检查点', async () => {
    const result = (await service.execute(
      { action: 'export', content: '# 成果\n中文内容', format: 'md' },
      context,
    )) as { path: string }
    expect(result.path).toMatch(/^documents\/thread-doc\/.+\.md$/)
    expect(await readFile(path.join(root, result.path), 'utf8')).toContain('中文内容')
    expect(checkpoints.commit).toHaveBeenCalledWith(null, Buffer.from('# 成果\n中文内容'))
  })

  it('不覆盖已有文件，不写入根目录或越出任务工作区', async () => {
    await expect(
      service.execute(
        { action: 'export', content: '正文', format: 'md', output: '../outside.md' },
        context,
      ),
    ).rejects.toThrow('工作区')
    await expect(
      service.execute(
        { action: 'export', content: '正文', format: 'md', output: 'root.md' },
        context,
      ),
    ).rejects.toThrow('根目录')
    const input = { action: 'export', content: '第一版', format: 'md', output: '任务/文稿.md' }
    await service.execute(input, context)
    await expect(service.execute({ ...input, content: '第二版' }, context)).rejects.toThrow(
      '已存在',
    )
    expect(await readFile(path.join(root, '任务/文稿.md'), 'utf8')).toBe('第一版')
    expect(await service.execute(input, context)).toMatchObject({ created: false })
  })

  it('生成的工作簿保留数字与公式，普通等号字符串不成为公式', async () => {
    const result = (await service.execute(
      {
        action: 'export',
        format: 'xlsx',
        workbook: {
          sheets: [
            {
              name: '预算',
              columns: ['项目', '金额'],
              rows: [
                ['交通', 120],
                ['住宿', 300],
                ['合计', { formula: 'SUM(B2:B3)', result: 420 }],
                ['原文', '=1+1'],
              ],
            },
          ],
        },
      },
      context,
    )) as { path: string }
    const { default: ExcelJS } = await import('exceljs')
    const book = new ExcelJS.Workbook()
    await book.xlsx.readFile(path.join(root, result.path))
    const sheet = book.getWorksheet('预算')!
    expect(sheet.getCell('B2').value).toBe(120)
    expect(sheet.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)', result: 420 })
    expect(sheet.getCell('B5').value).toBe('=1+1')
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
  })

  it('DOCX 可由文档读取器重新读取到标题和中文正文', async () => {
    const result = (await service.execute(
      { action: 'export', format: 'docx', content: '# 行程\n周末去公园。\n\n- 带水\n- 带伞' },
      context,
    )) as { path: string }
    const read = (await service.execute({ action: 'read', source: result.path }, context)) as {
      markdown: string
    }
    expect(read.markdown).toContain('行程')
    expect(read.markdown).toContain('周末去公园')
    expect(read.markdown).toContain('带伞')
  })

  it('PDFKit 产物能由客户端阅读器读回完整中文正文，无需 Electron', async () => {
    const result = (await service.execute(
      { action: 'export', format: 'pdf', content: '# 中文标题\n这里是中文正文。' },
      context,
    )) as { path: string }
    const bytes = await readFile(path.join(root, result.path))
    // 复用客户端实际安装的阅读器，独立解析服务端产物，不新增解析依赖。
    const frontendRequire = createRequire(
      new URL('../../../../frontend/package.json', import.meta.url),
    )
    const { getDocument } = await import(
      pathToFileURL(frontendRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
    )
    const loading = getDocument({
      data: Uint8Array.from(bytes),
      useSystemFonts: false,
      disableFontFace: true,
    })
    try {
      const document = await loading.promise
      expect(document.numPages).toBe(1)
      const content = await (await document.getPage(1)).getTextContent()
      const text = content.items.map((item: { str?: string }) => item.str ?? '').join('')
      expect(text).toContain('中文标题')
      expect(text).toContain('这里是中文正文。')
    } finally {
      await loading.destroy()
    }
    expect(chromium.render).not.toHaveBeenCalled()
  })

  it('取消后不发布任何文件，也不会悄悄切换到其他 PDF 引擎', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      service.execute(
        { action: 'export', format: 'md', content: '正文' },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toBeDefined()
    chromium.render.mockRejectedValueOnce(new Error('节点断开'))
    await expect(
      service.execute(
        { action: 'export', format: 'pdf', engine: 'chromium', content: '正文' },
        context,
      ),
    ).rejects.toThrow('节点断开')
    expect(checkpoints.commit).not.toHaveBeenCalled()
  })
})

describe('文档数据结构', () => {
  it('拒绝歧义参数和重复的工作表名称', () => {
    expect(
      documentInputSchema.safeParse({
        action: 'export',
        source: 'a.md',
        content: '正文',
        format: 'pdf',
      }).success,
    ).toBe(false)
    expect(
      workbookSchema.safeParse({
        sheets: [
          { name: '预算', rows: [] },
          { name: '预算', rows: [] },
        ],
      }).success,
    ).toBe(false)
  })

  it('多张 Markdown 表格必须显式选择，不把普通文字猜成工作簿', () => {
    const text = '| 项目 | 金额 |\n|---|---|\n| A | 10 |\n\n| 姓名 |\n|---|\n| B |'
    expect(() => markdownWorkbook('只有正文')).toThrow('没有表格')
    expect(() => markdownWorkbook(text)).toThrow('tableIndex')
    expect(markdownWorkbook(text, 2).sheets[0]!.rows).toEqual([['B']])
    expect(documentBlocks('# 标题\n\n**加粗**正文').map((block) => block.text)).toEqual([
      '标题',
      '加粗正文',
    ])
  })
})
