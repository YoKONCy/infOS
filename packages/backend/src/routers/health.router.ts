import { t as __t } from '../lib/i18n'
import { Hono } from 'hono'
import { SERVER_PORT } from '../lib/env'
import type { LogQueryService } from '../services/system/logQueryService'

/** 健康检查与日志查询路由。 */
export function createHealthRouter(logQuery?: LogQueryService) {
  const router = new Hono()
  router.get('/', (c) => {
    const uptime = process.uptime()
    const mem = process.memoryUsage()
    return c.json({
      code: 'OK',
      message: __t('server.routers', '成功'),
      data: {
        status: 'ok',
        version: '0.9.8',
        uptime: Math.round(uptime),
        uptimeHuman: formatUptime(uptime),
        port: SERVER_PORT,
        platform: process.platform,
        nodeVersion: process.version,
        memory: {
          rss: formatBytes(mem.rss),
          heapUsed: formatBytes(mem.heapUsed),
          heapTotal: formatBytes(mem.heapTotal),
          external: formatBytes(mem.external),
        },
        timestamp: new Date().toISOString(),
      },
    })
  })
  router.get('/logs', (c) => {
    if (!logQuery) {
      return c.json(
        {
          code: 'PRECONDITION_FAILED',
          message: __t('server.routers', '日志文件持久化未启用'),
          data: { reason: '未配置日志文件输出' },
        },
        422,
      )
    }
    try {
      const data = logQuery.list()
      if (!data) {
        return c.json(
          {
            code: 'PRECONDITION_FAILED',
            message: __t('server.routers', '日志文件持久化未启用'),
            data: { reason: '未配置日志文件输出' },
          },
          422,
        )
      }
      return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data })
    } catch {
      return c.json(
        { code: 'INTERNAL_ERROR', message: __t('server.routers', '读取日志目录失败') },
        500,
      )
    }
  })
  router.get('/logs/:filename', (c) => {
    if (!logQuery) {
      return c.json(
        { code: 'PRECONDITION_FAILED', message: __t('server.routers', '日志文件持久化未启用') },
        422,
      )
    }
    try {
      if (!logQuery.list()) {
        return c.json(
          { code: 'PRECONDITION_FAILED', message: __t('server.routers', '日志文件持久化未启用') },
          422,
        )
      }
      const data = logQuery.read(c.req.param('filename'), Number(c.req.query('lines') ?? 200))
      return data
        ? c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data })
        : c.json({ code: 'BAD_REQUEST', message: __t('server.routers', '非法文件名') }, 400)
    } catch {
      return c.json(
        {
          code: 'NOT_FOUND',
          message: __t('server.routers', '日志文件不存在: {0}', [c.req.param('filename')]),
        },
        404,
      )
    }
  })
  return router
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatUptime(seconds: number): string {
  const parts: string[] = []
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) parts.push(`${days}天`)
  if (hours) parts.push(`${hours}时`)
  if (minutes) parts.push(`${minutes}分`)
  parts.push(`${Math.floor(seconds % 60)}秒`)
  return parts.join('')
}
