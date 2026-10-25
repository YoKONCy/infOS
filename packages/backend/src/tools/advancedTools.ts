import { t as __t } from '../lib/i18n'
/**
 * 高级工具抽屉。
 *
 * 工具按包维护，主动展开后可随工作上下文续接；展开不会授予权限，
 * CapabilityGate、审批、节点 Trust 和 ToolExecutor 校验仍然完整生效。
 */
export const EXPAND_ADVANCED_TOOLS = 'expand_advanced_tools'

/** 当前执行共享，NIT 子调用沿用；续接时从成功执行记录恢复，并按当前权限重算名单。 */
export interface AdvancedToolAccess {
  names: ReadonlySet<string>
  expanded: boolean
}

export const ADVANCED_TOOL_PACKAGES = {
  browser: [
    'browser_open_url',
    'browser_click',
    'browser_type',
    'browser_scroll',
    'browser_back',
    'browser_get_content',
    'browser_search',
    'browser_screenshot',
    'browser_page_image',
    'browser_wait',
    'browser_tabs',
    'browser_interact',
    'browser_query_dom',
    'browser_dialog',
    'browser_network',
    'browser_download',
    'browser_upload',
    'browser_storage',
    'browser_emulate',
    'browser_evaluate',
    'browser_status',
  ],
  computerUse: [
    'automation_execute',
    'get_mouse_position',
    'open_application',
    'get_active_windows',
    'activate_window',
  ],
  remoteTerminal: [
    'remote_terminal_nodes',
    'remote_terminal_create',
    'remote_terminal_list',
    'remote_terminal_get',
    'remote_terminal_read',
    'remote_terminal_wait',
    'remote_terminal_write',
    'remote_terminal_interrupt',
    'remote_terminal_kill',
    'remote_terminal_close',
  ],
} as const

export const ADVANCED_TOOL_NAMES = new Set<string>(Object.values(ADVANCED_TOOL_PACKAGES).flat())

export function isAdvancedTool(name: string): boolean {
  return ADVANCED_TOOL_NAMES.has(name)
}

/** 入口关闭或未获授权时，包内定义也不进入本次执行。 */
export function availableToolDefinitions<T extends { name: string }>(tools: T[]): T[] {
  return tools.some((tool) => tool.name === EXPAND_ADVANCED_TOOLS)
    ? tools
    : tools.filter((tool) => !isAdvancedTool(tool.name))
}

const PACKAGE_DESCRIPTIONS = {
  browser: {
    label: __t('server.tools', '浏览器操作'),
    description: __t(
      'server.tools',
      '打开网站或预览工作区 HTML/Three.js 页面、截图检查渲染效果、填写表单和管理网页；不抢占用户桌面输入',
    ),
  },
  computerUse: {
    label: __t('server.tools', '桌面操作'),
    description: __t('server.tools', '操作桌面软件的鼠标、键盘和界面控件'),
  },
  remoteTerminal: {
    label: __t('server.tools', '远程终端'),
    description: __t('server.tools', '在已连接且获授权的远程节点创建终端、运行命令和等待结果'),
  },
}

export function describeAdvancedToolPackages(names: ReadonlySet<string>) {
  return Object.entries(ADVANCED_TOOL_PACKAGES).flatMap(([id, tools]) => {
    const available = tools.filter((name) => names.has(name))
    return available.length
      ? [
          {
            id,
            ...PACKAGE_DESCRIPTIONS[id as keyof typeof PACKAGE_DESCRIPTIONS],
            count: available.length,
            tools: available,
          },
        ]
      : []
  })
}
