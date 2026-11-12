/**
 * Maintenance API 模块
 *
 * 对齐后端 maintenance.router.ts 端点。
 */

import { apiClient } from '../client'
import type { TaskStats } from './schedulerApi'

import type { IndexScope, IndexMaintenanceStatus } from '@infos/shared'
export type { IndexScope, IndexMaintenanceStatus } from '@infos/shared'

/** 维护系统状态 */
export interface MaintenanceStatus {
  schedulerRunning: boolean
  tasks: Array<{
    name: string
    running: boolean
    lastRunAt: string
    intervalDesc: string
    stats: TaskStats
  }>
  memory: {
    totalMemories: number
    pendingSyncCount: number
  }
}

/** 主 Agent 全局记忆运行配置。 */
export interface MemoryRuntimeConfig {
  channels: Record<
    'desktop' | 'group',
    {
      contextPairs: number
      historyTokenBudget: number
      enableAutoRag: boolean
      retrievalLimit: number
      /** 自动注入记忆的专属 Token 上限，0 表示不限 */
      memoryTokenBudget: number
    }
  >
  /** 基础检索（未开启 SA-PPR）的相关度门槛 */
  basic: {
    enableRelevanceGate: boolean
    minSimilarity: number
  }
  advanced: {
    enableSaPpr: boolean
    expandDepth: number
    teleportAlpha: number
    minScore: number
    enableFista: boolean
    enableDpp: boolean
    enableLeiden: boolean
  }
}

export const maintenanceApi = {
  /** 获取经过后端校验的主 Agent 记忆运行配置。 */
  getMemoryConfig: () => apiClient.get<MemoryRuntimeConfig>('/maintenance/memory-config'),

  /** 保存主 Agent 记忆运行配置。 */
  setMemoryConfig: (config: MemoryRuntimeConfig) =>
    apiClient.put<MemoryRuntimeConfig>('/maintenance/memory-config', config),

  /** 维护系统状态 */
  status: () => apiClient.get<MaintenanceStatus>('/maintenance/status'),

  /** 手动触发维护任务 */
  trigger: (task: string) => apiClient.post<{ taskName: string }>('/maintenance/trigger', { task }),

  /** 触发向量重索引 */
  reindex: (agentId?: string, scope: IndexScope | 'all' = 'main') =>
    apiClient.post<{ executionId: string; total: number }>('/maintenance/reindex', {
      agentId,
      scope,
    }),
  indexes: () => apiClient.get<IndexMaintenanceStatus>('/maintenance/indexes'),
}
