import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __codeSearchInternals, resolveRipgrepPath } from '@infos/backend/tools/codeSearcher'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'infos-search-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'a.ts'), 'const alpha = 1\nconst target = alpha\n', 'utf8')
  await writeFile(path.join(root, 'src', 'b.js'), 'const target = 2\n', 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('code_search Node fallback', () => {
  it('按文件类型执行固定字符串搜索，返回行号与列号', async () => {
    const { matches, truncated } = await __codeSearchInternals.searchWithNode({
      query: 'target',
      isRegex: false,
      fileType: 'ts',
      searchPath: root,
    })
    expect(truncated).toBe(false)
    // 第 2 行 'const target = alpha'：'target' 从第 7 列开始（1-based）
    expect(matches).toEqual([
      expect.objectContaining({ file: path.join(root, 'src', 'a.ts'), line: 2, column: 7 }),
    ])
  })

  it('发行环境优先解析 resources 内置 rg', async () => {
    const resources = await mkdtemp(path.join(tmpdir(), 'infos-resources-'))
    const executable = process.platform === 'win32' ? 'rg.exe' : 'rg'
    const bundled = path.join(resources, 'bin', `${process.platform}-${process.arch}`, executable)
    await mkdir(path.dirname(bundled), { recursive: true })
    await writeFile(bundled, '')
    const previous = process.env.INFOS_RESOURCES_ROOT
    process.env.INFOS_RESOURCES_ROOT = resources
    try {
      expect(resolveRipgrepPath()).toBe(bundled)
      expect(existsSync(resolveRipgrepPath())).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.INFOS_RESOURCES_ROOT
      else process.env.INFOS_RESOURCES_ROOT = previous
      await rm(resources, { recursive: true, force: true })
    }
  })

  it('支持正则并拒绝无效表达式', async () => {
    const { matches } = await __codeSearchInternals.searchWithNode({
      query: 'alpha\\s*=\\s*1',
      isRegex: true,
      searchPath: root,
    })
    expect(matches).toHaveLength(1)
    expect(matches[0]!.column).toBe(7)
    expect(() => __codeSearchInternals.createMatcher('[', true)).toThrow(Error)
  })

  it('匹配数超过结果上限时标记截断', async () => {
    await writeFile(
      path.join(root, 'many.txt'),
      Array.from({ length: 60 }, (_, i) => `hit ${i}`).join('\n') + '\n',
      'utf8',
    )
    const { matches, truncated } = await __codeSearchInternals.searchWithNode({
      query: 'hit',
      isRegex: false,
      searchPath: root,
    })
    expect(matches).toHaveLength(50)
    expect(truncated).toBe(true)
  })
})

describe.each(['node', 'ripgrep'] as const)('code_search %s 引擎契约', (engine) => {
  const search =
    engine === 'node'
      ? __codeSearchInternals.searchWithNode
      : __codeSearchInternals.searchWithRipgrep
  it('默认遵守 Git 忽略规则，关闭后包含忽略项，隐藏项独立控制', async (context) => {
    await mkdir(path.join(root, '.git'))
    await mkdir(path.join(root, 'generated'))
    await mkdir(path.join(root, '.config'))
    await writeFile(path.join(root, '.gitignore'), 'generated/\n*.log\n')
    await writeFile(path.join(root, 'generated', 'a.ts'), 'scope_token')
    await writeFile(path.join(root, '.config', 'a.ts'), 'scope_token')
    await writeFile(path.join(root, 'visible.ts'), 'scope_token')
    const input = { query: 'scope_token', isRegex: false, searchPath: root }
    const normal = await search(input)
    if ('available' in normal && !normal.available) {
      context.skip()
      return
    }
    expect(normal.matches.map((match) => path.basename(match.file))).toEqual(['visible.ts'])
    const unignored = await search({ ...input, respectGitIgnore: false })
    expect(unignored.matches).toHaveLength(2)
    expect(unignored.matches.some((match) => match.file.includes('.config'))).toBe(false)
    const hidden = await search({ ...input, respectGitIgnore: false, includeHidden: true })
    expect(hidden.matches).toHaveLength(3)
  })

  it('支持子目录规则与否定规则', async (context) => {
    await mkdir(path.join(root, '.git'))
    await mkdir(path.join(root, '.git', 'info'))
    await writeFile(path.join(root, '.git', 'info', 'exclude'), 'local.ts\n')
    await writeFile(path.join(root, 'local.ts'), 'rules_token')
    await writeFile(path.join(root, '.gitignore'), '*.log\n!keep.log\n')
    await writeFile(path.join(root, 'hide.log'), 'rules_token')
    await writeFile(path.join(root, 'keep.log'), 'rules_token')
    await writeFile(path.join(root, 'src', '.gitignore'), 'skip.ts\n')
    await writeFile(path.join(root, 'src', 'skip.ts'), 'rules_token')
    const result = await search({ query: 'rules_token', isRegex: false, searchPath: root })
    if ('available' in result && !result.available) {
      context.skip()
      return
    }
    expect(result.matches.map((match) => path.basename(match.file))).toEqual(['keep.log'])
  })

  it('类型别名与扩展名一致，单文件中文和表情前缀列号正确', async (context) => {
    const file = path.join(root, 'unicode.ts')
    await writeFile(file, '中文😀 target\n')
    for (const fileType of ['ts', 'typescript', '*.ts', '.ts']) {
      const result = await search({ query: 'target', isRegex: false, fileType, searchPath: file })
      if ('available' in result && !result.available) {
        context.skip()
        return
      }
      expect(result.matches).toEqual([expect.objectContaining({ file, line: 1, column: 6 })])
    }
  })

  it('没有命中时返回空列表，取消不会伪装成空结果', async (context) => {
    const result = await search({ query: 'no_such_token', isRegex: false, searchPath: root })
    if ('available' in result && !result.available) {
      context.skip()
      return
    }
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(false)
    const controller = new AbortController()
    controller.abort(new Error('测试取消'))
    await expect(
      search({ query: 'target', isRegex: false, searchPath: root, signal: controller.signal }),
    ).rejects.toThrow('测试取消')
  })
})
