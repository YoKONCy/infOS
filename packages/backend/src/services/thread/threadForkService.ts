import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../database'
import {
  configs, flowStates, messageAttachments, taskPlans, taskPlanMutations,
  threadCharacterStateEvents, threadMessages, threads, workContextClears,
} from '../../database/schema'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'
import type { AttachmentService } from '../attachment/attachmentService'
import type { SillyTavernVariableStore } from '../prompt/sillyTavernVariables'
import type { TaskPlanService } from '../task/taskPlanService'

type Attachment = typeof messageAttachments.$inferSelect
type CopiedAttachment = { source: Attachment; id: string; storageKey: string }

/** 历史截止于所选完整轮次；当前设置和状态作为新会话的独立起点。 */
export class ThreadForkService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly attachments: Pick<AttachmentService, 'resolveStoragePath'>,
    private readonly variables: SillyTavernVariableStore,
    private readonly plans: Pick<TaskPlanService, 'get'>,
  ) {}

  private read(threadId: string, messageId: number) {
    const thread = this.db.select().from(threads).where(
      and(eq(threads.id, threadId), eq(threads.status, 'active')),
    ).get()
    if (!thread) throw new AppError('NOT_FOUND', { message: '会话不存在' })
    if (thread.threadKind === 'main')
      throw new AppError('FORBIDDEN', { message: '主会话无法创建检查点分支' })
    if (thread.channel !== 'desktop' || thread.purpose !== 'conversation')
      throw new AppError('INVALID_PARAMETER', { message: '此会话不支持创建分支' })
    const selected = this.db.select().from(threadMessages).where(and(
      eq(threadMessages.threadId, threadId), eq(threadMessages.id, messageId),
      ne(threadMessages.status, 'deleted'), eq(threadMessages.role, 'assistant'),
    )).get()
    if (!selected) throw new AppError('NOT_FOUND', { message: '请选择已保存的角色回复创建分支' })
    const end = selected.pairId
      ? this.db.select({ id: sql<number>`max(${threadMessages.id})` }).from(threadMessages)
          .where(and(eq(threadMessages.threadId, threadId),
            eq(threadMessages.pairId, selected.pairId), ne(threadMessages.status, 'deleted'))).get()!.id
      : selected.id
    const messages = this.db.select().from(threadMessages).where(and(
      eq(threadMessages.threadId, threadId), ne(threadMessages.status, 'deleted'),
      sql`${threadMessages.id} <= ${end}`,
    )).orderBy(asc(threadMessages.id)).all()
    const attachments = this.db.select().from(messageAttachments).where(and(
      eq(messageAttachments.threadId, threadId), eq(messageAttachments.status, 'bound'),
      sql`${messageAttachments.messageId} IN (
        SELECT id FROM thread_messages WHERE thread_id = ${threadId}
        AND status != 'deleted' AND id <= ${end}
      )`,
    )).orderBy(asc(messageAttachments.id)).all()
    return { thread, messages, attachments }
  }

  async fork(sourceThreadId: string, messageId: number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const source = this.db.transaction(() => this.read(sourceThreadId, messageId))
    const targetThreadId = `thread_${randomUUID()}`
    const copies: CopiedAttachment[] = []
    try {
      // 附件字节独立保存，源会话永久清理后，新会话仍可读取自己的附件。
      for (const attachment of source.attachments) {
        signal?.throwIfAborted()
        const id = randomUUID()
        const storageKey = `${id.slice(0, 2)}/${id}`
        copies.push({ source: attachment, id, storageKey })
        const target = this.attachments.resolveStoragePath(storageKey)
        try {
          await mkdir(path.dirname(target), { recursive: true })
          await copyFile(this.attachments.resolveStoragePath(attachment.storageKey), target,
            constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
          const hash = createHash('sha256')
          for await (const chunk of createReadStream(target, { signal })) hash.update(chunk)
          if ((await stat(target)).size !== attachment.sizeBytes ||
            hash.digest('hex') !== attachment.sha256) throw new Error('FORK_ATTACHMENT_CHANGED')
        } catch (cause) {
          // 排他复制发生名称冲突时，已有文件属于其他记录。
          if ((cause as NodeJS.ErrnoException).code === 'EEXIST') copies.pop()
          signal?.throwIfAborted()
          throw new AppError('CONFLICT', { message: '会话附件复制失败，请稍后重试', cause })
        }
      }
      return await this.variables.forkThread(sourceThreadId, targetThreadId, (configuration) =>
        this.db.transaction((tx) => {
          signal?.throwIfAborted()
          const current = this.read(sourceThreadId, messageId)
          // 文件复制期间允许原会话继续追加；前缀被编辑、撤回或附件改变时整次复制回滚。
          const prefixVersion = (rows: typeof source.messages) =>
            JSON.stringify(rows.map(({ scorerStatus: _scorerStatus, ...row }) => row))
          if (prefixVersion(source.messages) !== prefixVersion(current.messages) ||
            JSON.stringify(source.attachments) !== JSON.stringify(current.attachments))
            throw new AppError('CONFLICT', { message: '来源记录已变化，请重新创建分支' })
          const now = new Date().toISOString()
          const active = current.messages.filter((row) => row.status === 'active')
          tx.insert(threads).values({
            ...current.thread, id: targetThreadId, threadKind: 'side', generation: 1,
            title: t('server.routers', '{0}（分支）', [current.thread.title || t('server.routers', '未命名会话')]),
            messageCount: active.length,
            pairCount: active.filter((row) => row.role === 'assistant').length,
            createdAt: sql`datetime('now', 'localtime')`,
            updatedAt: sql`datetime('now', 'localtime')`,
            lastMessageAt: sql`datetime('now', 'localtime')`,
          }).run()
          const pairs = new Map<string, string>()
          const messages = new Map<number, number>()
          const attachmentIds = new Map(copies.map((copy) => [copy.source.id, copy.id]))
          for (const row of current.messages) {
            if (row.pairId && !pairs.has(row.pairId)) pairs.set(row.pairId, randomUUID())
            const { id: _id, ...data } = row
            const copy = tx.insert(threadMessages).values({
              ...data, threadId: targetThreadId,
              publicationId: null, executionId: null,
              pairId: row.pairId ? pairs.get(row.pairId)! : null,
              scorerStatus: 'skipped', deletedAt: null, deletedBy: null,
            }).returning({ id: threadMessages.id }).get()!
            messages.set(row.id, copy.id)
          }
          const remap = (value: unknown, key = ''): unknown => {
            if (key === 'memorySourceRevisions' && value && typeof value === 'object' && !Array.isArray(value)) {
              return Object.fromEntries(Object.entries(value).flatMap(([id, revision]) =>
                messages.has(Number(id)) ? [[String(messages.get(Number(id))), revision]] : [],
              ))
            }
            if (key === 'historyRevisions' && Array.isArray(value))
              return value.flatMap((entry) => Array.isArray(entry) && messages.has(entry[0])
                ? [[messages.get(entry[0]), entry[1]]] : [])
            if (Array.isArray(value)) return value.map((item) => remap(item, key))
            if (value && typeof value === 'object')
              return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, remap(item, name)]))
            if (typeof value === 'number' && ['messageId', 'historyMessageId'].includes(key))
              return messages.get(value) ?? value
            if (typeof value !== 'string') return value
            if (key === 'threadId' && value === sourceThreadId) return targetThreadId
            if (['pairId', 'pairIds'].includes(key)) return pairs.get(value) ?? value
            if (['id', 'attachmentId', 'attachmentIds'].includes(key)) return attachmentIds.get(value) ?? value
            if (['result', 'args', 'arguments', 'content'].includes(key) && value.trimStart().startsWith('{')) {
              try {
                const parsed = JSON.parse(value)
                const rewritten = remap(parsed)
                if (JSON.stringify(parsed) !== JSON.stringify(rewritten)) return JSON.stringify(rewritten)
              } catch { /* 普通文本继续按资源引用处理。 */ }
            }
            return value.replace(/((?:\/api)?\/attachments\/|attachment:(?:\/\/)?)([\da-f-]{36})(?=\/|\b)/gi,
              (match, prefix: string, id: string) => attachmentIds.has(id) ? prefix + attachmentIds.get(id) : match)
          }
          const metadata = (raw: string | null) => {
            try {
              const value = JSON.parse(raw ?? '{}')
              return value && typeof value === 'object' && !Array.isArray(value)
                ? remap(value) as Record<string, unknown> : {}
            } catch { return {} }
          }
          for (const row of current.messages) tx.update(threadMessages).set({
            metadataJson: JSON.stringify({ ...metadata(row.metadataJson),
              forkOrigin: { threadId: sourceThreadId, messageId: row.id, checkpointMessageId: messageId },
            }),
          }).where(eq(threadMessages.id, messages.get(row.id)!)).run()
          for (const copy of copies) tx.insert(messageAttachments).values({
            ...copy.source, id: copy.id, storageKey: copy.storageKey,
            threadId: targetThreadId, messageId: messages.get(copy.source.messageId!)!,
            metadataJson: JSON.stringify(metadata(copy.source.metadataJson)),
          }).run()
          for (const row of tx.select().from(flowStates).where(eq(flowStates.threadId, sourceThreadId)).all())
            tx.insert(flowStates).values({ ...row, threadId: targetThreadId, updatedByPairId: null }).run()

          // 清理边界跟随当前会话状态继承，消息引用只映射检查点实际复制的部分。
          const boundary = tx.select().from(workContextClears).where(and(
            eq(workContextClears.threadId, sourceThreadId), eq(workContextClears.generation, current.thread.generation),
          )).orderBy(sql`${workContextClears.id} DESC`).get()
          if (boundary) tx.insert(workContextClears).values({
            threadId: targetThreadId, agentId: current.thread.agentId, generation: 1,
            pairId: pairs.get(boundary.pairId) ?? `fork:${targetThreadId}:context-clear`,
            toolCallId: boundary.toolCallId, executionIdsJson: '[]',
            messageIdsJson: JSON.stringify((JSON.parse(boundary.messageIdsJson) as number[])
              .flatMap((id) => messages.has(id) ? [messages.get(id)!] : [])), createdAt: now,
          }).run()
          // 角色状态按有效事件复制为基线，保留临时台词原有过期时间。
          const events = tx.select().from(threadCharacterStateEvents)
            .where(eq(threadCharacterStateEvents.threadId, sourceThreadId))
            .orderBy(asc(threadCharacterStateEvents.id)).all()
          const retracted = new Set(events.filter((row) => row.kind === 'retract').map((row) => row.pairId))
          const cleared = events.filter((row) => row.kind === 'clear').at(-1)?.id ?? 0
          for (const row of events) {
            if (row.kind !== 'update' || row.id <= cleared || (row.pairId && retracted.has(row.pairId))) continue
            tx.insert(threadCharacterStateEvents).values({
              threadId: targetThreadId, agentId: row.agentId, kind: 'update',
              patchJson: row.patchJson, createdAt: row.createdAt, pairId: null, toolCallId: null,
            }).run()
          }
          const plan = this.plans.get(sourceThreadId, current.thread.agentId)
          if (plan) {
            const row = {
              id: randomUUID(), threadId: targetThreadId, agentId: current.thread.agentId,
              taskId: null, taskRevision: null, revision: plan.revision, title: plan.title,
              status: plan.status, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
              stepsJson: JSON.stringify(plan.steps.map(({ id, title, status }) => ({ id, title, status }))),
            }
            tx.insert(taskPlans).values(row).run()
            // 独立基线防止旧消息撤回被误判为创建计划的轮次。
            tx.insert(taskPlanMutations).values({
              threadId: targetThreadId, agentId: row.agentId, pairId: `fork:${targetThreadId}`,
              beforeJson: JSON.stringify([row]), afterJson: JSON.stringify([row]), createdAt: now,
            }).run()
          }
          tx.insert(configs).values(configuration).onConflictDoUpdate({
            target: configs.key, set: { value: configuration.value, updatedAt: now },
          }).run()
          return targetThreadId
        }),
      )
    } catch (error) {
      await Promise.allSettled(copies.map((copy) => rm(this.attachments.resolveStoragePath(copy.storageKey), { force: true })))
      throw error
    }
  }
}
