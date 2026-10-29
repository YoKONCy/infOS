import { describe, expect, it } from 'vitest'
import type { PromptFramework } from '@infos/shared'
import { ToolContextService } from '@infos/backend/services/context/toolContextService'
import { preparePromptReplay, promptFingerprint } from '@infos/backend/services/llm/promptCache'
import type { ChatMessage } from '@infos/backend/services/llm/types'
import {
  contexts,
  count,
  fixture,
  manager,
  marker,
  packageId,
  providerId,
  region,
  row,
  rows,
  send,
  setRegions,
  useDeliveryFixture,
} from '../../../helpers/packageContextDeliveryFixture'

useDeliveryFixture()

describe('Package context-provider 到模型请求的真实投递', () => {
  for (const layout of ['native', 'sillytavern', 'legacy'] as const) {
    for (const mode of ['chat', 'work', 'minimal'] as const) {
      it(`${layout}/${mode}：external user 资料只发送一次，位于完整历史与当前输入之间`, async () => {
        const { compiler } = await fixture(layout, mode)
        const result = await compiler.compile('fixture-thread', 'fixture', {
          disableMemoryRetrieval: true,
        })
        expect(
          result.manifest.regions.find((item) => item.providerId === providerId),
        ).toMatchObject({ selected: true, trust: 'external', required: false, priority: 50 })
        const received = await send(result.messages)
        expect(count(received, marker)).toBe(1)
        expect(count(result.messages, marker)).toBe(1)
        const index = result.messages.findIndex((message) =>
          String(message.content).includes(marker),
        )
        expect(result.messages[index]!.role).toBe('user')
        expect(index).toBeGreaterThan(
          result.messages.findIndex((message) => message.cacheControl?.historyMessageId === 2),
        )
        expect(index).toBeLessThan(result.currentMessageIndex!)
        expect(result.messages[result.currentMessageIndex!]?.content).toBe('本轮问题乙')
        for (const text of ['历史问题甲', '历史答复甲', '本轮问题乙'])
          expect(count(received, text)).toBe(1)
        expect(JSON.stringify(received)).not.toContain('user:本轮问题乙')
        if (layout === 'native') {
          expect(result.messages[index]!.content).toMatch(
            /<turn_context>[\s\S]*PACKAGE_CONTEXT_7C3F[\s\S]*<\/turn_context>/,
          )
        }
      })
    }
    it(`${layout}：插件内容变化不改变 system/旧历史的任何字节`, async () => {
      const { compiler } = await fixture(layout)
      const first = await compiler.compile('fixture-thread', 'fixture', {
        disableMemoryRetrieval: true,
      })
      const firstWire = await send(first.messages)
      await setRegions([{ content: `${marker}_CHANGED_LONGER` }])
      const second = await compiler.compile('fixture-thread', 'fixture', {
        disableMemoryRetrieval: true,
      })
      const secondWire = await send(second.messages)
      const prefixEnd =
        first.messages.findIndex((message) => message.cacheControl?.historyMessageId === 2) + 1
      expect(prefixEnd).toBeGreaterThan(1)
      expect(Buffer.from(JSON.stringify(second.messages.slice(0, prefixEnd)))).toEqual(
        Buffer.from(JSON.stringify(first.messages.slice(0, prefixEnd))),
      )
      // Provider 会合并相邻 system，线上前缀应按线上历史定位，不能复用 compiler 的数组下标。
      const wirePrefixEnd =
        firstWire.findIndex((message) => message.content.includes('历史答复甲')) + 1
      expect(wirePrefixEnd).toBeGreaterThan(1)
      expect(Buffer.from(JSON.stringify(secondWire.slice(0, wirePrefixEnd)))).toEqual(
        Buffer.from(JSON.stringify(firstWire.slice(0, wirePrefixEnd))),
      )
      expect(count(secondWire, `${marker}_CHANGED_LONGER`)).toBe(1)
    })
    it(`${layout}/work：插件变化后 preparePromptReplay 仍续接完整热轨迹`, async () => {
      const { compiler, setRows } = await fixture(layout, 'work')
      const first = await compiler.compile('fixture-thread', 'fixture', {
        disableMemoryRetrieval: true,
      })
      const start = preparePromptReplay(`package-${layout}`, first.messages, 'fake-model')
      const transcript: ChatMessage[] = [
        ...start.messages,
        {
          role: 'assistant',
          content: '旧工具轨迹',
          toolCalls: [
            { id: 'call-1', type: 'function', function: { name: 'fixture', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: '旧工具结果', toolCallId: 'call-1' },
        { role: 'assistant', content: '送达答复' },
      ]
      start.commit(transcript, '送达答复')
      setRows([...rows(), row(4, 'assistant', '送达答复'), row(5, 'user', '下一轮问题')])
      await setRegions([{ content: `${marker}_NEXT` }])
      const second = await compiler.compile('fixture-thread', 'fixture', {
        disableMemoryRetrieval: true,
      })
      const continued = preparePromptReplay(`package-${layout}`, second.messages, 'fake-model')
      expect(continued.reused).toBe(true)
      expect(continued.messages.slice(0, transcript.length)).toEqual(transcript)
      const received = await send(continued.messages)
      expect(count(received, `${marker}_NEXT`)).toBe(1)
      expect(count(received, '旧工具结果')).toBe(1)
    })
    it(`${layout}/work：旧历史展开为工具轨迹后，插件位置和当前输入索引仍正确`, async () => {
      const { compiler, setRows } = await fixture(layout, 'work')
      const history = rows()
      history[1]!.metadataJson = JSON.stringify({
        workContext: {
          version: 1,
          threadId: 'fixture-thread',
          agentId: 'fixture',
          channel: 'desktop',
          pairId: 'pair-1',
          inputHash: promptFingerprint('历史问题甲'),
          replyHash: promptFingerprint('历史答复甲'),
          historyRevisions: [[1, 1]],
          messages: [
            {
              role: 'assistant',
              content: '先读取',
              toolCalls: [
                {
                  id: 'history-call',
                  type: 'function',
                  function: { name: 'fixture', arguments: '{}' },
                },
              ],
            },
            { role: 'tool', content: '展开后的历史工具正文', toolCallId: 'history-call' },
            { role: 'assistant', content: '历史答复甲' },
          ],
        },
      })
      setRows(history)
      const result = await compiler.compile('fixture-thread', 'fixture', {
        disableMemoryRetrieval: true,
      })
      const pluginIndex = result.messages.findIndex((message) =>
        String(message.content).includes(marker),
      )
      const lastHistory = result.messages.reduce(
        (last, message, index) => (message.cacheControl?.kind === 'history' ? index : last),
        -1,
      )
      expect(
        result.messages.some(
          (message) => message.role === 'tool' && message.content === '展开后的历史工具正文',
        ),
      ).toBe(true)
      expect(pluginIndex).toBeGreaterThan(lastHistory)
      expect(pluginIndex).toBeLessThan(result.currentMessageIndex!)
      expect(result.messages[result.currentMessageIndex!]?.content).toBe('本轮问题乙')
      const received = await send(result.messages)
      expect(count(received, marker)).toBe(1)
      expect(count(received, '展开后的历史工具正文')).toBe(1)
    })
  }

  it('空、过期、重复和超预算插件保留选择约束，停用后不再发送', async () => {
    const { compiler } = await fixture('native')
    await setRegions([
      { content: marker, priority: 20 },
      { content: marker },
      { content: 'EXPIRED_PACKAGE', validUntil: '2000-01-01T00:00:00Z' },
      { content: '  ' },
      { content: 'OVER_BUDGET_PACKAGE '.repeat(1500), priority: -1 },
    ])
    const result = await compiler.compile('fixture-thread', 'fixture', {
      disableMemoryRetrieval: true,
      maxInputTokens: 4000,
    })
    const entries = result.manifest.regions.filter((item) => item.providerId === providerId)
    expect(entries.map((item) => item.reason)).toEqual([
      'selected',
      'duplicate',
      'expired',
      'empty',
      'budget_exceeded',
    ])
    const received = await send(result.messages)
    expect(count(received, marker)).toBe(1)
    expect(JSON.stringify(received)).not.toMatch(/EXPIRED_PACKAGE|OVER_BUDGET_PACKAGE/)
    await manager.setEnabled(packageId, false)
    expect(contexts.cacheSize).toBe(0)
    const disabled = await compiler.compile('fixture-thread', 'fixture', {
      disableMemoryRetrieval: true,
    })
    expect(disabled.manifest.regions.some((item) => item.providerId === providerId)).toBe(false)
    expect(count(await send(disabled.messages), marker)).toBe(0)
  })

  it('manifest-only 与非 package conversation 不发送，工具 conversation 照常发送', async () => {
    contexts.register({
      providerId: 'fixture.other',
      provide: async () => [
        region('fixture.other', 'OTHER_CONVERSATION', 'conversation'),
        region('package:diagnostic/context', 'MANIFEST_ONLY_PACKAGE', 'manifest-only'),
      ],
    })
    const { compiler, setRows } = await fixture('native', 'work')
    const toolContext = new ToolContextService({} as never)
    const source = toolContext.capture(
      { threadId: 'fixture-thread', agentId: 'fixture', pairId: 'pair-1', channel: 'desktop' },
      {
        name: 'web_fetch',
        args: { url: 'http://fixture.invalid/data' },
        output: 'TOOL_CONVERSATION',
        isError: false,
        callId: 'fixture-fetch',
      },
      1000,
    )
    expect(source).toBeDefined()
    const history = rows()
    history[1]!.metadataJson = JSON.stringify({ toolSources: [source] })
    setRows(history)
    compiler.setToolContextService(toolContext)
    const result = await compiler.compile('fixture-thread', 'fixture', {
      disableMemoryRetrieval: true,
    })
    const received = await send(result.messages)
    expect(count(received, marker)).toBe(1)
    expect(count(received, 'TOOL_CONVERSATION')).toBe(1)
    expect(JSON.stringify(received)).not.toMatch(/OTHER_CONVERSATION|MANIFEST_ONLY_PACKAGE/)
    expect(
      result.manifest.regions.find(
        (item) => item.regionId === 'package:diagnostic/context/fixture',
      ),
    ).toMatchObject({ selected: true, tokenEstimate: 0 })
  })

  for (const layout of ['native', 'sillytavern', 'legacy'] as const) {
    it(`${layout}：临时输入、禁用历史预览与 Realm 仍能投递，social 入口保持拒绝`, async () => {
      const { compiler, setChannel } = await fixture(layout, 'work')
      for (const options of [
        { currentInput: { role: 'user' as const, content: '临时问题' } },
        {
          currentInput: { role: 'user' as const, content: '临时问题' },
          appendThreadMessages: false,
        },
        { currentInput: { role: 'user' as const, content: '临时问题' }, realmExecution: true },
      ]) {
        const result = await compiler.compile('fixture-thread', 'fixture', {
          ...options,
          disableMemoryRetrieval: true,
        })
        expect(result.messages[result.currentMessageIndex!]?.content).toBe('临时问题')
        expect(count(await send(result.messages), marker)).toBe(1)
      }
      setChannel('social')
      await expect(compiler.compile('fixture-thread', 'fixture')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    })
    it(`${layout}：没有当前输入时在历史之后追加，索引保持 undefined`, async () => {
      const { compiler } = await fixture(layout)
      const result = await compiler.compile('fixture-thread', 'fixture', {
        appendThreadMessages: false,
        disableMemoryRetrieval: true,
      })
      expect(result.currentMessageIndex).toBeUndefined()
      expect(count(await send(result.messages), marker)).toBe(1)
    })
  }

  it('原生自定义框架没有 turn_context 槽位时，资料仍在历史后形成独立动态区', async () => {
    const { compiler, workspace } = await fixture('native')
    const framework: PromptFramework = {
      id: 'fixture.custom',
      name: '自定义原生',
      format: 'infos',
      bindings: [],
      blocks: [
        {
          id: 'main',
          name: '系统',
          kind: 'template',
          role: 'system',
          enabled: true,
          template: '固定系统前缀',
        },
        { id: 'history', name: '历史', kind: 'history', role: 'user', enabled: true },
      ],
    }
    await workspace!.save(
      {
        documents: [],
        frameworks: [framework],
        assignments: [{ agentId: '', channel: '', frameworkId: framework.id, overrides: {} }],
      },
      0,
    )
    await workspace!.publish(1)
    const result = await compiler.compile('fixture-thread', 'fixture', {
      disableMemoryRetrieval: true,
    })
    expect(result.messages.slice(-4).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
    ])
    expect(result.messages.slice(0, -4).every((message) => message.role === 'system')).toBe(true)
    expect(result.messages.at(-2)!.content).toMatch(
      /<turn_context>[\s\S]*PACKAGE_CONTEXT_7C3F[\s\S]*<\/turn_context>/,
    )
    expect(result.messages[result.currentMessageIndex!]?.content).toBe('本轮问题乙')
    expect(count(await send(result.messages), marker)).toBe(1)
  })
})
