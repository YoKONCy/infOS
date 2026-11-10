import { z } from 'zod'

export const homeId = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/)
export const homeScopeSchema = z
  .object({ agentId: homeId, sessionId: homeId, taskId: homeId.optional() })
  .strict()
const filePath = z.string().min(1).max(4096)
export const homeDeclarationSchema = z
  .object({ paths: z.array(filePath).max(100), apps: z.array(z.string().min(1).max(256)).max(30) })
  .strict()
export const homeFileSchema = z
  .object({
    action: z.enum(['read', 'list', 'search', 'write', 'move', 'delete']),
    path: filePath,
    destination: filePath.optional(),
    content: z
      .string()
      .max(44 * 1024 * 1024)
      .optional(),
    encoding: z.enum(['utf8', 'base64']).default('utf8'),
    query: z.string().min(1).max(200).optional(),
  })
  .strict()
export const homeShelfSchema = z
  .object({
    action: z.enum(['list', 'put', 'take', 'delete', 'restore']),
    id: homeId.optional(),
    kind: z.enum(['file', 'image', 'text', 'url']).optional(),
    name: z.string().min(1).max(200).optional(),
    value: z
      .string()
      .max(64 * 1024)
      .optional(),
    path: filePath.optional(),
    content: z
      .string()
      .max(44 * 1024 * 1024)
      .optional(),
    includeDeleted: z.boolean().optional(),
  })
  .strict()
export const homeMapSchema = z
  .object({
    action: z.enum(['list', 'get', 'put', 'delete', 'restore']),
    id: homeId.optional(),
    kind: z.enum(['app', 'folder', 'window']).optional(),
    name: z.string().max(1000).optional(),
    location: z.string().max(1000).optional(),
    purpose: z.string().max(1000).optional(),
    query: z.string().max(200).optional(),
    includeDeleted: z.boolean().optional(),
  })
  .strict()
export const homeCardSchema = z
  .object({
    action: z.enum(['get', 'messages', 'ack', 'patch']),
    cardId: homeId.optional(),
    messageId: homeId.optional(),
    revision: z.number().int().nonnegative().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
export const homeIntentSchema = z
  .object({
    action: z.enum([
      'read',
      'write',
      'move',
      'delete',
      'app',
      'send',
      'pay',
      'settings',
      'terminal',
    ]),
    paths: z.array(filePath).max(100),
    app: z.string().min(1).max(256).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
