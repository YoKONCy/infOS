import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ContextRegionRequest } from '@infos/shared'
import { PathResolver } from '@infos/backend/core/pathResolver'
import { LocalWorkspaceService } from '@infos/backend/services/workspace/workspaceService'
import { WorkspaceDirectoryContextProvider } from '@infos/backend/services/workspace/workspaceDirectoryContext'

let workspace: LocalWorkspaceService
let provider: WorkspaceDirectoryContextProvider
let root: string
const request: ContextRegionRequest = {
  agentId: 'pero', threadId: 'thread', channel: 'desktop', interactionMode: 'chat',
  tokenBudget: 0, now: '2026-11-12T00:00:00.000Z',
}

beforeEach(async () => {
  const temporary = mkdtempSync(path.join(process.env.PERO_DATA_DIR!, 'workspace-directory-'))
  workspace = new LocalWorkspaceService(new PathResolver({
    appRoot: temporary, dataDir: path.join(temporary, 'data'),
    tempDir: path.join(temporary, 'temp'), workshopDir: '',
  }))
  await workspace.ensureWorkspace('pero')
  root = workspace.getWorkspaceRoot('pero')
  provider = new WorkspaceDirectoryContextProvider(workspace)
})

describe('工作区根目录上下文', () => {
  it.each(['chat', 'work'] as const)('%s 每轮提供当前角色的直属名称', async (interactionMode) => {
    await workspace.write('pero', 'hello.txt', '根目录文件的正文', 'desktop')
    await workspace.write('pero', 'task/details.md', '任务的内部资料', 'desktop')
    await workspace.write('pero', 'notes/private.md', '笔记的内部资料', 'desktop')
    await workspace.ensureWorkspace('nana')
    await workspace.write('nana', 'nana-only.md', '其他角色的资料', 'desktop')
    const [region] = await provider.provide({ ...request, interactionMode })
    assert(region)
    expect(region.content).toContain('["notes/","task/","hello.txt"]')
    expect(region.content).not.toMatch(/details\.md|private\.md|nana-only\.md|文件的正文|内部资料|其他角色的资料/)
    expect(region.required).toBe(true)
  })

  it('快照随根目录名称变化刷新，文件正文变化沿用同一指纹', async () => {
    await workspace.write('pero', 'memo.md', '旧正文', 'desktop')
    const [first] = await provider.provide(request)
    assert(first)
    await workspace.write('pero', 'memo.md', '修改后的正文', 'desktop')
    const [bodyChanged] = await provider.provide(request)
    assert(bodyChanged)
    expect(bodyChanged.contentHash).toBe(first.contentHash)
    renameSync(path.join(root, 'memo.md'), path.join(root, 'renamed.md'))
    const [renamed] = await provider.provide(request)
    assert(renamed)
    expect(renamed.content).toContain('["renamed.md"]')
    expect(renamed.contentHash).not.toBe(first.contentHash)
    expect(renamed.sourceGeneration).toBe(renamed.contentHash)
    unlinkSync(path.join(root, 'renamed.md'))
    expect((await provider.provide(request))[0]!.content).toContain('\n[]\n')
  })

  it.each([
    { interactionMode: 'minimal' as const },
    { channel: 'group' },
    { channel: 'social' },
    { realmExecution: true },
    { background: true },
  ])('按模式和场景范围装配 $channel $interactionMode $realmExecution $background', async (scope) => {
    expect(await provider.provide({ ...request, ...scope })).toEqual([])
  })

  it('首次读取未创建的工作区返回空清单并保持只读', async () => {
    const [region] = await provider.provide({ ...request, agentId: 'new-agent' })
    assert(region)
    expect(region.content).toContain('\n[]\n')
    expect(existsSync(workspace.getWorkspaceRoot('new-agent'))).toBe(false)
  })

  it('根目录读取失败时提供不可用状态，普通对话继续装配', async () => {
    await workspace.write('pero', 'ordinary-file', '普通文件正文', 'desktop')
    const unavailable = new WorkspaceDirectoryContextProvider({
      getWorkspaceRoot: () => path.join(root, 'ordinary-file'),
    })
    const [region] = await unavailable.provide(request)
    assert(region)
    expect(region.content).toContain('本次目录概览暂时不可用。')
    expect(region.content).not.toContain('普通文件正文')
    expect(region.required).toBe(true)
  })
})
