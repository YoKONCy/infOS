import { z } from 'zod'
import type { TtsWorkspace } from '@infos/shared'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'

const id = z.string().min(1).max(120)
const format = z.enum(['mp3', 'wav', 'flac', 'opus', 'aac', 'pcm'])
const fields = z.record(z.string(), z.string().max(16000)).default({})
const custom = z
  .object({
    path: z.string().min(1).max(4000),
    method: z.enum(['POST', 'GET']),
    headers: fields.optional(),
    query: fields.optional(),
    bodyType: z.enum(['json', 'form', 'multipart', 'xml']),
    body: z.unknown(),
    response: z.object({
      mode: z.enum(['binary', 'json', 'sse']),
      encoding: z.enum(['base64', 'hex', 'url']).optional(),
      audioPath: z.string().max(300).optional(),
      format,
      sampleRate: z.number().int().min(8000).max(192000).optional(),
      sampleRatePath: z.string().max(300).optional(),
      successPath: z.string().max(300).optional(),
      successValue: z.unknown().optional(),
      errorPath: z.string().max(300).optional(),
      chunkMode: z.enum(['append', 'replace']).optional(),
    }),
  })
  .superRefine((value, ctx) => {
    if (
      (value.method !== 'GET' && value.body === undefined) ||
      (value.bodyType === 'xml' && typeof value.body !== 'string')
    )
      ctx.addIssue({ code: 'custom', message: 'body' })
    if (value.response.mode !== 'binary' && (!value.response.encoding || !value.response.audioPath))
      ctx.addIssue({ code: 'custom', message: 'response' })
    if (value.response.mode === 'sse' && value.response.encoding === 'url')
      ctx.addIssue({ code: 'custom', message: 'stream-url' })
    if (
      value.response.format === 'pcm' &&
      !value.response.sampleRate &&
      !value.response.sampleRatePath
    )
      ctx.addIssue({ code: 'custom', message: 'sampleRate' })
  })

export const ttsWorkspaceSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  connections: z
    .array(
      z.object({
        id,
        name: z.string().max(200),
        apiBase: z.string().max(4000),
        apiKey: z.string().max(16000),
        headers: fields,
        timeoutMs: z.number().int().min(1000).max(300000),
      }),
    )
    .max(100),
  profiles: z
    .array(
      z.object({
        id,
        adapter: z.enum(['edge_tts', 'openai', 'mimo', 'bailian', 'minimax', 'stepfun', 'custom']),
        custom: custom.optional(),
      }),
    )
    .max(100),
  models: z
    .array(
      z.object({
        id,
        connectionId: id,
        profileId: id,
        modelId: z.string().max(300),
        maxChars: z.number().int().min(1).max(100000).optional(),
      }),
    )
    .max(200),
  presets: z
    .array(
      z.object({
        id,
        name: z.string().max(200),
        modelId: id,
        voice: z.string().max(300),
        format,
        speed: z.number().finite().min(0.25).max(4),
        rate: z.string().max(30),
        pitch: z.string().max(30),
        language: z.string().max(80),
        instructions: z.string().max(8000),
        emotion: z.string().max(100),
        referenceAssetId: z.string().uuid().optional(),
        referenceText: z.string().max(16000),
        extra: z.record(z.string(), z.unknown()),
      }),
    )
    .max(200),
  defaultPresetId: z.string().max(120),
  bindings: z.record(z.string(), id),
})

/** 保存与启动加载复用同一校验，避免通用 KV 导入绕过引用检查。 */
export function parseTtsWorkspace(input: unknown): TtsWorkspace {
  const fail = (): never => {
    throw new AppError('CONFIG_ERROR', {
      message: t('server.tts', '语音配置无效，请检查字段与引用'),
    })
  }
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 16) return fail()
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) return fail()
        inspect(child, depth + 1)
      }
  }
  inspect(input, 0)
  const parsed = ttsWorkspaceSchema.safeParse(input)
  if (!parsed.success) return fail()
  const data = parsed.data as TtsWorkspace
  for (const items of [data.connections, data.profiles, data.models, data.presets]) {
    if (new Set(items.map((item) => item.id)).size !== items.length) return fail()
  }
  const connections = new Set(data.connections.map((item) => item.id))
  const profiles = new Map(data.profiles.map((item) => [item.id, item]))
  const models = new Map(data.models.map((item) => [item.id, item]))
  const presets = new Set(data.presets.map((item) => item.id))
  if (
    !presets.has(data.defaultPresetId) ||
    Object.values(data.bindings).some((value) => !presets.has(value))
  )
    return fail()
  for (const profile of data.profiles)
    if (profile.adapter === 'custom' && !profile.custom) return fail()
  for (const model of data.models) {
    if (!connections.has(model.connectionId) || !profiles.has(model.profileId)) return fail()
    if (profiles.get(model.profileId)?.adapter !== 'edge_tts' && !model.modelId.trim())
      return fail()
  }
  for (const preset of data.presets) if (!models.has(preset.modelId)) return fail()
  // 限制递归与总大小；模板只解释字段和变量，不执行表达式。
  if (JSON.stringify(data).length > 512000) return fail()
  return data
}
