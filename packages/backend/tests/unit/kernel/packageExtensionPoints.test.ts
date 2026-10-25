import { describe, expect, it } from 'vitest'
import { PackageHookBus } from '@infos/backend/packages/packageHookBus'
import { PackageUiRegistry } from '@infos/backend/packages/packageUiRegistry'
import { packageRequestMessages } from '@infos/backend/packages/packageAgentFlow'
import { runReActLoop } from '@infos/backend/services/agent/reactLoop'

describe('插件扩展点与卸载边界', () => {
  it('Agent 主循环实际触发模型前后钩子，保留当前 Thread 与 Realm 隔离信息', async () => {
    const hooks = new PackageHookBus()
    const events: string[] = []
    for (const event of [
      'agent:beforeRun',
      'agent:beforeRequest',
      'agent:afterRequest',
      'agent:afterRun',
    ] as const) {
      hooks.register('fixture', event, async (input: any) => {
        events.push(event)
        expect(input.threadId).toBe('fixture-thread')
        if (event === 'agent:beforeRequest') input.messages[0].content = '修改后的请求'
        return input
      })
    }
    const received: string[] = []
    const llmService = {
      async *chatStream(_model: unknown, messages: any[]) {
        received.push(messages[0].content)
        yield { choices: [{ delta: { content: '完成' } }] }
      },
    }
    const run = runReActLoop({
      packageHooks: hooks,
      llmService: llmService as never,
      modelConfig: { provider: 'openai', modelId: 'fixture', apiKey: '' },
      messages: [{ role: 'user', content: '原请求' }],
      tools: [],
      toolExecutor: undefined,
      source: 'desktop',
      agentId: 'pero',
      sessionId: 'fixture-thread',
      threadContext: { realmId: 'fixture-realm' },
    })
    for await (const _event of run) {
      /* 消费完整运行时间线。 */
    }
    expect(received).toEqual(['修改后的请求'])
    expect(events).toEqual([
      'agent:beforeRun',
      'agent:beforeRequest',
      'agent:afterRequest',
      'agent:afterRun',
    ])
  })
  it('超预算的消息变更回退原请求', async () => {
    const hooks = new PackageHookBus()
    hooks.register('fixture', 'agent:beforeRequest', async (input: any) => {
      input.messages[0].content = '额外内容'
      return input
    })
    const messages = [{ role: 'user' as const, content: '原请求' }]
    expect(await packageRequestMessages(hooks, messages, {}, () => false)).toBe(messages)
  })
  it('实际工具事件与声明事件一致，停用后不再拦截', async () => {
    const hooks = new PackageHookBus()
    const remove = hooks.register('fixture', 'chat:beforeToolCall', async (input: any) => ({
      ...input,
      args: { ...input.args, value: 2 },
    }))
    expect(await hooks.emitHook('tool:beforeCall', { args: { value: 1 } })).toEqual({
      args: { value: 2 },
    })
    remove()
    expect(await hooks.emitHook('chat:beforeToolCall', { args: { value: 1 } })).toEqual({
      args: { value: 1 },
    })
  })
  it('钩子异常和超时不会破坏主请求，也不会修改传入对象', async () => {
    const hooks = new PackageHookBus(10)
    const input = { value: 1 }
    hooks.register('bad', 'agent:beforeRun', async (value: any) => {
      value.value = 9
      throw new Error('模拟失败')
    })
    hooks.register('timeout', 'agent:beforeRun', async () => new Promise(() => undefined))
    expect(await hooks.emitHook('agent:beforeRun', input)).toEqual({ value: 1 })
    expect(input).toEqual({ value: 1 })
    expect(hooks.failures).toHaveLength(2)
  })
  it('模型扩展不能修改系统约束、角色或工具调用协议', async () => {
    const hooks = new PackageHookBus()
    const messages = [
      { role: 'system' as const, content: '系统规则' },
      { role: 'user' as const, content: '用户内容' },
    ]
    let remove = hooks.register('fixture', 'agent:beforeRequest', async (input: any) => {
      input.messages[0].content = '替换规则'
      return input
    })
    expect(await packageRequestMessages(hooks, messages, {})).toBe(messages)
    remove()
    remove = hooks.register('fixture', 'agent:beforeRequest', async (input: any) => {
      input.messages[1].content += '补充'
      return input
    })
    expect((await packageRequestMessages(hooks, messages, {}))[1]?.content).toBe('用户内容补充')
    expect(messages[1]?.content).toBe('用户内容')
    remove()
  })
  it('UI 只接受命名插槽，停用后操作入口立即失效', async () => {
    const ui = new PackageUiRegistry()
    const remove = ui.register(
      {
        id: 'fixture/panel',
        packageId: 'fixture',
        slot: 'integrations',
        title: '测试面板',
        actions: [{ id: 'refresh', label: '刷新' }],
      },
      async () => '已刷新',
    )
    expect(ui.list('integrations')).toHaveLength(1)
    await expect(ui.invoke('fixture/panel', 'other')).rejects.toThrow('ACTION_UNAVAILABLE')
    expect(await ui.invoke('fixture/panel', 'refresh')).toBe('已刷新')
    remove()
    expect(ui.list('integrations')).toEqual([])
    await expect(ui.invoke('fixture/panel', 'refresh')).rejects.toThrow('ACTION_UNAVAILABLE')
  })
})
