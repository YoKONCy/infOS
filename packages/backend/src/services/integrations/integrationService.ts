import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import {
  INTEGRATION_PROVIDERS,
  type ExtensionToolId,
  type IntegrationFeature,
  type IntegrationSourceInput,
  type IntegrationsView,
} from '@infos/shared'
import type { ConfigRepository } from '../../repositories/config.repo'
import type { ToolRegistry, ToolHandler } from '../agent/toolRegistry'
import type { PackageRegistry } from '../../packages/packageRegistry'
import type { PackageRuntime } from '../../packages/packageRuntime'
import type { PackageActivationContext } from '../../packages/types'
import { AppError } from '../../lib/appError'
import { apiUrl, integrationEndpoint, integrationJson } from './integrationHttp'
import {
  EXTENSION_PACKAGES,
  integrationDefinitions,
  officialExtensionManifest,
} from './integrationDefinitions'

export const sourceOptionsSchema = z.object({
  language: z.string().trim().max(20).default('ch'),
  ocr: z.boolean().default(false),
  model: z.enum(['vlm', 'pipeline']).default('vlm'),
  searchDepth: z.enum(['basic', 'advanced']).default('basic'),
  maxResults: z.number().int().min(1).max(10).default(5),
})
export const sourceInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  provider: z.enum(['tavily', 'brave', 'searxng', 'mineru-light', 'mineru', 'pdf-http']),
  endpoint: z.string().trim().max(2048),
  apiKey: z.string().trim().max(4096).optional(),
  clearApiKey: z.boolean().optional(),
  options: sourceOptionsSchema.partial().optional(),
})
const extensionSchema = z.object({
  enabled: z.boolean(),
  chatEnabled: z.boolean().default(false),
  endpoint: z.string(),
  apiKey: z.string().default(''),
  maxResults: z.number().int().min(1).max(20).default(5),
})
const storedSourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  provider: sourceInputSchema.shape.provider,
  endpoint: z.string(),
  apiKey: z.string().default(''),
  options: sourceOptionsSchema,
})
const featureSchema = z.object({
  enabled: z.boolean(),
  selectedSourceId: z.string().uuid().nullable(),
  sources: z.array(storedSourceSchema).max(32),
})
const settingsSchema = z.object({
  extensions: z.object({ deepwiki: extensionSchema, sciverse: extensionSchema }),
  features: z.object({ search: featureSchema, pdf: featureSchema }),
})
type StoredSettings = z.infer<typeof settingsSchema>
export type IntegrationSource = z.infer<typeof storedSourceSchema>

const CONFIG_KEY = 'integrations.v1'
const emptySettings = (): StoredSettings => ({
  extensions: {
    deepwiki: {
      enabled: false,
      chatEnabled: false,
      endpoint: 'https://mcp.deepwiki.com/mcp',
      apiKey: '',
      maxResults: 5,
    },
    sciverse: {
      enabled: false,
      chatEnabled: false,
      endpoint: 'https://api.sciverse.space',
      apiKey: '',
      maxResults: 5,
    },
  },
  features: {
    search: { enabled: false, selectedSourceId: null, sources: [] },
    pdf: { enabled: false, selectedSourceId: null, sources: [] },
  },
})
const record = z.record(z.string(), z.unknown())
const short = (value: unknown, max = 1600): string =>
  typeof value === 'string' ? value.slice(0, max) : ''
