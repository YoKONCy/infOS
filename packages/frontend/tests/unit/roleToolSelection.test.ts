import { describe, expect, it } from 'vitest'
import {
  APPLICATION_TOOL_WILDCARD,
  MCP_TOOL_WILDCARD,
  isRoleToolEnabled,
  toggleRoleTool,
} from '../../src/lib/roleToolSelection'

const app = (name: string) => ({ name, source: { kind: 'application' as const } })
const builtin = (name: string) => ({ name })

describe('roleToolSelection', () => {
  it('从 * 展开时保留子应用和 MCP 的离线授权', () => {
    // 动态工具都未启动，可见列表里只有内置工具。
    const next = toggleRoleTool(
      ['*'],
      [builtin('read_file'), builtin('web_search')],
      builtin('web_search'),
      false,
    )
    expect(next).toEqual(['read_file', APPLICATION_TOOL_WILDCARD, MCP_TOOL_WILDCARD])
    // 之后 Arca 上线，其工具仍视为启用。
    expect(isRoleToolEnabled(next, app('arca_collaborate'))).toBe(true)
    expect(isRoleToolEnabled(next, builtin('mcp_later_echo'))).toBe(true)
    expect(isRoleToolEnabled(next, builtin('web_search'))).toBe(false)
  })

  it('MCP 通配符正确显示启用，关闭单个工具时移除覆盖它的通配符', () => {
    const target = builtin('mcp_demo_write')
    const configured = ['read_file', MCP_TOOL_WILDCARD, APPLICATION_TOOL_WILDCARD]
    expect(isRoleToolEnabled(configured, target)).toBe(true)
    const next = toggleRoleTool(
      configured,
      [builtin('read_file'), target, builtin('mcp_demo_read'), app('arca_collaborate')],
      target,
      false,
    )
    expect(next).toEqual(['read_file', APPLICATION_TOOL_WILDCARD, 'mcp_demo_read'])
    expect(isRoleToolEnabled(next, target)).toBe(false)
  })

  it('通配符下关闭某个子应用工具时，逐个保留其余在线子应用工具', () => {
    const visible = [builtin('read_file'), app('arca_collaborate'), app('pictoria')]
    const next = toggleRoleTool(
      ['read_file', APPLICATION_TOOL_WILDCARD],
      visible,
      app('pictoria'),
      false,
    )
    expect(next).toEqual(['read_file', 'arca_collaborate'])
    expect(isRoleToolEnabled(next, app('pictoria'))).toBe(false)
  })

  it('显式列表下按名称增删，行为与原来一致', () => {
    expect(toggleRoleTool(['read_file'], [], builtin('web_search'), true)).toEqual([
      'read_file',
      'web_search',
    ])
    expect(toggleRoleTool(['read_file', 'pictoria'], [], app('pictoria'), false)).toEqual([
      'read_file',
    ])
  })
})
