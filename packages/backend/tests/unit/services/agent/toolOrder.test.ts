import { afterEach, describe, expect, it } from 'vitest'
import { compareToolNames, setDynamicToolPredicate } from '../../../../src/services/agent/toolOrder'
import { canonicalTools } from '../../../../src/services/llm/promptCache'

const definition = (name: string) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: {} },
})

describe('toolOrder', () => {
  let release: (() => void) | undefined
  afterEach(() => release?.())

  it('未注入动态工具判定时保持按函数名排序', () => {
    expect(['web_search', 'arca_collaborate', 'read_file'].sort(compareToolNames)).toEqual([
      'arca_collaborate',
      'read_file',
      'web_search',
    ])
  })

  it('动态工具排在常驻工具之后，上下线不改变常驻工具前缀', () => {
    const online = new Set(['pictoria', 'arca_collaborate'])
    release = setDynamicToolPredicate((name) => online.has(name))
    const names = (tools: string[]) =>
      canonicalTools(tools.map(definition))!.map((tool) => tool.function.name)

    const withApps = names(['web_search', 'pictoria', 'read_file', 'arca_collaborate'])
    expect(withApps).toEqual(['read_file', 'web_search', 'arca_collaborate', 'pictoria'])

    online.delete('arca_collaborate')
    const afterOffline = names(['web_search', 'pictoria', 'read_file'])
    expect(afterOffline).toEqual(['read_file', 'web_search', 'pictoria'])
    expect(afterOffline.slice(0, 2)).toEqual(withApps.slice(0, 2))
  })

  it('释放后恢复默认排序', () => {
    setDynamicToolPredicate(() => true)()
    expect(['b', 'a'].sort(compareToolNames)).toEqual(['a', 'b'])
  })
})
