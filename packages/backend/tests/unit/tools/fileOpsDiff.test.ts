import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  buildToolDiff,
  deleteFileTool,
  fileInfoTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from '@infos/backend/tools/fileOps'
import {
  clearProductivityRuntime,
  setProductivityRuntime,
} from '@infos/backend/tools/productivityRuntimeHolder'
import { ExecutionSessionManager } from '@infos/backend/services/execution/executionSession'
import { VirtualWorkspace } from '@infos/backend/services/execution/virtualWorkspace'
import { isStructuredToolResult } from '@infos/backend/services/execution/toolResult'

describe('write_file 工具 Diff 预览', () => {
  it('新建 Markdown 文件应按实际行数统计为纯新增', () => {
    const result = buildToolDiff('', '# 标题\n\n第一段\n')
    expect(result.insertions).toBe(3)
    expect(result.deletions).toBe(0)
    expect(result.diffPreview).toEqual([
      { kind: 'add', newLine: 1, text: '# 标题' },
      { kind: 'add', newLine: 2, text: '' },
      { kind: 'add', newLine: 3, text: '第一段' },
    ])
  })

  it('覆盖文件应同时生成红色删除行和绿色新增行', () => {
    const result = buildToolDiff('# 标题\n旧内容\n结尾\n', '# 标题\n新内容\n结尾\n')
    expect(result).toMatchObject({ insertions: 1, deletions: 1, diffTruncated: false })
    expect(result.diffPreview.some((row) => row.kind === 'remove' && row.text === '旧内容')).toBe(
      true,
    )
    expect(result.diffPreview.some((row) => row.kind === 'add' && row.text === '新内容')).toBe(true)
  })

  it('追加内容应只统计新增行', () => {
    const result = buildToolDiff('第一行\n', '第一行\n第二行\n第三行\n')
    expect(result.insertions).toBe(2)
    expect(result.deletions).toBe(0)
    expect(result.diffPreview.filter((row) => row.kind === 'add')).toHaveLength(2)
  })

  it('Diff 保留全部变更行与完整单行文本', () => {
    const content = Array.from({ length: 100 }, (_, index) => `${index}-${'x'.repeat(700)}`).join(
      '\n',
    )
    const result = buildToolDiff('', content)
    expect(result.insertions).toBe(100)
    expect(result.diffPreview).toHaveLength(100)
    expect(result.diffPreview.map((row) => row.text).join('\n')).toBe(content)
    expect(result.diffTruncated).toBe(false)
  })
})

describe('文件工具统一执行路径', () => {
  let tempRoot = ''
  let workspaceRoot = ''
  const context = {
    agentId: 'pero',
    sessionId: 'thread-1',
    source: 'desktop',
    threadId: 'thread-1',
    channel: 'desktop',
    deviceReadScope: true,
    approvedOutsideWorkspace: true,
  }

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'infos-file-ops-'))
    workspaceRoot = path.join(tempRoot, 'workspace')
    await mkdir(workspaceRoot)
    setProductivityRuntime({
      sessions: new ExecutionSessionManager(),
      virtualWorkspace: new VirtualWorkspace(),
      workspace: { getWorkspaceRoot: () => workspaceRoot } as never,
      terminals: {} as never,
      approvalService: {} as never,
    })
  })

  afterEach(async () => {
    clearProductivityRuntime()
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('设备只读与工作区编辑器共用路径和文件版本', async () => {
    const outsideFile = path.join(tempRoot, 'outside.txt')
    await writeFile(outsideFile, '设备内容', 'utf8')

    const read = await readFileTool.execute({ file_path: outsideFile }, context)
    expect(isStructuredToolResult(read)).toBe(true)
    if (!isStructuredToolResult(read)) throw new Error('读取结果缺少结构化元数据')
    expect(read.output).toMatch(/^设备内容\n【读取引用】read_ref=read:/)
    expect(read.metadata?.readRef).toEqual(expect.stringMatching(/^read:/))
    expect(read.metadata?.hash).toBe(createHash('sha256').update('设备内容').digest('hex'))
    // Windows CI 的 TEMP 可能使用 RUNNER~1 短路径，工具引用保存规范化的真实路径。
    expect(read.metadata?.sourceRef).toBe(await realpath(outsideFile))

    const info = await fileInfoTool.execute({ file_path: outsideFile }, context)
    expect(JSON.parse(String(info))).toMatchObject({
      size: Buffer.byteLength('设备内容'),
      isDirectory: false,
    })
    const listing = await listDirectoryTool.execute({ dir_path: tempRoot }, context)
    expect(JSON.parse(String(listing))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'outside.txt', type: 'file' })]),
    )
  })

  it('追加使用原子写入，并拒绝过期文件 hash', async () => {
    const file = path.join(workspaceRoot, 'note.txt')
    await writeFile(file, '旧内容', 'utf8')
    const oldHash = createHash('sha256').update('旧内容').digest('hex')
    const inWorkspace = { ...context, approvedOutsideWorkspace: false }

    const appended = await writeFileTool.execute(
      {
        file_path: 'note.txt',
        content: '\n新内容',
        append: true,
        expected_hash: oldHash,
      },
      inWorkspace,
    )
    expect(JSON.parse(String(appended))).toMatchObject({
      success: true,
      operation: 'append',
      oldHash,
      newHash: createHash('sha256').update('旧内容\n新内容').digest('hex'),
    })
    expect(await readFile(file, 'utf8')).toBe('旧内容\n新内容')
    const aliased = await readFileTool.execute({ file_path: '@principal/note.txt' }, inWorkspace)
    expect(isStructuredToolResult(aliased) && aliased.output).toMatch(
      /^旧内容\n新内容\n【读取引用】read_ref=read:/,
    )

    const stale = await writeFileTool.execute(
      {
        file_path: 'note.txt',
        content: '错误覆盖',
        expected_hash: oldHash,
      },
      inWorkspace,
    )
    expect(JSON.parse(String(stale)).error).toContain('expected_hash')
    expect(await readFile(file, 'utf8')).toBe('旧内容\n新内容')
  })

  it('家的回收服务不可用时，审批凭证也不能绕过保护删除文件', async () => {
    const outsideFile = path.join(tempRoot, 'delete-me.txt')
    await writeFile(outsideFile, '待删除', 'utf8')
    for (const approvedSensitiveAction of [false, true]) {
      const result = await deleteFileTool.execute({ file_path: outsideFile }, { ...context, approvedSensitiveAction })
      expect(result).toMatchObject({ ok: false, error: { code: 'HOME_UNAVAILABLE' } })
      expect(await readFile(outsideFile, 'utf8')).toBe('待删除')
    }
  })
})
