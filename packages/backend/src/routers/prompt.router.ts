import { t as __t } from '../lib/i18n'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { WHOLESOME_MODE_KEY, ASSISTANT_PREFILL_KEY } from '@infos/shared'
import type { AppContext } from '../container'
import { promptBundleSchema, readPromptPersona } from '../services/prompt/promptWorkspace'
import { AppError } from '../lib/appError'
import {
  importSillyTavernPreset,
  exportSillyTavernPreset,
} from '../services/prompt/sillyTavernPreset'

const revision = z.number().int().nonnegative()
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new AppError('VALIDATION_ERROR', {
      message: '提示词配置格式无效',
      data: result.error.issues,
    })
  return result.data
}

export function createPromptRouter(ctx: AppContext) {
  const router = new Hono()
  router.use(
    '*',
    bodyLimit({
      maxSize: 4_100_000,
      onError: (c) =>
        c.json(
          { code: 'VALIDATION_ERROR', message: __t('server.routers', '提示词配置不能超过 4 MB') },
          413,
        ),
    }),
  )
  router.get('/', (c) =>
    c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: ctx.promptWorkspace.view(),
    }),
  )
  router.get('/variables', async (c) => {
    const scope = parse(z.string().min(1).max(500).optional(), c.req.query('scope'))
    const state = await ctx.promptWorkspace.variableStore.inspect()
    const values =
      scope && scope !== '$global'
        ? (await ctx.promptWorkspace.variableStore.snapshot(scope)).local
        : state.global
    return c.json({ code: 'OK', data: { ...state, values } })
  })
  router.post('/variables/reset', async (c) => {
    const input = parse(
      z.object({ scope: z.string().min(1).max(500).optional() }),
      await c.req.json(),
    )
    await ctx.promptWorkspace.variableStore.reset(input.scope)
    return c.json({ code: 'OK', message: __t('server.routers', '变量已重置') })
  })
  router.get('/versions/:id', (c) =>
    c.json({
      code: 'OK',
      message: __t('server.routers', '获取成功'),
      data: ctx.promptWorkspace.release(c.req.param('id')),
    }),
  )
  router.put('/draft', async (c) => {
    const input = parse(z.object({ revision, bundle: promptBundleSchema }), await c.req.json())
    return c.json({
      code: 'OK',
      message: __t('server.routers', '草稿已保存'),
      data: await ctx.promptWorkspace.save(input.bundle, input.revision),
    })
  })
  router.post('/validate', async (c) => {
    const input = parse(z.object({ bundle: promptBundleSchema }), await c.req.json())
    return c.json({
      code: 'OK',
      message: __t('server.routers', '校验完成'),
      data: ctx.promptWorkspace.validate(input.bundle),
    })
  })
  router.post('/import/sillytavern', async (c) => {
    const input = parse(
      z.object({
        preset: z.unknown(),
        name: z.string().max(300).optional(),
        profile: z.number().int().min(0).max(99).optional(),
      }),
      await c.req.json(),
    )
    try {
      const result = importSillyTavernPreset(input.preset, input.name, input.profile)
      const draft = ctx.promptWorkspace.view().draft
      result.issues.push(
        ...ctx.promptWorkspace
          .validate({ ...draft, frameworks: [...draft.frameworks, result.framework] })
          .filter(
            (issue) =>
              issue.source === result.framework.id ||
              result.framework.blocks.some((block) => block.id === issue.source),
          ),
      )
      return c.json({
        code: 'OK',
        message: __t('server.routers', '预设已解析，尚未保存'),
        data: result,
      })
    } catch (error) {
      throw new AppError('VALIDATION_ERROR', {
        message: error instanceof Error ? error.message : '酒馆预设解析失败',
      })
    }
  })
  router.post('/export/sillytavern', async (c) => {
    const input = parse(
      z.object({ bundle: promptBundleSchema, frameworkId: z.string().max(180) }),
      await c.req.json(),
    )
    const framework = input.bundle.frameworks.find((item) => item.id === input.frameworkId)
    if (!framework || framework.format !== 'sillytavern')
      throw new AppError('VALIDATION_ERROR', { message: '请选择 SillyTavern 框架' })
    return c.json({ code: 'OK', data: exportSillyTavernPreset(framework) })
  })
  router.post('/publish', async (c) => {
    const input = parse(
      z.object({ revision, note: z.string().max(200).optional() }),
      await c.req.json(),
    )
    return c.json({
      code: 'OK',
      message: __t('server.routers', '已发布，下轮生效'),
      data: await ctx.promptWorkspace.publish(input.revision, input.note),
    })
  })
  router.post('/restore', async (c) => {
    const input = parse(z.object({ revision, id: z.string().max(180) }), await c.req.json())
    return c.json({
      code: 'OK',
      message: __t('server.routers', '版本已恢复到草稿'),
      data: await ctx.promptWorkspace.restore(input.id, input.revision),
    })
  })
  router.post('/preview', async (c) => {
    const input = parse(
      z.object({
        bundle: promptBundleSchema,
        channel: z.string().max(60),
        agentId: z.string().max(100),
        frameworkId: z.string().max(180).optional(),
        taskId: z.string().max(180).optional(),
        variables: z.record(z.string(), z.unknown()).default({}),
      }),
      await c.req.json(),
    )
    const profile = ctx.agentManager.getAgent(input.agentId)
    const persona = await readPromptPersona(profile?.promptPath)
    const variables = {
      persona_definition: persona,
      owner_name: (await ctx.configRepo.get('owner.name')) ?? '用户',
      owner_appellation: profile ? ctx.agentManager.getOwnerAppellation(input.agentId) : '主人',
      current_time: new Date().toLocaleString('zh-CN'),
      agent_name: profile?.name ?? input.agentId,
      flow_state: { currentGoal: '', privateFacts: '' },
      task_plan_enabled: input.channel === 'desktop',
      task_plan: null,
      native_history: [
        { role: 'user', content: '上一轮问题' },
        { role: 'assistant', content: '上一轮回答' },
      ],
      current_message: { role: 'user', content: '本次问题' },
      prompt_seed: 'preview',
      generation_type: 'normal',
      ...input.variables,
      wholesome_mode_enabled: (await ctx.configRepo.get(WHOLESOME_MODE_KEY)) !== 'false',
      assistant_prefill_config: await ctx.configRepo.get(ASSISTANT_PREFILL_KEY),
    }
    const state = input.taskId
      ? undefined
      : await ctx.promptWorkspace.previewVariableState(
          input.bundle,
          input.channel,
          input.agentId,
          input.frameworkId,
        )
    const seed = z.record(z.string().max(100), z.string().max(200_000))
    if (state && input.variables.local_variables !== undefined)
      state.local = parse(seed, input.variables.local_variables)
    if (state && input.variables.global_variables !== undefined)
      state.global = parse(seed, input.variables.global_variables)
    return c.json({
      code: 'OK',
      message: __t('server.routers', '预览完成'),
      data: ctx.promptWorkspace.preview(
        input.bundle,
        input.channel,
        input.agentId,
        variables,
        input.frameworkId,
        input.taskId,
        state,
      ),
    })
  })
  return router
}
