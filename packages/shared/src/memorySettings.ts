/** 两个开关彼此独立，关闭时保留已有记忆和索引。 */
export const MEMORY_BACKGROUND_ENABLED_KEY = 'memory.background.enabled'
export const MEMORY_BACKGROUND_AGENT_PREFIX = 'memory.background.agent.'
export const EMBEDDING_ENABLED_KEY = 'embedding.enabled'

/** 角色开关未保存时默认开启，最终仍受后台记忆总开关控制。 */
export function memoryBackgroundAgentKey(agentId: string): string {
  return `${MEMORY_BACKGROUND_AGENT_PREFIX}${agentId}.enabled`
}

export function memoryBackgroundAgentId(key: string): string | null {
  return /^memory\.background\.agent\.([a-z0-9_-]+)\.enabled$/.exec(key)?.[1] ?? null
}

export function isMemoryBackgroundSwitchKey(key: string): boolean {
  return key === MEMORY_BACKGROUND_ENABLED_KEY || memoryBackgroundAgentId(key) !== null
}

/** 宿主向后台记忆任务提供的只读执行门控。 */
export interface MemoryBackgroundPolicy {
  readonly enabled: boolean
  readonly signal: AbortSignal
  readonly disabledAgentIds?: readonly string[]
  isAgentEnabled?(agentId: string): boolean
  agentSignal?(agentId: string): AbortSignal
}

export function isMemoryBackgroundEnabled(policy: MemoryBackgroundPolicy | undefined, agentId: string): boolean {
  return policy?.enabled !== false && policy?.isAgentEnabled?.(agentId) !== false
}
