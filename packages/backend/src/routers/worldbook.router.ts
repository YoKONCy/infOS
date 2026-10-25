import { t as __t } from '../lib/i18n'
/**
 * Worldbook Router — 世界书书库、全局激活设置与角色绑定
 *
 * - GET    /api/worldbooks                     书库列表与全局设置
 * - POST   /api/worldbooks                     新建（可携带条目，用于导入）
 * - PUT    /api/worldbooks/settings            保存激活设置（不传 globalBooks 时保留全局列表）
 * - POST   /api/worldbooks/settings/global-books/:id    加入全局启用列表
 * - DELETE /api/worldbooks/settings/global-books/:id    移出全局启用列表
 * - GET    /api/worldbooks/bindings            所有角色绑定
 * - GET    /api/worldbooks/bindings/:agentId   单个角色绑定
 * - PUT    /api/worldbooks/bindings/:agentId   保存角色绑定（可带 expected 做冲突检测）
 * - POST   /api/worldbooks/test                命中测试（不保存）
 * - GET    /api/worldbooks/:id                 读取世界书
 * - PUT    /api/worldbooks/:id                 保存名称与条目（带修订号）
 * - POST   /api/worldbooks/:id/duplicate       复制
 * - DELETE /api/worldbooks/:id                 删除并清理引用
 *
 * 世界书保存后立即生效，不经过提示词草稿发布。
 *
 * @module packages/backend/src/routers/worldbook.router
 */

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { WORLDBOOK_CHANNELS, WORLDBOOK_LIMITS, type WorldbookChannel } from '@infos/shared'
import type { AppContext } from '../container'
import { AppError } from '../lib/appError'

// 条目结构由共享归一化函数逐项收敛，这里只限制外层形状与规模。
const entries = z.array(z.unknown()).max(WORLDBOOK_LIMITS.entries)
const name = z.string().max(WORLDBOOK_LIMITS.name * 4)
const createSchema = z.object({ name, entries: entries.optional() })
const saveSchema = z.object({ name, entries, revision: z.number().int().positive() })
const duplicateSchema = z.object({ name })
const settingsSchema = z.object({
  scanDepth: z.number().int(),
  tokenBudget: z.number().int(),
  globalBooks: z.array(z.string()).max(WORLDBOOK_LIMITS.books).optional(),
})
const binding = z.object({
  primary: z.string().nullable(),
  additional: z.array(z.string()).max(WORLDBOOK_LIMITS.additionalBooks),
})
const bindingSchema = binding.extend({ expected: binding.optional() })
const testSchema = z.object({
  entries,
  text: z.string().max(200_000),
  channel: z.enum(WORLDBOOK_CHANNELS as unknown as [WorldbookChannel, ...WorldbookChannel[]]),
})

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new AppError('VALIDATION_ERROR', {
      message: __t('server.worldbook', '世界书数据格式无效'),
      data: result.error.issues,
    })
  return result.data
}

async function body(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new AppError('VALIDATION_ERROR', {
      message: __t('server.worldbook', '世界书数据格式无效'),
    })
  }
}

export function createWorldbookRouter(ctx: AppContext) {
  const router = new Hono()
  const service = ctx.worldbookService
  router.use(
    '*',
    bodyLimit({
      maxSize: 48 * 1024 * 1024,
      onError: (c) =>
        c.json(
          { code: 'PAYLOAD_TOO_LARGE', message: __t('server.worldbook', '世界书数据过大') },
          413,
        ),
    }),
  )
  const ok = <T>(data: T) => ({
    code: 'OK' as const,
    message: __t('server.routers', '获取成功'),
    data,
  })
  const saved = <T>(data: T) => ({
    code: 'OK' as const,
    message: __t('server.worldbook', '世界书已保存'),
    data,
  })
  const requireAgent = (agentId: string) => {
    if (!ctx.agentManager.getAgent(agentId))
      throw new AppError('AGENT_NOT_FOUND', {
        message: `Agent "${agentId}" 不存在`,
        data: { agentId },
      })
  }

  router.get('/', (c) => c.json(ok({ books: service.list(), settings: service.getSettings() })))

  router.post('/', async (c) => {
    const input = parse(createSchema, await body(c))
    return c.json(
      {
        code: 'CREATED',
        message: __t('server.worldbook', '世界书已创建'),
        data: service.create(input),
      },
      201,
    )
  })

  router.put('/settings', async (c) =>
    c.json(saved(service.saveSettings(parse(settingsSchema, await body(c))))),
  )

  router.post('/settings/global-books/:id', (c) =>
    c.json(saved(service.addGlobalBook(c.req.param('id')))),
  )

  router.delete('/settings/global-books/:id', (c) =>
    c.json(saved(service.removeGlobalBook(c.req.param('id')))),
  )

  router.get('/bindings', (c) => c.json(ok(service.listBindings())))

  router.get('/bindings/:agentId', (c) => {
    const agentId = c.req.param('agentId')
    requireAgent(agentId)
    return c.json(ok(service.getBinding(agentId)))
  })

  router.put('/bindings/:agentId', async (c) => {
    const agentId = c.req.param('agentId')
    requireAgent(agentId)
    const { expected, ...next } = parse(bindingSchema, await body(c))
    return c.json(saved(service.saveBinding(agentId, next, expected)))
  })

  router.post('/test', async (c) => {
    const input = parse(testSchema, await body(c))
    return c.json(ok(service.test(input as Parameters<typeof service.test>[0])))
  })

  router.get('/:id', (c) => {
    const book = service.get(c.req.param('id'))
    if (!book)
      throw new AppError('NOT_FOUND', {
        message: __t('server.worldbook', '世界书不存在: {0}', [c.req.param('id')]),
        data: { bookId: c.req.param('id') },
      })
    return c.json(ok(book))
  })

  router.put('/:id', async (c) =>
    c.json(saved(service.save(c.req.param('id'), parse(saveSchema, await body(c))))),
  )

  router.post('/:id/duplicate', async (c) => {
    const input = parse(duplicateSchema, await body(c))
    return c.json(
      {
        code: 'CREATED',
        message: __t('server.worldbook', '世界书已创建'),
        data: service.duplicate(c.req.param('id'), input.name),
      },
      201,
    )
  })

  router.delete('/:id', (c) => {
    service.remove(c.req.param('id'))
    return c.json({ code: 'OK', message: __t('server.worldbook', '世界书已删除'), data: null })
  })

  return router
}
