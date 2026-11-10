import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDrizzleConnection, closeDrizzleConnection } from '../../../src/database'
import { conversationMessageSources } from '../../../src/database/schema'
import { ThreadRepository } from '../../../src/repositories/thread.repo'
import { ThreadService } from '../../../src/services/thread/threadService'
import { ConversationTurnService } from '../../../src/services/conversation/conversationTurnService'
import type { CompiledRunParams } from '../../../src/services/agent/agentService'
import { conversationSourceKey } from '@infos/shared'
import { PetStateService } from '../../../src/services/agent/petStateService'
import { ConversationProjectionService } from '../../../src/projections/conversationProjectionService'
import { projectConversationExecutions } from '../../../src/services/context/workContext'

let db: ReturnType<typeof createDrizzleConnection>
let repo: ThreadRepository
let threads: ThreadService
let mainId: string

beforeEach(async () => {
  db = createDrizzleConnection(':memory:')
  repo = new ThreadRepository(db)
  threads = new ThreadService(repo)
  mainId = (await threads.getMainThread('pero')).id
})
afterEach(() => closeDrizzleConnection(db))

function createTurns(run: (params: CompiledRunParams) => Promise<string>) {
  return new ConversationTurnService({
    threadService: threads,
    attachmentService: { validateForBinding: async () => [], bindOutgoing: async () => {} } as never,
    imageUnderstandingService: {} as never,
    contextCompiler: {
      compile: async (_thread: string, _agent: string, options: {
        currentMessageId?: number
        excludeMessageIds?: number[]
        currentInput?: import('../../../src/services/pipeline/types').ChatMessage
      }) => {
        const history = (await threads.getConversationHistory(mainId, 16384, options.currentMessageId))
          .filter((message) => !options.excludeMessageIds?.includes(message.id))
        const messages = history.map((message) => ({ role: message.role, content: message.content,
          cacheControl: { kind: 'history' as const, historyMessageId: message.id, historyRevision: message.revision },
        })) as import('../../../src/services/pipeline/types').ChatMessage[]
        if (options.currentInput) messages.push(options.currentInput)
        return {
          messages,
          currentMessageIndex: messages.length - 1,
          manifest: { disabledTools: [] },
        }
      },
    } as never,
    agentService: { chatWithCompiledMessages: run } as never,
  })
}

