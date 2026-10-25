import { describe, expect, it } from 'vitest'
import {
  APPLICATION_TOOL_WILDCARD,
  isRoleToolEnabled,
  toggleRoleTool,
} from '../../src/lib/roleToolSelection'

const app = (name: string) => ({ name, source: { kind: 'application' as const } })
const builtin = (name: string) => ({ name })

describe('roleToolSelection', () => {
  it('从 * 展开时子应用工具以通配符保留，离线子应用不会被丢掉', () => {
    // 子应用都未启动，可见列表里没有子应用工具。
    const next = toggleRoleTool(
      ['*'],
      [builtin('read_file'), builtin('web_search')],
      builtin('web_search'),
      false,
    )
    expect(next).toEqual(['read_file', APPLICATION_TOOL_WILDCARD])
    // 之后 Arca 上线，其工具仍视为启用。
    expect(isRoleToolEnabled(next, app('arca_collaborate'))).toBe(true)
    expect(isRoleToolEnabled(next, builtin('web_search'))).toBe(false)
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
