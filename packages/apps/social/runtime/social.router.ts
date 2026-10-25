import { t as __t } from './i18n'
/**
 * Social Router — 社交模式 HTTP + WebSocket 端点
 *
 * 提供:
 * - GET  /api/social/status   适配器连接状态
 * - POST /api/social/send     手动发送消息 (调试用)
 * - GET  /api/social/ws       平台 WebSocket 传输端点 (由主入口 WS 升级)
 *
 * 注意: WS 升级在不同运行时 (Bun/Node) 有不同的 API,
 * 因此 WS 端点的实际 upgrade 逻辑由 app 入口层处理。
 * 本 Router 负责业务管理端点；宿主按传输注册表完成 WS 升级。
 *
 * @module packages/apps/social/runtime/social.router
 */

import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AppError } from '@infos/backend/applicationHostAbi'
import type { SocialBridge } from './socialBridge'
import type { SocialDataService } from './socialDataService'
import type { SocialStatusCardService } from './statusCardService'
import type { StickerService } from './stickerService'

/** 使用统一业务码，保留外部服务的错误原因，不让契约守卫把它改成未知错误。 */
function stickerFailure(c: Context, error: unknown) {
  const failure =
    error instanceof AppError
      ? error
      : new AppError('EXTERNAL_ERROR', {
          message: error instanceof Error ? error.message : '收藏表情服务暂不可用',
        })
  return c.json(
    { code: failure.code, message: failure.message },
    failure.httpStatus as ContentfulStatusCode,
  )
}

/**
 * 创建社交路由
 *
 * 接收 SocialBridge 实例作为参数，不再依赖 AppContext。
 */
