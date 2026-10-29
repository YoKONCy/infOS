import type { InteractionMode } from '@infos/shared'
import type { ToolRegistry } from '../services/agent/toolRegistry'
import { isAdvancedTool } from './advancedTools'
import { WORK_CONTROL_TOOLS } from './systemProtocolTools'

/** 极简模式仅开放截图、结束任务、私有心流和事件查询；主动行为开关不参与工具权限判断。 */
export const MINIMAL_TOOLS = new Set([
  'finish_task',
  'update_flow_state',
  'take_screenshot',
  'query_event_notes',
])

/** 聊天保留日常助理和文本处理能力；扩展通过注册元数据声明准入。 */
const CHAT_TOOLS = new Set([
  'manage_task',
  'ask_user',
  'run_script',
  'send_file',
  'update_state',
  'update_flow_state',
  'finish_task',
  'query_event_notes',
  'write_event_note',
  'revise_event_note',
  'query_facts',
  'write_fact',
  'supersede_fact',
  'search_knowledge',
  'web_search',
  'web_fetch',
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
  'schedule_follow_up',
  'suggest_next_step',
  'read_file',
  'read_image',
  'read_file_range',
  'get_file_info',
  'list_directory',
  'glob_files',
  'search_files',
  'code_search',
  'write_file',
  'edit_file',
])

export function isToolAllowedInInteractionMode(
  name: string,
  mode: InteractionMode,
  registry: ToolRegistry,
): boolean {
  if (name === 'document' || name === 'runtime_debug' || registry.isRuntimeScoped(name))
    return mode === 'work'
  if (mode === 'minimal') return MINIMAL_TOOLS.has(name)
  if (mode === 'chat' && (WORK_CONTROL_TOOLS.has(name) || isAdvancedTool(name))) return false
  return mode === 'work' || CHAT_TOOLS.has(name) || registry.isChatEnabled(name)
}
