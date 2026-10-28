export type ExtensionToolId = 'deepwiki' | 'sciverse'
export type IntegrationFeature = 'search' | 'pdf'

/** 已安装拓展的只读投影；操作仍由各领域的管理接口执行。 */
export type InstalledExtensionKind = 'package' | 'skill' | 'persona' | 'model' | 'mcp' | 'feature'
export type InstalledExtensionSource = 'official' | 'local' | 'workshop'
export type InstalledExtensionState =
  | 'ready'
  | 'available'
  | 'disabled'
  | 'starting'
  | 'failed'
  | 'needs-authorization'
  | 'needs-configuration'
export type ExtensionManager = 'packages' | 'extensions' | 'features' | 'skills' | 'agents' | 'mcp'

export interface InstalledExtension {
  id: string
  resourceId: string
  name: string
  description?: string
  kind: InstalledExtensionKind
  source: InstalledExtensionSource
  state: InstalledExtensionState
  version?: string
  author?: string
  location?: string
  ownerPackageId?: string
  manager?: ExtensionManager
  managerId?: string
  /** 仅展示声明的要求，不把未知兼容性当作已验证。 */
  requirements: string[]
  missingRequirements: string[]
  contributions?: string[]
  hasRollback?: boolean
  metadataUnavailable?: boolean
}

export interface InstalledExtensionsView {
  items: InstalledExtension[]
  /** 某类数据读取失败时保留其他类别，并显式报告缺失。 */
  unavailable: InstalledExtensionKind[]
}
export type IntegrationProvider =
  | 'tavily'
  | 'brave'
  | 'searxng'
  | 'mineru-light'
  | 'mineru'
  | 'pdf-http'

export interface IntegrationSourceOptions {
  language: string
  ocr: boolean
  model: 'vlm' | 'pipeline'
  searchDepth: 'basic' | 'advanced'
  maxResults: number
}

export interface IntegrationSourceView {
  id: string
  name: string
  provider: IntegrationProvider
  endpoint: string
  options: IntegrationSourceOptions
  hasApiKey: boolean
  configured: boolean
}

export interface IntegrationFeatureView {
  enabled: boolean
  selectedSourceId: string | null
  sources: IntegrationSourceView[]
  ready: boolean
}

export interface ExtensionToolView {
  enabled: boolean
  chatEnabled: boolean
  endpoint: string
  hasApiKey: boolean
  configured: boolean
  ready: boolean
  maxResults: number
}

export interface IntegrationsView {
  extensions: Record<ExtensionToolId, ExtensionToolView>
  features: Record<IntegrationFeature, IntegrationFeatureView>
}

export interface IntegrationSourceInput {
  id?: string
  name: string
  provider: IntegrationProvider
  endpoint: string
  apiKey?: string
  clearApiKey?: boolean
  options?: Partial<IntegrationSourceOptions>
}

export const INTEGRATION_PROVIDERS: Array<{
  id: IntegrationProvider
  kind: IntegrationFeature
  name: string
  endpoint: string
  needsKey: boolean
  logo: string
}> = [
  {
    id: 'tavily',
    kind: 'search',
    name: 'Tavily',
    endpoint: 'https://api.tavily.com',
    needsKey: true,
    logo: 'tavily',
  },
  {
    id: 'brave',
    kind: 'search',
    name: 'Brave Search',
    endpoint: 'https://api.search.brave.com',
    needsKey: true,
    logo: 'brave',
  },
  {
    id: 'searxng',
    kind: 'search',
    name: 'SearXNG',
    endpoint: '',
    needsKey: false,
    logo: 'searxng',
  },
  {
    id: 'mineru-light',
    kind: 'pdf',
    name: 'MinerU 轻量解析',
    endpoint: 'https://mineru.net',
    needsKey: false,
    logo: 'mineru',
  },
  {
    id: 'mineru',
    kind: 'pdf',
    name: 'MinerU 精准解析',
    endpoint: 'https://mineru.net',
    needsKey: true,
    logo: 'mineru',
  },
  { id: 'pdf-http', kind: 'pdf', name: 'HTTP 解析服务', endpoint: '', needsKey: false, logo: '' },
]
