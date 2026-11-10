export type ProactiveMode = 'off' | 'companion' | 'autonomous'

export interface AgentProactiveSettings {
  /** 缺省时实时继承全局模式。 */
  mode?: ProactiveMode
  /** 缺省时实时继承全局据点设置。 */
  strongholdActivity?: boolean
}

export interface NextAgentActivity {
  kind: 'rest' | 'wait_message' | 'wait_task'
  senderId?: string
  taskId?: string
}

/** 全局默认策略与角色覆盖，执行时解析角色的有效设置。 */
export interface ProactiveSettings {
  mode: ProactiveMode
  strongholdActivity?: boolean
  agents?: Record<string, AgentProactiveSettings>
  companionIntervalMinutes: number
  autonomousIntervalMinutes: number
  goal: string
  maxDailyRuns: number
  timeZone: string
}

export function resolveProactiveSettings(settings: ProactiveSettings, agentId: string) {
  const override = settings.agents && Object.hasOwn(settings.agents, agentId) ? settings.agents[agentId] : undefined
  return {
    mode: override?.mode ?? settings.mode,
    strongholdActivity: override?.strongholdActivity ?? settings.strongholdActivity ?? false,
  }
}

export interface ProactiveState {
  settings: ProactiveSettings
  activities?: Record<string, NextAgentActivity['kind']>
  /** 仅表示当前正在执行的角色，不是模式绑定。 */
  agentId: string | null
  phase: 'off' | 'waiting' | 'running' | 'error'
  nextRunAt: number | null
  lastRunAt: number | null
  lastActivityAt: number
  lastOutcome: string
  lastError: string | null
  dailyRuns: number
  recent: Array<{
    at: number
    mode: ProactiveMode
    agentId?: string
    outcome: string
    error?: string
  }>
}
