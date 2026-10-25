/** 与后端 CapabilityGate 约定：放行全部在线子应用工具。 */
export const APPLICATION_TOOL_WILDCARD = 'application:*'

interface SelectableTool {
  name: string
  source?: { kind: 'application' }
}

function isApplicationTool(tool: SelectableTool): boolean {
  return tool.source?.kind === 'application'
}

/** 角色当前通道配置下该工具是否启用。 */
export function isRoleToolEnabled(configured: readonly string[], tool: SelectableTool): boolean {
  return (
    configured.includes('*') ||
    configured.includes(tool.name) ||
    (isApplicationTool(tool) && configured.includes(APPLICATION_TOOL_WILDCARD))
  )
}

/**
 * 切换单个工具后的角色工具列表。
 * 展开 '*' 时子应用工具用通配符保留：离线子应用此刻不在可见列表里，逐个展开会把它们丢掉。
 */
export function toggleRoleTool(
  configured: readonly string[],
  visible: readonly SelectableTool[],
  tool: SelectableTool,
  enabled: boolean,
): string[] {
  let current = configured.includes('*')
    ? [
        ...visible.filter((item) => !isApplicationTool(item)).map((item) => item.name),
        APPLICATION_TOOL_WILDCARD,
      ]
    : [...configured]
  // 在通配符下关闭某个子应用工具时，改为逐个列出其余在线子应用工具。
  if (!enabled && isApplicationTool(tool) && current.includes(APPLICATION_TOOL_WILDCARD)) {
    current = [
      ...current.filter((name) => name !== APPLICATION_TOOL_WILDCARD),
      ...visible.filter(isApplicationTool).map((item) => item.name),
    ]
  }
  return enabled
    ? [...new Set([...current, tool.name])]
    : current.filter((name) => name !== tool.name)
}
