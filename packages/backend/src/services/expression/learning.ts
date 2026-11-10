import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  ExpressionLearningOutcome,
  ExpressionLearningRecord,
  ExpressionLearningStatus,
  HandbookRule,
} from '@infos/shared'
import { ExpressionStore } from './store'
import { forbiddenHandbookText, handbookChars } from './handbook'
import { createLogger } from '../../lib/logger'
import { t } from '../../lib/i18n'

const logger = createLogger('ExpressionLearning')
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const MINUTE = 60_000
const MAX_WAIT_MS = 30 * MINUTE
const MAX_ATTEMPTS = 3
const MAX_TASKS = 20
/** 同一条回复上的批注不拆开，但也不能无限大，超过这个数才不得不拆。 */
const MAX_GROUP = 30
const MAX_INPUT_CHARS = 24_000
const REPLY_CHARS = 4000
const CONTEXT_CHARS = 1000
const MAX_CONTEXT_CHARS = 24_000
/** 系统时间被往回调时，记录的时间会落在未来；超过这个量就不再等它。 */
const CLOCK_SLACK_MS = MINUTE
// 只留明显在说她说话方式的词；普通聊天不进队列，也不会把学习时间往后推。宁可漏学。
const SPEECH_FEEDBACK =
  /语气|口吻|说话|人机|翻译腔|客服腔|复述|废话|啰嗦|(?:回复|回答)太|(?:别|不要|少)(?:老|总|再)?(?:说|讲|回|答|用|问|卖萌|复述)|以后(?:别|不要)(?:说|讲|回|答|用|问)/
export const looksLikeSpeechFeedback = (text: string) =>
  [...text.trim()].length <= 300 && SPEECH_FEEDBACK.test(text)

const operationSchema = z
  .object({
    action: z.enum(['add', 'update', 'reward', 'penalize']),
    id: z.string().nullish(),
    text: z.string().max(5000).nullish(),
    quote: z
      .string()
      .max(2000)
      .nullish()
      .transform((value) => value ?? ''),
    mergeIds: z
      .array(z.string())
      .max(20)
      .nullish()
      .transform((value) => value ?? []),
  })
  .strict()
const resultSchema = z
  .object({
    taskId: z.string(),
    confidence: z.number().min(0).max(1),
    operations: z.array(operationSchema).max(20),
  })
  .strict()
// 外壳不对多半是回复被截断，可以重试；单条不合格只跳过那一条。
const batchSchema = z.object({
  summary: z.string().max(300).nullish(),
  results: z.array(z.unknown()).max(200),
})

interface Task {
  id: string
  agentId: string
  kind: 'mark' | 'chat'
  sourceId: string
  revision: number
  fingerprint: string
  batchId: string | null
}
interface Batch {
  id: string
  agentId: string
  status: 'running' | 'waiting'
  base: string | null
  decision: string | null
  attempts: number
  nextRetryAt: number | null
}
type Source = {
  evidence: string
  threadId: string
  messageId: number
  reply: string
  markKind?: 'good' | 'robotic'
  markedQuote?: string
}
export interface LearningItem {
  taskId: string
  kind: 'mark' | 'chat'
  markKind?: 'good' | 'robotic'
  /** 用户在回复里选中的那句话；批注多半是在说它。 */
  markedQuote?: string
  evidence: string
  threadId: string
  /** 这条依据对应的消息，在 contexts 里能按 id 找到。 */
  messageId: number
  /** 她的那条回复，在 replies 里查；聊天纠正没有。 */
  replyId?: string
}
export interface LearningInput {
  agentId: string
  items: LearningItem[]
  replies: Record<string, string>
  /** 按对话分开；同一对话里多条依据的上下文合在一起，按消息顺序排。 */
  contexts: Record<string, { id: number; role: string; content: string }[]>
  rules: HandbookRule[]
}
export interface LearningOptions {
  /** 第 1、2 次失败后各等多久再试。 */
  retryDelaysMs?: number[]
  startupDelayMs?: number
  /** 学习时手册被改，稍等再按新手册重学，避免连续改手册时空转。 */
  conflictDelayMs?: number
}
type Due = { kind: 'retry'; batch: Batch } | { kind: 'new'; agentId: string }

