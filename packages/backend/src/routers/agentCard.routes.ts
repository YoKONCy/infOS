import { t as __t } from '../lib/i18n'
/**
 * Agent Card Routes — 角色卡导入导出端点（挂在 /api/agents 下）
 *
 * - POST /api/agents/cards/preview     预览角色卡
 * - POST /api/agents/cards/import      导入角色卡（overwrite / new / create）
 * - POST /api/agents/:id/card/export   导出角色卡（png / zip）
 *
 * @module packages/backend/src/routers/agentCard.routes
 */

import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { AgentCardService } from '../services/agent/agentCardService'
import { AgentCardError, CARD_LIMITS } from '../services/agent/agentCardCodec'
import { AppError } from '../lib/appError'
import type { AppContext } from '../container'

/** 注册角色卡端点；需在 /:id 等通配路由之前调用，保持原有匹配顺序。 */
export function registerAgentCardRoutes(router: Hono, ctx: AppContext): void {
  const cards = new AgentCardService(ctx.agentManager, () =>
    ctx.capabilityGate.reloadAll(),
  )
  const cardError = (error: unknown): never => {
    const reason = error instanceof AgentCardError ? error.reason : 'INVALID'
    const message =
      reason === 'LIMIT'
        ? __t('server.agent', '角色卡超过大小或文件数量限制')
        : reason === 'UNSUPPORTED'
          ? __t('server.agent', '角色卡包含当前版本尚未支持的附加资料')
        : reason === 'CONFLICT'
          ? __t('server.agent', '角色已存在，请选择覆盖或导入为新角色')
          : __t('server.agent', '角色卡无效、已损坏或版本不受支持')
    throw new AppError(reason === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', { message })
  }
  const cardLimit = bodyLimit({
    maxSize: CARD_LIMITS.file + 65536,
    onError: () => cardError(new AgentCardError('LIMIT')),
  })

  for (const action of ['preview', 'import'] as const) {
    router.post(`/cards/${action}`, cardLimit, async (c) => {
      try {
        const body = await c.req.parseBody()
        const file = body.file
        if (!(file instanceof File) || file.size > CARD_LIMITS.file) throw new AgentCardError()
        const bytes = Buffer.from(await file.arrayBuffer())
        const mode = body.mode
        if (action === 'import' && mode !== 'overwrite' && mode !== 'new' && mode !== 'create')
          throw new AgentCardError()
        const data =
          action === 'preview'
            ? cards.preview(bytes)
            : cards.import(bytes, mode as 'overwrite' | 'new' | 'create')
        return c.json({ code: 'OK', message: __t('server.agent', '角色卡处理成功'), data })
      } catch (error) {
        return cardError(error)
      }
    })
  }
  router.post('/:id/card/export', cardLimit, async (c) => {
    try {
      const body = await c.req.parseBody()
      if (body.format !== 'png' && body.format !== 'zip') throw new AgentCardError()
      const cover =
        body.cover instanceof File ? Buffer.from(await body.cover.arrayBuffer()) : undefined
      const data = cards.export(c.req.param('id'), body.format, cover)
      return c.json({ code: 'OK', message: __t('server.agent', '角色卡处理成功'), data })
    } catch (error) {
      return cardError(error)
    }
  })
}

