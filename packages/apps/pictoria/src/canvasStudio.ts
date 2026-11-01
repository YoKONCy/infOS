import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store'
import { identifier, serviceSchema, stepSchema, type Step } from './domain'
import { providerCredential, type ProviderProfile } from './providers'
import { CANVAS_ASSISTANT_SYSTEM, canvasProposalSchema } from './canvasDocument'
import { t } from './i18n'
import {
  assistantSettingsSchema,
  assistantCallOptions,
  assistantRequestParameters,
  defaultAssistantSettings,
  type AssistantSettings,
} from './assistantSettings'
const label = (source: string) => t('apps.pictoria.studio', source)
const settingsLabel = (source: string) => t('apps.pictoria.assistant', source)

function parseSettings(input: unknown): AssistantSettings {
  const result = assistantSettingsSchema.safeParse(input)
  if (!result.success) throw new Error(settingsLabel('请检查参数范围'))
  return result.data
}

/** 实时选择只保存在宿主内存；提案、会话和模型任务分别持久化，不直接改写用户画布。 */
export class CanvasStudio {
  private contexts = new Map<
    string,
    { sequence: number; capturedAt: number; snapshot: Record<string, unknown> }
  >()
  constructor(private readonly store: Store) {}
  invoke(owner: string, operation: string, value: Record<string, unknown>): unknown {
    if (operation === 'canvas.context.get' && value.projectId === undefined) {
      const sessions = [...this.contexts.entries()]
        .filter(
          ([key, entry]) => key.startsWith(`${owner}/`) && Date.now() - entry.capturedAt <= 120000,
        )
        .map(([key, entry]) => ({
          projectId: key.split('/')[1],
          sessionId: key.split('/')[2],
          sequence: entry.sequence,
          title: (entry.snapshot.project as { title?: string } | undefined)?.title,
        }))
      if (sessions.length === 1) value = { ...value, ...sessions[0] }
      else return { sessions }
    }
    const projectId = identifier.parse(value.projectId)
    if (operation === 'canvas.assistant.settings.get')
      return (
        this.store.get(owner, 'canvas-assistant-settings', projectId) ?? {
          revision: 0,
          settings: defaultAssistantSettings(),
        }
      )
    if (operation === 'canvas.assistant.settings.save')
      return this.store.put(
        owner,
        'canvas-assistant-settings',
        { id: projectId, settings: parseSettings(value.settings) },
        z.number().int().nonnegative().parse(value.expectedRevision),
      )
    if (operation === 'canvas.assistant.prepare')
      return this.assistant(
        owner,
        parseSettings(
          value.settings ?? { providerId: value.providerId ?? '', model: value.model ?? '' },
        ),
        value.vision === true,
      )
    if (operation === 'canvas.context.set') {
      const sessionId = identifier.parse(value.sessionId)
      const snapshot = z.record(z.string(), z.unknown()).parse(value.snapshot)
      if (JSON.stringify(snapshot).length > 1_000_000) throw new Error(label('画布上下文过大'))
      const sequence = z.number().int().nonnegative().parse(value.sequence)
      const key = `${owner}/${projectId}/${sessionId}`
      const previous = this.contexts.get(key)
      for (const [key, entry] of this.contexts)
        if (Date.now() - entry.capturedAt > 120000) this.contexts.delete(key)
      if (!previous && this.contexts.size >= 500) throw new Error(label('打开的画布会话过多'))
      if (!previous || sequence > previous.sequence)
        this.contexts.set(key, { sequence, capturedAt: Date.now(), snapshot })
      return { accepted: true }
    }
    if (operation === 'canvas.context.close') {
      this.contexts.delete(`${owner}/${projectId}/${identifier.parse(value.sessionId)}`)
      return { closed: true }
    }
    if (operation === 'canvas.context.get' || operation === 'canvas.propose') {
      const prefix = `${owner}/${projectId}/`
      const active = [...this.contexts.entries()].filter(
        ([key, entry]) =>
          key.startsWith(prefix) &&
          Date.now() - entry.capturedAt <= 120000 &&
          (!value.sessionId || key === prefix + value.sessionId),
      )
      if (active.length !== 1)
        throw new Error(
          label(
            active.length ? '多个窗口正在编辑此画布，请指定 sessionId' : '画布未打开或上下文已过期',
          ),
        )
      const [key, context] = active[0]!
      if (operation === 'canvas.context.get')
        return {
          ...context,
          projectId,
          sessionId: key.slice(prefix.length),
          ageMs: Date.now() - context.capturedAt,
          proposalSchema: z.toJSONSchema(canvasProposalSchema),
        }
      if (value.sequence !== context.sequence)
        throw new Error(label('画布上下文已变化，请重新读取'))
      const proposal = canvasProposalSchema.parse(value.proposal)
      return this.store.put(
        owner,
        'canvas-proposal',
        {
          id: randomUUID(),
          projectId,
          sessionId: key.slice(prefix.length),
          sequence: context.sequence,
          baseKey: context.snapshot.baseKey,
          proposal,
          state: 'pending',
        },
        0,
      )
    }
    if (operation === 'canvas.proposal.list')
      return this.store
        .list<{ projectId: string; state: string }>(owner, 'canvas-proposal', 200)
        .filter((entry) => entry.projectId === projectId && entry.state === 'pending')
    if (operation === 'canvas.proposal.resolve') {
      const entry = this.store.get<{ id: string; projectId: string; state: string }>(
        owner,
        'canvas-proposal',
        identifier.parse(value.id),
      )
      if (!entry || entry.projectId !== projectId || entry.state !== 'pending')
        throw new Error(label('提案不存在或已处理'))
      return this.store.put(
        owner,
        'canvas-proposal',
        { ...entry, state: z.enum(['applied', 'rejected']).parse(value.state) },
        z.number().int().parse(value.expectedRevision),
      )
    }
    if (operation === 'canvas.conversation.get')
      return (
        this.store.get(owner, 'canvas-conversation', projectId) ?? {
          id: projectId,
          revision: 0,
          messages: [],
        }
      )
    if (operation === 'canvas.conversation.save') {
      const messages = z
        .array(
          z
            .object({
              id: identifier,
              role: z.enum(['user', 'assistant']),
              text: z.string().max(64000),
              taskId: identifier.optional(),
              baseKey: z.string().optional(),
              proposal: canvasProposalSchema.optional(),
              submission: z
                .object({
                  stepId: identifier,
                  stepRevision: z.number().int().positive(),
                  prompt: z.string().max(64000),
                  images: z
                    .array(z.object({ assetId: identifier }).strict())
                    .max(4)
                    .optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .max(2000)
        .parse(value.messages)
      return this.store.put(
        owner,
        'canvas-conversation',
        { id: projectId, messages },
        z.number().int().nonnegative().parse(value.expectedRevision),
      )
    }
    throw new Error(label('画布工作室操作不存在'))
  }
  private assistant(owner: string, settings: AssistantSettings, vision = false): Step {
    const { providerId, model } = settings
    const provider = providerId
      ? this.store.get<ProviderProfile>(owner, 'model-provider', identifier.parse(providerId))
      : undefined
    if (providerId && (!provider?.enabled || provider.protocol !== 'openai'))
      throw new Error(label('请选择启用的 OpenAI 兼容供应商'))
    const modelId =
      typeof model === 'string' && model.trim() ? model.trim() : provider?.defaultModel
    if (provider && !modelId) throw new Error(label('请填写助手模型名称'))
    const suffix = createHash('sha256')
      .update(
        JSON.stringify([
          provider?.id ?? 'infos',
          modelId ?? '',
          'canvas-v3',
          vision,
          settings.generation,
          settings.instructions,
          settings.timeoutSeconds,
        ]),
      )
      .digest('hex')
      .slice(0, 24)
    const id = `canvas-assistant-${suffix}`
    // 创作偏好补充在固定提案协议后，不能替换操作边界或自动提交生成任务。
    const system = settings.instructions
      ? `${CANVAS_ASSISTANT_SYSTEM}\n\n用户创作偏好：\n${settings.instructions}\n\n创作偏好仅影响内容，始终遵守以上提案格式与确认要求。`
      : CANVAS_ASSISTANT_SYSTEM
    const inputSchema = {
      type: 'object',
      properties: {
        prompt: { type: 'string', maxLength: 64000 },
        ...(vision
          ? {
              images: {
                type: 'array',
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: { assetId: { type: 'string' } },
                  required: ['assetId'],
                  additionalProperties: false,
                },
              },
            }
          : {}),
      },
      required: ['prompt'],
      additionalProperties: false,
    }
    const outputSchema = {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    }
    return this.store.transaction(() => {
      if (provider) {
        const service = serviceSchema.parse({
          id,
          name: label('画布助手'),
          enabled: true,
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          credentialId: providerCredential(provider.id),
          requiresCredential: provider.requiresCredential,
          authHeader: provider.authHeader,
          authPrefix: provider.authPrefix,
          submit: {
            path: 'chat/completions',
            body: {
              model: modelId,
              ...assistantRequestParameters(settings, modelId),
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: '' },
              ],
            },
            fields: {
              'messages.1.content': { from: 'prompt', format: vision ? 'openai_content' : 'value' },
            },
            outputs: { text: { path: 'choices.0.message.content', kind: 'text' } },
          },
          timeoutMs: settings.timeoutSeconds * 1000,
        })
        const old = this.store.get<{ revision: number }>(owner, 'service', id)
        this.store.put(
          owner,
          'service',
          {
            ...service,
            hasCredential: Boolean(this.store.secret(owner, providerCredential(provider.id))),
          },
          old?.revision ?? 0,
        )
      }
      const step = stepSchema.parse({
        id,
        name: label('画布助手'),
        enabled: true,
        usageDescription: CANVAS_ASSISTANT_SYSTEM,
        inputSchema,
        outputSchema,
        implementation: provider
          ? { kind: 'service', serviceId: id }
          : { kind: 'llm', system, outputMode: 'text', options: assistantCallOptions(settings) },
      })
      const old = this.store.get<Step>(owner, 'step', id)
      if (old) return old
      const saved = this.store.put(owner, 'step', step, 0)
      this.store.put(owner, 'step-version', { id: `${id}:${saved.revision}`, snapshot: saved }, 0)
      return saved
    })
  }
}
