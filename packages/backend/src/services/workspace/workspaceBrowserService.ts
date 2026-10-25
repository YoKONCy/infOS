/**
 * workspaceBrowserService — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import path from 'node:path'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import type { CodeSearchNavigation, WorkspaceFileDescriptor } from '@infos/shared'
import { AppError } from '../../lib/appError'
import type { ProductivityRuntime } from '../../tools/productivityRuntimeHolder'
import { __codeSearchInternals } from '../../tools/codeSearcher'
import type { ThreadService } from '../thread/threadService'
import { workspaceFileType } from './workspaceFileType'
import { readToolObservation } from '../execution/toolObservation'
import { t } from '../../lib/i18n'

export interface WorkspaceTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modifiedAt?: string
}

/** Workspace浏览与搜索用例层；封装文件系统和搜索引擎基础设施。 */
export class WorkspaceBrowserService {
  constructor(
    private readonly runtime: ProductivityRuntime,
    private readonly threads?: ThreadService,
  ) {}

  /** 外部与任务文件仅通过已有搜索凭据读取，不能借此扩展工作区写权限。 */
  async searchResultFile(input: CodeSearchNavigation & { file: string; line?: number }) {
    const thread = await this.threads?.getThread(input.threadId)
    if (!thread || thread.agentId !== input.agentId)
      throw new AppError('FORBIDDEN', { message: t('server.tools', '搜索结果与会话不匹配') })
    let manifest: { kind?: string; files?: unknown[] }
    try {
      const stored = readToolObservation(
        input.resultRef,
        {
          agentId: input.agentId,
          threadId: input.threadId,
          taskId: input.taskId,
          channel: thread.channel,
        },
        0,
        128_000,
      )
      manifest = JSON.parse(stored.content)
    } catch {
      throw new AppError('FORBIDDEN', { message: t('server.tools', '搜索结果与会话不匹配') })
    }
    const target = path.resolve(input.file)
    if (
      !manifest ||
      manifest.kind !== 'code_search_files' ||
      !Array.isArray(manifest.files) ||
      !manifest.files.includes(target)
    )
      throw new AppError('FORBIDDEN', { message: t('server.tools', '文件不属于本次搜索结果') })
    if ((await realpath(target)) !== target)
      throw new AppError('FORBIDDEN', {
        message: t('server.tools', '搜索文件路径已变化，请重新搜索'),
      })
    const info = await stat(target)
    if (!info.isFile() || info.size > 10 * 1024 * 1024)
      throw new AppError('VALIDATION_ERROR', {
        message: t('server.tools', '搜索文件暂不可预览，请重新搜索'),
      })
    const principalRoot = this.runtime.workspace.getWorkspaceRoot(input.agentId)
    const session = await this.runtime.sessions.getOrCreate({
      ownerAgentId: input.agentId,
      threadId: input.threadId,
      taskId: input.taskId,
      channel: thread.channel,
      workspaceRoot: input.taskId
        ? path.join(path.dirname(principalRoot), 'tasks', input.taskId, 'workspace')
        : principalRoot,
    })
    const read = await this.runtime.virtualWorkspace.read(session, target, {
      deviceScope: true,
      limit: 128_000,
      ...(input.line ? { lineStart: Math.max(1, input.line - 20), lineEnd: input.line + 80 } : {}),
    })
    const descriptor: WorkspaceFileDescriptor = {
      path: target,
      name: path.basename(target),
      kind: 'text',
      mimeType: 'text/plain',
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      version: read.hash,
    }
    return { descriptor, read }
  }

  async session(agentId: string, threadId: string) {
    if (this.threads) {
      const thread = await this.threads.getThread(threadId)
      if (!thread || thread.agentId !== agentId || thread.channel !== 'desktop') {
        throw new AppError('FORBIDDEN', { message: '工作区会话与角色不匹配' })
      }
    }
    const workspaceRoot = this.runtime.workspace.getWorkspaceRoot(agentId)
    return this.runtime.sessions.getOrCreate({
      ownerAgentId: agentId,
      threadId,
      channel: 'desktop',
      workspaceRoot,
    })
  }

  async tree(
    agentId: string,
    threadId: string,
    relative = '.',
  ): Promise<{
    root: string
    parent: string
    nodes: WorkspaceTreeNode[]
  }> {
    const session = await this.session(agentId, threadId)
    const directory = await this.runtime.virtualWorkspace.resolveDirectory(session, relative)
    const info = await stat(directory).catch(() => null)
    if (!info?.isDirectory())
      throw new AppError('NOT_FOUND', { message: `目录不存在: ${relative}` })
    const entries = await readdir(directory, { withFileTypes: true })
    const nodes: WorkspaceTreeNode[] = []
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = path.join(directory, entry.name)
      const childInfo = entry.isFile() ? await stat(absolute).catch(() => null) : null
      nodes.push({
        name: entry.name,
        path: path.posix.join(relative.replaceAll('\\', '/').replace(/^\.\/?$/, ''), entry.name),
        type: entry.isDirectory() ? 'directory' : 'file',
        size: childInfo?.size,
        modifiedAt: childInfo?.mtime.toISOString(),
      })
    }
    nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
    )
    return { root: session.workspaceRoot, parent: relative, nodes }
  }

  /** 浏览器只解析当前工作区的真实文件，二进制内容不经过文本读取或模型。 */
  async file(agentId: string, threadId: string, inputPath: string) {
    const session = await this.session(agentId, threadId)
    const filePath = await this.runtime.virtualWorkspace.resolveReadablePath(session, inputPath)
    const handle = await open(filePath, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new AppError('VALIDATION_ERROR', { message: '目标不是普通文件' })
      const header = Buffer.alloc(Math.min(info.size, 8192))
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      const descriptor: WorkspaceFileDescriptor = {
        path: inputPath,
        name: path.basename(filePath),
        ...workspaceFileType(filePath, header.subarray(0, bytesRead)),
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        version: `${info.size}-${info.mtimeMs}-${info.ctimeMs}`,
      }
      return { filePath, descriptor }
    } finally {
      await handle.close()
    }
  }

  async search(input: {
    agentId: string
    threadId: string
    query: string
    isRegex?: boolean
    fileType?: string
    path?: string
    respectGitIgnore?: boolean
    includeHidden?: boolean
  }) {
    const session = await this.session(input.agentId, input.threadId)
    const searchPath = await this.runtime.virtualWorkspace.resolveDirectory(
      session,
      input.path ?? '.',
    )
    const options = {
      query: input.query,
      isRegex: Boolean(input.isRegex),
      fileType: input.fileType,
      searchPath,
      respectGitIgnore: input.respectGitIgnore,
      includeHidden: input.includeHidden,
    }
    const rg = await __codeSearchInternals.searchWithRipgrep(options)
    const node = rg.available ? null : await __codeSearchInternals.searchWithNode(options)
    const matches = rg.available ? rg.matches : node!.matches
    return {
      matches,
      total: matches.length,
      truncated: rg.available ? rg.truncated : node!.truncated,
      engine: rg.available ? 'ripgrep' : 'node-fallback',
    }
  }
}
