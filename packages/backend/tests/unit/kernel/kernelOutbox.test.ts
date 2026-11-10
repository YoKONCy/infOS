import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KernelExecutionDescriptor, KernelExecutionId, KernelProcessId } from '@infos/shared'
import { kernelOutboxEvents, threadMessages, threads } from '@infos/backend/database/schema'
import {
  ExecutionRuntime,
  KernelOutboxDispatcher,
  KernelOutboxRepository,
} from '@infos/backend/kernel'
import { ThreadRepository } from '@infos/backend/repositories/thread.repo'

let connection: ReturnType<typeof createDrizzleConnection> | undefined
let sqlite: Database.Database | undefined

function createDb() {
  connection = createDrizzleConnection(':memory:')
  sqlite = connection.$client
  return connection
}

function execution(): KernelExecutionDescriptor {
  return {
    executionId: 'execution-1' as KernelExecutionId,
    processId: 'process-1' as KernelProcessId,
    principalId: 'nana',
    threadId: 'thread-1',
    channel: 'desktop',
    class: 'interactive',
    priority: 5,
    budget: {},
  }
}

afterEach(() => {
  if (connection) closeDrizzleConnection(connection)
  connection = undefined
  sqlite = undefined
})

describe('消息事务 Outbox', () => {
  it('Execution状态、WaitReason、Usage与timed_out终态应持久化为Durable Event', async () => {
    const db = createDb()
    const outbox = new KernelOutboxRepository(db)
    const runtime = new ExecutionRuntime(outbox)
    const descriptor = await runtime.create({
      principalId: 'nana',
      class: 'background',
      budget: { maxLlmCalls: 2 },
    })
    await runtime.stateChanged(descriptor, 'queued', 'resource_locked', {
      llmCalls: 1,
      inputTokens: 10,
      outputTokens: 2,
      toolCalls: 0,
      concurrentIo: 0,
    })
    await runtime.timeout(descriptor, new Error('超过Deadline'))

    const events = (await outbox.listPending()).map((row) => ({
      type: row.eventType,
      payload: JSON.parse(row.payloadJson),
    }))
    expect(events.map((event) => event.type)).toEqual([
      'kernel.execution.created',
      'kernel.execution.state_changed',
      'kernel.execution.timed_out',
    ])
    expect(events[1]?.payload).toMatchObject({
      state: 'queued',
      waitReason: 'resource_locked',
      usage: { llmCalls: 1, inputTokens: 10 },
    })
    expect(events[2]?.payload).toMatchObject({
      state: 'timed_out',
      exitStatus: { state: 'timed_out', code: 'DEADLINE_EXCEEDED' },
    })
  })

  it('消息与 Durable Event 应在同一事务提交并保留因果身份', async () => {
    const db = createDb()
    sqlite!
      .prepare("INSERT INTO threads (id, agent_id, channel) VALUES ('thread-1', 'nana', 'desktop')")
      .run()
    const outbox = new KernelOutboxRepository(db)
    const repo = new ThreadRepository(db, outbox)

    const message = await repo.appendMessage({
      threadId: 'thread-1',
      role: 'assistant',
      content: '完成',
      pairId: 'pair-1',
      agentId: 'nana',
      execution: execution(),
    })

    const rows = await outbox.listPending()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      eventType: 'conversation.message.committed',
      principalId: 'nana',
      executionId: 'execution-1',
      correlationId: 'execution-1',
      objectType: 'thread-message',
      objectId: String(message.id),
    })
    expect(JSON.parse(rows[0]!.payloadJson)).toMatchObject({
      threadId: 'thread-1',
      messageId: message.id,
      role: 'assistant',
    })
  })

  it('Outbox 写入失败时必须回滚消息行', async () => {
    const db = createDb()
    sqlite!
      .prepare("INSERT INTO threads (id, agent_id, channel) VALUES ('thread-1', 'nana', 'desktop')")
      .run()
    const outbox = new KernelOutboxRepository(db)
    const repo = new ThreadRepository(db, outbox)
    const createEvent = vi.spyOn(outbox, 'createEvent')
    const fixed = outbox.createEvent({
      protocolVersion: 1,
      type: 'occupied',
      durability: 'durable',
      principalId: 'nana',
      payload: {},
    })
    await (db as unknown as ReturnType<typeof drizzle>)
      .insert(kernelOutboxEvents)
      .values(outbox.toRow(fixed))
    createEvent.mockReturnValue(fixed)

    await expect(
      repo.appendMessage({
        threadId: 'thread-1',
        role: 'assistant',
        content: '不应留下',
        execution: execution(),
      }),
    ).rejects.toThrow()

    expect(sqlite!.prepare('SELECT COUNT(*) AS count FROM thread_messages').get()).toEqual({
      count: 0,
    })
  })

  it('Dispatcher 失败时应停止当前批次，禁止越序发布后继事实', async () => {
    const db = createDb()
    const outbox = new KernelOutboxRepository(db)
    await outbox.enqueue({
      protocolVersion: 1,
      type: 'kernel.first',
      durability: 'durable',
      principalId: 'pero',
      payload: {},
    })
    await outbox.enqueue({
      protocolVersion: 1,
      type: 'kernel.second',
      durability: 'durable',
      principalId: 'pero',
      payload: {},
    })
    const received: string[] = []
    const dispatcher = new KernelOutboxDispatcher(outbox, (event) => {
      received.push(event.type)
      if (event.type === 'kernel.first') throw new Error('暂时不可用')
    })

    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      published: 0,
      failed: 1,
      deadLettered: 0,
    })
    expect(received).toEqual(['kernel.first'])
    expect(await outbox.listPending()).toHaveLength(1)
  })

  it('达到最大重试后应进入死信并允许后继事实继续发布', async () => {
    const db = createDb()
    const outbox = new KernelOutboxRepository(db)
    const first = await outbox.enqueue({
      protocolVersion: 1,
      type: 'kernel.poison',
      durability: 'durable',
      principalId: 'pero',
      payload: {},
    })
    await outbox.enqueue({
      protocolVersion: 1,
      type: 'kernel.after',
      durability: 'durable',
      principalId: 'pero',
      payload: {},
    })
    const received: string[] = []
    const dispatcher = new KernelOutboxDispatcher(
      outbox,
      (event) => {
        received.push(event.type)
        if (event.type === 'kernel.poison') throw new Error('永久失败')
      },
      1,
    )
    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      published: 1,
      failed: 1,
      deadLettered: 1,
    })
    expect(received).toEqual(['kernel.poison', 'kernel.after'])
    expect((await outbox.listDeadLetters())[0]).toMatchObject({ eventId: first.eventId })
    expect(await outbox.replay(first.eventId)).toBe(true)
    expect((await outbox.listPending())[0]).toMatchObject({ eventId: first.eventId, attempts: 0 })
  })

  it('保留清理只能删除过期Published事件，不能删除Pending或死信', async () => {
    const db = createDb()
    const outbox = new KernelOutboxRepository(db)
    const published = await outbox.enqueue({
      protocolVersion: 1,
      type: 'kernel.published',
      durability: 'durable',
      principalId: 'pero',
      payload: {},
    })
    await outbox.enqueue({
      protocolVersion: 1,
      type: 'kernel.pending',
      durability: 'durable',
      principalId: 'pero',
      payload: {},
    })
    const dead = await outbox.enqueue({
      protocolVersion: 1,
      type: 'kernel.dead',
      durability: 'durable',
      principalId: 'pero',
      payload: {},
    })
    await outbox.markFailed(dead.eventId, '测试失败', new Date(), 1)
    await outbox.markPublished(published.eventId)
    sqlite!
      .prepare(
        `UPDATE kernel_outbox_events SET published_at = '2020-01-01T00:00:00.000Z' WHERE event_id = ?`,
      )
      .run(published.eventId)
    expect(await outbox.cleanupPublished(new Date('2021-01-01T00:00:00.000Z'))).toBe(1)
    expect(await outbox.countByStatus()).toEqual({ pending: 1, dead_letter: 1 })
  })

  it('Dispatcher 应发布事件并标记完成', async () => {
    const db = createDb()
    const outbox = new KernelOutboxRepository(db)
    await outbox.enqueue({
      protocolVersion: 1,
      type: 'kernel.test',
      durability: 'durable',
      principalId: 'pero',
      payload: { ok: true },
    })
    const received: string[] = []
    const dispatcher = new KernelOutboxDispatcher(outbox, (event) => {
      received.push(event.type)
    })

    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      published: 1,
      failed: 0,
      deadLettered: 0,
    })
    expect(received).toEqual(['kernel.test'])
    expect(await outbox.listPending()).toEqual([])
  })
})
