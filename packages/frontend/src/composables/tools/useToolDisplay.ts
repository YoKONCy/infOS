import { t as __t } from '../../i18n/index'
/**
 * useToolDisplay — 工具显示元数据注册表
 *
 * 职责：
 * 1. 启动后经 /api/agents/tools 拉取后端工具 display 元数据（label/icon/color/style）
 *    —— 官方工具在 manifest.json 声明；社区扩展工具同样声明后自动透传，零前端代码定制。
 * 2. API 未就绪或工具无 display 时，使用内置兜底表（style 级默认图标/配色），保证轨迹区始终可渲染。
 *
 * 元数据来源优先级：后端 API display > 内置兜底表 > generic 兜底。
 *
 * @module packages/frontend/src/composables/tools/useToolDisplay
 */

import { agentApi } from '../../api/modules/agentApi'
import type { AgentToolDisplay } from '../../api/modules/agentApi'
import { logger } from '../../lib/logger'

/**
 * 工具主题色语义名 → UI 令牌（后端 display.color 使用语义名，前端在此映射）
 *
 * 每个语义色提供 solid（主色）+ soft（软底）两个令牌，
 * 均走 ui-tokens，浅色/深色主题自动切换。
 */
export const TOOL_COLOR_CSS: Record<string, { solid: string; soft: string }> = {
  pink: { solid: 'var(--ui-accent-primary)', soft: 'var(--ui-accent-primary-soft)' },
  purple: { solid: 'var(--ui-accent-purple)', soft: 'var(--ui-accent-purple-soft)' },
  sky: { solid: 'var(--ui-accent-sky)', soft: 'var(--ui-accent-sky-soft)' },
  green: { solid: 'var(--ui-success)', soft: 'var(--ui-success-soft)' },
  orange: { solid: 'var(--ui-warning)', soft: 'var(--ui-warning-soft)' },
  // 兼容别名
  yellow: { solid: 'var(--ui-warning)', soft: 'var(--ui-warning-soft)' },
}

/** 兜底色（pink） */
const FALLBACK_COLOR = TOOL_COLOR_CSS.pink!

/** 每个轨迹样式的默认图标与配色（兜底表） */
const STYLE_FALLBACK: Record<string, { icon: string; color: string }> = {
  edit: { icon: 'edit', color: 'pink' },
  read: { icon: 'file', color: 'sky' },
  search: { icon: 'search', color: 'purple' },
  terminal: { icon: 'terminal', color: 'green' },
  web: { icon: 'globe', color: 'sky' },
  browser: { icon: 'globe', color: 'sky' },
  script: { icon: 'code', color: 'purple' },
  screen: { icon: 'image', color: 'pink' },
  reminder: { icon: 'clock', color: 'orange' },
  task: { icon: 'check', color: 'green' },
  skill: { icon: 'puzzle', color: 'purple' },
  social: { icon: 'chat', color: 'green' },
  stronghold: { icon: 'door-open', color: 'purple' },
  system: { icon: 'cpu', color: 'purple' },
  desktop: { icon: 'activity', color: 'purple' },
  file: { icon: 'file', color: 'purple' },
  generic: { icon: 'tool', color: 'pink' },
}

/** 工具名 → 轨迹样式兜底映射（仅 API 不可用时生效） */
const FALLBACK_TOOL_STYLE: Record<string, string> = {
  edit_file: 'edit',
  write_file: 'edit',
  read_file: 'read',
  read_image: 'read',
  read_file_range: 'read',
  browser_get_content: 'read',
  code_search: 'search',
  glob_files: 'search',
  search_files: 'search',
  terminal_execute: 'terminal',
  terminal_create: 'terminal',
  terminal_list: 'terminal',
  terminal_get: 'terminal',
  terminal_read: 'terminal',
  terminal_wait: 'terminal',
  terminal_write: 'terminal',
  terminal_resize: 'terminal',
  terminal_interrupt: 'terminal',
  terminal_kill: 'terminal',
  terminal_close: 'terminal',
  web_fetch: 'web',
  browser_open_url: 'browser',
  browser_click: 'browser',
  browser_type: 'browser',
  browser_scroll: 'browser',
  browser_back: 'browser',
  browser_query_dom: 'browser',
  run_script: 'script',
  take_screenshot: 'screen',
  browser_screenshot: 'screen',
  browser_page_image: 'screen',
  set_reminder: 'reminder',
  schedule_follow_up: 'reminder',
  suggest_next_step: 'task',
  list_reminders: 'reminder',
  cancel_reminder: 'reminder',
  finish_task: 'task',
  load_skill: 'skill',
  social_notify_owner: 'social',
  stronghold_move_to_room: 'stronghold',
  stronghold_list_rooms: 'stronghold',
  stronghold_get_room_info: 'stronghold',
  stronghold_set_environment: 'stronghold',
  stronghold_call_butler: 'stronghold',
  get_system_info: 'system',
  open_application: 'system',
  get_active_windows: 'system',
  activate_window: 'system',
  automation_execute: 'desktop',
  get_mouse_position: 'desktop',
  get_file_info: 'file',
  list_directory: 'file',
}