describe('主线连续交流的持久合同', () => {
  it('独立失败执行的快照版本可序列化，消息总数来自正式消息', async () => {
    const input = await threads.appendUserMessage(mainId, '请继续处理')
    repo.conversations.begin({ id: 'failed-run', threadId: mainId, agentId: 'pero', generation: 1,
      sources: [{ messageId: input.id, revision: 1 }] })
    repo.conversations.settle('failed-run', 'failed', { failureMessage: 'MODEL_UNAVAILABLE' })
    const projection = new ConversationProjectionService(threads, { listForMessages: async () => new Map() } as never)
    const snapshot = await projection.getSnapshot(mainId)
    expect(snapshot.totalMessages).toBe(1)
    expect(snapshot.messages.map((message) => message.messageId)).toEqual([String(input.id), 'execution:failed-run'])
    expect(Number.isSafeInteger(snapshot.revision)).toBe(true)
    expect(JSON.parse(JSON.stringify(snapshot)).revision).toBe(snapshot.revision)
  })

  it('没有正式发言的执行保留完整工具协议组供后续工作接续', async () => {
    const input = await threads.appendUserMessage(mainId, '读取配置后先保存进展')
    const history = await threads.getActiveMessages(mainId)
    const messages = projectConversationExecutions([
      { role: 'user', content: input.content, cacheControl: { kind: 'history', historyMessageId: input.id, historyRevision: 1 } },
    ], history, [{
      id: 'silent-run', status: 'completed', inputSourcesJson: JSON.stringify([{ messageId: input.id, revision: 1 }]),
      metadataJson: JSON.stringify({
        historyRevisions: [[input.id, 1]], executionMessages: [
          { role: 'assistant', content: '', toolCalls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"config.json"}' } }] },
          { role: 'tool', content: '{"enabled":true}', toolCallId: 'read' },
        ],
      }),
    }], 16384)
    expect(messages.map((message) => [message.role, message.content]))
      .toEqual([['user', '读取配置后先保存进展'], ['assistant', ''], ['tool', '{"enabled":true}']])
    expect(messages[1]?.toolCalls?.[0]?.id).toBe('read')
    expect(messages[2]?.toolCallId).toBe('read')
  })

  it('重新生成在发表前失败时保留原回复', async () => {
    const original = await createTurns(async () => '原回复').executeTurn({ threadId: mainId, content: '你好' })
    const source = original.assistantMessage!
    await expect(createTurns(async () => { throw new Error('MODEL_UNAVAILABLE') }).executeTurn({
      threadId: mainId, content: '重新生成', regeneration: { messageId: source.id, revision: source.revision },
    })).rejects.toThrow('MODEL_UNAVAILABLE')
    expect((await threads.getActiveMessages(mainId)).map((message) => message.content)).toEqual(['你好', '原回复'])
  })

  it('角色主动发言可以独立重新生成，聊天历史保留真实发言者', async () => {
    const original = await createTurns(async ({ conversation }) => {
      await conversation!.publish({ id: 'hello', content: '今天过得怎么样？' })
      return ''
    }).executeTurn({ threadId: mainId, content: '主动问候事件', inputPersistence: 'ephemeral', proactive: true })
    const message = original.assistantMessage!
    const regenerated = await createTurns(async () => '要不要一起聊聊今天的事？').executeTurn({
      threadId: mainId, content: '重新生成', regeneration: { messageId: message.id, revision: message.revision },
    })
    expect((await threads.getActiveMessages(mainId)).map((item) => [item.role, item.content]))
      .toEqual([['assistant', '要不要一起聊聊今天的事？']])
    expect(regenerated.inputSources).toEqual([])
    expect(JSON.parse(repo.conversations.get(regenerated.pairId)!.metadataJson).regeneration)
      .toMatchObject({ messageId: message.id, revision: 1, content: '今天过得怎么样？' })
  })

  it('从用户输入重新生成时保留输入及其他交流记录', async () => {
    await createTurns(async () => '第一条回复').executeTurn({ threadId: mainId, content: '第一个话题' })
    const source = (await threads.getActiveMessages(mainId))[0]!
    await createTurns(async () => '第二条回复').executeTurn({ threadId: mainId, content: '第二个话题' })
    await createTurns(async () => '重新整理的第一条回复').executeTurn({ threadId: mainId, content: '重新生成',
      regeneration: { messageId: source.id, revision: source.revision } })
    expect((await threads.getActiveMessages(mainId)).map((message) => message.content))
      .toEqual(['第一个话题', '第二个话题', '第二条回复', '重新整理的第一条回复'])
  })

  it('工具发言标识与自动最终答复使用各自的发布身份', async () => {
    const result = await createTurns(async ({ conversation }) => {
      await conversation!.publish({ id: 'final', content: '我先确认一下安排。' })
      return '安排已经整理好了。'
    }).executeTurn({ threadId: mainId, content: '帮我整理安排' })
    expect((await threads.getActiveMessages(mainId)).filter((message) => message.role === 'assistant')
      .map((message) => message.content)).toEqual(['我先确认一下安排。', '安排已经整理好了。'])
    expect(result.assistantMessage?.content).toBe('安排已经整理好了。')
  })

  it('一次执行发表两个问题后释放等待，一条用户输入回应两个事项', async () => {
    const first = createTurns(async ({ conversation }) => {
      const firstQuestion = await conversation!.publish({ id: 'place', content: '想去哪里？' })
      const secondQuestion = await conversation!.publish({ id: 'time', content: '几点出发？' })
      await conversation!.wait([
        { id: 'place', question: '目的地', continuation: '确定目的地后安排行程', messageIds: [firstQuestion.messageId] },
        { id: 'time', question: '出发时间', continuation: '结合时间检查行程', messageIds: [secondQuestion.messageId] },
      ])
      return ''
    })
    await first.executeTurn({ threadId: mainId, content: '一起安排明天吧' })
    const pending = repo.conversations.open(mainId, 1)
    expect(pending.map((item) => item.question)).toEqual(['目的地', '出发时间'])
    expect(repo.conversations.list(mainId, 1).map((run) => run.status)).toEqual(['waiting'])
    const resumed = createTurns(async ({ conversation }) => {
      await conversation!.publish({ id: 'answer', content: '明天九点去公园。', respondsTo: pending.map((item) => item.id) })
      return ''
    })
    await resumed.executeTurn({ threadId: mainId, content: '去公园，九点出发' })
    const messages = await threads.getActiveMessages(mainId)
    expect(messages.map((message) => [message.role, message.content, message.pairId])).toEqual([
      ['user', '一起安排明天吧', null], ['assistant', '想去哪里？', null],
      ['assistant', '几点出发？', null], ['user', '去公园，九点出发', null],
      ['assistant', '明天九点去公园。', null],
    ])
    expect(repo.conversations.open(mainId, 1)).toEqual([])
    const links = db.select().from(conversationMessageSources)
      .where(eq(conversationMessageSources.messageId, messages[4]!.id)).all()
    expect(links.map((link) => link.sourceMessageId).sort((a, b) => a - b))
      .toEqual([messages[1]!.id, messages[2]!.id, messages[3]!.id])
  })

  it('零条发言也能结束执行，并保留独立用户来源', async () => {
    const result = await createTurns(async () => '').executeTurn({ threadId: mainId, content: '先记在这里' })
    expect(result.assistantMessage).toBeUndefined()
    expect((await threads.getActiveMessages(mainId)).map((message) => message.content)).toEqual(['先记在这里'])
    expect(repo.conversations.list(mainId, 1)[0]?.status).toBe('completed')
  })

  it('发表后的执行失败保留正式消息及独立失败记录', async () => {
    const turns = createTurns(async ({ conversation }) => {
      await conversation!.publish({ id: 'notice', content: '已经收到你的安排。' })
      throw new Error('MODEL_CONNECTION_LOST')
    })
    await expect(turns.executeTurn({ threadId: mainId, content: '开始安排' })).rejects.toThrow('MODEL_CONNECTION_LOST')
    const messages = await threads.getActiveMessages(mainId)
    expect(messages.map((message) => message.content)).toEqual(['开始安排', '已经收到你的安排。'])
    expect(repo.conversations.list(mainId, 1)[0]).toMatchObject({ status: 'failed' })
  })

  it('重试同一发布只产生一条消息，冲突正文不会覆盖已发表内容', async () => {
    const user = await threads.appendUserMessage(mainId, '你好')
    repo.conversations.begin({ id: 'run', threadId: mainId, agentId: 'pero', generation: 1,
      sources: [{ messageId: user.id, revision: 1 }] })
    const input = { threadId: mainId, role: 'assistant' as const, content: '你好呀', executionId: 'run', publicationId: 'hello' }
    const first = await repo.appendMessage(input)
    expect((await repo.appendMessage(input)).id).toBe(first.id)
    await expect(repo.appendMessage({ ...input, content: '其他正文' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await repo.countActiveMessages(mainId)).toBe(2)
  })

  it('批量等待遇到无效来源时整批回滚', async () => {
    repo.conversations.begin({ id: 'run', threadId: mainId, agentId: 'pero', generation: 1, sources: [] })
    const question = await repo.appendMessage({ threadId: mainId, role: 'assistant', content: '几点？', executionId: 'run' })
    expect(() => repo.conversations.waitMany('run', [
      { id: 'valid', question: '时间', continuation: '等待时间', messageIds: [question.id] },
      { id: 'invalid', question: '地点', continuation: '等待地点', messageIds: [999999] },
    ])).toThrow()
    expect(repo.conversations.open(mainId, 1)).toEqual([])
  })

  it('重启保留待回应事项，并将正在运行的执行收口为中断', async () => {
    repo.conversations.begin({ id: 'waiting', threadId: mainId, agentId: 'pero', generation: 1, sources: [] })
    const question = await repo.appendMessage({ threadId: mainId, role: 'assistant', content: '想聊什么？', executionId: 'waiting' })
    repo.conversations.waitMany('waiting', [{ id: 'topic', question: '话题', continuation: '接续用户话题', messageIds: [question.id] }])
    repo.conversations.settle('waiting', 'completed', {})
    repo.conversations.begin({ id: 'unfinished', threadId: mainId, agentId: 'pero', generation: 1, sources: [] })
    const restored = new ThreadRepository(db)
    restored.conversations.recover()
    expect(restored.conversations.open(mainId, 1).map((item) => item.question)).toEqual(['话题'])
    expect(restored.conversations.get('unfinished')?.status).toBe('interrupted')
  })

  it('用户单独发言可以炼化，编辑后使用新的来源修订', async () => {
    const user = await threads.appendUserMessage(mainId, '喜欢蓝色')
    const first = await repo.queryMemoryMessagesThrough(mainId, user.id)
    expect(first.map((message) => message.pairId)).toEqual([`message:${user.id}@1`])
    await threads.editMessage(user.id, '喜欢紫色', mainId, 1)
    expect(await repo.findMessagesByPairIds(mainId, [conversationSourceKey(user)])).toEqual([])
    const revised = await repo.queryMemoryMessagesThrough(mainId, user.id)
    expect(revised.map((message) => [message.content, message.pairId])).toEqual([['喜欢紫色', `message:${user.id}@2`]])
  })

  it('撤回输入撤销关联执行的状态贡献，保留后续有效状态', async () => {
    const states = new PetStateService(db)
    threads.setCharacterStateLifecycle(states)
    const first = await threads.appendUserMessage(mainId, '今天先休息')
    repo.conversations.begin({ id: 'state-a', threadId: mainId, agentId: 'pero', generation: 1,
      sources: [{ messageId: first.id, revision: 1 }] })
    await states.update('pero', { mood: '放松' }, { threadId: mainId, pairId: 'state-a', generation: 1 })
    repo.conversations.settle('state-a', 'completed', {})
    const second = await threads.appendUserMessage(mainId, '一起做点有趣的事')
    repo.conversations.begin({ id: 'state-b', threadId: mainId, agentId: 'pero', generation: 1,
      sources: [{ messageId: second.id, revision: 1 }] })
    await states.update('pero', { mood: '期待' }, { threadId: mainId, pairId: 'state-b', generation: 1 })
    repo.conversations.settle('state-b', 'completed', {})
    await threads.deleteMessage(first.id)
    expect((await states.get('pero', mainId))?.mood).toBe('期待')
    expect(repo.conversations.get('state-a')?.status).toBe('revoked')
    expect(repo.conversations.get('state-b')?.status).toBe('completed')
  })

  it('撤回一条问题保留另一条独立发言，重置使旧发布失效', async () => {
    await createTurns(async ({ conversation }) => {
      const first = await conversation!.publish({ id: 'a', content: '喝什么？' })
      const second = await conversation!.publish({ id: 'b', content: '吃什么？' })
      await conversation!.wait([
        { id: 'a', question: '饮品', continuation: '选择饮品', messageIds: [first.messageId] },
        { id: 'b', question: '食物', continuation: '选择食物', messageIds: [second.messageId] },
      ])
      return ''
    }).executeTurn({ threadId: mainId, content: '准备午餐' })
    const messages = await threads.getActiveMessages(mainId)
    await threads.rewindMessage(mainId, messages[1]!.id)
    expect((await threads.getActiveMessages(mainId)).map((message) => message.content)).toEqual(['准备午餐', '吃什么？'])
    expect(repo.conversations.open(mainId, 1).map((item) => item.question)).toEqual(['食物'])
    await threads.resetMainThread(mainId)
    expect(repo.conversations.open(mainId, 2)).toEqual([])
    const old = repo.conversations.list(mainId, 1)[0]!
    await expect(repo.appendMessage({ threadId: mainId, role: 'assistant', content: '旧执行',
      executionId: old.id, expectedGeneration: 1 })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
