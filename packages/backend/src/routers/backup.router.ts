import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { validate as zValidator } from '../lib/validation'
import { AppError } from '../lib/appError'
import { t } from '../lib/i18n'
import { prepareBackupDownload, type BackupService } from '../services/backup/backupService'

const ids = z.array(z.string().min(1).max(200)).max(1000).default([])
const selection = z
  .object({
    level: z.enum(['settings', 'agent', 'content', 'full']),
    modules: z
      .array(
        z.enum([
          'settings',
          'agents',
          'conversations',
          'memory',
          'facts',
          'knowledge',
          'tasks',
          'workspace',
          'applications',
        ]),
      )
      .min(1)
      .max(9),
    agentIds: ids,
    threadIds: ids,
    documentIds: ids,
    factIds: ids,
    taskIds: ids,
    includeSecrets: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (input.level === 'agent' && !input.agentIds.length)
      ctx.addIssue({ code: 'custom', message: t('server.backup', '请选择角色') })
  })
const password = z.string().max(512).default('')
const policy = z.object({
  conflict: z.enum(['skip', 'replace', 'duplicate']),
  agentTargets: z.record(z.string(), z.string()).default({}),
})
const messages: Record<string, string> = {
  BACKUP_ACTIVE_EXECUTIONS: '当前有任务正在执行，请等待任务结束后备份',
  BACKUP_ACTIVE_WRITES: '数据正在写入，请稍后重试备份',
  BACKUP_SOCIAL_FEATURE_CONFLICT: '社交记忆特征存在冲突，请导入为新角色或选择覆盖',
  BACKUP_ACTIVE_APPLICATIONS: '请先停止 Arca 和 Pictoria 子应用，再备份它们的数据',
  BACKUP_PASSWORD_REQUIRED: '请输入备份口令',
  BACKUP_PASSWORD_TOO_SHORT: '携带凭据的备份需要至少八位口令',
  BACKUP_ALREADY_IMPORTED: '这份备份已导入，请勿重复导入',
  BACKUP_PREVIEW_EXPIRED: '导入预览已过期，请重新上传或选择备份',
  BACKUP_PENDING_IMPORT: '已有待应用的导入，请先重启服务或取消导入',
  BACKUP_FULL_REPLACE_REQUIRED: '完整恢复需要选择覆盖模式',
  BACKUP_EMPTY: '所选范围没有可导出的数据',
  BACKUP_BUSY: '另一项备份操作正在进行，请稍后重试',
  BACKUP_SIZE_INVALID: '备份大小超出限制或文件不完整',
  BACKUP_RECORD_LIMIT: '所选逻辑记录过多，请缩小导出范围',
  BACKUP_AGENT_INVALID: '角色映射无效，请使用不重复的字母、数字、下划线或连字符标识',
  BACKUP_APPLICATION_DUPLICATE_UNSUPPORTED: '子应用数据不支持复制导入，请选择跳过或覆盖',
  BACKUP_LOCAL_DOWNLOAD: '恢复点包含凭据，请设置至少八位下载口令',
  BACKUP_DATABASE_LOCATION_UNSUPPORTED: '当前使用自定义数据库路径，请先迁移到标准数据目录再导入',
}

export function createBackupRouter(service: BackupService) {
  const router = new Hono()
  const downloads = new Map<
    string,
    {
      open: () => ReadableStream<Uint8Array>
      size: number
      id: string
      cleanup: () => Promise<void>
      timer: ReturnType<typeof setTimeout>
    }
  >()
  router.onError((error, c) => {
    const code = error.message
    if (error instanceof AppError)
      return c.json({ code: error.code, message: error.message }, error.httpStatus as 400)
    return c.json(
      {
        code: 'BAD_REQUEST',
        message: t('server.backup', messages[code] ?? '备份操作失败，请检查文件、口令和版本'),
      },
      400,
    )
  })
  const ok = <T>(data: T) => ({ code: 'OK', message: t('server.backup', '操作成功'), data })
  router.get('/downloads/:ticket', (c) => {
    const ticket = c.req.param('ticket'),
      download = downloads.get(ticket)
    if (!download)
      return c.json(
        { code: 'NOT_FOUND', message: t('server.backup', '下载链接已失效，请重新下载') },
        404,
      )
    downloads.delete(ticket)
    clearTimeout(download.timer)
    return new Response(download.open(), {
      headers: {
        'Content-Type': 'application/vnd.infos.backup',
        'Content-Length': String(download.size),
        'Content-Disposition': `attachment; filename="infos-${download.id}.infos-backup"`,
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
      },
    })
  })
  router.get('/catalogue', (c) => c.json(ok(service.catalogue())))
  router.get('/', async (c) =>
    c.json(
      ok({
        records: await service.list(),
        pending: await service.pending(),
        lastImport: await service.lastResult(),
      }),
    ),
  )
  router.post('/', zValidator('json', z.object({ selection, password })), async (c) => {
    const input = c.req.valid('json')
    return c.json(ok(await service.create(input.selection, input.password)))
  })
  router.delete('/pending', async (c) => {
    await service.cancelPending()
    return c.json(ok(null))
  })
  router.post('/previews', async (c) => {
    const body = c.req.raw.body
    if (!body) throw new Error('BACKUP_FORMAT_INVALID')
    const value = decodeURIComponent(c.req.header('X-Backup-Password') ?? '')
    if (value.length > 512) throw new Error('BACKUP_FORMAT_INVALID')
    return c.json(ok(await service.receive(body, value)))
  })
  router.post('/previews/:ticket/commit', zValidator('json', policy), async (c) => {
    await service.stage(c.req.param('ticket'), c.req.valid('json'))
    return c.json(ok({ restartRequired: true }))
  })
  router.post('/:id/preview', zValidator('json', z.object({ password })), async (c) =>
    c.json(ok(await service.previewSaved(c.req.param('id'), c.req.valid('json').password))),
  )
  router.post('/:id/download', zValidator('json', z.object({ password })), async (c) => {
    if (downloads.size >= 32) throw new Error('BACKUP_BUSY')
    const download = await prepareBackupDownload(
      await service.download(c.req.param('id'), c.req.valid('json').password),
    )
    const ticket = randomBytes(32).toString('hex')
    const timer = setTimeout(() => {
      downloads.delete(ticket)
      void download.cleanup().catch(() => {})
    }, 5 * 60_000)
    timer.unref()
    downloads.set(ticket, { ...download, id: c.req.param('id'), timer })
    return c.json(ok({ url: `/api/backups/downloads/${ticket}` }))
  })
  router.delete('/:id', async (c) => {
    await service.remove(c.req.param('id'))
    return c.json(ok(null))
  })
  return router
}

/** 永久凭据只用于签发；下载使用短时、单次、限定文件的随机票据。 */
export function isBackupDownloadRequest(method: string, path: string): boolean {
  return method === 'GET' && /^\/api\/backups\/downloads\/[a-f0-9]{64}$/.test(path)
}
