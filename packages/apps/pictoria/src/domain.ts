import { t as __t } from './i18n'
import { z } from 'zod'

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/)
const record = z.record(z.string(), z.unknown())
export const schemaObject = record.refine((s) => s.type === 'object', '根 schema 必须是 object')
export const stepSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(100),
    usageDescription: z.string().max(16000).default(''),
    enabled: z.boolean().default(true),
    inputSchema: schemaObject,
    outputSchema: schemaObject,
    implementation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('service'), serviceId: identifier }),
      z.object({
        kind: z.literal('llm'),
        system: z.string().max(32000).default(''),
        modelId: identifier.optional(),
        outputMode: z.enum(['text', 'json']).default('text'),
      }),
      z.object({
        kind: z.literal('workflow'),
        workflowId: identifier,
        revision: z.number().int().positive(),
      }),
    ]),
  })
  .strict()
export type Step = z.infer<typeof stepSchema> & { revision: number }

export type BindingPath = Array<string | number>
export type Binding =
  | { input: string; path?: BindingPath }
  | { node: string; output: string; path?: BindingPath }
  | { literal: unknown }
  | { array: Binding[]; flatten?: boolean }
  | { select: Binding; path: BindingPath }
const bindingPath = z
  .array(
    z.union([
      z
        .string()
        .min(1)
        .max(128)
        .refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key), '字段路径无效'),
      z.number().int().nonnegative().max(100000),
    ]),
  )
  .max(16)
const recursiveBinding: z.ZodType<Binding> = z.lazy(() =>
  z
    .union([
      z.object({ input: identifier, path: bindingPath.optional() }).strict(),
      z.object({ node: identifier, output: identifier, path: bindingPath.optional() }).strict(),
      z
        .object({ literal: z.unknown() })
        .strict()
        .refine((value) => Object.hasOwn(value, 'literal'), '引用缺少字段'),
      z
        .object({ array: z.array(recursiveBinding).max(64), flatten: z.boolean().optional() })
        .strict(),
      z.object({ select: recursiveBinding, path: bindingPath }).strict(),
    ])
    .transform((value) => value as Binding),
)
export const bindingSchema = z.unknown().transform((value, context): Binding => {
  let count = 0
  const inspect = (entry: unknown, depth = 0) => {
    if (depth > 16 || ++count > 1024) throw new Error('输入引用超过嵌套或数量限制')
    if (entry && typeof entry === 'object' && 'array' in entry && Array.isArray(entry.array))
      entry.array.forEach((item) => inspect(item, depth + 1))
    if (entry && typeof entry === 'object' && 'select' in entry) inspect(entry.select, depth + 1)
  }
  try {
    inspect(value)
    return recursiveBinding.parse(value)
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : __t('apps.pictoria.ui', '输入引用格式无效'),
    })
    return z.NEVER
  }
})
export const workflowSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(100),
    usageDescription: z.string().max(16000).default(''),
    inputSchema: schemaObject,
    outputSchema: schemaObject,
    nodes: z
      .array(
        z
          .object({
            id: identifier,
            stepId: identifier,
            stepRevision: z.number().int().positive(),
            inputs: z.record(z.string(), bindingSchema),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    outputs: z.record(z.string(), bindingSchema),
  })
  .strict()
export type Workflow = z.infer<typeof workflowSchema> & { revision: number; published?: boolean }
export const endpointSchema = z
  .object({
    bodyFormat: z.enum(['json', 'multipart']).default('json'),
    path: z.string().min(1).max(2048),
    method: z.enum(['GET', 'POST', 'PUT']).default('POST'),
    body: record.default({}),
    fields: z
      .record(
        z.string(),
        z
          .object({
            from: z.string().min(1),
            format: z.enum(['value', 'data_url', 'text', 'file']).default('value'),
          })
          .strict(),
      )
      .default({}),
    taskIdField: z.string().optional(),
    outputs: z
      .record(
        z.string(),
        z
          .object({
            path: z.string(),
            kind: z.enum(['value', 'image', 'video', 'audio', 'file', 'text']).default('value'),
          })
          .strict(),
      )
      .default({}),
  })
  .strict()
export const serviceSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    baseUrl: z.string().url(),
    adapter: z.enum(['atlascloud', 'apimodels']).optional(),
    providerId: identifier.optional(),
    credentialId: identifier.optional(),
    credentialSourceId: identifier.optional(),
    headers: z
      .record(z.string(), z.string())
      .default({})
      .refine(
        (headers) =>
          !Object.keys(headers).some((key) =>
            /authorization|cookie|api[-_]?key|token|secret/i.test(key),
          ),
        '认证字段请使用独立凭据配置',
      ),
    requiresCredential: z.boolean().default(false),
    authHeader: z
      .string()
      .regex(/^[\w-]+$/)
      .default('Authorization'),
    authPrefix: z.string().default('Bearer '),
    credential: z.string().max(8192).optional(),
    clearCredential: z.boolean().optional(),
    submit: endpointSchema,
    poll: z
      .object({
        path: z.string().min(1),
        stateField: z.string().min(1),
        success: z.array(z.string()).min(1),
        failed: z.array(z.string()).min(1),
        intervalMs: z.number().int().min(1000).max(60000).default(3000),
      })
      .strict()
      .optional(),
    cancel: z
      .object({ path: z.string().min(1), method: z.enum(['POST', 'DELETE']).default('POST') })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).default(600000),
    concurrency: z.number().int().min(1).max(8).default(2),
    requestTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
    recoveryWindowMs: z.number().int().min(60000).max(86400000).optional(),
    idempotencyWindowMs: z.number().int().min(1000).max(86400000).optional(),
    idempotencyHeader: z
      .string()
      .regex(/^[\w-]+$/)
      .optional(),
  })
  .strict()
export type ServiceProfile = Omit<
  z.infer<typeof serviceSchema>,
  'credential' | 'clearCredential'
> & { revision: number; hasCredential: boolean }
export type State =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
export type NodeState =
  | 'pending'
  | 'running'
  | 'submitted'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'uncertain'
  | 'cancelled'
  | 'skipped'
export interface NodeRun {
  attempt?: number
  id: string
  step: Step
  service?: ServiceProfile
  inputs: Record<string, Binding>
  state: NodeState
  remoteId?: string
  response?: unknown
  outputs?: Record<string, unknown>
  error?: string
  startedAt?: string
  finishedAt?: string
  retry?: { phase: 'submit' | 'poll' | 'save'; count: number; firstAt: string; nextAt: string }
  savedOutputs?: Record<string, unknown>
}
export interface Run {
  id: string
  projectId: string
  owner: string
  name: string
  state: State
  revision: number
  inputs: Record<string, unknown>
  nodes: NodeRun[]
  outputs: Record<string, Binding>
  outputSchema: Record<string, unknown>
  result?: Record<string, unknown>
  createdAt: string
  updatedAt: string
  callId?: string
  error?: string
}
/** 查询快照不暴露提供商原始响应、服务配置和宿主关联标识。 */
export type RunSnapshot = Omit<Run, 'nodes' | 'callId'> & {
  nodes: Array<Omit<NodeRun, 'response' | 'service' | 'savedOutputs'>>
}
export interface Asset {
  id: string
  owner: string
  name: string
  mimeType: string
  sizeBytes: number
  sha256: string
  createdAt: string
}
export interface Invocation {
  owner: string
  key?: string
  callId?: string
}
export interface HostPort {
  generate(
    input: { callId: string; system: string; inputs: Record<string, unknown>; modelId?: string },
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('输入必须是对象')
  return value as Record<string, unknown>
}
