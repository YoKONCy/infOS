import path from 'node:path'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceBrowserService } from '@infos/backend/services/workspace/workspaceBrowserService'
import { ExecutionSessionManager } from '@infos/backend/services/execution/executionSession'
import { VirtualWorkspace } from '@infos/backend/services/execution/virtualWorkspace'
import {
  retainToolObservation,
  releaseToolObservations,
} from '@infos/backend/services/execution/toolObservation'
import { createWorkspaceRouter } from '@infos/backend/routers/workspace.router'
import { errorHandler } from '@infos/backend/middleware/errorHandler'

let root = '',
  file = ''
const owner = {
  agentId: 'search-reader',
  threadId: 'search-thread',
  channel: 'desktop',
  taskId: 'search-task',
}
const virtual = new VirtualWorkspace()
let service: WorkspaceBrowserService
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'search-file-'))
  file = path.join(await realpath(root), 'result.ts')
  await writeFile(file, 'const 中文 = 1\n')
  const sessions = new ExecutionSessionManager()
  await sessions.getOrCreate({
    ownerAgentId: owner.agentId,
    threadId: owner.threadId,
    taskId: owner.taskId,
    channel: owner.channel,
    workspaceRoot: path.join(root, 'tasks', owner.taskId, 'workspace'),
  })
  service = new WorkspaceBrowserService(
    {
      sessions,
      virtualWorkspace: virtual,
      workspace: { getWorkspaceRoot: () => path.join(root, 'workspace') },
    } as never,
    {
      getThread: async (id: string) =>
        id === owner.threadId ? { agentId: owner.agentId, channel: owner.channel } : null,
    } as never,
  )
})
afterEach(async () => {
  releaseToolObservations(owner, true)
  await rm(root, { recursive: true, force: true })
})
function reference() {
  return retainToolObservation(JSON.stringify({ kind: 'code_search_files', files: [file] }), owner)!
}
describe('搜索结果只读打开', () => {
  it('外部任务文件凭据可读取，普通工作区接口仍拒绝越界', async () => {
    const result = await service.searchResultFile({ ...owner, resultRef: reference(), file })
    expect(result.descriptor).toMatchObject({ path: file, kind: 'text' })
    expect(result.read.content).toBe('const 中文 = 1\n')
    const session = await service.session(owner.agentId, owner.threadId)
    await expect(virtual.resolveReadablePath(session, file)).rejects.toBeDefined()
  })
  it('其他角色、会话、任务和未命中文件都不能复用凭据', async () => {
    const input = { ...owner, resultRef: reference(), file }
    await expect(service.searchResultFile({ ...input, agentId: 'other' })).rejects.toBeDefined()
    await expect(service.searchResultFile({ ...input, threadId: 'other' })).rejects.toBeDefined()
    await expect(service.searchResultFile({ ...input, taskId: 'other' })).rejects.toBeDefined()
    const other = path.join(root, 'other.ts')
    await writeFile(other, '不能读取')
    await expect(service.searchResultFile({ ...input, file: other })).rejects.toThrow(
      '文件不属于本次搜索结果',
    )
  })
  it('清除短期缓存后可从持久凭据恢复，新版本内容按当前文件读取', async () => {
    const input = { ...owner, resultRef: reference(), file }
    releaseToolObservations(owner)
    await writeFile(file, '当前版本\n')
    expect((await service.searchResultFile(input)).read.content).toBe('当前版本\n')
  })
  it('长文件按命中行读取窗口，避免只能定位到前 128K 字符', async () => {
    const input = { ...owner, resultRef: reference(), file, line: 1500 }
    await writeFile(
      file,
      Array.from({ length: 2000 }, (_, index) => `${index + 1} ${'内容'.repeat(40)}`).join('\n'),
    )
    const result = await service.searchResultFile(input)
    expect(result.read.lineStart).toBe(1480)
    expect(result.read.lineEnd).toBe(1580)
    expect(result.read.content).toContain('1500 ')
  })
  it('HTTP 打开接口校验凭据格式并拒绝跨任务访问', async () => {
    const router = createWorkspaceRouter({ workspaceBrowserService: service } as never)
    router.onError(errorHandler)
    const input = { ...owner, resultRef: reference(), file }
    const request = (body: unknown) =>
      router.request('/search-result-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await request(input)).status).toBe(200)
    expect((await request({ ...input, taskId: 'other' })).status).toBe(403)
    expect((await request({ ...input, resultRef: '../../other' })).status).toBe(400)
  })
  it('其他工具的结果引用不能充当搜索文件凭据', async () => {
    const resultRef = retainToolObservation('null', owner)!
    await expect(service.searchResultFile({ ...owner, resultRef, file })).rejects.toThrow(
      '文件不属于本次搜索结果',
    )
  })
})
