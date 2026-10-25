import { t as __t } from '../lib/i18n'
import { Hono } from 'hono'
import { z } from 'zod'
import { bodyLimit } from 'hono/body-limit'
import type { AppContext } from '../container'
import { validate as zValidator } from '../lib/validation'
import { AppError } from '../lib/appError'
import {
  decodeKnowledgeText,
  fetchKnowledgePage,
  MAX_SOURCE_BYTES,
} from '../services/knowledge/knowledgeText'
import { knowledgeSearchSchema } from '../services/knowledge/knowledgeValidation'
import { factEditSchema } from '../schemas/archiveEdit.schema'
import { throwArchiveEditError, throwArchiveRestoreError } from './archiveEditError'
import { knowledgeRecallSettingsSchema } from '../services/knowledge/knowledgeRecallService'

const archiveQuerySchema = z.object({
  query: z.string().trim().max(200).default(''),
})
const documentBodyLimit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', {
        message: '资料请求过大，请先手动切分后导入（文本文件上限 8 MiB）',
      })
    },
  })

export function createKnowledgeRouter(ctx: AppContext) {
  const router = new Hono()

  router.get('/recall-settings', async (c) =>
    c.json({ code: 'OK', data: await ctx.knowledgeRecallService.settings() }),
  )
  router.put('/recall-settings', zValidator('json', knowledgeRecallSettingsSchema), async (c) =>
    c.json({
      code: 'OK',
      data: await ctx.knowledgeRecallService.saveSettings(c.req.valid('json')),
    }),
  )

  router.patch('/facts/:id', zValidator('json', factEditSchema), async (c) => {
    try {
      const data = await ctx.factsRepo.editFact(c.req.param('id'), c.req.valid('json'))
      return c.json({ code: 'OK', data })
    } catch (error) {
      throwArchiveEditError(error)
    }
  })

  router.get('/facts', zValidator('query', archiveQuerySchema), async (c) => {
    const { query } = c.req.valid('query')
    const data = await ctx.factsRepo.archive(query)
    return c.json({ code: 'OK', message: __t('server.routers', '获取成功'), data })
  })

  router.post('/facts/:id/retract', async (c) => {
    await ctx.factsRepo.retractFact(c.req.param('id'))
    return c.json({ code: 'OK', message: __t('server.routers', '事实已撤回') })
  })
  router.post('/facts/:id/restore', async (c) => {
    try {
      await ctx.factsRepo.restoreFact(c.req.param('id'))
    } catch (error) {
      throwArchiveRestoreError(error)
    }
    return c.json({ code: 'OK', message: __t('server.archive-edit', '事实已还原') })
  })
  router.delete('/facts/:id', async (c) => {
    await ctx.privacyDeletionService.deleteFact(c.req.param('id'))
    return c.json({ code: 'OK', message: __t('server.routers', '事实已永久删除') })
  })

  router.get(
    '/documents',
    zValidator(
      'query',
      z.object({
        query: z.string().trim().max(200).default(''),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(30),
      }),
    ),
    (c) => {
      const { query, page, pageSize } = c.req.valid('query')
      return c.json({
        code: 'OK',
        message: __t('server.routers', '获取成功'),
        data: ctx.knowledgeService.repo.list(query, page, pageSize),
      })
    },
  )
  router.get('/documents/:id', (c) =>
    c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: ctx.knowledgeService.detail(c.req.param('id')),
    }),
  )

  router.post(
    '/documents',
    documentBodyLimit(MAX_SOURCE_BYTES + 1024 * 1024),
    zValidator(
      'json',
      z
        .object({
          title: z.string().trim().max(200).default(''),
          kind: z.enum(['text', 'url']),
          content: z.string().max(MAX_SOURCE_BYTES).optional(),
          url: z.string().url().max(4096).optional(),
          replaceId: z.string().uuid().optional(),
        })
        .refine(
          (value) => (value.kind === 'text' ? Boolean(value.content?.trim()) : Boolean(value.url)),
          '请提供正文或网页地址',
        ),
    ),
    async (c) => {
      const input = c.req.valid('json')
      let page: Awaited<ReturnType<typeof fetchKnowledgePage>> | null = null
      if (input.kind === 'url') {
        try {
          page = await fetchKnowledgePage(input.url!)
        } catch (cause) {
          if (cause instanceof AppError) throw cause
          throw new AppError('EXTERNAL_ERROR', {
            message: `网页读取失败：${(cause as Error).message}`,
          })
        }
      }
      const data = await ctx.knowledgeService.import({
        title: input.title || page?.title || __t('server.routers', '未命名资料'),
        content: page?.content ?? input.content!,
        sourceKind: input.kind,
        source: page?.source,
        replaceId: input.replaceId,
      })
      return c.json(
        { code: 'ACCEPTED', message: __t('server.routers', '资料已加入整理队列'), data },
        202,
      )
    },
  )

  router.post('/documents/upload', documentBodyLimit(MAX_SOURCE_BYTES + 64 * 1024), async (c) => {
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) throw new AppError('BAD_REQUEST', { message: '请选择文本文件' })
    const title = typeof form.title === 'string' ? form.title.slice(0, 200) : file.name
    const replacement = z.string().uuid().optional().safeParse(form.replaceId)
    if (!replacement.success) throw new AppError('BAD_REQUEST', { message: '资料编号无效' })
    const replaceId = replacement.data
    const content = decodeKnowledgeText(new Uint8Array(await file.arrayBuffer()))
    const data = await ctx.knowledgeService.import({
      title: title || file.name,
      content,
      sourceKind: 'file',
      source: file.name.slice(0, 512),
      replaceId,
    })
    return c.json(
      { code: 'ACCEPTED', message: __t('server.routers', '资料已加入整理队列'), data },
      202,
    )
  })
  router.post('/documents/:id/retry', async (c) =>
    c.json(
      {
        code: 'ACCEPTED',
        message: __t('server.routers', '已重新排队'),
        data: await ctx.knowledgeService.retry(c.req.param('id')),
      },
      202,
    ),
  )
  router.delete('/documents/:id', async (c) => {
    await ctx.knowledgeService.delete(c.req.param('id'))
    return c.json({ code: 'OK', message: __t('server.routers', '资料已删除') })
  })
  router.post('/reindex', async (c) => {
    await ctx.knowledgeService.reindex(true)
    return c.json({ code: 'ACCEPTED', message: __t('server.routers', '索引重建已安排') }, 202)
  })
  router.post('/search', zValidator('json', knowledgeSearchSchema), async (c) => {
    try {
      const data = await ctx.knowledgeService.index.search(c.req.valid('json'), c.req.raw.signal)
      return c.json({ code: 'OK', message: __t('server.routers', '检索完成'), data })
    } catch (cause) {
      throw new AppError('BAD_REQUEST', { message: (cause as Error).message })
    }
  })

  return router
}
