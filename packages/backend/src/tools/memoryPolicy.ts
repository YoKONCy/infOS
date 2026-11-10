/** 共享事实的全部 Agent 修改入口统一执行主会话身份校验。 */
export const FACT_MUTATION_TOOLS = new Set([
  'write_fact', 'supersede_fact', 'delete_fact', 'add_fact_object_alias', 'remove_fact_object_alias',
])

export function isMemoryToolAllowed(name: string, threadKind: 'main' | 'side' | undefined): boolean {
  if (name === 'write_event_note' || name === 'revise_event_note') return false
  return !FACT_MUTATION_TOOLS.has(name) || threadKind === 'main'
}
