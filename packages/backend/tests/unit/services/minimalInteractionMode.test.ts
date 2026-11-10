import { describe, expect, it, vi } from 'vitest'
import { isToolAllowedInInteractionMode } from '../../../src/tools/interactionMode'

const registry = { isChatEnabled: vi.fn(() => true), isRuntimeScoped: vi.fn(() => false) } as never
describe('Thread 极简模式', () => {
  it('开放基础交流、记忆查询和受限记事本入口，其他能力按模式关闭', () => {
    for (const name of ['conversation', 'finish_task', 'update_flow_state', 'take_screenshot', 'query_event_notes',
      'query_facts', 'clear_work_context', 'read_file', 'write_file', 'edit_file', 'get_file_info', 'list_directory'])
      expect(isToolAllowedInInteractionMode(name, 'minimal', registry)).toBe(true)
    for (const name of [
      'set_reminder',
      'list_reminders',
      'cancel_reminder',
      'schedule_follow_up',
      'suggest_next_step',
      'write_event_note',
      'revise_event_note',
      'search_knowledge',
      'write_fact',
      'supersede_fact',
      'delete_fact',
      'add_fact_object_alias',
      'remove_fact_object_alias',
      'manage_task',
      'ask_user',
      'update_state',
      'update_plan',
      'load_skill',
      'run_script',
      'expand_advanced_tools',
      'terminal_execute',
      'custom_tool',
    ])
      expect(isToolAllowedInInteractionMode(name, 'minimal', registry)).toBe(false)
    expect(isToolAllowedInInteractionMode('terminal_execute', 'work', registry)).toBe(true)
  })
})
