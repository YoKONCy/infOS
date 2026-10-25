/** 与后端 CapabilityGate 约定：放行全部在线子应用工具。 */
export const APPLICATION_TOOL_WILDCARD = 'application:*'
export const MCP_TOOL_WILDCARD = 'mcp:*'
const DYNAMIC_TOOL_WILDCARDS = [APPLICATION_TOOL_WILDCARD, MCP_TOOL_WILDCARD] as const

interface SelectableTool {
  name: string
  source?: { kind: 'application' }
}

function matchesWildcard(
  tool: SelectableTool,
  wildcard: (typeof DYNAMIC_TOOL_WILDCARDS)[number],
): boolean {
  return wildcard === APPLICATION_TOOL_WILDCARD
    ? tool.source?.kind === 'application'
    : tool.name.startsWith('mcp_')
}

/** 角色当前通道配置下该工具是否启用。 */
export function isRoleToolEnabled(configured: readonly string[], tool: SelectableTool): boolean {
  return (
    configured.includes('*') ||
    configured.includes(tool.name) ||
    DYNAMIC_TOOL_WILDCARDS.some(
      (wildcard) => configured.includes(wildcard) && matchesWildcard(tool, wildcard),
    )
  )
}

/**
 * 切换单个工具后的角色工具列表。
 * 展开 '*' 时保留子应用和 MCP 通配符，避免编辑其他开关时丢失离线工具的授权。
 * 关闭某个动态工具会把覆盖它的通配符转成显式白名单，之后新上线的同类工具需另行授权。
 */
export function toggleRoleTool(
  configured: readonly string[],
  visible: readonly SelectableTool[],
  tool: SelectableTool,
  enabled: boolean,
): string[] {
  let current = configured.includes('*')
    ? [
        ...visible
          .filter(
            (item) => !DYNAMIC_TOOL_WILDCARDS.some((wildcard) => matchesWildcard(item, wildcard)),
          )
          .map((item) => item.name),
        ...DYNAMIC_TOOL_WILDCARDS,
      ]
    : [...configured]
  // 所有覆盖目标的动态通配符都需展开，否则界面关掉后后端仍可能放行。
  if (!enabled) {
    for (const wildcard of DYNAMIC_TOOL_WILDCARDS) {
      if (!current.includes(wildcard) || !matchesWildcard(tool, wildcard)) continue
      current = [
        ...current.filter((name) => name !== wildcard),
        ...visible.filter((item) => matchesWildcard(item, wildcard)).map((item) => item.name),
      ]
    }
  }
  const next = enabled ? [...current, tool.name] : current.filter((name) => name !== tool.name)
  return [...new Set(next)]
}
