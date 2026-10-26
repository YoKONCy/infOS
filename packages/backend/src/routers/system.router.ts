import { t as __t } from '../lib/i18n'
/**
 * System Router — 系统信息与健康检查
 *
 * 提供系统级 API：
 * - GET /api/system/health   健康检查
 * - GET /api/system/info     系统信息 (版本/运行时/统计)
 *
 * @module packages/backend/src/routers/system.router
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { validate as zValidator } from '../lib/validation'
import { streamSSE } from 'hono/streaming'
import type { AppContext } from '../container'
import { addLogListener, getLogHistory } from '../lib/logBroadcaster'
import { AppError } from '../lib/appError'
import { BACKGROUND_PRESET_IDS } from '../services/system/chatBackgroundService'

/** 应用版本号 (由 scripts/sync-version.ts 自动同步) */
const APP_VERSION = '0.9.7'
const backgroundPresetQuery = z.object({
  preset: z.enum(BACKGROUND_PRESET_IDS).default('preset-1'),
})

export function createSystemRouter(ctx: AppContext) {
  const router = new Hono()

  router.get(
    '/token-usage/filters',
    zValidator(
      'query',
      z.object({
        agentId: z.string().trim().min(1).max(128).optional(),
      }),
    ),
    (c) =>
      c.json({
        code: 'OK',
        data: ctx.tokenUsageService.filterOptions(c.req.valid('query').agentId),
      }),
  )

  router.get(
    '/token-usage',
    zValidator(
      'query',
      z.object({
        period: z.enum(['today', '7d', '30d']).default('today'),
        timeZone: z
          .string()
          .min(1)
          .max(100)
          .default('UTC')
          .refine((value) => {
            try {
              new Intl.DateTimeFormat('en', { timeZone: value })
              return true
            } catch {
              return false
            }
          }, '时区无效'),
        agentId: z.string().trim().min(1).max(128).optional(),
        threadId: z.string().trim().min(1).max(300).optional(),
        provider: z.string().trim().min(1).max(100).optional(),
        modelId: z.string().trim().min(1).max(300).optional(),
      }),
    ),
    (c) => {
      const { period, timeZone, agentId, ...filters } = c.req.valid('query')
      return c.json({
        code: 'OK',
        message: __t('server.routers', '获取成功'),
        data: ctx.tokenUsageService.statistics(period, timeZone, agentId, filters),
      })
    },
  )

  router.get('/weather', (c) =>
    c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: ctx.weatherService.getStatus(),
    }),
  )
  router.put(
    '/weather/location',
    zValidator('json', z.object({ location: z.string().max(80) })),
    async (c) => {
      const { location } = c.req.valid('json')
      const data = await ctx.weatherService.setLocation(location)
      return c.json({ code: 'OK', message: __t('server.routers', '城市已保存'), data })
    },
  )

  // GET /api/system/health — 健康检查
  router.get('/health', (c) => {
    return c.json({
      code: 'OK',
      message: __t('server.routers', '服务运行正常'),
      data: {
        status: 'healthy',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      },
    })
  })

  // GET /api/system/info — 系统信息
  router.get('/info', async (c) => {
    const agents = ctx.agentManager.listAgents()

    // 业务逻辑委托 Service 层 (S05 §2)
    const snapshot = await ctx.systemService.getSnapshot()

    return c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: {
        version: APP_VERSION,
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          uptime: Math.floor(process.uptime()),
          memoryUsage: {
            rss: snapshot.memoryUsedMB,
            heapUsed: snapshot.heapUsedMB,
          },
          cpuPercent: snapshot.cpuPercent,
          totalMemoryMB: snapshot.totalMemoryMB,
        },
        storage: {
          sqliteSizeMB: snapshot.sqliteSizeMB,
          triviumSizeMB: snapshot.triviumSizeMB,
          triviumNodeCount: ctx.storeRegistry.countExistingNodes(agents.map((agent) => agent.id)),
        },
        agents: {
          total: agents.length,
          enabled: agents.filter((a) => a.isEnabled).length,
          activeId: ctx.agentManager.defaultAgentId,
        },
        gateway: {
          connectedNodes: ctx.gatewayHub.connectedCount,
        },
        multiNode: {
          nodes: ctx.nodeRegistry.listNodes(),
          sessions: ctx.nodeRegistry.listSessions(),
          inputSeats: ctx.nodeRegistry.listInputSeats(),
          capabilityTransport: ctx.capabilityBridge.diagnostics(),
        },
      },
    })
  })

  // 背景接口按预设隔离；不传预设时兼容原有背景。
  router.put('/chat-background', zValidator('query', backgroundPresetQuery), async (c) => {
    const body = await c.req.parseBody()
    const file = body.background
    if (!(file instanceof File)) throw new AppError('MISSING_FIELD', { message: '请上传背景图片' })
    const { preset } = c.req.valid('query')
    await ctx.chatBackgroundService.save(file, preset)
    return c.json({
      code: 'OK',
      message: __t('server.routers', '聊天背景已保存'),
      data: { contentUrl: `/system/chat-background/content?preset=${preset}&v=${Date.now()}` },
    })
  })

  router.get('/chat-background/content', zValidator('query', backgroundPresetQuery), async (c) => {
    const { bytes, mime } = await ctx.chatBackgroundService.read(c.req.valid('query').preset)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
      },
    })
  })

  router.delete('/chat-background', zValidator('query', backgroundPresetQuery), async (c) => {
    await ctx.chatBackgroundService.remove(c.req.valid('query').preset)
    return c.json({ code: 'OK', message: __t('server.routers', '聊天背景已删除') })
  })

  // POST /api/system/token-count — 为前端编辑器提供后端统一精确计数。
  router.post(
    '/token-count',
    zValidator('json', z.object({ text: z.string().max(1_000_000) })),
    (c) => {
      const { text } = c.req.valid('json')
      return c.json({
        code: 'OK',
        message: __t('server.routers', '计算成功'),
        data: {
          tokens: ctx.tokenCounter.countTokens(text),
          tokenizer: ctx.tokenCounter.tokenizerId,
        },
      })
    },
  )

  // POST /api/system/storage/sqlite-snapshot — 为云存档生成一致性 SQLite 快照
  router.post('/storage/sqlite-snapshot', async (c) => {
    const data = await ctx.databaseSnapshotService.createCloudSnapshot()
    return c.json({ code: 'OK', message: __t('server.routers', '数据库快照已生成'), data })
  })

  // POST /api/system/open-path — 通过系统打开路径 (P2-13)
  router.post('/open-path', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const targetPath = (body as Record<string, unknown>).path as string

    await ctx.systemService.openPath(targetPath)

    return c.json({ code: 'OK', message: __t('server.routers', '已请求打开') })
  })

  // GET /api/system/logs/stream — SSE 日志流
  // 支持 EventSource 断线续传 (Last-Event-ID header)
  router.get('/logs/stream', (c) => {
    // 解析 Last-Event-ID（断线重连时 EventSource 自动携带）
    const lastEventId = c.req.header('Last-Event-ID')
    const afterId = lastEventId ? parseInt(lastEventId, 10) : undefined

    return streamSSE(c, async (stream) => {
      // 1. 先发送缓冲区中的历史日志（支持增量续传）
      const history = getLogHistory(afterId)
      for (const event of history) {
        await stream.writeSSE({
          event: 'log',
          id: String(event.id),
          data: JSON.stringify(event),
        })
      }

      // 2. 注册实时监听
      let alive = true
      const unlisten = addLogListener((event) => {
        if (!alive) return
        stream
          .writeSSE({
            event: 'log',
            id: String(event.id),
            data: JSON.stringify(event),
          })
          .catch(() => {
            // 连接已断开，忽略
            alive = false
          })
      })

      // 3. 心跳保活（防止代理/负载均衡器超时断开）
      try {
        while (alive) {
          await stream.writeSSE({ event: 'ping', data: '' })
          await stream.sleep(15000)
        }
      } catch {
        // 客户端断开
      } finally {
        alive = false
        unlisten()
      }
    })
  })

  return router
}
