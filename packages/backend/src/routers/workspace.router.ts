/**
 * workspace.router — HTTP 路由适配层
 *
 * 负责定义该模块的稳定入口、数据边界与错误语义。
 * 调用方通过这里访问领域能力，避免绕过校验直接耦合内部状态。
 */
import { Hono } from 'hono'
import { validate as zValidator } from '../lib/validation'
import { z } from 'zod'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'
import { resourceContent } from '../services/attachment/resourceContent'

const sessionSchema = z.object({
  agentId: z.string().min(1),
  threadId: z.string().min(1),
})

const readSchema = sessionSchema.extend({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(128_000).optional(),
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional(),
  tailLines: z.number().int().min(1).max(10_000).optional(),
})

const writeSchema = sessionSchema.extend({
  path: z.string().min(1),
  content: z.string(),
  expectedHash: z.string().optional(),
})

const renameSchema = sessionSchema.extend({
  path: z.string().min(1),
  newName: z.string().trim().min(1).max(255),
})

const deleteSchema = sessionSchema.extend({
  path: z.string().min(1),
})

const searchSchema = sessionSchema.extend({
  query: z.string().min(1),
  isRegex: z.boolean().optional(),
  fileType: z.string().optional(),
  path: z.string().optional(),
  respectGitIgnore: z.boolean().optional(),
  includeHidden: z.boolean().optional(),
})

