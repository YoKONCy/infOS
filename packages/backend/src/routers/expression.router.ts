import { EXPRESSION_MARKS_MAX_PAGE_SIZE } from '@infos/shared'
import { translateDiagnostic } from '@infos/shared/i18n'
import { Hono } from 'hono'
import { z } from 'zod'
import { AppError } from '../lib/appError'
import { errorHandler } from '../middleware/errorHandler'
import type { ClientIdentity } from '../services/system/clientAccessService'
import type { ExpressionStore } from '../services/expression/store'
import type { PromptWorkspace } from '../services/prompt/promptWorkspace'
import type { ContextCompiler } from '../services/context/contextCompiler'
const id = z.string().min(1).max(200)
const text = z.string().refine((value) => [...value].length <= 2000)
const kind = z.enum(['good', 'robotic'])
export function createExpressionRouter(
  store: ExpressionStore,
  authenticate: (request: Request) => ClientIdentity | undefined,
  runtime?: { workspace: PromptWorkspace; compiler: ContextCompiler },
) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const identity = authenticate(c.req.raw)
    if (!identity) throw new AppError('UNAUTHORIZED')
    if (!identity.admin) throw new AppError('FORBIDDEN')
    await next()
  })
  app.onError((error, c) =>
    errorHandler(
      error instanceof z.ZodError || error instanceof SyntaxError
        ? new AppError('INVALID_PARAMETER')
        : error,
      c,
    ),
  )
  const respond = (data: unknown) => ({
    code: 'OK',
    message: translateDiagnostic('操作成功'),
    data,
  })
  const handbook = store.handbook
  const ruleText = z
    .string()
    .trim()
    .min(1)
    .refine((v) => [...v].length <= 5000)
  app.get('/handbook', (c) => c.json(respond(handbook.list(id.parse(c.req.query('agentId'))))))
  app.post('/handbook/rules', async (c) => {
    const input = z
      .object({ agentId: id, text: ruleText })
      .strict()
      .parse(await c.req.json())
    return c.json(respond(handbook.add(input.agentId, input.text)))
  })
  app.patch('/handbook/rules/:id', async (c) => {
    const input = z
      .object({ text: ruleText })
      .strict()
      .parse(await c.req.json())
    return c.json(respond(handbook.edit(id.parse(c.req.param('id')), input.text)))
  })
  app.delete('/handbook/rules/:id', (c) =>
    c.json(respond(handbook.remove(id.parse(c.req.param('id'))))),
  )
  app.get('/handbook/learning', (c) => {
    const agentId = id.parse(c.req.query('agentId'))
    return c.json(
      respond(
        store.learningStatus?.(agentId) ?? {
          state: 'idle',
          pending: 0,
          nextAt: null,
          attempts: 0,
          recent: [],
        },
      ),
    )
  })
  app.post('/handbook/learn-now', async (c) => {
    const input = z
      .object({ agentId: id })
      .strict()
      .parse(await c.req.json())
    // 告诉界面有没有东西可学，没有时按钮不能看起来像没反应。
    const pending = store.learningStatus?.(input.agentId).pending ?? 0
    store.onLearnNow?.(input.agentId)
    return c.json(respond({ pending }))
  })
  app.get('/handbook/versions', (c) =>
    c.json(respond(handbook.versions(id.parse(c.req.query('agentId'))))),
  )
  app.post('/handbook/versions/:id/restore', async (c) => {
    const input = z
      .object({ agentId: id })
      .strict()
      .parse(await c.req.json())
    return c.json(respond(handbook.restore(input.agentId, id.parse(c.req.param('id')))))
  })
  app.get('/settings', (c) => c.json(respond(handbook.settings(id.parse(c.req.query('agentId'))))))
  app.patch('/settings', async (c) => {
    const { agentId, ...patch } = z
      .object({
        agentId: id,
        learningEnabled: z.boolean().optional(),
        learningIdleMinutes: z.number().int().min(1).max(120).optional(),
        handbookMaxChars: z.number().int().min(300).max(5000).optional(),
        materials: z
          .object({
            enabled: z.boolean(),
            notes: z.boolean(),
            goodQuotes: z.boolean(),
            memories: z.boolean(),
            repetition: z.boolean(),
            activity: z.boolean(),
            maxChars: z.number().int().min(100).max(1000),
          })
          .partial()
          .strict()
          .optional(),
      })
      .strict()
      .parse(await c.req.json())
    return c.json(respond(handbook.updateSettings(agentId, patch)))
  })
  app.post('/preview', async (c) => {
    if (!runtime) throw new AppError('NOT_FOUND')
    const input = z
      .object({
        agentId: id,
        mode: z.enum(['chat', 'work', 'minimal']),
        message: z.string().max(20000),
      })
      .strict()
      .parse(await c.req.json())
    return c.json(respond(await runtime.compiler.previewExpression(input)))
  })
  app.post('/marks/:id/relearn', (c) => {
    store.onRelearn?.(store.get(id.parse(c.req.param('id'))))
    return c.json(respond({ ok: true }))
  })
  app.get('/marks', (c) =>
    c.json(
      respond(
        store.list(
          z
            .object({
              agentId: id,
              threadId: id.optional(),
              messageId: id.regex(/^\d+$/).optional(),
              kind: kind.optional(),
              learning: z.enum(['none', 'pending', 'learned', 'skipped', 'failed']).optional(),
              page: z.coerce.number().int().min(1).max(1000000).default(1),
              pageSize: z.coerce
                .number()
                .int()
                .min(1)
                .max(EXPRESSION_MARKS_MAX_PAGE_SIZE)
                .default(20),
            })
            .strict()
            .parse(c.req.query()),
        ),
      ),
    ),
  )
  app.post('/marks', async (c) =>
    c.json(
      respond(
        store.create(
          z
            .object({
              agentId: id,
              threadId: id,
              messageId: id.regex(/^\d+$/),
              kind,
              quote: text.default(''),
              note: text.optional(),
            })
            .strict()
            .parse(await c.req.json()),
        ),
      ),
    ),
  )
  app.patch('/marks/:id', async (c) =>
    c.json(
      respond(
        store.update(
          c.req.param('id'),
          z
            .object({ kind: kind.optional(), note: text.optional() })
            .strict()
            .refine((v) => Object.keys(v).length > 0)
            .parse(await c.req.json()),
        ),
      ),
    ),
  )
  app.delete('/marks/:id', (c) => c.json(respond(store.remove(c.req.param('id')))))
  app.get('/status', (c) => c.json(respond(store.status(id.parse(c.req.query('agentId'))))))
  // 独立的只读统计端点，不改变既有 status 响应形状。
  app.get('/versions', (c) => c.json(respond(store.versions(id.parse(c.req.query('agentId'))))))
  return app
}
