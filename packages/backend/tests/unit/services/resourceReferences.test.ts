import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResourceService } from '@infos/backend/services/attachment/resourceService'
import { WorkspaceBrowserService } from '@infos/backend/services/workspace/workspaceBrowserService'
import {
  ExecutionSessionManager,
  createDefaultSandboxProfile,
} from '@infos/backend/services/execution/executionSession'
import { VirtualWorkspace } from '@infos/backend/services/execution/virtualWorkspace'
import {
  clearProductivityRuntime,
  setProductivityRuntime,
} from '@infos/backend/tools/productivityRuntimeHolder'
import { createWorkspaceRouter } from '@infos/backend/routers/workspace.router'
import { fileAccessError } from '@infos/backend/services/workspace/workspaceReference'

const context = { agentId: 'pero', threadId: 'files-thread', lookupWorkspace: true }
let root = '',
  workspace = ''
let resources: ResourceService, browser: WorkspaceBrowserService
let sessions: ExecutionSessionManager
const attachments = { outgoingCall: vi.fn(async () => null), saveOutgoing: vi.fn() }
const threads = {
  getThread: async (id: string) =>
    id === context.threadId ? { agentId: context.agentId, channel: 'desktop' } : null,
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'infos-references-')))
  workspace = path.join(root, 'workspace')
  await mkdir(path.join(workspace, 'src', '工具'), { recursive: true })
  await writeFile(path.join(workspace, 'src', '工具', '结果.ts'), 'export const 结果 = 1\n')
  sessions = new ExecutionSessionManager()
  const runtime = {
    sessions,
    virtualWorkspace: new VirtualWorkspace(),
    workspace: { getWorkspaceRoot: () => workspace },
  }
  setProductivityRuntime(runtime as never)
  resources = new ResourceService(attachments as never, threads as never)
  browser = new WorkspaceBrowserService(runtime as never, threads as never)
  vi.clearAllMocks()
})
afterEach(async () => {
  clearProductivityRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('工作区资源引用', () => {
  it('唯一简写补全为完整工作区路径，文件 URL 保留行号和中文空格', async () => {
    expect((await resources.resolveReference(context, '工具/结果.ts')).origin?.value).toBe(
      'src/工具/结果.ts',
    )
    const file = path.join(workspace, '中文 空格%20.txt')
    await writeFile(file, '原始文件')
    const result = await resources.resolveReference(context, `${pathToFileURL(file).href}#L12`)
    expect(result.origin).toMatchObject({ value: '中文 空格%20.txt', line: 12 })
    expect((await resources.referenceFile(context, '中文 空格%20.txt')).filePath).toBe(file)
  })
  it('同名文件返回歧义候选，不按修改时间挑选', async () => {
    await mkdir(path.join(workspace, 'other'))
    await writeFile(path.join(workspace, 'other', '结果.ts'), '不同内容')
    await expect(resources.resolveReference(context, '结果.ts')).rejects.toMatchObject({
      code: 'CONFLICT',
      data: { candidates: expect.arrayContaining(['src/工具/结果.ts', 'other/结果.ts']) },
    })
    expect((await resources.resolveReference(context, 'src/工具/结果.ts')).origin?.value).toBe(
      'src/工具/结果.ts',
    )
  })
  it('发送文件不继承点击引用的猜测补全，越界绝对路径始终拒绝', async () => {
    await expect(
      resources.resolveReference({ ...context, lookupWorkspace: false }, '结果.ts'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(resources.prepare(context, '结果.ts')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const outside = path.join(root, 'private.txt')
    await writeFile(outside, '私密数据')
    const session = await browser.session(context.agentId, context.threadId)
    session.sandboxProfile = createDefaultSandboxProfile('full-access', workspace)
    await expect(resources.prepare(context, outside)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(attachments.saveOutgoing).not.toHaveBeenCalled()
  })
  it('目录链接不能绕出工作区，也不能通过别名读取受保护目录', async () => {
    await mkdir(path.join(root, 'private'))
    await writeFile(path.join(root, 'private', 'secret.txt'), '工作区外')
    await mkdir(path.join(workspace, '.infos'))
    await writeFile(path.join(workspace, '.infos', 'secret.txt'), '受保护')
    // Windows 使用目录 Junction，无需创建文件符号链接的特权。
    await symlink(path.join(root, 'private'), path.join(workspace, 'escape'), 'junction')
    await symlink(path.join(workspace, '.infos'), path.join(workspace, 'alias'), 'junction')
    await expect(resources.resolveReference(context, 'escape/secret.txt')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(resources.resolveReference(context, 'alias/secret.txt')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
  it('文件元信息与读取接口区分不存在和越界，不返回笼统的 500 或 400', async () => {
    const router = createWorkspaceRouter({
      workspaceBrowserService: browser,
      productivityRuntime: { virtualWorkspace: new VirtualWorkspace() },
    } as never)
    const describe = await router.request(
      `/file?${new URLSearchParams({
        agentId: context.agentId,
        threadId: context.threadId,
        path: 'missing.txt',
      })}`,
    )
    expect(describe.status).toBe(404)
    const read = await router.request('/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...context, path: '../private.txt' }),
    })
    expect(read.status).toBe(403)
    expect(await read.json()).toMatchObject({ code: 'FORBIDDEN' })
  })
  it('会话和任务不能借文件引用切换到其他角色或目录', async () => {
    await expect(
      resources.resolveReference({ ...context, agentId: 'other' }, '结果.ts'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      resources.resolveReference({ ...context, taskId: '../other' }, '结果.ts'),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('远程请求不能让服务端直接执行工作区程序', async () => {
    await writeFile(path.join(workspace, 'run.exe'), '程序内容')
    const openTrustedPath = vi.fn()
    const router = createWorkspaceRouter({
      workspaceBrowserService: browser,
      systemService: { openTrustedPath },
    } as never)
    const response = await router.request('/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...context, path: 'run.exe', openOnNode: true }),
    })
    expect(response.status).toBe(403)
    expect(openTrustedPath).not.toHaveBeenCalled()
  })
  it.each([
    ['ENOENT', 'NOT_FOUND', 404],
    ['EPERM', 'FORBIDDEN', 403],
    ['EBUSY', 'RESOURCE_BUSY', 422],
  ] as const)('将 %s 映射到明确的 API 错误', (code, expected, status) => {
    expect(fileAccessError(Object.assign(new Error('文件系统错误'), { code }))).toMatchObject({
      code: expected,
      httpStatus: status,
    })
  })
})
