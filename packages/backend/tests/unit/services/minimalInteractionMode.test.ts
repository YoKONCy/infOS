import { describe, expect, it, vi } from 'vitest'
import { isToolAllowedInInteractionMode } from '../../../src/tools/interactionMode'

const registry = { isChatEnabled: vi.fn(() => true), isRuntimeScoped: vi.fn(() => false) } as never
describe('Thread 极简模式', () => {
  it('主会话开放连续交流、更新心流和完成任务，侧会话开放后两项', () => {
    for (const name of ['conversation', 'finish_task', 'update_flow_state'])
      expect(isToolAllowedInInteractionMode(name, 'minimal', registry, 'main')).toBe(true)
    for (const name of ['finish_task', 'update_flow_state'])
      expect(isToolAllowedInInteractionMode(name, 'minimal', registry, 'side')).toBe(true)
    expect(isToolAllowedInInteractionMode('conversation', 'minimal', registry, 'side')).toBe(false)
    for (const name of [
      'take_screenshot',
      'query_event_notes',
      'query_facts',
      'clear_work_context',
      'read_file',
      'write_file',
      'edit_file',
      'get_file_info',
      'list_directory',
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
    ]) {
      expect(isToolAllowedInInteractionMode(name, 'minimal', registry, 'main')).toBe(false)
      expect(isToolAllowedInInteractionMode(name, 'minimal', registry, 'side')).toBe(false)
    }
    expect(isToolAllowedInInteractionMode('terminal_execute', 'work', registry)).toBe(true)
  })
})