/** Workspace浏览器API：严格绑定Agent的执行会话根目录。 */
export function createWorkspaceRouter(ctx: AppContext) {
  const router = new Hono()
  const runtime = ctx.productivityRuntime
  const resolve = (agentId: string, threadId: string) =>
    ctx.workspaceBrowserService.session(agentId, threadId)

  router.post(
    '/search-result-file',
    zValidator(
      'json',
      sessionSchema.extend({
        resultRef: z.string().regex(/^tool-result:[0-9a-f-]{36}$/i),
        taskId: z.string().optional(),
        file: z.string().min(1),
        line: z.number().int().min(1).optional(),
      }),
    ),
    async (c) => {
      const data = await ctx.workspaceBrowserService.searchResultFile(c.req.valid('json'))
      return c.json({ code: 'OK', data })
    },
  )

  /** 目录树（单层懒加载，前端点目录再深入） */
  router.get(
    '/tree',
    zValidator('query', sessionSchema.extend({ path: z.string().optional() })),
    async (c) => {
      const query = c.req.valid('query')
      const result = await ctx.workspaceBrowserService.tree(
        query.agentId,
        query.threadId,
        query.path ?? '.',
      )
      return c.json({ code: 'OK', data: result })
    },
  )

  /**
   * 返回经过 ExecutionSession 安全解析的真实 workspace 根目录。
   * Electron 客户端在自身桌面会话中打开本地路径；纯 Web/远程模式可请求执行节点代为打开。
   */
  router.post(
    '/reveal',
    zValidator('json', sessionSchema.extend({ openOnNode: z.boolean().optional() })),
    async (c) => {
      const input = c.req.valid('json')
      const session = await resolve(input.agentId, input.threadId)
      if (input.openOnNode) await ctx.systemService.openTrustedPath(session.workspaceRoot)
      return c.json({
        code: 'OK',
        data: {
          path: session.workspaceRoot,
          platform: process.platform,
          location: 'execution-node',
        },
      })
    },
  )

  /** 类型描述与二进制流式浏览共用工作区边界。 */
  const fileQuery = sessionSchema.extend({
    path: z.string().min(1),
    version: z.string().optional(),
  })
  router.get('/file', zValidator('query', fileQuery), async (c) => {
    const input = c.req.valid('query')
    const { descriptor } = await ctx.workspaceBrowserService.file(
      input.agentId,
      input.threadId,
      input.path,
    )
    return c.json({ code: 'OK', data: descriptor })
  })
  router.on(['GET', 'HEAD'], '/content', zValidator('query', fileQuery), async (c) => {
    const input = c.req.valid('query')
    const { filePath, descriptor } = await ctx.workspaceBrowserService.file(
      input.agentId,
      input.threadId,
      input.path,
    )
    if (input.version && input.version !== descriptor.version)
      throw new AppError('CONFLICT', { message: '文件已变化，请重新载入预览' })
    // SVG 以文本交给客户端清理，再作为隔离图像显示，不直接嵌入应用 DOM。
    const mime =
      descriptor.kind === 'svg' && c.req.query('download') !== '1'
        ? 'text/plain'
        : descriptor.mimeType
    return resourceContent(c, filePath, mime, descriptor.name)
  })
  router.post(
    '/open-file',
    zValidator(
      'json',
      readSchema
        .pick({ agentId: true, threadId: true, path: true })
        .extend({ openOnNode: z.boolean().optional() }),
    ),
    async (c) => {
      const input = c.req.valid('json')
      const { filePath, descriptor } = await ctx.workspaceBrowserService.file(
        input.agentId,
        input.threadId,
        input.path,
      )
      if (input.openOnNode) await ctx.systemService.openTrustedPath(filePath)
      return c.json({ code: 'OK', data: { path: filePath, name: descriptor.name } })
    },
  )

  /** 范围读取（行/字节/tail，含 hash 与截断状态） */
  router.post('/read', zValidator('json', readSchema), async (c) => {
    const input = c.req.valid('json')
    const session = await resolve(input.agentId, input.threadId)
    try {
      const result = await runtime.virtualWorkspace.read(session, input.path, {
        offset: input.offset,
        limit: input.limit,
        lineStart: input.lineStart,
        lineEnd: input.lineEnd,
        tailLines: input.tailLines,
      })
      return c.json({ code: 'OK', data: result })
    } catch (error) {
      throw new AppError('VALIDATION_ERROR', {
        message: String(error instanceof Error ? error.message : error),
      })
    }
  })

  /** 全量原子写（VirtualWorkspace.atomicWrite，可带 hash 乐观锁） */
  router.post('/write', zValidator('json', writeSchema), async (c) => {
    const input = c.req.valid('json')
    const session = await resolve(input.agentId, input.threadId)
    const virtualWorkspace = runtime.virtualWorkspace
    try {
      const result = await virtualWorkspace.write(session, {
        path: input.path,
        content: input.content,
        expectedHash: input.expectedHash,
      })
      return c.json({
        code: 'OK',
        data: {
          hash: result.newHash,
          bytes: result.bytes,
          operation: result.operation,
          editRange: result.editRange,
          insertions: result.insertions,
          deletions: result.deletions,
        },
      })
    } catch (error) {
      throw new AppError('VALIDATION_ERROR', {
        message: String(error instanceof Error ? error.message : error),
      })
    }
  })

  /** 重命名工作区文件或目录，固定在原目录且禁止覆盖。 */
  router.post('/rename', zValidator('json', renameSchema), async (c) => {
    const input = c.req.valid('json')
    const session = await resolve(input.agentId, input.threadId)
    try {
      const result = await runtime.virtualWorkspace.renameFile(
        session,
        input.path,
        input.newName,
        true,
      )
      return c.json({ code: 'OK', data: result })
    } catch (error) {
      throw new AppError('VALIDATION_ERROR', {
        message: String(error instanceof Error ? error.message : error),
      })
    }
  })

  /** 文件树确认后的删除，支持递归目录并保留工作区安全校验。 */
  router.post('/delete', zValidator('json', deleteSchema), async (c) => {
    const input = c.req.valid('json')
    const session = await resolve(input.agentId, input.threadId)
    try {
      const result = await runtime.virtualWorkspace.deleteEntry(session, input.path)
      return c.json({ code: 'OK', data: result })
    } catch (error) {
      throw new AppError('VALIDATION_ERROR', {
        message: String(error instanceof Error ? error.message : error),
      })
    }
  })

  /** rg 搜索（无 rg 自动 Node fallback，目录强制在 workspace 内） */
  router.post('/search', zValidator('json', searchSchema), async (c) => {
    const input = c.req.valid('json')
    try {
      const result = await ctx.workspaceBrowserService.search(input)
      return c.json({ code: 'OK', data: result })
    } catch (error) {
      throw new AppError('VALIDATION_ERROR', {
        message: String(error instanceof Error ? error.message : error),
      })
    }
  })

  return router
}
