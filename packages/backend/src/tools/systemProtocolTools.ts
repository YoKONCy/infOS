import { ADVANCED_TOOL_NAMES, isAdvancedTool } from './advancedTools'

/** Agent执行协议的固定工具；逐项开关不可关闭，仍受 Thread 模式与作用域限制。 */
export const SYSTEM_PROTOCOL_TOOLS = new Set([
  'finish_task',
  'run_script',
  'load_skill',
  'update_flow_state',
  'ask_user',
  'update_state',
  'skill_list_resources',
  'skill_read_resource',
  'interact_with_social',
])

/** 可由用户关闭、仅工作模式开放的协调工具，不属于系统必需项。 */
export const WORK_CONTROL_TOOLS = new Set(['expand_advanced_tools', 'update_plan'])

/** 协调动作不算实际业务成果，不能单独解锁任务完成或作为交付证据。 */
export function isTaskCoordinationTool(name: string): boolean {
  // NIT 编排实际业务工具，不因菜单归入系统协议就被当作纯状态协调动作。
  return (
    name === 'manage_task' ||
    (SYSTEM_PROTOCOL_TOOLS.has(name) && name !== 'run_script') ||
    WORK_CONTROL_TOOLS.has(name)
  )
}

/** 据点group通道除固定执行协议外，仅开放据点空间状态机工具。 */
export const STRONGHOLD_CHANNEL_TOOLS = new Set([
  'stronghold_move_to_room',
  'stronghold_list_rooms',
  'stronghold_get_room_info',
  'stronghold_set_environment',
  'stronghold_summon_agents',
  'stronghold_call_butler',
])

/** 判断工具是否属于据点通道的上游白名单。 */
export function isStrongholdChannelTool(name: string): boolean {
  return SYSTEM_PROTOCOL_TOOLS.has(name) || STRONGHOLD_CHANNEL_TOOLS.has(name)
}

/** 高级工具清单由统一工具包定义维护。 */
export { ADVANCED_TOOL_NAMES, isAdvancedTool }

export function isSystemProtocolTool(name: string): boolean {
  return SYSTEM_PROTOCOL_TOOLS.has(name)
}
