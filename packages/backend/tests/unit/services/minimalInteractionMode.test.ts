import { describe, expect, it, vi } from 'vitest'
import { isToolAllowedInInteractionMode } from '../../../src/tools/interactionMode'

const registry = { isChatEnabled: vi.fn(() => true), isRuntimeScoped: vi.fn(() => false) } as never
describe('Thread 极简模式', () => {
  it('仅开放截图、完成任务、私有心流和事件查询，其他工具不能通过扩展元数据或 NIT 绕过', () => {
    for (const name of ['finish_task', 'update_flow_state', 'take_screenshot', 'query_event_notes'])
      expect(isToolAllowedInInteractionMode(name, 'minimal', registry)).toBe(true)
    for (const name of [
      'query_facts',
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
      'read_file',
      'edit_file',
      'custom_tool',
    ])
      expect(isToolAllowedInInteractionMode(name, 'minimal', registry)).toBe(false)
    expect(isToolAllowedInInteractionMode('terminal_execute', 'work', registry)).toBe(true)
  })
})
