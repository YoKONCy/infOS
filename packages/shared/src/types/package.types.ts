/** Package 安装、贡献与能力需求的公共静态 ABI。 */

export type PlatformId = 'windows' | 'linux' | 'darwin' | 'docker'

export type PackagePermission =
  | 'runtime:execute'
  | 'filesystem:read'
  | 'filesystem:write'
  | 'network:local'
  | 'network:internet'
  | 'process:spawn'
  | 'database:read'
  | 'database:write'
  | 'system:info'

export interface ToolVisualSignatureMeta {
  archetype?: string
  variant?: string
  chain?: string
  motion?: string
  silhouette?: string
  summaryFields?: string[]
  collapseDelayMs?: number
}

export interface ToolDisplayMeta {
  /** 面向普通用户的工具名称；与模型调用函数名分离。 */
  label?: string
  /** 面向普通用户的简明用途；与模型使用的技术描述分离。 */
  description?: string
  icon?: string
  color?: string
  style?: string
  /** Tool Atelier视觉签名；社区工具可选，缺失时回退Generic。 */
  signature?: ToolVisualSignatureMeta
}

export type PackageTrustLevel = 'official' | 'signed' | 'user' | 'generated'

export type PackageContributionKind =
  | 'application'
  | 'service'
  | 'capability-provider'
  | 'runtime-adapter'
  | 'tool'
  | 'skill'
  | 'policy'
  | 'event-subscriber'
  | 'presenter'
  | 'web-ui'
  | 'asset'
  | 'context-provider'
  | 'agent-flow'

export interface PackageContribution {
  id: string
  kind: PackageContributionKind
  entry?: string
  capabilityType?: string
  contractVersion?: string
  operations?: string[]
  metadata?: Record<string, unknown>
  /** 完整页面的静态根与显式交互；entry 可指向本贡献的后端模块。 */
  webUi?: PackageWebUiDefinition
}

export interface PackageWebUiDefinition {
  root: string
  index?: string
  title?: string
  actions?: string[]
}

export interface PackageCapabilityRequirement {
  id: string
  capabilityType: string
  contractVersion: string
  operations: string[]
  required: boolean
  binding?: 'eager' | 'lazy'
  cardinality?: 'one' | 'many'
}

export interface PackageSignature {
  algorithm: 'ed25519'
  publisherId: string
  keyId: string
  manifestHash: string
  files: Array<{ path: string; sha256: string; sizeBytes: number }>
  signature: string
  signedAt: string
}

export interface PackageManifest {
  manifestVersion: 2
  packageId: string
  name: string
  version: string
  description?: string
  author?: string
  minInfosVersion?: string
  trust: PackageTrustLevel
  contributions: PackageContribution[]
  requires?: PackageCapabilityRequirement[]
  permissions?: PackagePermission[]
  platforms?: PlatformId[]
  signature?: PackageSignature
}
