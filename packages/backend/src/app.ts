import { t as __t } from './lib/i18n'
import { createRuntimeDebugRouter } from './routers/runtimeDebug.router'
import { createResourceVersionsRouter } from './routers/resourceVersions.router'
import { ResourceVersions } from '@infos/shared/resource-versions'
import { createPackagesRouter } from './routers/packages.router'
import { createUserAvatarRouter } from './routers/userAvatar.router'
import { createBackupRouter, isBackupDownloadRequest } from './routers/backup.router'
/**
 * Hono 应用入口
 *
 * 负责中间件注册、路由挂载与健康检查端点。
 * 使用 createApp() 工厂模式，便于测试。
 *
 * @module packages/backend/src/app
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { CODE_MESSAGES, CLIENT_ERROR_CODES } from '@infos/shared'
import { createObserverRouter } from './observer'
import { StaticAssetService } from './services/system/staticAssetService'
import { apiContractMiddleware } from './middleware/apiContract'
import { errorHandler } from './middleware/errorHandler'
import { metricsMiddleware } from './middleware/metrics'
import { requestContextMiddleware } from './middleware/requestContext'
import { tracingMiddleware } from './middleware/tracing'
import { requestLogger } from './middleware/requestLogger'
import { createAuthMiddleware, DEFAULT_PUBLIC_PATHS } from './middleware/auth'
import { HtmlPreviewService } from './services/attachment/htmlPreviewService'
import { createHtmlPreviewRouter } from './routers/htmlPreview.router'
import { createHealthRouter } from './routers/health.router'
import { createMetricsRouter } from './routers/metrics.router'
import { createIntegrationsRouter } from './routers/integrations.router'
import type { AppContext } from './container'
import { initTelemetry } from './lib/telemetry'
import {
  createArcaRouter,
  createArcaCollaborationRouter,
  createArcaUiRouter,
  createApplicationsRouter,
  createChatRouter,
  createAttachmentRouter,
  createMemoryRouter,
  createKnowledgeRouter,
  createConfigRouter,
  createModelRouter,
  createSystemRouter,
  createDistributedRouter,
  createAgentRouter,
  createRuntimeRouter,
  createApprovalRouter,
  createAgentInputRouter,
  createSurfaceRouter,
  createWorkspaceRouter,
  createTerminalRouter,
  createSchedulerRouter,
  createAssetRouter,
  createGatewayRouter,
  createMaintenanceRouter,
  createResetRouter,
  // 注意：createSocialRouter 已迁移到 packages/apps/social/runtime/social.router.ts
  // （由 SocialAppRuntime.initialize 通过 ctx.mountRouter 动态挂载）
  createInboundRouteRouter,
  createBackgroundTaskRouter,
  createTaskPlanRouter,
  createVoiceRouter,
  createMcpRouter,
  createStrongholdRouter,
} from './routers'
import { createPictoriaRouter } from './routers/pictoria.router'
import { createPromptRouter } from './routers/prompt.router'
import { createTarotRouter } from './routers/tarot.router'
import { createClientAccessRouter } from './routers/clientAccess.router'

/**
 * 创建并配置 Hono 应用实例
 * @param ctx - 依赖注入上下文
 */