export class ExpressionLearning {
  private running?: Promise<void>
  private stopped = false
  private controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private forced = new Set<string>()
  private notBefore = 0
  private readonly retryDelaysMs: number[]
  private readonly startupDelayMs: number
  private readonly conflictDelayMs: number
  constructor(
    private store: ExpressionStore,
    private model: (input: LearningInput, signal: AbortSignal) => Promise<string>,
    options: LearningOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? [MINUTE, 5 * MINUTE]
    this.startupDelayMs = options.startupDelayMs ?? 30_000
    this.conflictDelayMs = options.conflictDelayMs ?? 5_000
    store.handbook.onSettingsChanged = () => this.schedule()
  }
  start() {
    this.notBefore = Date.now() + this.startupDelayMs
    try {
      // 上次没跑完的批次：已存的模型结果还能用，没有结果的重新问。
      this.store.db
        .prepare(
          "UPDATE expression_learning_batches SET status='waiting',next_retry_at=? WHERE status='running'",
        )
        .run(this.notBefore)
      this.requeueOnce()
      this.relearnOldOnce()
    } catch (error) {
      this.warn(error)
    }
    this.schedule()
  }
  stop() {
    this.stopped = true
    this.controller.abort()
    if (this.timer) clearTimeout(this.timer)
    if (this.store.handbook.onSettingsChanged) this.store.handbook.onSettingsChanged = undefined
  }
  /** 旧版把合格的批注也判成失败，升级后补学一次；更早的批注从没进过队列，也补上。 */
  private requeueOnce() {
    const key = 'learning-requeue-v1',
      db = this.store.db
    if (process.env.INFOS_EXPRESSION_ENABLED === '0' || this.store.readState(key, false)) return
    const failed = db
      .prepare(
        "SELECT agent_id AS agentId,kind,source_id AS sourceId FROM expression_learning WHERE status='failed' AND last_error='invalid'",
      )
      .all() as Pick<Task, 'agentId' | 'kind' | 'sourceId'>[]
    for (const job of failed) this.enqueue(job.kind, job.agentId, job.sourceId, true)
    const unseen = db
      .prepare(
        "SELECT id,agent_id AS agentId FROM expression_marks WHERE note<>'' AND id NOT IN (SELECT source_id FROM expression_learning WHERE kind='mark') ORDER BY created_at DESC LIMIT 50",
      )
      .all() as { id: string; agentId: string }[]
    for (const mark of unseen) this.enqueue('mark', mark.agentId, mark.id)
    this.store.writeState(key, true)
  }
  /**
   * 旧版学过的批注没留结果，也可能是被旧提示词判成不学；手册里没有对应规则的补学一次。
   * 这些批注早就写好了，不用再等停手，启动保护期过后就学。
   */
  private relearnOldOnce() {
    const key = 'learning-relearn-old-v2',
      db = this.store.db
    if (process.env.INFOS_EXPRESSION_ENABLED === '0' || this.store.readState(key, false)) return
    const old = db
      .prepare(
        `SELECT l.agent_id AS agentId,l.source_id AS sourceId FROM expression_learning l
        JOIN expression_marks m ON m.id=l.source_id
        WHERE l.kind='mark' AND m.note<>'' AND l.status='done' AND l.outcome IS NULL
        AND COALESCE(l.rule_ids,'[]')='[]'
        AND l.revision=(SELECT MAX(revision) FROM expression_learning x WHERE x.agent_id=l.agent_id AND x.kind='mark' AND x.source_id=l.source_id)
        ORDER BY m.created_at DESC LIMIT 50`,
      )
      .all() as { agentId: string; sourceId: string }[]
    for (const job of old) {
      this.enqueue('mark', job.agentId, job.sourceId, true)
      db.prepare(
        "UPDATE expression_learning SET first_at=0 WHERE agent_id=? AND kind='mark' AND source_id=? AND status='pending'",
      ).run(job.agentId, job.sourceId)
    }
    this.store.writeState(key, true)
  }
  /** 用户要求重新学：开一个新修订，旧修订还在跑也提交不了。 */
  relearn(agentId: string, markId: string) {
    this.enqueue('mark', agentId, markId, true)
    return this.learnNow(agentId)
  }
  /** 这个角色立刻学；不删任何记录，只让它马上到点。 */
  learnNow(agentId: string): Promise<void> {
    if (this.stopped || !this.enabled(agentId)) return Promise.resolve()
    this.forced.add(agentId)
    return this.drain()
  }
  enqueue(kind: 'mark' | 'chat', agentId: string, sourceId: string, force = false) {
    if (!this.enabled(agentId)) return
    const source = this.source({ kind, agentId, sourceId })
    if (!source) return
    const db = this.store.db,
      fingerprint = hash(JSON.stringify(source))
    db.transaction(() => {
      const latest = db
        .prepare(
          'SELECT revision,fingerprint,status FROM expression_learning WHERE agent_id=? AND kind=? AND source_id=? ORDER BY revision DESC LIMIT 1',
        )
        .get(agentId, kind, sourceId) as
        | { revision: number; fingerprint: string; status: string }
        | undefined
      // 同样的内容不重复学，也不算新动作；改回原文时最新一条已经不同，会开新修订。
      if (!force && latest?.fingerprint === fingerprint && latest.status !== 'superseded') return
      const now = Date.now()
      // 编辑不能把「第一条的时间」往后推，否则 30 分钟上限会失效。
      const earlier = db
        .prepare(
          "SELECT MIN(first_at) AS firstAt FROM expression_learning WHERE agent_id=? AND kind=? AND source_id=? AND status='pending'",
        )
        .get(agentId, kind, sourceId) as { firstAt: number | null }
      db.prepare(
        "UPDATE expression_learning SET status='superseded' WHERE agent_id=? AND kind=? AND source_id=? AND status='pending'",
      ).run(agentId, kind, sourceId)
      db.prepare(
        'INSERT INTO expression_learning(id,agent_id,kind,source_id,revision,fingerprint,first_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        randomUUID(),
        agentId,
        kind,
        sourceId,
        (latest?.revision ?? 0) + 1,
        fingerprint,
        earlier.firstAt ?? now,
        now,
      )
    })()
    this.schedule()
  }
  private enabled(agentId: string) {
    return (
      process.env.INFOS_EXPRESSION_ENABLED !== '0' &&
      this.store.handbook.settings(agentId).learningEnabled
    )
  }
  private source(job: Pick<Task, 'kind' | 'agentId' | 'sourceId'>): Source | undefined {
    if (job.kind === 'mark')
      return this.store.db
        .prepare(
          `SELECT m.note AS evidence,m.kind AS markKind,m.quote AS markedQuote,m.thread_id AS threadId,m.message_id AS messageId,t.content AS reply
        FROM expression_marks m JOIN thread_messages t ON t.id=m.message_id JOIN threads th ON th.id=t.thread_id
        WHERE m.id=? AND m.agent_id=? AND t.role='assistant' AND t.deleted_at IS NULL
        AND COALESCE(t.status,'active')='active' AND COALESCE(t.revision,1)=m.source_revision
        AND m.thread_id=t.thread_id AND COALESCE(t.agent_id,th.agent_id)=m.agent_id`,
        )
        .get(job.sourceId, job.agentId) as Source | undefined
    return this.store.db
      .prepare(
        `SELECT m.content AS evidence,m.thread_id AS threadId,m.id AS messageId,'' AS reply FROM thread_messages m JOIN threads t ON t.id=m.thread_id
      WHERE m.id=? AND m.role='user' AND m.deleted_at IS NULL AND COALESCE(m.status,'active')='active'
      AND t.purpose='conversation' AND t.thread_kind='main' AND t.agent_id=?`,
      )
      .get(job.sourceId, job.agentId) as Source | undefined
  }
  observeChat(agentId: string, threadId: string) {
    const row = this.store.db
      .prepare(
        `SELECT m.id,m.content FROM thread_messages m JOIN threads t ON t.id=m.thread_id WHERE m.thread_id=? AND t.agent_id=? AND t.purpose='conversation' AND t.thread_kind='main' AND m.role='user' AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1`,
      )
      .get(threadId, agentId) as { id: number; content: string } | undefined
    if (row && looksLikeSpeechFeedback(row.content)) this.enqueue('chat', agentId, String(row.id))
  }
  /** 时间都从数据库算，重启和休眠都不会丢；定时器只是提醒，到点后还会再核对一遍。 */
  private plan(now: number): { due?: Due; wakeAt?: number } {
    const db = this.store.db
    let wakeAt: number | undefined
    const later = (at: number) => {
      wakeAt = wakeAt === undefined ? at : Math.min(wakeAt, at)
    }
    const batches = db
      .prepare(
        "SELECT id,agent_id AS agentId,status,base,decision,attempts,next_retry_at AS nextRetryAt FROM expression_learning_batches WHERE status='waiting' ORDER BY created_at,rowid",
      )
      .all() as Batch[]
    for (const batch of batches) {
      if (!this.enabled(batch.agentId)) continue
      const at = batch.nextRetryAt ?? 0
      if (this.forced.has(batch.agentId) || at <= now) return { due: { kind: 'retry', batch } }
      // 重试时间最多是几分钟后；落得太远只可能是系统时间被改过。
      if (at > now + 10 * MINUTE) return { due: { kind: 'retry', batch } }
      later(at)
    }
    const agents = db
      .prepare(
        "SELECT agent_id AS agentId,MIN(first_at) AS firstAt,MAX(created_at) AS lastAt FROM expression_learning WHERE status='pending' AND batch_id IS NULL GROUP BY agent_id",
      )
      .all() as { agentId: string; firstAt: number; lastAt: number }[]
    const busy = new Set(
      (
        db.prepare('SELECT DISTINCT agent_id AS agentId FROM expression_learning_batches').all() as {
          agentId: string
        }[]
      ).map((row) => row.agentId),
    )
    for (const agent of agents) {
      // 上一批没结束时，新内容留给下一批。
      if (busy.has(agent.agentId) || !this.enabled(agent.agentId)) continue
      if (this.forced.has(agent.agentId)) return { due: { kind: 'new', agentId: agent.agentId } }
      const at = this.dueAt(agent)
      if (at <= now || agent.firstAt > now + CLOCK_SLACK_MS) {
        if (now >= this.notBefore) return { due: { kind: 'new', agentId: agent.agentId } }
      }
      later(at)
    }
    return { wakeAt }
  }
  private dueAt(agent: { agentId: string; firstAt: number; lastAt: number }) {
    const idle = this.store.handbook.settings(agent.agentId).learningIdleMinutes * MINUTE
    return Math.max(
      Math.min(agent.lastAt + idle, agent.firstAt + Math.max(idle, MAX_WAIT_MS)),
      this.notBefore,
    )
  }
  /** 给手册页看：现在在干什么、下次什么时候学、最近每条的结果。 */
  status(agentId: string): ExpressionLearningStatus {
    const db = this.store.db
    const batch = db
      .prepare(
        'SELECT status,attempts,next_retry_at AS nextRetryAt FROM expression_learning_batches WHERE agent_id=? ORDER BY created_at,rowid LIMIT 1',
      )
      .get(agentId) as { status: string; attempts: number; nextRetryAt: number | null } | undefined
    const queue = db
      .prepare(
        "SELECT count(*) AS pending,MIN(first_at) AS firstAt,MAX(created_at) AS lastAt FROM expression_learning WHERE agent_id=? AND status='pending'",
      )
      .get(agentId) as { pending: number; firstAt: number | null; lastAt: number | null }
    const rows = db
      .prepare(
        `SELECT id,kind,source_id AS sourceId,status,outcome,rule_ids AS ruleIds,created_at AS createdAt,finished_at AS finishedAt
        FROM expression_learning l WHERE agent_id=? AND status<>'superseded'
        AND revision=(SELECT MAX(revision) FROM expression_learning x WHERE x.agent_id=l.agent_id AND x.kind=l.kind AND x.source_id=l.source_id AND x.status<>'superseded')
        ORDER BY COALESCE(finished_at,created_at) DESC,rowid DESC LIMIT 100`,
      )
      .all(agentId) as {
      id: string
      kind: 'mark' | 'chat'
      sourceId: string
      status: 'pending' | 'done' | 'failed'
      outcome: ExpressionLearningOutcome | null
      ruleIds: string | null
      createdAt: number
      finishedAt: number | null
    }[]
    const rules = this.store.handbook.rules(agentId)
    const recent: ExpressionLearningRecord[] = rows.map((row) => {
      const ids: string[] = row.ruleIds ? JSON.parse(row.ruleIds) : []
      const source = this.source({ kind: row.kind, agentId, sourceId: row.sourceId })
      const text = source?.evidence || source?.markedQuote || ''
      return {
        id: row.id,
        kind: row.kind,
        text: [...text].slice(0, 80).join(''),
        ...(source?.reply ? { reply: [...source.reply].slice(0, 60).join('') } : {}),
        status: row.status,
        outcome: row.outcome,
        ruleTexts: rules.filter((rule) => ids.includes(rule.id)).map((rule) => rule.text),
        at: row.finishedAt ?? row.createdAt,
      }
    })
    const base = { pending: queue.pending, attempts: batch?.attempts ?? 0, recent }
    if (!this.enabled(agentId))
      return { ...base, state: queue.pending ? 'paused' : 'idle', nextAt: null }
    if (batch?.status === 'running') return { ...base, state: 'learning', nextAt: null }
    if (batch) return { ...base, state: 'retrying', nextAt: batch.nextRetryAt }
    if (queue.pending && queue.firstAt !== null && queue.lastAt !== null)
      return {
        ...base,
        state: 'waiting',
        nextAt: this.dueAt({ agentId, firstAt: queue.firstAt, lastAt: queue.lastAt }),
      }
    return { ...base, state: 'idle', nextAt: null }
  }
  private schedule() {
    if (this.stopped || this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const now = Date.now(),
      { due, wakeAt } = this.plan(now)
    if (due) {
      this.timer = setTimeout(() => void this.drain(), 0)
      this.timer.unref?.()
    } else if (wakeAt !== undefined) {
      // 系统时间可能被改，最多隔 30 分钟重新核对一次。
      this.timer = setTimeout(() => void this.drain(), Math.min(Math.max(wakeAt - now, 0), MAX_WAIT_MS))
      this.timer.unref?.()
    }
  }
  drain(): Promise<void> {
    this.running ??= this.runDue().finally(() => {
      this.running = undefined
      // 跑的时候来的通知不能丢：退出时一定重新算下一次。
      this.schedule()
    })
    return this.running
  }
  private async runDue() {
    while (!this.stopped) {
      const { due } = this.plan(Date.now())
      if (!due) return
      const agentId = due.kind === 'new' ? due.agentId : due.batch.agentId
      const forced = this.forced.delete(agentId)
      try {
        const batch = due.kind === 'retry' ? due.batch : this.formBatch(due.agentId)
        if (batch) await this.execute(batch)
      } catch (error) {
        // 一个角色出错不挡其他角色。
        this.warn(error)
      }
      // 「现在就学」要把放不下的也学完；这批失败在等重试时不抢跑，也不空转。
      if (forced && this.hasWaiting(agentId)) this.forced.add(agentId)
    }
  }
  private hasWaiting(agentId: string) {
    const db = this.store.db
    return (
      !db.prepare('SELECT 1 FROM expression_learning_batches WHERE agent_id=?').get(agentId) &&
      !!db
        .prepare(
          "SELECT 1 FROM expression_learning WHERE agent_id=? AND status='pending' AND batch_id IS NULL",
        )
        .get(agentId)
    )
  }
  private warn(error: unknown) {
    logger.warn(t('logs.agent', '表达手册学习失败，聊天不受影响'), {
      reason: String(error instanceof Error ? error.message : error).slice(0, 300),
    })
  }
  private tasksOf(batchId: string) {
    return this.store.db
      .prepare(
        "SELECT id,agent_id AS agentId,kind,source_id AS sourceId,revision,fingerprint,batch_id AS batchId FROM expression_learning WHERE batch_id=? AND status='pending' ORDER BY first_at,created_at,rowid",
      )
      .all(batchId) as Task[]
  }
  /** 这条任务现在还算不算数：必须是这个来源的最新修订，内容也没变。 */
  private current(task: Task): Source | undefined {
    const latest = this.store.db
      .prepare(
        'SELECT MAX(revision) AS revision FROM expression_learning WHERE agent_id=? AND kind=? AND source_id=?',
      )
      .get(task.agentId, task.kind, task.sourceId) as { revision: number }
    if (latest.revision !== task.revision) return undefined
    const source = this.source(task)
    return source && hash(JSON.stringify(source)) === task.fingerprint ? source : undefined
  }
  /** 选定这批成员并固定下来；之后来的内容进下一批。 */
  private formBatch(agentId: string): Batch | undefined {
    const db = this.store.db,
      setStatus = db.prepare('UPDATE expression_learning SET status=? WHERE id=?')
    return db.transaction(() => {
      const tasks = db
        .prepare(
          "SELECT id,agent_id AS agentId,kind,source_id AS sourceId,revision,fingerprint,batch_id AS batchId FROM expression_learning WHERE agent_id=? AND status='pending' AND batch_id IS NULL ORDER BY first_at,created_at,rowid",
        )
        .all(agentId) as Task[]
      const hasRules = this.store.handbook.rules(agentId).length > 0
      const groups = new Map<string, { task: Task; size: number }[]>()
      for (const task of tasks) {
        const source = this.current(task)
        if (!source) setStatus.run('superseded', task.id)
        // 没写批注只能给已有规则加减分；手册是空的就没什么可做，不用调模型。
        else if (!source.evidence && !hasRules)
          db.prepare(
            "UPDATE expression_learning SET status='done',outcome='no_rule',finished_at=? WHERE id=?",
          ).run(Date.now(), task.id)
        else {
          const key = task.kind === 'mark' ? `reply:${source.messageId}` : `chat:${task.id}`
          const list = groups.get(key) ?? []
          list.push({
            task,
            size: source.evidence.length + Math.min(source.reply.length, REPLY_CHARS),
          })
          groups.set(key, list)
        }
      }
      const members: Task[] = []
      let chars = 0
      for (const group of groups.values()) {
        const size = group.reduce((sum, item) => sum + item.size, 0)
        if (members.length && (members.length + group.length > MAX_TASKS || chars + size > MAX_INPUT_CHARS))
          break
        members.push(...group.slice(0, MAX_GROUP).map((item) => item.task))
        chars += size
      }
      if (!members.length) return undefined
      const batch: Batch = {
        id: randomUUID(),
        agentId,
        status: 'running',
        base: null,
        decision: null,
        attempts: 0,
        nextRetryAt: null,
      }
      db.prepare(
        "INSERT INTO expression_learning_batches(id,agent_id,status,attempts,created_at) VALUES (?,?,'running',0,?)",
      ).run(batch.id, agentId, Date.now())
      const join = db.prepare('UPDATE expression_learning SET batch_id=? WHERE id=?')
      for (const task of members) join.run(batch.id, task.id)
      return batch
    })()
  }
  private buildInput(agentId: string, tasks: Task[], rules: HandbookRule[]): LearningInput {
    const db = this.store.db,
      items: LearningItem[] = [],
      replies: LearningInput['replies'] = {},
      seen = new Map<string, Map<number, { id: number; role: string; content: string }>>()
    let contextChars = 0
    for (const task of tasks) {
      const source = this.current(task)
      if (!source) continue
      const replyId = task.kind === 'mark' ? String(source.messageId) : undefined
      if (replyId) replies[replyId] = source.reply.slice(0, REPLY_CHARS)
      items.push({
        taskId: task.id,
        kind: task.kind,
        markKind: source.markKind,
        markedQuote: source.markedQuote,
        evidence: source.evidence,
        threadId: source.threadId,
        messageId: source.messageId,
        replyId,
      })
      // 每条取自己那条消息往前的上下文，同一对话里重复的只留一份；总量到顶后只剩回复本身。
      if (contextChars >= MAX_CONTEXT_CHARS) continue
      const thread = seen.get(source.threadId) ?? new Map()
      seen.set(source.threadId, thread)
      const window = db
        .prepare(
          "SELECT id,role,content FROM thread_messages WHERE thread_id=? AND id<=? AND role IN ('user','assistant') AND deleted_at IS NULL ORDER BY id DESC LIMIT 8",
        )
        .all(source.threadId, source.messageId) as { id: number; role: string; content: string }[]
      for (const row of window) {
        if (thread.has(row.id)) continue
        const content = row.content.slice(0, CONTEXT_CHARS)
        thread.set(row.id, { id: row.id, role: row.role, content })
        contextChars += content.length
      }
    }
    const contexts: LearningInput['contexts'] = {}
    for (const [threadId, thread] of seen)
      contexts[threadId] = [...thread.values()].sort((a, b) => a.id - b.id)
    return { agentId, items, replies, contexts, rules }
  }
  private async execute(batch: Batch) {
    const db = this.store.db,
      tasks = this.tasksOf(batch.id)
    if (!tasks.length) {
      db.prepare('DELETE FROM expression_learning_batches WHERE id=?').run(batch.id)
      return
    }
    db.prepare("UPDATE expression_learning_batches SET status='running' WHERE id=?").run(batch.id)
    const before = this.store.handbook.rules(batch.agentId),
      base = hash(JSON.stringify(before))
    // 存着的结果只有手册没变时才能用。
    let raw = batch.base === base ? batch.decision : null
    if (raw === null) {
      try {
        raw = await this.model(this.buildInput(batch.agentId, tasks, before), this.controller.signal)
        const parsed = batchSchema.parse(
          JSON.parse(
            raw
              .trim()
              .replace(/^```(?:json)?\s*/i, '')
              .replace(/\s*```$/, ''),
          ),
        )
        raw = JSON.stringify(parsed)
      } catch (error) {
        if (!this.stopped) this.failAttempt(batch, error)
        return
      }
      if (this.stopped) return
      // 模型结果先存下来；写入和完成回执在同一事务，崩溃后不会重复加分。
      db.prepare('UPDATE expression_learning_batches SET base=?,decision=? WHERE id=?').run(
        base,
        raw,
        batch.id,
      )
    }
    try {
      this.commit(batch, before, batchSchema.parse(JSON.parse(raw)))
    } catch (error) {
      db.prepare(
        "UPDATE expression_learning SET status='failed',last_error='invalid',outcome='error',finished_at=?,batch_id=NULL WHERE batch_id=? AND status='pending'",
      ).run(Date.now(), batch.id)
      db.prepare('DELETE FROM expression_learning_batches WHERE id=?').run(batch.id)
      this.warn(error)
    }
  }
  /** 模型连不上或回复被截断：隔一会儿重试，这批成员不变。 */
  private failAttempt(batch: Batch, error: unknown) {
    const db = this.store.db,
      attempts = batch.attempts + 1
    if (attempts < MAX_ATTEMPTS) {
      const delay = this.retryDelaysMs[attempts - 1] ?? this.retryDelaysMs.at(-1) ?? MINUTE
      db.prepare(
        "UPDATE expression_learning_batches SET status='waiting',attempts=?,next_retry_at=? WHERE id=?",
      ).run(attempts, Date.now() + delay, batch.id)
      this.warn(error)
      return
    }
    db.transaction(() => {
      db.prepare(
        "UPDATE expression_learning SET status='failed',last_error='model',outcome='model_failed',finished_at=?,attempts=?,batch_id=NULL WHERE batch_id=? AND status='pending'",
      ).run(Date.now(), attempts, batch.id)
      db.prepare('DELETE FROM expression_learning_batches WHERE id=?').run(batch.id)
    })()
    this.warn(error)
  }
  private commit(
    batch: Batch,
    before: HandbookRule[],
    decision: z.infer<typeof batchSchema>,
  ) {
    const db = this.store.db,
      handbook = this.store.handbook
    db.transaction(() => {
      // 关掉学习是暂停：结果留着，重新打开后接着提交。
      if (!this.enabled(batch.agentId)) {
        db.prepare(
          "UPDATE expression_learning_batches SET status='waiting',next_retry_at=0 WHERE id=?",
        ).run(batch.id)
        return
      }
      // 手册变了就按新手册重学；这不是故障，不扣重试次数。
      if (JSON.stringify(before) !== JSON.stringify(handbook.rules(batch.agentId))) {
        db.prepare(
          "UPDATE expression_learning_batches SET status='waiting',base=NULL,decision=NULL,next_retry_at=? WHERE id=?",
        ).run(Date.now() + this.conflictDelayMs, batch.id)
        return
      }
      // 来源只认服务端的任务记录，模型自报什么都不算。
      const results = new Map<string, z.infer<typeof resultSchema>>()
      for (const item of decision.results) {
        const parsed = resultSchema.safeParse(item)
        if (parsed.success && !results.has(parsed.data.taskId))
          results.set(parsed.data.taskId, parsed.data)
      }
      let rules = structuredClone(before)
      let textChanged = false
      const touchedAll = new Set<string>()
      const links: { markId: string; ruleId: string; note: string }[] = []
      const finished: { task: Task; ruleIds: string[]; outcome: ExpressionLearningOutcome }[] = []
      const setStatus = db.prepare('UPDATE expression_learning SET status=? WHERE id=?')
      for (const task of this.tasksOf(batch.id)) {
        const source = this.current(task)
        // 已被新修订取代或内容变了：这条结果作废，不写手册。
        if (!source) {
          setStatus.run('superseded', task.id)
          continue
        }
        const result = results.get(task.id)
        if (!result || !result.operations.length) {
          finished.push({ task, ruleIds: [], outcome: 'nothing' })
          continue
        }
        if (result.confidence < 0.9) {
          finished.push({ task, ruleIds: [], outcome: 'low_confidence' })
          continue
        }
        if (forbiddenHandbookText(source.evidence)) {
          finished.push({ task, ruleIds: [], outcome: 'forbidden' })
          continue
        }
        const applied = this.applyOperations(
          task,
          source,
          result,
          rules,
          touchedAll,
          handbook.settings(batch.agentId).handbookMaxChars,
        )
        if (!applied.touched.size) {
          finished.push({ task, ruleIds: [], outcome: applied.reason })
          continue
        }
        rules = applied.rules
        textChanged ||= applied.textChanged
        for (const id of applied.touched) touchedAll.add(id)
        if (task.kind === 'mark' && source.evidence)
          for (const ruleId of applied.touched)
            links.push({ markId: task.sourceId, ruleId, note: source.evidence })
        finished.push({
          task,
          ruleIds: [...applied.touched],
          outcome: applied.textChanged ? 'learned' : 'scored',
        })
      }
      for (const link of links)
        if (rules.some((r) => r.id === link.ruleId))
          db.prepare('INSERT OR REPLACE INTO expression_mark_rules VALUES (?,?,?)').run(
            link.markId,
            link.ruleId,
            link.note,
          )
      if (touchedAll.size)
        // 只加减分时手册文字没变，不算一个版本。
        handbook.save(
          batch.agentId,
          rules,
          'learn',
          textChanged ? decision.summary?.trim() || t('server.routers', '学到新的说话习惯') : null,
        )
      const done = db.prepare(
        "UPDATE expression_learning SET status='done',rule_ids=?,outcome=?,finished_at=?,batch_id=NULL WHERE id=?",
      )
      const finishedAt = Date.now()
      for (const item of finished)
        done.run(JSON.stringify(item.ruleIds), item.outcome, finishedAt, item.task.id)
      db.prepare(
        "UPDATE expression_learning SET batch_id=NULL WHERE batch_id=? AND status='superseded'",
      ).run(batch.id)
      db.prepare('DELETE FROM expression_learning_batches WHERE id=?').run(batch.id)
    })()
  }
  /** 只改副本：这条不合格或放不下时，不影响同批其他条。 */
  private applyOperations(
    task: Task,
    source: Source,
    result: z.infer<typeof resultSchema>,
    current: HandbookRule[],
    protectedIds: Set<string>,
    limit: number,
  ) {
    let rules = structuredClone(current)
    const touched = new Set<string>(),
      now = Date.now(),
      skipped: string[] = []
    let textChanged = false
    // 模型提的每一条单独判断：不合格的这条跳过，不连累同一次里合格的，也不算学习失败。
    for (const op of result.operations) {
      const existing = rules.find((r) => r.id === op.id)
      const text = op.text?.trim() ?? ''
      // 手册里没有对应规则却要改或加减分：带了规律正文就当新增，否则这条没有意义。
      const action = op.action !== 'add' && !existing && text ? 'add' : op.action
      const scoreOnly = action === 'reward' || action === 'penalize'
      if (action !== 'add' && !existing) {
        skipped.push('UNKNOWN_RULE')
        continue
      }
      if (
        scoreOnly &&
        task.kind === 'mark' &&
        (action === 'reward') !== (source.markKind === 'good')
      ) {
        skipped.push('SCORE_DIRECTION')
        continue
      }
      if (!scoreOnly || task.kind === 'chat') {
        // 引用只和这条任务自己的依据核对；太短（比如一个「别」字）什么都能对上，不算。
        const minQuote = Math.max(1, Math.min(4, [...source.evidence.trim()].length))
        if (
          !source.evidence.trim() ||
          [...op.quote.trim()].length < minQuote ||
          !source.evidence.includes(op.quote)
        ) {
          skipped.push('EVIDENCE')
          continue
        }
      }
      if (!scoreOnly && !text) {
        skipped.push('TEXT_REQUIRED')
        continue
      }
      if (forbiddenHandbookText(op.quote) || (!scoreOnly && forbiddenHandbookText(text))) {
        skipped.push('FORBIDDEN_CONTENT')
        continue
      }
      if (existing && touched.has(existing.id)) {
        skipped.push('DUPLICATE_RULE_OPERATION')
        continue
      }
      const origin: HandbookRule['source'] = {
        kind: task.kind,
        threadId: source.threadId,
        messageId: String(source.messageId),
        quote: op.quote,
        ...(task.kind === 'mark' ? { markId: task.sourceId, markKind: source.markKind } : {}),
      }
      let rule = action === 'add' ? undefined : existing
      if (scoreOnly) {
        rule!.score += action === 'reward' ? 1 : -1
        rule!.lastMatchedAt = now
        rule!.updatedAt = now
      } else {
        textChanged = true
        if (action === 'add')
          rule = rules.find((r) => r.text.replace(/\s/g, '') === text.replace(/\s/g, ''))
        if (rule) {
          rule.text = text
          rule.source = origin
          rule.updatedAt = now
          rule.lastMatchedAt = now
        } else {
          rule = {
            id: randomUUID(),
            agentId: task.agentId,
            text,
            score: 0,
            source: origin,
            lastMatchedAt: now,
            createdAt: now,
            updatedAt: now,
          }
          rules.push(rule)
        }
        const kept = rule
        rules = rules.filter((r) => r.id === kept.id || !op.mergeIds.includes(r.id))
      }
      touched.add(rule!.id)
    }
    if (skipped.length) logger.info(t('logs.agent', '表达手册学习跳过了不合格的内容'), { skipped })
    const nothing = (reason: ExpressionLearningOutcome) => ({
      rules: current,
      touched: new Set<string>(),
      textChanged: false,
      reason,
    })
    if (!touched.size)
      return nothing(
        skipped.includes('FORBIDDEN_CONTENT')
          ? 'forbidden'
          : skipped.includes('EVIDENCE')
            ? 'evidence'
            : 'rejected',
      )
    // 这批命中的规则不立即淘汰；先删低分、长期未命中的旧规律。
    const victims = rules
      .filter((r) => !touched.has(r.id) && !protectedIds.has(r.id))
      .sort(
        (a, b) =>
          a.score - b.score ||
          (a.lastMatchedAt ?? 0) - (b.lastMatchedAt ?? 0) ||
          a.createdAt - b.createdAt,
      )
    while (handbookChars(rules) > limit && victims.length) {
      const victim = victims.shift()!
      rules = rules.filter((r) => r.id !== victim.id)
    }
    // 放不下就放弃这一条，同批其他条照常。
    if (handbookChars(rules) > limit) {
      logger.info(t('logs.agent', '表达手册学习跳过了不合格的内容'), { skipped: ['HANDBOOK_FULL'] })
      return nothing('full')
    }
    return { rules, touched, textChanged, reason: 'learned' as ExpressionLearningOutcome }
  }
}
