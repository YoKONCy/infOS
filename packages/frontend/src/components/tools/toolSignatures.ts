/**
 * toolSignatures — 工具轨迹视觉签名与双调图标语义映射
 *
 * 集中管理工具原型分类、摘要提取字段与 v6 双调微刻图标/语义色绑定。
 * 调用方依赖这里的稳定契约，不直接耦合底层传输或运行时实现。
 */
import type { TrajectoryIconName } from './TrajectoryIcon.vue'

export type ToolArchetype =
  | 'file-paper'
  | 'edit-splice'
  | 'search-radar'
  | 'terminal-tape'
  | 'browser-space'
  | 'vision-frame'
  | 'desktop-motion'
  | 'time-ticket'
  | 'state-ribbon'
  | 'stronghold-scene'
  | 'system-module'
  | 'web-sheet'
  | 'script-circuit'
  | 'social-signal'
  | 'generic'

export interface ToolVisualSignature {
  archetype: ToolArchetype
  variant: string
  chain: string
  motion: string
  silhouette: string
  summaryFields: string[]
  collapseDelayMs: number
}

export interface TrajectoryVisualToken {
  icon: TrajectoryIconName
  color: string
}

const terminalTools = [
  'terminal_execute',
  'terminal_create',
  'terminal_list',
  'terminal_get',
  'terminal_read',
  'terminal_wait',
  'terminal_write',
  'terminal_resize',
  'terminal_interrupt',
  'terminal_kill',
  'terminal_close',
]
const browserTools = [
  'browser_open_url',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_back',
  'browser_get_content',
  'browser_search',
  'browser_wait',
  'browser_tabs',
  'browser_interact',
  'browser_query_dom',
  'browser_dialog',
  'browser_network',
  'browser_upload',
  'browser_download',
  'browser_storage',
  'browser_emulate',
  'browser_evaluate',
  'browser_status',
]
const socialTools = [
  'social_send_message',
  'social_get_contacts',
  'social_get_groups',
  'social_get_contact_info',
  'social_get_group_info',
  'social_get_group_members',
  'social_handle_request',
  'social_notify_owner',
]

const groups: Array<[ToolArchetype, string, string[]]> = [
  [
    'file-paper',
    'files',
    [
      'read_file',
      'read_file_range',
      'get_file_info',
      'list_directory',
      'glob_files',
      'home_files',
      'send_file',
    ],
  ],
  ['edit-splice', 'files', ['write_file', 'edit_file']],
  [
    'search-radar',
    'search',
    ['search_files', 'code_search', 'search_knowledge', 'query_facts'],
  ],
  ['terminal-tape', 'terminal', terminalTools],
  ['browser-space', 'browser', browserTools],
  [
    'vision-frame',
    'vision',
    ['read_image', 'take_screenshot', 'browser_screenshot', 'browser_page_image'],
  ],
  [
    'desktop-motion',
    'desktop',
    [
      'automation_execute',
      'get_mouse_position',
      'get_system_info',
      'open_application',
      'get_active_windows',
      'activate_window',
      'desktop_plan',
      'desktop_safety',
      'desktop_direct',
      'shell_layout',
      'shell_window',
      'shell_theme',
      'shell_card',
      'shell_fence',
    ],
  ],
  [
    'time-ticket',
    'time',
    ['set_reminder', 'schedule_follow_up', 'list_reminders', 'cancel_reminder'],
  ],
  ['state-ribbon', 'state', ['update_state', 'update_flow_state']],
  [
    'stronghold-scene',
    'stronghold',
    [
      'stronghold_move_to_room',
      'stronghold_list_rooms',
      'stronghold_get_room_info',
      'stronghold_set_environment',
      'stronghold_summon_agents',
      'stronghold_call_butler',
      'home_shelf',
      'home_map',
      'home_card',
      'home_declare',
    ],
  ],
  [
    'system-module',
    'system',
    [
      'finish_task',
      'load_skill',
      'skill_list_resources',
      'skill_read_resource',
      'interact_with_social',
      'communicate_with_host',
    ],
  ],
  ['web-sheet', 'web', ['web_fetch']],
  ['script-circuit', 'script', ['run_script']],
  ['social-signal', 'social', socialTools],
]

const signatureMap = new Map<string, ToolVisualSignature>()
for (const [archetype, chain, names] of groups) {
  names.forEach((name, index) => {
    signatureMap.set(name, {
      archetype,
      variant: name.replaceAll('_', '-'),
      chain,
      motion: `${archetype}-${index % 6}`,
      silhouette: `${archetype}-${index % 5}`,
      summaryFields: summaryFields(name),
      collapseDelayMs: 600,
    })
  })
}