export function createSocialRouter(
  socialBridge: SocialBridge,
  deps?: {
    statusCards?: SocialStatusCardService
    stickers?: StickerService
    getStickerAccounts?: () => string[]
    resolveStickers?: (platform?: string) => StickerService | undefined
    getStickerConnections?: () => Array<{ platform: string; accountId: string }>
    getPlatforms?: () => Array<{ type: string; platform: string }>
    enablePlatform?: (type: string) => Promise<void>
    management?: (
      id: string,
      action?: string,
      input?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>
    getConnections?: () => unknown[]
    updateOwner?: (connectionId: string, ownerId: string) => Promise<void>
    getHostAgentId?: () => string
    dataService: SocialDataService
    getModeConfig: () => Record<string, unknown>
    updateModeConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>
    getAgentConfig: () => { agentId: string }
    updateAgentConfig: (agentId: string) => Promise<{ agentId: string; closedSessions: number }>
  },
) {
  const router = new Hono()
  const managementFailure = (error: unknown) =>
    new AppError('EXTERNAL_ERROR', {
      message: __t(
        'errors.social',
        error instanceof Error && /^SOCIAL_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'SOCIAL_CONNECTION_FAILED',
      ),
    })
  router.get('/platforms', (c) =>
    c.json({ code: 'OK', data: { platforms: deps?.getPlatforms?.() ?? [] } }),
  )
  router.post('/platforms/:type/enable', async (c) => {
    if (!deps?.enablePlatform) throw new AppError('SERVICE_UNAVAILABLE')
    try {
      await deps.enablePlatform(c.req.param('type'))
      return c.json({ code: 'OK' })
    } catch (error) {
      throw managementFailure(error)
    }
  })
  router.get('/connections/:id/management', async (c) => {
    if (!deps?.management) throw new AppError('SERVICE_UNAVAILABLE')
    c.header('Cache-Control', 'no-store')
    try {
      return c.json({ code: 'OK', data: await deps.management(c.req.param('id')) })
    } catch (error) {
      throw managementFailure(error)
    }
  })
  router.post('/connections/:id/management', async (c) => {
    const body = await c.req.json<Record<string, unknown> | null>().catch(() => null)
    if (
      !body ||
      typeof body.action !== 'string' ||
      !deps?.management ||
      ![
        'account_add',
        'account_remove',
        'account_reconnect',
        'login_start',
        'login_poll',
        'login_verify',
        'login_cancel',
      ].includes(body.action) ||
      !body.input ||
      typeof body.input !== 'object' ||
      Array.isArray(body.input) ||
      JSON.stringify(body.input).length > 4096
    )
      throw new AppError('INVALID_PARAMETER')
    c.header('Cache-Control', 'no-store')
    try {
      return c.json({
        code: 'OK',
        data: await deps.management(
          c.req.param('id'),
          body.action,
          body.input as Record<string, unknown>,
        ),
      })
    } catch (error) {
      throw managementFailure(error)
    }
  })

  router.get('/connections', (c) =>
    c.json({ code: 'OK', data: { connections: deps?.getConnections?.() ?? [] } }),
  )
  router.put('/connections/:id/owner', async (c) => {
    const body = await c.req.json<Record<string, unknown> | null>().catch(() => null)
    if (!body || typeof body.ownerId !== 'string' || !deps?.updateOwner)
      throw new AppError('INVALID_PARAMETER')
    try {
      await deps.updateOwner(c.req.param('id'), body.ownerId.trim())
    } catch (error) {
      if (
        error instanceof Error &&
        ['SOCIAL_OWNER_INVALID', 'SOCIAL_CONNECTION_INVALID'].includes(error.message)
      )
        throw new AppError('INVALID_PARAMETER', { message: __t('errors.social', error.message) })
      throw error
    }
    return c.json({ code: 'OK' })
  })
  router.get('/turns/:agentId', async (c) => {
    const kind = c.req.query('kind')
    if (kind !== undefined && kind !== 'task' && kind !== 'conversation')
      throw new AppError('BAD_REQUEST')
    return c.json({ code: 'OK', data: await socialBridge.listTurns(c.req.param('agentId'), kind) })
  })
  router.post('/turns/:id/cancel', async (c) => {
    await socialBridge.cancelTurn(c.req.param('id'))
    return c.json({ code: 'OK', message: __t('apps.social.ui', '社交任务已取消') })
  })
  router.post('/turns/:id/acknowledge', async (c) => {
    await socialBridge.acknowledgeTurn(c.req.param('id'))
    return c.json({ code: 'OK', message: __t('apps.social.ui', '已处理') })
  })
  router.post('/turns/:agentId/acknowledge-all', async (c) => {
    const body: unknown = await c.req.json()
    const ids = (body as { ids?: unknown } | null)?.ids
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string' || id.length > 200)
    )
      throw new AppError('BAD_REQUEST')
    await socialBridge.acknowledgeTurns(c.req.param('agentId'), ids)
    return c.json({ code: 'OK' })
  })
  router.get('/stickers/accounts', (c) =>
    c.json({
      code: 'OK',
      data: {
        accounts: deps?.getStickerAccounts?.() ?? [],
        connections: deps?.getStickerConnections?.() ?? [],
      },
    }),
  )
  router.get('/stickers/:accountId', async (c) => {
    const accountId = c.req.param('accountId')
    const matches = deps
      ?.getStickerConnections?.()
      .filter(
        (item) =>
          item.accountId === accountId &&
          (!c.req.query('platform') || item.platform === c.req.query('platform')),
      )
    const service = deps?.resolveStickers
      ? matches?.length === 1
        ? deps.resolveStickers(matches[0]!.platform)
        : undefined
      : deps?.stickers
    if (
      !service ||
      (!deps?.getStickerConnections && !deps?.getStickerAccounts?.().includes(accountId))
    )
      return c.json(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: __t('apps.social.ui', '所选平台账号未连接或不支持收藏表情'),
        },
        503,
      )
    try {
      const data = await service.list(
        accountId,
        (c.req.query('query') ?? '').slice(0, 200),
        Number(c.req.query('offset') ?? 0),
        Number(c.req.query('limit') ?? 30),
        c.req.query('refresh') === 'true',
      )
      return c.json({
        code: 'OK',
        data: {
          ...data,
          stickers: data.stickers.map(({ id, description }) => ({ id, description })),
        },
      })
    } catch (error) {
      return stickerFailure(c, error)
    }
  })
  router.get('/stickers/:accountId/:stickerId/image', async (c) => {
    const accountId = c.req.param('accountId')
    const matches = deps
      ?.getStickerConnections?.()
      .filter(
        (item) =>
          item.accountId === accountId &&
          (!c.req.query('platform') || item.platform === c.req.query('platform')),
      )
    const service = deps?.resolveStickers
      ? matches?.length === 1
        ? deps.resolveStickers(matches[0]!.platform)
        : undefined
      : deps?.stickers
    if (
      !service ||
      (!deps?.getStickerConnections && !deps?.getStickerAccounts?.().includes(accountId))
    )
      return c.json(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: __t('apps.social.ui', '所选平台账号未连接或不支持收藏表情'),
        },
        503,
      )
    try {
      const image = await service.read(accountId, c.req.param('stickerId'))
      c.header('Cache-Control', 'no-store')
      return c.json({
        code: 'OK',
        data: { dataUrl: `data:${image.mimeType};base64,${image.bytes.toString('base64')}` },
      })
    } catch (error) {
      return stickerFailure(c, error)
    }
  })
  router.post('/stickers/:accountId', async (c) => {
    const accountId = c.req.param('accountId')
    const matches = deps
      ?.getStickerConnections?.()
      .filter(
        (item) =>
          item.accountId === accountId &&
          (!c.req.query('platform') || item.platform === c.req.query('platform')),
      )
    const service = deps?.resolveStickers
      ? matches?.length === 1
        ? deps.resolveStickers(matches[0]!.platform)
        : undefined
      : deps?.stickers
    if (
      !service ||
      (!deps?.getStickerConnections && !deps?.getStickerAccounts?.().includes(accountId))
    )
      return c.json(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: __t('apps.social.ui', '所选平台账号未连接或不支持收藏表情'),
        },
        503,
      )
    try {
      const body = (await c.req.json().catch(() => {
        throw new AppError('INVALID_PARAMETER', { message: '请求正文必须为 JSON 对象' })
      })) as Record<string, unknown>
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        typeof body.stickerId !== 'string' ||
        !body.stickerId.trim()
      )
        throw new AppError('INVALID_PARAMETER', { message: '请提供有效的表情 ID' })
      if (body.action === 'describe' && typeof body.description === 'string') {
        const sticker = await service.describe(accountId, body.stickerId, body.description)
        return c.json({ code: 'OK', data: { id: sticker.id, description: sticker.description } })
      }
      if (body.action === 'delete')
        return c.json({ code: 'OK', data: await service.remove(accountId, body.stickerId) })
      throw new AppError('INVALID_PARAMETER', { message: '表情操作无效' })
    } catch (error) {
      return stickerFailure(c, error)
    }
  })
  router.get('/status-card/design', async (c) => {
    if (!deps?.statusCards)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '状态卡片服务未就绪') },
        503,
      )
    return c.json({
      code: 'OK',
      data: await deps.statusCards.getDesign(deps.getAgentConfig().agentId),
    })
  })
  router.put('/status-card/design', async (c) => {
    if (!deps?.statusCards)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '状态卡片服务未就绪') },
        503,
      )
    try {
      return c.json({
        code: 'OK',
        data: await deps.statusCards.saveDesign(deps.getAgentConfig().agentId, await c.req.json()),
      })
    } catch (error) {
      return c.json(
        { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
  })
  router.post('/status-card/preview', async (c) => {
    if (!deps?.statusCards || !deps.getHostAgentId)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '状态卡片服务未就绪') },
        503,
      )
    try {
      const image = await deps.statusCards.render(deps.getHostAgentId(), await c.req.json())
      return c.json({ code: 'OK', data: image })
    } catch (error) {
      return c.json(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error),
        },
        503,
      )
    }
  })

  // ── GET /api/social/status — 获取所有适配器状态 ──
  router.get('/status', async (c) => {
    const statuses = await socialBridge.getAllStatus()
    return c.json({
      code: 'OK',
      message: __t('apps.social.ui', '获取社交状态成功'),
      data: { adapters: statuses },
    })
  })

  // ── POST /api/social/send — 手动发送消息 (调试) ──
  router.post('/send', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const statuses = await socialBridge.getAllStatus()
    const platform =
      typeof body.platform === 'string'
        ? body.platform
        : statuses.length === 1
          ? String(statuses[0]!.platform)
          : undefined
    if (!platform) throw new AppError('INVALID_PARAMETER')
    const channelId = body.channelId as string
    const channelType = (body.channelType as string) ?? 'private'
    const content = body.content as string

    if (!channelId || !content || !['private', 'group'].includes(channelType)) {
      return c.json(
        { code: 'BAD_REQUEST', message: __t('apps.social.ui', '缺少 channelId 或 content') },
        400,
      )
    }

    await socialBridge.sendReply(platform, {
      accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
      channelId,
      channelType: channelType as 'private' | 'group',
      content,
    })

    return c.json({ code: 'OK', message: __t('apps.social.ui', '消息已发送') })
  })

  router.get('/mode-config', (c) => {
    if (!deps)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '社交配置服务未初始化') },
        503,
      )
    return c.json({
      code: 'OK',
      message: __t('apps.social.ui', '获取社交模式配置成功'),
      data: deps.getModeConfig(),
    })
  })

  router.post('/loop-guard/allow', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (
      !body ||
      typeof body.accountId !== 'string' ||
      !body.accountId.trim() ||
      body.accountId.length > 200 ||
      typeof body.channelId !== 'string' ||
      !body.channelId.trim() ||
      body.channelId.length > 200 ||
      !['private', 'group'].includes(String(body.channelType))
    )
      return c.json(
        {
          code: 'INVALID_PARAMETER',
          message: __t('apps.social.ui', '请提供平台、已连接账号、会话类型和会话标识'),
        },
        400,
      )
    const data = await socialBridge.allowLimitedConversation(
      String(body.accountId),
      body.channelType as 'private' | 'group',
      String(body.channelId),
      typeof body.platform === 'string' ? body.platform : undefined,
    )
    return c.json({
      code: 'OK',
      message: __t('apps.social.ui', '已重新开放有限交流预算，旧计划不会复活'),
      data,
    })
  })

  router.put('/mode-config', async (c) => {
    if (!deps)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '社交配置服务未初始化') },
        503,
      )
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json(
        { code: 'INVALID_PARAMETER', message: __t('apps.social.ui', '社交模式配置必须是对象') },
        400,
      )
    // 设置页编辑默认策略；单群覆盖由群状态机入口维护，避免旧页面快照覆盖 Agent 的新设置。
    const { groupPolicies: _groupPolicies, ...defaults } = body
    const data = await deps.updateModeConfig(defaults)
    return c.json({ code: 'OK', message: __t('apps.social.ui', '社交模式配置已保存'), data })
  })

  router.get('/agent-config', (c) => {
    if (!deps)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '社交配置服务未初始化') },
        503,
      )
    return c.json({
      code: 'OK',
      message: __t('apps.social.ui', '获取社交角色成功'),
      data: deps.getAgentConfig(),
    })
  })

  router.put('/agent-config', async (c) => {
    if (!deps)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '社交配置服务未初始化') },
        503,
      )
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
    if (!agentId)
      return c.json({ code: 'BAD_REQUEST', message: __t('apps.social.ui', '缺少 agentId') }, 400)
    try {
      const data = await deps.updateAgentConfig(agentId)
      return c.json({ code: 'OK', message: __t('apps.social.ui', '社交角色已切换'), data })
    } catch (error) {
      return c.json(
        { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
  })

  router.get('/projection/:agentId', async (c) => {
    if (!deps)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '社交数据服务未初始化') },
        503,
      )
    const agentId = c.req.param('agentId')
    return c.json({
      code: 'OK',
      message: __t('apps.social.ui', '获取社交Surface成功'),
      data: await deps.dataService.project(agentId),
    })
  })

  router.get('/contacts/:agentId', async (c) => {
    if (!deps)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '社交数据服务未初始化') },
        503,
      )
    const contacts = await deps.dataService.listContacts(c.req.param('agentId'))
    return c.json({
      code: 'OK',
      message: __t('apps.social.ui', '获取联系人成功'),
      data: { contacts },
    })
  })

  router.post('/history-sync/:platform', async (c) => {
    const platform = c.req.param('platform')
    await socialBridge.syncOfflineHistory(platform)
    return c.json({ code: 'OK', message: __t('apps.social.ui', '离线历史同步完成') })
  })

  router.post('/data/clear', async (c) => {
    if (!deps)
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: __t('apps.social.ui', '社交数据服务未初始化') },
        503,
      )
    const result = await deps.dataService.clear(
      (await c.req.json().catch(() => ({}))) as Record<string, unknown>,
    )
    if ('error' in result) return c.json({ code: 'BAD_REQUEST', message: result.error }, 400)
    if ('precondition' in result) {
      return c.json({ code: 'PRECONDITION_FAILED', message: result.precondition }, 422)
    }
    return c.json({ code: 'OK', message: result.message, data: result.data })
  })

  return router
}