/** 后端 API 提供的 display 元数据（name → display） */
const metaByTool = new Map<string, AgentToolDisplay>()

/** 已解析结果缓存（避免每个轨迹卡片重复 await） */
const resolvedCache = new Map<string, AgentToolDisplay>()

let loaded = false
let loadingPromise: Promise<void> | null = null

/** 拉取一次后端工具元数据（幂等） */
async function ensureLoaded(): Promise<void> {
  if (loaded) return
  if (!loadingPromise) {
    loadingPromise = (async () => {
      try {
        const tools = (await agentApi.listTools({ includeAdvanced: true })).data ?? []
        for (const tool of tools) {
          if (tool?.name && tool.display) metaByTool.set(tool.name, tool.display)
        }
      } catch (error) {
        // API 不可用：使用内置兜底表，不影响轨迹渲染
        logger.warn(
          'useToolDisplay',
          __t('logs.frontend.tools', '拉取工具显示元数据失败，使用内置兜底表'),
          error,
        )
      } finally {
        loaded = true
      }
    })()
  }
  return loadingPromise
}

/** 解析某个工具轨迹的显示元数据（API display 优先，兜底表其次） */
export async function resolveToolDisplay(name: string): Promise<AgentToolDisplay> {
  const cached = resolvedCache.get(name)
  if (cached) return cached

  await ensureLoaded()

  let meta: AgentToolDisplay
  const fromApi = metaByTool.get(name)
  if (fromApi) {
    meta = fromApi
  } else {
    const style = FALLBACK_TOOL_STYLE[name]
    const fallback = style ? STYLE_FALLBACK[style] : STYLE_FALLBACK.generic
    meta = fallback ? { icon: fallback.icon, color: fallback.color, style } : {}
  }
  resolvedCache.set(name, meta)
  return meta
}

