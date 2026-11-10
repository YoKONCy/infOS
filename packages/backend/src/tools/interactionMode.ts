import type { InteractionMode } from '@infos/shared'
import type { ToolRegistry } from '../services/agent/toolRegistry'
import { isAdvancedTool } from './advancedTools'
import { WORK_CONTROL_TOOLS } from './systemProtocolTools'
import { isMemoryToolAllowed } from './memoryPolicy'

/** 极简模式保留心流与执行结束，主会话另有连续交流协议。 */
export const MINIMAL_TOOLS = new Set([
  'conversation',
  'finish_task',
  'update_flow_state',
])

/** 聊天保留日常助理和文本处理能力；扩展通过注册元数据声明准入。 */
const CHAT_TOOLS = new Set([
  'conversation',
  'manage_task',
  'ask_user',
  'run_script',
  'send_file',
  'update_state',
  'update_flow_state',
  'finish_task',
  'query_event_notes',
  'clear_work_context',
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
  'skill_list_resources',
  'skill_read_resource',
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
  threadKind?: 'main' | 'side',
): boolean {
  if (!isMemoryToolAllowed(name, 'main')) return false
  if (name === 'document' || name === 'runtime_debug' || registry.isRuntimeScoped(name))
    return mode === 'work'
  // 无会话身份时计算模式上限，具体会话依据真实主侧类型继续收窄。
  if (mode === 'minimal')
    return MINIMAL_TOOLS.has(name) && (name !== 'conversation' || threadKind !== 'side')
  if (mode === 'chat' && (WORK_CONTROL_TOOLS.has(name) || isAdvancedTool(name))) return false
  return mode === 'work' || CHAT_TOOLS.has(name) || registry.isChatEnabled(name)
}
