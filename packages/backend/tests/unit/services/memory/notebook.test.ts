import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { PathResolver } from '@infos/backend/core/pathResolver'
import { LocalWorkspaceService } from '@infos/backend/services/workspace/workspaceService'
import { NotebookContextProvider, isNotebookPath } from '@infos/backend/services/memory/notebook'

let workspace: LocalWorkspaceService
let provider: NotebookContextProvider
let root: string
const request = { agentId: 'pero', threadId: 'thread', channel: 'desktop', tokenBudget: 0, now: '2026-11-09T00:00:00.000Z' }

beforeEach(async () => {
  const temporary = mkdtempSync(path.join(process.env.PERO_DATA_DIR!, 'notebook-'))
  workspace = new LocalWorkspaceService(new PathResolver({
    appRoot: temporary, dataDir: path.join(temporary, 'data'),
    tempDir: path.join(temporary, 'temp'), workshopDir: '',
  }))
  await workspace.ensureWorkspace('pero')
  root = workspace.getWorkspaceRoot('pero')
  provider = new NotebookContextProvider(workspace)
})

describe('角色记事本', () => {
  it('首次编译给出文件位置，目录与正文按正常写入懒创建', async () => {
    const [region] = await provider.provide(request)
    assert(region)
    expect(region.content).toContain('notes/MEMORY.md')
    expect(existsSync(path.join(root, 'notes'))).toBe(false)
    await workspace.write('pero', 'notes/MEMORY.md', '主人喜欢红茶。', 'group')
    expect((await provider.provide(request))[0]!.content).toContain('主人喜欢红茶。')
  })

  it('主文件每次编译固定内容与指纹，附页和其他角色资料按需单独读取', async () => {
    await workspace.write('pero', 'notes/MEMORY.md', '主人喜欢红茶。', 'group')
    await workspace.write('pero', 'notes/工作.md', '附页中的详细工作过程。', 'group')
    await workspace.ensureWorkspace('nana')
    await workspace.write('nana', 'notes/MEMORY.md', 'Nana 的私人要点。', 'group')
    const [first] = await provider.provide(request)
    assert(first)
    await workspace.write('pero', 'notes/MEMORY.md', '主人现在喜欢绿茶。', 'group')
    const [next] = await provider.provide(request)
    assert(next)
    expect(first.content).toContain('主人喜欢红茶。')
    expect(first.content).not.toContain('详细工作过程')
    expect(first.content).not.toContain('Nana 的私人要点')
    expect(next.content).toContain('主人现在喜欢绿茶。')
    expect(next.contentHash).not.toBe(first.contentHash)
    expect(next.sourceGeneration).toBe(next.contentHash)
    expect(await provider.provide({ ...request, realmExecution: true })).toEqual([])
    expect(await provider.provide({ ...request, background: true })).toEqual([])
  })

  it('受限文件入口接受直接 Markdown 路径，拒绝跨目录、嵌套与其他格式', async () => {
    expect(await isNotebookPath(root, 'notes/MEMORY.md')).toBe(true)
    expect(await isNotebookPath(root, '@principal/notes/提醒.md')).toBe(true)
    expect(await isNotebookPath(root, 'notes', true)).toBe(true)
    for (const requested of ['notes/../private.md', 'notes/sub/page.md', 'notes/config.json', '../notes/MEMORY.md'])
      expect(await isNotebookPath(root, requested)).toBe(false)
  })

  it('notes 被目录链接重定向时拒绝读写及列举', async () => {
    const redirected = path.join(root, 'other')
    mkdirSync(redirected)
    writeFileSync(path.join(redirected, 'MEMORY.md'), '其他目录内容。')
    symlinkSync(redirected, path.join(root, 'notes'), 'junction')
    expect(await isNotebookPath(root, 'notes/MEMORY.md')).toBe(false)
    expect(await isNotebookPath(root, 'notes/new.md')).toBe(false)
    expect(await isNotebookPath(root, 'notes', true)).toBe(false)
  })
})
