import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeDrizzleConnection, createDrizzleConnection } from '../../../src/database'
import {
  configs, flowStates, taskPlanMutations, taskPlans, threadCharacterStateEvents,
  threadMessages, threads,
} from '../../../src/database/schema'
import { ThreadRepository } from '../../../src/repositories/thread.repo'
import { AttachmentRepository } from '../../../src/repositories/attachment.repo'
import { ConfigRepository } from '../../../src/repositories/config.repo'
import { TaskPlanRepository } from '../../../src/repositories/taskPlan.repo'
import { AttachmentService } from '../../../src/services/attachment/attachmentService'
import { SillyTavernVariableStore } from '../../../src/services/prompt/sillyTavernVariables'
import { TaskPlanService } from '../../../src/services/task/taskPlanService'
import { ThreadForkService } from '../../../src/services/thread/threadForkService'
import { PetStateService } from '../../../src/services/agent/petStateService'
import { WorkContextClearRepository } from '../../../src/repositories/workContextClear.repo'

let db: ReturnType<typeof createDrizzleConnection>
let root: string
let repo: ThreadRepository
let attachments: AttachmentRepository
let attachmentService: AttachmentService
let variables: SillyTavernVariableStore
let plans: TaskPlanService
let service: ThreadForkService
let messageIds: number[]
const originalTime = '2026-10-01 09:00:00'
const sourceScope = 'desktop:pero:source'

it('检查点继承当前清理边界，来源引用限定到实际复制的消息', async () => {
  const clears = new WorkContextClearRepository(db)
  const source = clears.clear({ threadId: 'source', agentId: 'pero', generation: 1,
    pairId: 'pair-2', toolCallId: 'clear-after-third-pair' })
  const targetId = await service.fork('source', messageIds[3]!)
  const boundary = clears.latest(targetId, 1)!
  const copied = db.select().from(threadMessages).where(eq(threadMessages.threadId, targetId)).all()
  expect(copied.map((message) => message.content)).toEqual(['问题一', '回复一', '问题二', '回复二'])
  expect(boundary.messageIds).toEqual(copied.map((message) => message.id))
  expect(boundary.executionIds).toEqual([])
  expect(boundary.toolCallId).toBe('clear-after-third-pair')
  expect(clears.latest('source', 1)).toEqual({ id: source.id, pairId: 'pair-2',
    toolCallId: 'clear-after-third-pair', messageIds, executionIds: [] })
})

