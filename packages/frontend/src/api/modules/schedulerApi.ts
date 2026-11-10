/**
 * Scheduler API 模块
 *
 * 对齐后端 scheduler.router.ts 端点。
 */

import { apiClient } from '../client'
import type { ProactiveSettings, ProactiveState } from '@infos/shared'
import type { BackgroundTaskInfo } from './backgroundTasksApi'

/** 任务执行统计 */
export interface TaskStats {
  totalRuns: number
  successCount: number
  errorCount: number
  lastError?: string
  lastDurationMs?: number
  averageDurationMs: number
}

/** 任务状态 */
export interface SchedulerTask {
  name: string
  displayName: string
  description: string
  intervalMs: number
  intervalDesc: string
  running: boolean
  lastStartedAt: number | null
  lastFinishedAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastOutcome: 'success' | 'error' | null
  nextDueAt: number
  stats: TaskStats
}

/** 调度器全局状态 */
export interface SchedulerStatus {
  schedulerRunning: boolean
  serverNow: number
  taskCount: number
  activeTasks: number
}

/** 任务列表响应 */
export interface TaskListData {
  schedulerRunning: boolean
  serverNow: number
  items: SchedulerTask[]
  total: number
}

/** 用户提醒项 (由 Agent 通过 set_reminder 工具创建) */
export interface ReminderItem {
  id: number
  type: 'reminder' | 'topic' | 'reaction' | 'agent_task' | 'follow_up'
  time: string
  content: string
  isTriggered: boolean
  agentId: string
  createdAt: string | null
  status: 'pending' | 'dispatching' | 'dispatched' | 'completed' | 'failed' | 'cancelled' | 'paused'
  threadId: string | null
  reason: string | null
  lastError: string | null
  attempts: number
  taskId: string | null
  repeatIntervalMinutes?: number | null
}

export interface ProactiveSuggestion {
  id: string
  agentId: string
  threadId: string
  title: string
  instruction: string
  reason: string
  status: 'open' | 'accepting' | 'accepted' | 'dismissed'
  sourceExecutionId: string | null
  taskId: string | null
  createdAt: string
}

export interface CompanionActivity {
  agentId: string
  tasks: BackgroundTaskInfo[]
  recent: BackgroundTaskInfo[]
  scheduled: ReminderItem[]
  suggestions: ProactiveSuggestion[]
}

/** 提醒列表响应 */
export interface ReminderListData {
  items: ReminderItem[]
  total: number
}

export const schedulerApi = {
  proactive: () => apiClient.get<ProactiveState>('/scheduler/proactive'),
  configureProactive: (settings: Partial<ProactiveSettings>) =>
    apiClient.put<ProactiveState>('/scheduler/proactive', settings),
  configureAgentProactive: (agentId: string, settings: { mode?: ProactiveSettings['mode'] | null; strongholdActivity?: boolean | null }) =>
    apiClient.put<ProactiveState>(`/scheduler/proactive/agents/${encodeURIComponent(agentId)}`, settings),
  checkProactive: () => apiClient.post<ProactiveState>('/scheduler/proactive/check'),
  activity: (agentId: string) =>
    apiClient.get<CompanionActivity>(`/scheduler/activity?agentId=${encodeURIComponent(agentId)}`),
  cancelReminder: (id: number, agentId: string) =>
    apiClient.post(`/scheduler/reminders/${id}/cancel`, { agentId }),
  retryReminder: (id: number, agentId: string) =>
    apiClient.post(`/scheduler/reminders/${id}/retry`, { agentId }),
  pauseReminder: (id: number, agentId: string, paused: boolean) =>
    apiClient.post(`/scheduler/reminders/${id}/${paused ? 'pause' : 'resume'}`, { agentId }),
  resolveSuggestion: (id: string, agentId: string, action: 'accept' | 'dismiss') =>
    apiClient.post<ProactiveSuggestion>(
      `/scheduler/suggestions/${encodeURIComponent(id)}/${action}`,
      { agentId },
    ),
  /** 调度器全局状态 */
  status: () => apiClient.get<SchedulerStatus>('/scheduler/status'),

  /** 获取全部定时任务列表 (系统级 cron) */
  tasks: () => apiClient.get<TaskListData>('/scheduler/tasks'),

  /** 获取待触发的用户提醒列表 */
  reminders: (agentId?: string) =>
    apiClient.get<ReminderListData>(
      '/scheduler/reminders' + (agentId ? `?agentId=${agentId}` : ''),
    ),

  createAgentTask: (data: {
    agentId: string
    time: string
    instruction: string
    threadId?: string
    repeatIntervalMinutes?: number
  }) => apiClient.post<ReminderItem>('/scheduler/agent-tasks', data),

  /** 手动触发任务 */
  trigger: (name: string) => apiClient.post<{ taskName: string }>('/scheduler/trigger/' + name),
}
