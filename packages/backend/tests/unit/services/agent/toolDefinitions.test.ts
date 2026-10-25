import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '@infos/backend/services/agent/toolRegistry'

describe('工具说明的稳定性', () => {
  it('提供者修改副本，反复装配和跨会话装配不会累积说明或污染注册原件', async () => {
    const registry = new ToolRegistry()
    const definition = {
      name: 'example',
      description: '固定说明',
      parameters: { type: 'object', properties: {} },
    }
    registry.register(definition, vi.fn())
    registry.registerDefinitionProvider('example', async (copy, agentId) => {
      copy.description += `\n${agentId} 的能力`
      copy.parameters.properties = { code: { type: 'string' } }
      return copy
    })
    const first = await registry.resolveDefinitions([definition], 'pero', 'thread-a')
    const second = await registry.resolveDefinitions(first, 'pero', 'thread-a')
    expect(second).toEqual(first)
    const other = await registry.resolveDefinitions(first, 'nana', 'thread-b')
    expect(other[0]?.description).toBe('固定说明\nnana 的能力')
    expect(definition).toEqual({
      name: 'example',
      description: '固定说明',
      parameters: { type: 'object', properties: {} },
    })
  })
})
