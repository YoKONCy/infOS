import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { PackagePermission, PackageUiSlot } from '@infos/shared'
import type { PackageManagementService } from '../packages/packageManagementService'
import type { PackageUiRegistry } from '../packages/packageUiRegistry'
import { PACKAGE_UI_SLOTS } from '../packages/packageUiRegistry'
import { PACKAGE_UPLOAD_LIMIT } from '../packages/packageArchive'
import { AppError } from '../lib/appError'
import { t } from '../lib/i18n'
import type { PackageAssets } from '../packages/packageAssets'
import { errorHandler } from '../middleware/errorHandler'
import type { PackageWebUi, PackageWebUiOwner } from '../packages/packageWebUi'
import { createPackageWebUiRouter } from './packageWebUi.router'

export function createPackagesRouter(
  manager: PackageManagementService,
  ui: PackageUiRegistry,
  assets: PackageAssets,
  webUi?: PackageWebUi,
  identify?: (request: Request) => PackageWebUiOwner | undefined,
): Hono {
  const router = new Hono()
  router.onError((error, c) => {
    if (error instanceof AppError) return errorHandler(error, c)
    const reason = String(error).match(/PACKAGE_[A-Z_]+/)?.[0] ?? 'PACKAGE_OPERATION_FAILED'
    const message =
      reason === 'PACKAGE_RECOVERY_MODE'
        ? '当前处于拓展恢复模式，请在资源版本页恢复拓展并重启。'
        : reason === 'PACKAGE_INDEX_INVALID'
          ? '插件记录无法读取，请检查数据目录中的安装记录。'
          : reason === 'PACKAGE_SOURCE_CHANGED'
            ? '插件内容已修改，请先读取本地修改并重新审核。'
            : reason === 'PACKAGE_PERMISSION_GRANT_REQUIRED' ||
                reason === 'PACKAGE_PERMISSION_DENIED'
              ? '请先审核并授权此版本。'
              : reason.startsWith('PACKAGE_DEPENDENCY_')
                ? '插件依赖准备失败，请检查网络和依赖声明。'
                : [
                      'PACKAGE_PATH_INVALID',
                      'PACKAGE_FILE_FORBIDDEN',
                      'PACKAGE_MANIFEST_INVALID',
                    ].includes(reason)
                  ? '插件包无效，或含有不允许的路径和配置。'
                  : '插件操作失败，请检查插件包与授权状态。'
    return errorHandler(
      new AppError(
        ['PACKAGE_WEB_UI_UNAVAILABLE', 'PACKAGE_WEB_UI_FILE_UNAVAILABLE'].includes(reason)
          ? 'NOT_FOUND'
          : 'INVALID_PARAMETER',
        {
          message: t(
            'server.packages',
            reason.startsWith('PACKAGE_WEB_UI_') ? '插件界面已关闭或不可用，请重新打开。' : message,
          ),
          data: { reason },
        },
      ),
      c,
    )
  })
  if (webUi && identify) router.route('/web-ui', createPackageWebUiRouter(webUi, identify))
  router.get('/', (c) => c.json({ code: 'OK', data: manager.list() }))
  router.get('/assets/:id', async (c) => {
    const file = c.req.query('file')
    if (!file) throw new AppError('MISSING_FIELD')
    const asset = await assets.read(c.req.param('id'), file)
    return new Response(new Uint8Array(asset.bytes).buffer, {
      headers: {
        'Content-Type': asset.type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
      },
    })
  })
  router.post(
    '/install',
    bodyLimit({
      maxSize: PACKAGE_UPLOAD_LIMIT + 65536,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE')
      },
    }),
    async (c) => {
      const body = await c.req.parseBody()
      if (!(body.package instanceof File)) throw new AppError('MISSING_FIELD')
      const data = await manager.install(new Uint8Array(await body.package.arrayBuffer()))
      return c.json({ code: 'OK', data })
    },
  )
  router.post('/:id/authorize', async (c) => {
    const body = z
      .object({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        permissions: z.array(z.string()).max(32),
      })
      .parse(await c.req.json())
    await manager.authorize(c.req.param('id'), body.digest, body.permissions as PackagePermission[])
    return c.json({ code: 'OK' })
  })
  router.put('/:id/enabled', async (c) => {
    const body = z.object({ enabled: z.boolean() }).parse(await c.req.json())
    await manager.setEnabled(c.req.param('id'), body.enabled)
    return c.json({ code: 'OK' })
  })
  router.post('/:id/reload', async (c) => {
    await manager.reload(c.req.param('id'))
    return c.json({ code: 'OK' })
  })
  router.post('/:id/review', async (c) => {
    await manager.review(c.req.param('id'))
    return c.json({ code: 'OK' })
  })
  router.post('/:id/rollback', async (c) => {
    await manager.rollback(c.req.param('id'))
    return c.json({ code: 'OK' })
  })
  router.delete('/:id', async (c) => {
    await manager.uninstall(c.req.param('id'))
    return c.json({ code: 'OK' })
  })
  router.get('/panels/:slot', (c) => {
    const slot = c.req.param('slot') as PackageUiSlot
    if (!PACKAGE_UI_SLOTS.includes(slot)) throw new AppError('INVALID_PARAMETER')
    return c.json({ code: 'OK', data: ui.list(slot) })
  })
  router.post('/panel-actions', async (c) => {
    const body = z
      .object({ panelId: z.string().max(250), actionId: z.string().max(100) })
      .parse(await c.req.json())
    const data = await ui.invoke(body.panelId, body.actionId)
    return c.json({ code: 'OK', data: data ?? null })
  })
  return router
}