export function createApp(ctx: AppContext) {
  // 测试和嵌入式调用可能绕过 startServer，工厂本身也保证 Provider 已初始化。
  initTelemetry()
  const app = new Hono()

  // ── 全局中间件 ──
  app.use('*', cors({ origin: (origin) => origin, credentials: true }))
  // metrics 需要包住后续中间件与路由，才能统计包含日志、业务处理和错误响应在内的完整耗时
  app.use('*', metricsMiddleware)
  // request context 必须早于 tracing/logger，确保业务日志和 Span 可共享请求字段
  app.use('*', requestContextMiddleware)
  app.use('*', tracingMiddleware)
  app.use('*', requestLogger)
  app.use('*', apiContractMiddleware)

  // 业务请求统一校验安装实例或设备身份；日志不属于公共健康检查。
  const apiToken = process.env.INFOS_API_TOKEN ?? ''
  if (ctx.clientAccess) {
    app.use('*', async (c, next) => {
      const path = c.req.path
      const publicPath =
        path === '/api/health' ||
        path === '/api/health/' ||
        path === '/api/client-access' ||
        path.startsWith('/api/client-access/') ||
        isBackupDownloadRequest(c.req.method, path) ||
        (!path.startsWith('/api/') && !path.startsWith('/ws') && path !== '/metrics')
      const identity = publicPath ? undefined : ctx.clientAccess.authenticate(c.req.raw)
      if (!publicPath && !identity)
        return c.json(
          { code: 'UNAUTHORIZED', message: __t('server.app.ts', '请先配对此设备，或重新登录') },
          401,
        )
      await next()
      // 撤销设备时同时关闭持续读取的 SSE，不让旧连接继续收取新事件。
      if (
        identity &&
        c.res.body &&
        c.res.headers.get('content-type')?.includes('text/event-stream')
      ) {
        const access = ctx.clientAccess
        const reader = c.res.body.getReader()
        let closed = false
        let timer: ReturnType<typeof setInterval> | undefined
        let unsubscribe: (() => void) | undefined
        const cleanup = () => {
          closed = true
          clearInterval(timer)
          unsubscribe?.()
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const validate = () => {
              if (!closed && !access.identify(identity.token)) {
                cleanup()
                void reader.cancel().catch(() => {})
                controller.close()
              }
            }
            unsubscribe = access.onRevoke(validate)
            timer = setInterval(validate, 30_000)
            timer.unref()
            validate()
          },
          async pull(controller) {
            try {
              const result = await reader.read()
              if (closed) return
              if (result.done) {
                cleanup()
                controller.close()
              } else controller.enqueue(result.value)
            } catch (error) {
              if (!closed) {
                cleanup()
                controller.error(error)
              }
            }
          },
          cancel(reason) {
            cleanup()
            return reader.cancel(reason)
          },
        })
        c.res = new Response(body, { status: c.res.status, headers: c.res.headers })
      }
    })
    app.route('/api/client-access', createClientAccessRouter(ctx.clientAccess))
  } else {
    const legacyAuth = createAuthMiddleware({
      token: apiToken,
      publicPaths: [
        ...DEFAULT_PUBLIC_PATHS,
        '/applications/arca',
        '/applications/pictoria',
        '/html-previews',
      ],
    })
    app.use('*', (c, next) => isBackupDownloadRequest(c.req.method, c.req.path) ? next() : legacyAuth(c, next))
  }

  // ── 全局错误处理 ──
  app.onError(errorHandler)
  app.use('/api/*', async (c, next) => {
    const path = c.req.path
    const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
    const backupControl = path === '/api/backups' || path.startsWith('/api/backups/') || path === '/api/distributed/snapshot'
    const release = !readOnly && !backupControl ? ctx.backupService?.beginWrite() : undefined
    try { await next() } finally { release?.() }
  })

  // ── 健康检查 (白名单，无需鉴权) ──
  app.route('/api/health', createHealthRouter(ctx.logQueryService))

  // ── Prometheus 指标端点 (白名单，供 scrape 使用) ──
  app.route('/metrics', createMetricsRouter())

  // ── API 路由挂载 ──
  // 资源用复数名词, 路径 2-4 层
  if (ctx.arcaApplication) {
    app.route(
      '/applications/arca',
      createArcaUiRouter(new StaticAssetService(ctx.arcaApplication.uiRoot)),
    )
    app.route('/api/applications/arca', createArcaRouter(ctx))
  }
  if (ctx.arcaCollaboration) {
    app.route('/api/applications/arca/collaboration', createArcaCollaborationRouter(ctx))
  }
  app.route('/api/applications/pictoria', createPictoriaRouter(ctx))
  if (ctx.pictoria)
    app.route(
      '/applications/pictoria',
      createArcaUiRouter(new StaticAssetService(ctx.pictoria.controller.uiRoot), 'pictoria'),
    )
  app.route('/api/applications', createApplicationsRouter(ctx))
  app.route('/api/chat', createChatRouter(ctx))
  const htmlPreviews =
    ctx.htmlPreviewService ??
    new HtmlPreviewService(ctx.resourceService, ctx.attachmentService, ctx.threadService)
  app.route('/html-previews', createHtmlPreviewRouter(htmlPreviews))
  app.route('/api/attachments', createAttachmentRouter(ctx, htmlPreviews))
  app.route('/api/memories', createMemoryRouter(ctx))
  app.route('/api/knowledge', createKnowledgeRouter(ctx))
  app.route('/api/configs', createConfigRouter(ctx))
  app.route('/api/models', createModelRouter(ctx))
  app.route('/api/system', createSystemRouter(ctx))
  app.route('/api/system/user-avatar', createUserAvatarRouter(ctx))
  app.route('/api/tarot', createTarotRouter(ctx))
  app.route('/api/integrations', createIntegrationsRouter(ctx))
  app.route(
    '/api/packages',
    createPackagesRouter(ctx.packageManagement, ctx.packageUi, ctx.packageAssets),
  )
  app.route('/api/distributed', createDistributedRouter(ctx))
  if (ctx.backupService) app.route('/api/backups', createBackupRouter(ctx.backupService))
  app.route('/api/agents', createAgentRouter(ctx))
  app.route('/api/runtime', createRuntimeRouter(ctx))
  app.route('/api/runtime-debug', createRuntimeDebugRouter(ctx.runtimeDebug))
  app.route(
    '/api/resource-versions',
    createResourceVersionsRouter(new ResourceVersions(ctx.pathResolver.getRoot('@data')!)),
  )
  app.route('/api/approvals', createApprovalRouter(ctx))
  app.route('/api/agent-inputs', createAgentInputRouter(ctx))
  app.route('/api/surfaces', createSurfaceRouter(ctx))
  if (ctx.agentStateService) {
    app.route('/api/observer', createObserverRouter(ctx.agentStateService))
  }
  app.route('/api/workspace', createWorkspaceRouter(ctx))
  app.route('/api/terminals', createTerminalRouter(ctx))
  app.route('/api/scheduler', createSchedulerRouter(ctx))
  app.route('/api/assets', createAssetRouter(ctx))
  app.route('/api/prompts', createPromptRouter(ctx))
  app.route('/api/maintenance', createMaintenanceRouter(ctx))
  // 危险区域重置（清空对话/记忆/恢复出厂，均需确认短语）
  app.route('/api/reset', createResetRouter(ctx))
  // 注意：社交 HTTP 路由已迁移到 packages/apps/social/runtime/social.router.ts
  // （由 SocialAppRuntime 管理，不再通过主 AppContext 挂载）
  app.route('/api/inbound-routes', createInboundRouteRouter(ctx))
  // M05: 统一任务中心（派发/查询/控制 + Gateway 事件桥接）
  app.route('/api/background-tasks', createBackgroundTaskRouter(ctx))
  app.route('/api/task-plans', createTaskPlanRouter(ctx))
  app.route(
    '/api/voice',
    createVoiceRouter({ ttsService: ctx.ttsService, asrService: ctx.asrService }),
  )
  app.route('/api/mcp', createMcpRouter(ctx))
  // 据点（群聊）路由：群聊房间管理、Agent 位置、管家配置等
  app.route('/api/stronghold', createStrongholdRouter(ctx))
  app.route('/ws', createGatewayRouter(ctx.gatewayHub))

  // ── 404 兜底 ──
  const notFoundCode = CLIENT_ERROR_CODES.NOT_FOUND
  app.notFound(async (c) => {
    const frontend = await ctx.webFrontend?.response(c.req.raw)
    return (
      frontend ??
      c.json(
        {
          code: notFoundCode,
          message: CODE_MESSAGES[notFoundCode],
        },
        404,
      )
    )
  })

  return app
}
