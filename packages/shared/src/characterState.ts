/** 角色自行维护的表达状态，与任务执行状态分开。 */
export interface CharacterState {
  mood: string
  vibe: string
  mind: string
  ongoingGoals: string
  commitments: string
  relationships: string
}

export const DEFAULT_CHARACTER_STATE: Readonly<CharacterState> = {
  mood: '开心',
  vibe: '活泼',
  mind: '正在发呆...',
  ongoingGoals: '',
  commitments: '',
  relationships: '',
}

/** 空白表示保留已有状态，工具更新与持久化入口共用同一规则。 */
export function normalizeCharacterState(update: Partial<CharacterState>): Partial<CharacterState> {
  const result: Partial<CharacterState> = {}
  for (const key of ['mood', 'vibe', 'mind'] as const) {
    const value = update[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') throw new Error('角色心情、外在表现和心声必须是文本')
    const text = value.trim()
    if (text) result[key] = text
  }
  for (const key of ['ongoingGoals', 'commitments', 'relationships'] as const) {
    const value = update[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length > 8000) throw new Error('CHARACTER_STATE_INVALID')
    result[key] = value.trim()
  }
  return result
}