const FALLBACK_TOOL_LABEL: Record<string, string> = {
  get conversation() {
    return __t('common.tools', '主线交流')
  },
  get home_declare() {
    return __t('common.tools', '声明行动范围')
  },
  get home_files() {
    return __t('common.tools', '家的文件通道')
  },
  get home_shelf() {
    return __t('common.tools', '置物架')
  },
  get home_map() {
    return __t('common.tools', '家的地图')
  },
  get home_card() {
    return __t('common.tools', '卡片互动')
  },
  get shell_layout() {
    return __t('common.tools', '查看 infOS 窗口布局')
  },
  get shell_window() {
    return __t('common.tools', '调整 infOS 窗口')
  },
  get shell_theme() {
    return __t('common.tools', '管理 infOS 主题')
  },
  get shell_card() {
    return __t('common.tools', '管理 infOS 桌面卡片')
  },
  get shell_fence() {
    return __t('common.tools', '整理桌面收纳框')
  },
  get desktop_plan() {
    return __t('common.tools', '申请任务预批')
  },
  get desktop_safety() {
    return __t('common.tools', '查看或调整桌面操作权限')
  },
  get desktop_direct() {
    return __t('common.tools', '剪贴板与媒体键')
  },
  get send_file() {
    return __t('ui.tools', '发送文件')
  },
  get update_plan() {
    return __t('ui.tools', '更新计划')
  },
  get edit_file() {
    return __t('ui.tools', '编辑文件')
  },
  get write_file() {
    return __t('ui.tools', '写入文件')
  },
  get read_file() {
    return __t('ui.tools', '读取文件')
  },
  get read_image() {
    return __t('ui.tools', '读取图片')
  },
  get read_file_range() {
    return __t('ui.tools', '范围读取')
  },
  get get_file_info() {
    return __t('ui.tools', '查看文件信息')
  },
  get list_directory() {
    return __t('ui.tools', '浏览目录')
  },
  get glob_files() {
    return __t('ui.tools', '查找文件')
  },
  code_search: '搜索代码',
  get search_files() {
    return __t('ui.tools', '搜索文件')
  },
  get terminal_execute() {
    return __t('ui.tools', '终端执行')
  },
  get terminal_create() {
    return __t('ui.tools', '创建终端')
  },
  get terminal_list() {
    return __t('ui.tools', '终端列表')
  },
  get terminal_get() {
    return __t('ui.tools', '查看终端')
  },
  get terminal_read() {
    return __t('ui.tools', '读取终端')
  },
  get terminal_wait() {
    return __t('ui.tools', '等待终端')
  },
  get terminal_write() {
    return __t('ui.tools', '输入终端')
  },
  get terminal_resize() {
    return __t('ui.tools', '调整终端')
  },
  get terminal_interrupt() {
    return __t('ui.tools', '中断终端')
  },
  get terminal_kill() {
    return __t('ui.tools', '终止终端')
  },
  get terminal_close() {
    return __t('ui.tools', '关闭终端')
  },
  get web_fetch() {
    return __t('ui.tools', '获取网页')
  },
  get browser_open_url() {
    return __t('ui.tools', '打开网页')
  },
  get browser_click() {
    return __t('ui.tools', '点击网页')
  },
  get browser_type() {
    return __t('ui.tools', '网页输入')
  },
  get browser_scroll() {
    return __t('ui.tools', '滚动网页')
  },
  get browser_back() {
    return __t('ui.tools', '网页后退')
  },
  browser_get_content: '读取网页内容',
  browser_query_dom: '检查网页结构',
  get assembling_tool() {
    return __t('ui.tools', '准备工具调用')
  },
  get run_script() {
    return __t('ui.tools', '运行脚本')
  },
  get take_screenshot() {
    return __t('ui.tools', '屏幕截图')
  },
  get browser_screenshot() {
    return __t('ui.tools', '浏览器截图')
  },
  get browser_page_image() {
    return __t('ui.tools', '读取网页图片')
  },
  get_system_info: '系统信息',
  get open_application() {
    return __t('ui.tools', '打开应用')
  },
  get get_active_windows() {
    return __t('ui.tools', '活动窗口')
  },
  get activate_window() {
    return __t('ui.tools', '切换窗口')
  },
  get automation_execute() {
    return __t('ui.tools', '桌面自动化')
  },
  get get_mouse_position() {
    return __t('ui.tools', '鼠标位置')
  },
  get set_reminder() {
    return __t('ui.tools', '创建提醒')
  },
  get schedule_follow_up() {
    return __t('ui.tools', '安排跟进')
  },
  get suggest_next_step() {
    return __t('ui.tools', '提出建议')
  },
  query_facts: '查询事实',
  get search_knowledge() {
    return __t('ui.tools', '检索知识')
  },
  get write_fact() {
    return __t('ui.tools', '记录事实')
  },
  get supersede_fact() {
    return __t('ui.tools', '更新事实')
  },
  get delete_fact() {
    return __t('ui.tools', '删除事实')
  },
  get add_fact_object_alias() {
    return __t('ui.tools', '添加别名')
  },
  get remove_fact_object_alias() {
    return __t('ui.tools', '移除别名')
  },
  get list_reminders() {
    return __t('ui.tools', '查看提醒')
  },
  get cancel_reminder() {
    return __t('ui.tools', '取消提醒')
  },
  get finish_task() {
    return __t('ui.tools', '完成任务')
  },
  get update_state() {
    return __t('ui.tools', '更新角色状态')
  },
  get load_skill() {
    return __t('ui.tools', '加载技能')
  },
  get skill_list_resources() {
    return __t('ui.tools', '查看技能资源')
  },
  get skill_read_resource() {
    return __t('ui.tools', '读取技能资源')
  },
  get social_notify_owner() {
    return __t('ui.tools', '通知主人')
  },
  get stronghold_move_to_room() {
    return __t('ui.tools', '移动到房间')
  },
  get stronghold_list_rooms() {
    return __t('ui.tools', '查看房间')
  },
  get stronghold_get_room_info() {
    return __t('ui.tools', '房间信息')
  },
  get stronghold_set_environment() {
    return __t('ui.tools', '设置环境')
  },
  get stronghold_summon_agents() {
    return __t('ui.tools', '传唤据点成员')
  },
  get stronghold_call_butler() {
    return __t('ui.tools', '呼叫管家')
  },
}

/** 工具名 → 显示名；任何情况下都不向用户暴露 snake_case 函数标识。 */
export function toolDisplayLabel(name: string, display?: AgentToolDisplay): string {
  if (display?.label) return __t('common.tools', display.label)
  if (FALLBACK_TOOL_LABEL[name]) return FALLBACK_TOOL_LABEL[name]
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** 工具名 → 图标（display.icon 优先，缺省回退 tool） */
export function toolDisplayIcon(display?: AgentToolDisplay): string {
  return display?.icon || 'tool'
}

/** 工具名 → 主题色（主色）CSS 变量 */
export function toolDisplayColor(display?: AgentToolDisplay): string {
  const semantic = display?.color || 'pink'
  return TOOL_COLOR_CSS[semantic]?.solid ?? FALLBACK_COLOR.solid
}

/** 工具名 → 主题色（软底）CSS 变量 */
export function toolDisplayColorSoft(display?: AgentToolDisplay): string {
  const semantic = display?.color || 'pink'
  return TOOL_COLOR_CSS[semantic]?.soft ?? FALLBACK_COLOR.soft
}