function summaryFields(name: string): string[] {
  if (name === 'update_state' || name === 'update_flow_state')
    return ['mood', 'vibe', 'mind', 'current_goal', 'summary']
  if (name === 'home_shelf' || name === 'send_file')
    return ['title', 'name', 'file_path', 'path', 'action', 'note']
  if (name.includes('file') || name.includes('directory')) return ['path', 'file_path', 'dir_path']
  if (name.startsWith('browser_')) return ['url', 'target', 'selector', 'text', 'query']
  if (name.startsWith('terminal_')) return ['command', 'terminal_id', 'title']
  if (name.startsWith('stronghold_') || name.startsWith('home_'))
    return ['room_name', 'place', 'title', 'action', 'agent_ids', 'key', 'request', 'path']
  if (name.includes('reminder') || name === 'schedule_follow_up')
    return ['content', 'message', 'topic', 'reason', 'time', 'delay_minutes', 'reminder_id']
  if (name.startsWith('social_')) return ['content', 'user_id', 'group_id', 'request_id']
  if (name === 'run_script') return ['summary', 'description', 'code', 'script']
  return ['query', 'summary', 'action', 'skill_id', 'url']
}

export function resolveToolSignature(
  name: string,
  override?: Partial<ToolVisualSignature>,
): ToolVisualSignature {
  const base = signatureMap.get(name) ?? {
    archetype: 'generic' as const,
    variant: `generic-${name.replaceAll('_', '-')}`,
    chain: `generic:${name}`,
    motion: 'generic-pulse',
    silhouette: 'generic-node',
    summaryFields: ['path', 'query', 'url', 'command', 'action'],
    collapseDelayMs: 600,
  }
  return { ...base, ...override }
}

/**
 * 解析轨迹节点与折叠叠章的双调微刻图标及主题语义色
 */
export function resolveTrajectoryVisual(
  name: string,
  options?: { hasChildren?: boolean; archetype?: ToolArchetype },
): TrajectoryVisualToken {
  const archetype = options?.archetype ?? resolveToolSignature(name).archetype

  if (name === 'run_script' || archetype === 'script-circuit') {
    return options?.hasChildren
      ? { icon: 'nit', color: 'var(--ui-accent-purple)' }
      : { icon: 'compute', color: 'var(--ui-accent-purple)' }
  }
  if (name === 'home_shelf' || name === 'send_file') {
    return { icon: 'shelf', color: 'var(--ui-accent-sky)' }
  }
  if (
    [
      'get_active_windows',
      'activate_window',
      'open_application',
      'get_system_info',
      'shell_layout',
      'shell_window',
      'shell_theme',
      'shell_card',
      'shell_fence',
    ].includes(name)
  ) {
    return { icon: 'windows', color: 'var(--ui-accent-sky)' }
  }
  if (name === 'browser_click' || name === 'browser_interact') {
    return { icon: 'cursor', color: 'var(--ui-accent-sky)' }
  }

  switch (archetype) {
    case 'edit-splice':
      return { icon: 'patch', color: 'var(--ui-accent-sky)' }
    case 'file-paper':
      return name === 'glob_files'
        ? { icon: 'radar', color: 'var(--ui-accent-purple)' }
        : { icon: 'files', color: 'var(--ui-accent-sky)' }
    case 'search-radar':
      return { icon: 'radar', color: 'var(--ui-accent-purple)' }
    case 'terminal-tape':
      return { icon: 'console', color: 'var(--ui-success)' }
    case 'time-ticket':
      return { icon: 'alarm', color: 'var(--ui-warning)' }
    case 'state-ribbon':
      return { icon: 'gem-heart', color: 'var(--ui-accent-primary)' }
    case 'stronghold-scene':
      return { icon: 'stronghold', color: 'var(--ui-accent-purple)' }
    case 'vision-frame':
      return { icon: 'aperture', color: 'var(--ui-accent-sky)' }
    case 'desktop-motion':
      return { icon: 'cursor', color: 'var(--ui-success)' }
    case 'browser-space':
    case 'web-sheet':
      return { icon: 'globe', color: 'var(--ui-accent-sky)' }
    case 'social-signal':
      return { icon: 'social', color: 'var(--ui-success)' }
    case 'system-module':
      if (name.includes('skill')) return { icon: 'skill', color: 'var(--ui-accent-purple)' }
      if (name === 'finish_task') return { icon: 'pass', color: 'var(--ui-success)' }
      if (name.includes('social') || name.includes('communicate'))
        return { icon: 'social', color: 'var(--ui-accent-sky)' }
      return { icon: 'module', color: 'var(--ui-accent-purple)' }
    default:
      return { icon: 'module', color: 'var(--ui-accent-purple)' }
  }
}

export function officialToolSignatures(): ReadonlyMap<string, ToolVisualSignature> {
  return signatureMap
}