const resultUrl = (value: unknown): string => {
  const text = short(value, 2048)
  try {
    const url = new URL(text)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

/** 原生功能和官方扩展共用配置入口，运行时仍分属各自的注册路径。 */
export class IntegrationService {
  private settings = emptySettings()
  private changes: Promise<void> = Promise.resolve()
  private controller = new AbortController()

  constructor(
    private config: ConfigRepository,
    private tools: ToolRegistry,
    private packages: PackageRegistry,
    private runtime: PackageRuntime,
  ) {}

  async initialize(): Promise<void> {
    const saved = settingsSchema.safeParse(await this.config.getJson(CONFIG_KEY))
    if (saved.success) this.settings = saved.data
    for (const id of ['deepwiki', 'sciverse'] as const)
      this.packages.install(officialExtensionManifest(id))
  }

  dispose(): void {
    this.controller.abort()
    this.tools.unregister(integrationDefinitions.search.name)
  }

  private validEndpoint(endpoint: string): boolean {
    try {
      return Boolean(integrationEndpoint(endpoint))
    } catch {
      return false
    }
  }
  extensionConfigured(id: ExtensionToolId): boolean {
    const value = this.settings.extensions[id]
    return this.validEndpoint(value.endpoint) && (id === 'deepwiki' || Boolean(value.apiKey))
  }
  extensionReady(id: ExtensionToolId): boolean {
    return this.settings.extensions[id].enabled && this.extensionConfigured(id)
  }
  managedPackage(packageId: string): boolean {
    return Object.values(EXTENSION_PACKAGES).some((id) => id === packageId)
  }

  sourceConfigured(source: IntegrationSource, kind: IntegrationFeature): boolean {
    const provider = INTEGRATION_PROVIDERS.find(
      (item) => item.id === source.provider && item.kind === kind,
    )
    return Boolean(
      provider && this.validEndpoint(source.endpoint) && (!provider.needsKey || source.apiKey),
    )
  }
  selectedSource(kind: IntegrationFeature): IntegrationSource | undefined {
    const value = this.settings.features[kind]
    if (!value.enabled) return undefined
    const source = value.sources.find((item) => item.id === value.selectedSourceId)
    return source && this.sourceConfigured(source, kind) ? structuredClone(source) : undefined
  }

  view(): IntegrationsView {
    const extension = (id: ExtensionToolId) => {
      const value = this.settings.extensions[id]
      return {
        enabled: value.enabled,
        chatEnabled: value.chatEnabled,
        endpoint: value.endpoint,
        hasApiKey: Boolean(value.apiKey),
        maxResults: value.maxResults,
        configured: this.extensionConfigured(id),
        ready: this.extensionReady(id) && this.tools.has(integrationDefinitions[id].name),
      }
    }
    const feature = (kind: IntegrationFeature) => {
      const value = this.settings.features[kind]
      return {
        enabled: value.enabled,
        selectedSourceId: value.selectedSourceId,
        ready: Boolean(this.selectedSource(kind)),
        sources: value.sources.map(({ apiKey, ...source }) => ({
          ...source,
          hasApiKey: Boolean(apiKey),
          configured: this.sourceConfigured({ ...source, apiKey }, kind),
        })),
      }
    }
    return {
      extensions: { deepwiki: extension('deepwiki'), sciverse: extension('sciverse') },
      features: { search: feature('search'), pdf: feature('pdf') },
    }
  }

  private mutate(update: (draft: StoredSettings) => void): Promise<IntegrationsView> {
    const change = this.changes.then(async () => {
      const previous = this.settings
      const draft = structuredClone(previous)
      update(draft)
      await this.config.setJson(CONFIG_KEY, draft)
      this.settings = draft
      try {
        await this.reconcile()
      } catch (error) {
        this.settings = previous
        await this.config.setJson(CONFIG_KEY, previous)
        await this.reconcile()
        throw error
      }
    })
    this.changes = change.catch(() => undefined)
    return change.then(() => this.view())
  }

  updateExtension(
    id: ExtensionToolId,
    input: {
      enabled: boolean
      chatEnabled?: boolean
      endpoint: string
      apiKey?: string
      clearApiKey?: boolean
      maxResults: number
    },
  ): Promise<IntegrationsView> {
    return this.mutate((draft) => {
      const old = draft.extensions[id]
      const endpoint = integrationEndpoint(input.endpoint)
      const apiKey =
        input.apiKey?.trim() ||
        (input.clearApiKey ? '' : old.endpoint === endpoint ? old.apiKey : '')
      draft.extensions[id] = {
        enabled: input.enabled,
        chatEnabled: input.chatEnabled ?? old.chatEnabled,
        endpoint,
        apiKey,
        maxResults: input.maxResults,
      }
      if (input.enabled && (!endpoint || (id === 'sciverse' && !apiKey)))
        throw new AppError('INVALID_PARAMETER', { message: '请先完成扩展配置，再启用工具' })
    })
  }

  updateFeature(
    kind: IntegrationFeature,
    input: { enabled: boolean; selectedSourceId: string | null },
  ): Promise<IntegrationsView> {
    return this.mutate((draft) => {
      const value = draft.features[kind]
      const source = value.sources.find((item) => item.id === input.selectedSourceId)
      if (input.selectedSourceId && !source)
        throw new AppError('INVALID_PARAMETER', { message: '所选来源不存在' })
      if (input.enabled && (!source || !this.sourceConfigured(source, kind)))
        throw new AppError('INVALID_PARAMETER', { message: '请选择配置完整的来源' })
      value.enabled = input.enabled
      value.selectedSourceId = input.selectedSourceId
    })
  }

  saveSource(kind: IntegrationFeature, input: IntegrationSourceInput): Promise<IntegrationsView> {
    return this.mutate((draft) => {
      const provider = INTEGRATION_PROVIDERS.find(
        (item) => item.id === input.provider && item.kind === kind,
      )
      if (!provider) throw new AppError('INVALID_PARAMETER', { message: '来源类型不属于当前功能' })
      const sources = draft.features[kind].sources
      const old = sources.find((item) => item.id === input.id)
      if (input.id && !old) throw new AppError('NOT_FOUND', { message: '来源不存在' })
      if (!old && sources.length >= 32)
        throw new AppError('OUT_OF_RANGE', { message: '最多保存 32 个来源' })
      const endpoint = integrationEndpoint(input.endpoint)
      const source: IntegrationSource = {
        id: old?.id ?? randomUUID(),
        name: input.name,
        provider: input.provider,
        endpoint,
        apiKey:
          input.apiKey?.trim() ||
          (input.clearApiKey
            ? ''
            : old?.provider === input.provider && old.endpoint === endpoint
              ? old.apiKey
              : ''),
        options: sourceOptionsSchema.parse({ ...old?.options, ...input.options }),
      }
      if (old) sources.splice(sources.indexOf(old), 1, source)
      else sources.push(source)
      if (
        draft.features[kind].selectedSourceId === source.id &&
        !this.sourceConfigured(source, kind)
      )
        draft.features[kind].enabled = false
    })
  }
  removeSource(kind: IntegrationFeature, id: string): Promise<IntegrationsView> {
    return this.mutate((draft) => {
      const value = draft.features[kind]
      value.sources = value.sources.filter((item) => item.id !== id)
      if (value.selectedSourceId === id) {
        value.selectedSourceId = null
        value.enabled = false
      }
    })
  }

  async reconcile(): Promise<void> {
    for (const id of ['deepwiki', 'sciverse'] as const) {
      if (this.extensionReady(id)) await this.runtime.activate(EXTENSION_PACKAGES[id])
      else await this.runtime.deactivate(EXTENSION_PACKAGES[id])
      this.tools.setChatEnabled(
        integrationDefinitions[id].name,
        this.settings.extensions[id].chatEnabled,
      )
    }
    this.tools.unregister(integrationDefinitions.search.name)
    if (this.selectedSource('search'))
      this.tools.register(integrationDefinitions.search, this.handler('search'))
  }

  activateBuiltinTool(context: PackageActivationContext): (() => void) | undefined {
    const id = (Object.keys(EXTENSION_PACKAGES) as ExtensionToolId[]).find(
      (value) => EXTENSION_PACKAGES[value] === context.manifest.packageId,
    )
    if (!id) throw new Error('没有匹配的官方扩展入口')
    if (!this.extensionReady(id)) throw new Error('官方扩展尚未配置或未启用')
    const definition = integrationDefinitions[id]
    this.tools.register(definition, this.handler(id), undefined, {
      chatEnabled: this.settings.extensions[id].chatEnabled,
    })
    return () => {
      this.tools.unregister(definition.name)
    }
  }

  private handler(id: ExtensionToolId | 'search'): ToolHandler {
    return async (args, context) => {
      const signal = AbortSignal.any([
        this.controller.signal,
        ...(context.signal ? [context.signal] : []),
        AbortSignal.timeout(60_000),
      ])
      if (id !== 'search' && !this.extensionReady(id))
        throw new AppError('SERVICE_UNAVAILABLE', { message: '扩展已停用或配置不完整' })
      try {
        const output =
          id === 'deepwiki'
            ? await this.deepwiki(args, signal)
            : id === 'sciverse'
              ? await this.sciverse(args, signal)
              : await this.search(args, signal)
        const value = output as Record<string, unknown>
        // 在工具统一截断之前按条目收敛，保持 JSON 与来源信息完整。
        const items = Array.isArray(value.hits)
          ? value.hits
          : Array.isArray(value.results)
            ? value.results
            : undefined
        while (items?.length && JSON.stringify(value).length > 7600) {
          items.pop()
          value.truncated = true
        }
        for (const key of ['text', 'query']) {
          let content = value[key]
          while (
            typeof content === 'string' &&
            content.length &&
            JSON.stringify(value).length > 7600
          ) {
            content = content.slice(0, Math.max(0, content.length - 500))
            value[key] = content
            value.truncated = true
          }
        }
        return JSON.stringify(value)
      } catch (error) {
        if (error instanceof AppError || error instanceof z.ZodError) throw error
        if (signal.aborted)
          throw new AppError('GATEWAY_TIMEOUT', { message: '外部请求已取消或超时' })
        throw new AppError('SERVICE_UNAVAILABLE', {
          message: '外部服务调用失败，请检查配置或稍后重试',
        })
      }
    }
  }

  private async deepwiki(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const input = z
      .object({
        repository: z
          .string()
          .max(200)
          .regex(/^[\w.-]+\/[\w.-]+$/),
        question: z.string().trim().min(1).max(2000),
      })
      .parse(args)
    const settings = { ...this.settings.extensions.deepwiki }
    const client = new Client({ name: 'infOS-DeepWiki', version: '1.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(settings.endpoint), {
      requestInit: { signal },
    })
    const abort = () => {
      void client.close().catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      await client.connect(transport)
      const result = await client.callTool(
        {
          name: 'ask_question',
          arguments: { repoName: input.repository, question: input.question },
        },
        undefined,
        { signal },
      )
      if (result.isError)
        throw new AppError('SERVICE_UNAVAILABLE', {
          message: 'DeepWiki 未能完成仓库查询，请检查仓库是否已被收录',
        })
      const content = z
        .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
        .parse(result.content)
      const text = content
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n')
      if (!text.trim())
        throw new AppError('SERVICE_UNAVAILABLE', { message: 'DeepWiki 没有返回可读内容' })
      return {
        repository: input.repository,
        source: `https://deepwiki.com/${input.repository}`,
        text: text.slice(0, 6000),
        truncated: text.length > 6000,
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await client.close().catch(() => undefined)
    }
  }

  private async sciverse(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const input = z
      .object({
        query: z.string().trim().min(1).max(2000).optional(),
        limit: z.number().int().min(1).max(20).optional(),
        doc_id: z.string().trim().min(1).max(300).optional(),
        offset: z.number().int().min(0).max(10000000).default(0),
      })
      .refine(
        (value) => Boolean(value.query) !== Boolean(value.doc_id),
        '请指定检索词或原文编号其中之一',
      )
      .parse(args)
    const settings = { ...this.settings.extensions.sciverse }
    const headers = {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    }
    if (input.doc_id) {
      const url = new URL(apiUrl(settings.endpoint, 'content'))
      url.search = new URLSearchParams({
        doc_id: input.doc_id,
        offset: String(input.offset),
        limit: '4000',
      }).toString()
      const result = record.parse(await integrationJson(url.href, { headers, signal }))
      return {
        doc_id: input.doc_id,
        offset: input.offset,
        text: short(result.text, 4000),
        next_offset: typeof result.next_offset === 'number' ? result.next_offset : null,
        more: result.more === true,
        source: 'Sciverse.space',
      }
    }
    const limit = input.limit ?? settings.maxResults
    const result = record.parse(
      await integrationJson(apiUrl(settings.endpoint, 'agentic-search'), {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({ query: input.query, top_k: limit }),
      }),
    )
    const hits = z
      .array(record)
      .parse(result.hits ?? [])
      .slice(0, limit)
    return {
      query: input.query,
      source: 'Sciverse.space',
      hits: hits.map((hit) => ({
        doc_id: short(hit.doc_id, 300),
        title: short(hit.title, 300),
        year: typeof hit.year === 'number' ? hit.year : short(hit.year, 10),
        doi: short(hit.doi, 300),
        url: resultUrl(hit.url),
        offset: typeof hit.offset === 'number' ? hit.offset : 0,
        text: short(hit.text ?? hit.snippet ?? hit.content, 2000),
      })),
    }
  }

  private async search(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const input = z
      .object({
        query: z.string().trim().min(1).max(2000),
        limit: z.number().int().min(1).max(10).optional(),
      })
      .parse(args)
    const source = this.selectedSource('search')
    if (!source) throw new AppError('SERVICE_UNAVAILABLE', { message: '联网搜索尚未配置或已停用' })
    const limit = input.limit ?? source.options.maxResults
    let items: Record<string, unknown>[]
    if (source.provider === 'tavily') {
      const result = record.parse(
        await integrationJson(apiUrl(source.endpoint, 'search'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${source.apiKey}`, 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            query: input.query,
            max_results: limit,
            search_depth: source.options.searchDepth,
            include_answer: false,
            include_raw_content: false,
          }),
        }),
      )
      items = z.array(record).parse(result.results ?? [])
    } else {
      const url = new URL(
        apiUrl(source.endpoint, source.provider === 'brave' ? 'res/v1/web/search' : 'search'),
      )
      url.search = new URLSearchParams(
        source.provider === 'brave'
          ? { q: input.query, count: String(limit) }
          : { q: input.query, format: 'json', categories: 'general' },
      ).toString()
      const result = record.parse(
        await integrationJson(url.href, {
          signal,
          headers: source.provider === 'brave' ? { 'X-Subscription-Token': source.apiKey } : {},
        }),
      )
      items = z
        .array(record)
        .parse(
          source.provider === 'brave'
            ? (record.parse(result.web ?? {}).results ?? [])
            : (result.results ?? []),
        )
    }
    return {
      query: input.query,
      source: source.name,
      results: items.slice(0, limit).map((item) => ({
        title: short(item.title, 300),
        url: resultUrl(item.url),
        snippet: short(item.content ?? item.description),
        publishedAt: short(item.published_date ?? item.publishedDate, 80),
      })),
    }
  }
}