beforeEach(async () => {
  const temporary = fileURLToPath(new URL('../../../../../TEMP/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  root = await mkdtemp(path.join(temporary, 'thread-fork-'))
  db = createDrizzleConnection(':memory:')
  repo = new ThreadRepository(db)
  attachments = new AttachmentRepository(db)
  attachmentService = new AttachmentService(attachments, repo, root)
  variables = new SillyTavernVariableStore(new ConfigRepository(db))
  plans = new TaskPlanService(new TaskPlanRepository(db), async () => {})
  service = new ThreadForkService(db, attachmentService, variables, plans)
  await repo.createThread({ id: 'source', agentId: 'pero', channel: 'desktop', title: '原会话' })
  messageIds = []
  // 三轮源对话；第二轮的回复是检查点，第三轮用于验证后续历史保持原样。
  for (const [index, content] of ['问题一', '回复一', '问题二', '回复二', '问题三', '回复三'].entries()) {
    const row = await repo.appendMessage({
      threadId: 'source', role: index % 2 ? 'assistant' : 'user', content,
      rawContent: index % 2 ? `思考与${content}` : undefined,
      pairId: `pair-${Math.floor(index / 2)}`, agentId: index % 2 ? 'pero' : undefined,
    })
    messageIds.push(row.id)
  }
  db.update(threadMessages).set({ timestamp: originalTime }).run()
  db.update(threads).set({
    disabledToolsJson: '["terminal_run"]', enabledSkillsJson: '["writing"]',
    reasoningEffort: 'high', executionMode: 'auto', autoExecuteTools: true,
    interactionMode: 'work', contextPolicy: '{"historyLimit":80}',
  }).where(eq(threads.id, 'source')).run()
  db.insert(flowStates).values({
    threadId: 'source', agentId: 'pero', currentGoal: '第三轮后的当前目标',
    privateFacts: '当前私有事实', updatedByPairId: 'pair-2',
  }).run()
  db.insert(threadCharacterStateEvents).values({
    threadId: 'source', agentId: 'pero', kind: 'update', pairId: 'pair-2',
    patchJson: '{"mood":"期待","mind":"当前的想法"}', createdAt: new Date().toISOString(),
  }).run()
  await new PetStateService(db).update('pero', { mood: '期待', mind: '当前的想法' }, {
    threadId: 'source', pairId: 'pair-2', toolCallId: 'shared-state', generation: 1,
  })
  await plans.update({ threadId: 'source', agentId: 'pero' }, {
    action: 'create', title: '当前计划', steps: [{ id: 'step', title: '继续整理', status: 'pending' }],
  })
  await variables.commit({
    id: randomUUID(), scope: sourceScope, epoch: 0,
    effects: {
      local: [{ name: 'scene', after: '当前场景', write: true }],
      global: [{ name: 'shared', after: '共享设定', write: true }],
    },
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeDrizzleConnection(db)
  await rm(root, { recursive: true, force: true })
})

async function addAttachment() {
  const id = randomUUID()
  const storageKey = `${id.slice(0, 2)}/${id}`
  const content = Buffer.from('检查点中的附件原文')
  const file = attachmentService.resolveStoragePath(storageKey)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  await attachments.create({
    id, storageKey, threadId: 'source', kind: 'text', originalName: '笔记.txt',
    mimeType: 'text/plain', sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), extractedText: content.toString(),
  })
  await attachments.bind([id], 'source', messageIds[2])
  return { id, storageKey, content }
}

describe('会话检查点分支', () => {
  it('复制完整历史前缀并继承当前设置、状态和变量，后续独立编辑与撤回', async () => {
    const sourceMessages = db.select().from(threadMessages).where(eq(threadMessages.threadId, 'source'))
      .orderBy(threadMessages.id).all()
    const id = await service.fork('source', messageIds[3])
    const thread = await repo.getThread(id)
    expect(thread).toMatchObject({
      agentId: 'pero', channel: 'desktop', interactionMode: 'work', reasoningEffort: 'high',
      enabledSkillsJson: '["writing"]', disabledToolsJson: '["terminal_run"]',
      executionMode: 'auto', autoExecuteTools: true, contextPolicy: '{"historyLimit":80}',
      messageCount: 4, pairCount: 2,
    })
    const copied = db.select().from(threadMessages).where(eq(threadMessages.threadId, id)).orderBy(threadMessages.id).all()
    expect(copied.map((row) => row.content)).toEqual(['问题一', '回复一', '问题二', '回复二'])
    expect(copied.map((row) => row.timestamp)).toEqual(Array(4).fill(originalTime))
    expect(copied.map((row) => row.rawContent)).toEqual([null, '思考与回复一', null, '思考与回复二'])
    expect(copied.every((row) => !messageIds.includes(row.id))).toBe(true)
    expect(copied[0].pairId).toBe(copied[1].pairId)
    expect(copied[2].pairId).toBe(copied[3].pairId)
    expect(copied.map((row) => row.pairId)).not.toContain('pair-0')
    expect(JSON.parse(copied[3].metadataJson!).forkOrigin).toMatchObject({
      threadId: 'source', messageId: messageIds[3], checkpointMessageId: messageIds[3],
    })
    expect(db.select().from(flowStates).where(eq(flowStates.threadId, id)).get()).toMatchObject({
      currentGoal: '第三轮后的当前目标', privateFacts: '当前私有事实', updatedByPairId: null,
    })
    expect(await new PetStateService(db).get('pero', id)).toMatchObject({ mood: '期待', mind: '当前的想法' })
    const plan = plans.get(id, 'pero')!
    expect(plan.title).toBe('当前计划')
    expect(plan.steps).toEqual([{ id: 'step', title: '继续整理', status: 'pending' }])
    expect(plan.id).not.toBe(plans.get('source', 'pero')!.id)
    const targetScope = `desktop:pero:${id}`
    expect(await variables.snapshot(targetScope)).toMatchObject({
      local: { scene: '当前场景' }, global: { shared: '共享设定' },
    })
    expect(await repo.queryMemoryMessagesThrough(id, Number.MAX_SAFE_INTEGER)).toEqual([])
    expect(copied.every((row) => row.scorerStatus === 'skipped')).toBe(true)
    await variables.commit({
      id: randomUUID(), scope: targetScope, epoch: 0,
      effects: { local: [{ name: 'scene', before: '当前场景', after: '分支场景', write: true }], global: [] },
    })
    expect((await variables.snapshot(sourceScope)).local).toEqual({ scene: '当前场景' })
    await repo.softDeletePair(copied[3].id, 'user')
    await plans.rollbackPairs(id, [copied[3].pairId!])
    expect(plans.get(id, 'pero')?.title).toBe('当前计划')
    expect(db.select().from(threadMessages).where(eq(threadMessages.threadId, 'source'))
      .orderBy(threadMessages.id).all()).toEqual(sourceMessages)
    await repo.appendMessage({ threadId: id, role: 'user', pairId: 'new-pair', content: '分支的新问题' })
    await repo.appendMessage({ threadId: id, role: 'assistant', pairId: 'new-pair', content: '分支的新回复' })
    expect((await repo.queryMemoryMessagesThrough(id, Number.MAX_SAFE_INTEGER)).map((row) => row.content))
      .toEqual(['分支的新问题', '分支的新回复'])
  })

  it('重映射工作轨迹与附件引用，源附件永久清理后分支仍保有完整字节', async () => {
    const attachment = await addAttachment()
    db.update(threadMessages).set({ metadataJson: JSON.stringify({
      workContext: {
        version: 1, threadId: 'source', pairId: 'pair-1',
        historyRevisions: [[messageIds[0], 1], [messageIds[2], 1]],
        input: { attachmentId: attachment.id }, messages: [],
      },
      toolCalls: [{ name: 'read_file', result: JSON.stringify({ source: `attachment:${attachment.id}`, attachmentId: attachment.id }) }],
    }) }).where(eq(threadMessages.id, messageIds[3])).run()
    const id = await service.fork('source', messageIds[3])
    const copied = db.select().from(threadMessages).where(eq(threadMessages.threadId, id)).orderBy(threadMessages.id).all()
    const rows = await attachments.listByMessageIds(copied.map((row) => row.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ threadId: id, messageId: copied[2].id, extractedText: attachment.content.toString() })
    expect(rows[0].id).not.toBe(attachment.id)
    expect(rows[0].storageKey).not.toBe(attachment.storageKey)
    expect(JSON.parse(copied[3].metadataJson!).workContext).toMatchObject({
      threadId: id, pairId: copied[3].pairId,
      historyRevisions: [[copied[0].id, 1], [copied[2].id, 1]],
      input: { attachmentId: rows[0].id },
    })
    expect(JSON.parse(JSON.parse(copied[3].metadataJson!).toolCalls[0].result)).toEqual({
      source: `attachment:${rows[0].id}`, attachmentId: rows[0].id,
    })
    await attachments.softDeleteByMessageIds([messageIds[2]])
    await attachmentService.purgeDeleted(attachment.id, attachment.storageKey)
    expect(await readFile(attachmentService.resolveStoragePath(rows[0].storageKey))).toEqual(attachment.content)
  })

  it('提交变量失败时回滚全部会话数据并清理已复制的附件', async () => {
    const attachment = await addAttachment()
    const before = db.select().from(configs).all()
    const sqlite = (db as unknown as { $client: { exec(sql: string): void } }).$client
    sqlite.exec("CREATE TRIGGER reject_config_write BEFORE UPDATE ON configs BEGIN SELECT RAISE(ABORT, '模拟写入失败'); END")
    await expect(service.fork('source', messageIds[3])).rejects.toThrow('模拟写入失败')
    expect(db.select().from(threads).all().map((row) => row.id)).toEqual(['source'])
    expect(db.select().from(threadMessages).all().map((row) => row.id)).toEqual(messageIds)
    expect(db.select().from(configs).all()).toEqual(before)
    expect(db.select().from(taskPlans).all()).toHaveLength(1)
    expect(db.select().from(taskPlanMutations).all()).toEqual([])
    const remaining = (await Promise.all((await readdir(root)).map((shard) => readdir(path.join(root, shard))))).flat()
    expect(remaining).toEqual([attachment.id])
  })

  it('拒绝跨会话和用户消息边界，来源前缀变化时拒绝提交', async () => {
    await repo.createThread({ id: 'other', agentId: 'pero', channel: 'desktop' })
    await expect(service.fork('other', messageIds[3])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(service.fork('source', messageIds[2])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const attachment = await addAttachment()
    const resolve = attachmentService.resolveStoragePath.bind(attachmentService)
    vi.spyOn(attachmentService, 'resolveStoragePath').mockImplementation((key) => {
      if (key !== attachment.storageKey)
        db.update(threadMessages).set({ content: '复制期间编辑' }).where(eq(threadMessages.id, messageIds[0])).run()
      return resolve(key)
    })
    await expect(service.fork('source', messageIds[3])).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(db.select().from(threads).all().map((row) => row.id).sort()).toEqual(['other', 'source'])
  })

  it('主线在读取附件或复制变量前拒绝检查点分支', async () => {
    const main = repo.ensureMainThread('pero')
    const reply = await repo.appendMessage({ threadId: main.id, role: 'assistant', content: '主线回复' })
    const before = db.select().from(threads).all()
    await expect(service.fork(main.id, reply.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(db.select().from(threads).all()).toEqual(before)
    expect(await variables.snapshot(`desktop:pero:${main.id}`)).toMatchObject({ local: {} })
  })

  it('同一轮有多条回复时复制完整轮次，后续用户输入仍留在来源', async () => {
    await repo.createThread({ id: 'multi-reply', agentId: 'pero', channel: 'desktop' })
    await repo.appendMessage({ threadId: 'multi-reply', pairId: 'multi', role: 'user', content: '分阶段回答' })
    const selected = await repo.appendMessage({ threadId: 'multi-reply', pairId: 'multi', role: 'assistant', content: '第一部分' })
    await repo.appendMessage({ threadId: 'multi-reply', pairId: 'multi', role: 'assistant', content: '第二部分' })
    await repo.appendMessage({ threadId: 'multi-reply', pairId: 'next', role: 'user', content: '下一轮' })
    const id = await service.fork('multi-reply', selected.id)
    const copied = db.select().from(threadMessages).where(eq(threadMessages.threadId, id)).orderBy(threadMessages.id).all()
    expect(copied.map((row) => row.content)).toEqual(['分阶段回答', '第一部分', '第二部分'])
    expect(new Set(copied.map((row) => row.pairId)).size).toBe(1)
  })
})
