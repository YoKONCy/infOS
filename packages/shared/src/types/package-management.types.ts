import type { PackageManifest, PackagePermission } from './package.types'

export type PackageUiSlot = 'dashboard.overview' | 'chat.header' | 'chat.footer' | 'integrations'
/** 声明式 UI 不接收 HTML、脚本或任意 CSS。 */
export interface PackagePanel {
  id: string
  packageId: string
  slot: PackageUiSlot
  title: string
  text?: string
  fields?: Array<{ label: string; value: string }>
  actions?: Array<{ id: string; label: string }>
  /**
   * 由宿主绘制的入口：`tool-groups` 为工具管理弹窗；`local-page` 在插件卡片上显示「打开页面」，
   * 经 `page.url` 动作取得插件本机页面地址（只接受回环地址），在浏览器或独立窗口中打开，不嵌入设置页。
   */
  settings?: { kind: 'tool-groups' } | { kind: 'local-page' }
}

export type PackageToolGroupState = 'pinned' | 'ondemand' | 'off'
export interface PackageToolGroup {
  id: string
  name: string
  description: string
  state: PackageToolGroupState
  tools: string[]
}
export interface PackageToolSettingsSnapshot {
  revision: number
  values: Record<string, string>
  fields: Array<{ id: string; label: string; placeholder?: string; checkable?: boolean }>
  groups: PackageToolGroup[]
  ungroupedState: PackageToolGroupState
  disabledTools: string[]
  tools: Array<{
    id: string
    title: string
    description: string
    params?: Record<string, { required: boolean; description: string }>
  }>
  fresh: string[]
  notice?: { message: string; parameters?: string[] }
}
export interface ManagedPackageInfo {
  manifest: PackageManifest
  state: string
  enabled: boolean
  authorized: boolean
  digest: string
  sourceDirectory: string
  error?: string
  previousVersion?: string
  requestedPermissions: PackagePermission[]
}

/** 会话只由宿主持有，页面拿到的资源票据不能调用业务接口。 */
export interface PackageWebUiSession {
  id: string
  channel: string
  packageId: string
  contributionId: string
  title: string
  documentPath: string
}

export interface PackageWebUiActionContext {
  clientId: string
  signal: AbortSignal
  report(value: unknown): void
}

export interface PackageWebUiModule {
  actions: Record<
    string,
    (input: unknown, context: PackageWebUiActionContext) => unknown | Promise<unknown>
  >
}

/** 浏览器页面由宿主注入 infosPlugin；本接口只描述公开的页面 SDK。 */
export interface PackageWebUiClient {
  readonly context: { theme: 'light' | 'dark'; locale: string }
  onContext(listener: (context: PackageWebUiClient['context']) => void): () => void
  call<T = unknown>(
    action: string,
    input?: unknown,
    options?: { signal?: AbortSignal; onProgress?: (value: unknown) => void },
  ): Promise<T>
}
