export type IndexScope = 'main' | 'social' | 'facts' | 'knowledge'

/** 文件系统错误与嵌套原因保持结构化；code/phase 不随界面语言变化。 */
export interface IndexMaintenanceDiagnostic {
  code: string
  phase: string
  path?: string
  message: string
  causes?: IndexMaintenanceDiagnostic[]
}

export interface IndexMaintenanceTarget {
  scope: IndexScope
  agentId?: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  error?: IndexMaintenanceDiagnostic
  warnings?: IndexMaintenanceDiagnostic[]
}

export interface IndexMaintenanceStatus {
  dimension: number
  model: string
  embeddingAvailable: boolean
  busy: boolean
  indexes: Array<{
    scope: IndexScope
    agentId?: string
    exists: boolean
    dimension: number | null
    nodeCount: number | null
    maintenance?: boolean
    error?: string
    diagnostic?: IndexMaintenanceDiagnostic
    warnings?: IndexMaintenanceDiagnostic[]
  }>
  jobs: Array<{
    executionId?: string
    scope: IndexScope | 'all'
    agentId?: string
    state: string
    /** 保留旧客户端字段，仍表示成功数量。 */
    completed: number
    processed: number
    failed: number
    total: number
    results: IndexMaintenanceTarget[]
    error?: string
  }>
}
