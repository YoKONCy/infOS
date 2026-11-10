import { createHash } from 'node:crypto'
import { normalizeExpressionQuote, type EventNote, type HomeActivity } from '@infos/shared'
import { ExpressionStore } from './store'
import { settings, type Note, type Nudge, type Glow } from './algorithmTypes'
import { slimNote, pickMemories, idfTable, relevanceOf } from './recall.mjs'
import { glowFromNote, pickGlow, mergeGlows } from './afterglow.mjs'
import { findPatterns, decideNudge, markNudge, nudgeLine } from './repetition.mjs'
import { compose } from './compose.mjs'
import { terms, clip } from './text.mjs'
import { createLogger } from '../../lib/logger'
import { t } from '../../lib/i18n'
import type { ExpressionLearning } from './learning'

const logger = createLogger('Expression')

interface State {
  cooldown: Record<string, number>
  turn: number
  memoryTurn: number
  nudge: Nudge
  lastRun?: string
  lastContent?: string
  sourceKey?: string
}
export interface SelectionInput {
  agentId: string
  threadId: string
  channel: string
  query: string
  notes?: EventNote[]
  preview?: boolean
  runId?: string
  generation?: number
  now?: number
}
export class ExpressionService {
  learning?: ExpressionLearning
  constructor(
    readonly store: ExpressionStore,
    private activities: (agentId: string, from: number) => HomeActivity[] = () => [],
  ) {}
  /** 直接消费内部事件，不注册插件，不开放工具或动态能力。检索素材仍以本轮通过隐私筛选的结果为准。 */
  observe(event: string, data: unknown) {
    // 表达层只是附加素材，出错只跳过，不能拖垮记忆和聊天主流程。
    try {
      this.consume(event, data)
    } catch (error) {
      logger.warn(t('logs.agent', '表达层事件处理失败，已跳过'), { event, error })
    }
  }
  private consume(event: string, data: unknown) {
    const value = data as {
      agentId?: string
      threadId?: string
      channel?: string
      realmId?: string
      text?: string
      note?: EventNote
      notes?: EventNote[]
      result?: { notes?: EventNote[] }
    }
    if (
      event === 'chat:beforeSend' &&
      !value.realmId &&
      value.agentId &&
      value.threadId &&
      (!value.channel || value.channel === 'desktop')
    )
      this.learning?.observeChat(value.agentId, value.threadId)
    if (event === 'memory:afterCreate' || event === 'memory:afterRetrieve') {
      const agentId = value.note?.agentId ?? value.agentId
      const notes = value.note ? [value.note] : (value.notes ?? value.result?.notes ?? [])
      if (agentId && notes.length) {
        const now = Date.now(),
          key = `glows:${agentId}`
        const glows = this.store.readState<Glow[]>(key, [])
        this.store.writeState(
          key,
          mergeGlows(
            glows,
            notes.map((n) => glowFromNote(n, now, settings)),
            now,
            settings,
          ),
        )
      }
    }
  }
  private replyHistory(agentId: string, threadId: string) {
    const items = this.store.db
      .prepare(
        `SELECT content AS text FROM thread_messages WHERE thread_id=?
      AND role='assistant' AND agent_id=? AND status='active' AND deleted_at IS NULL ORDER BY id DESC LIMIT 60`,
      )
      .all(threadId, agentId) as { text: string }[]
    const count = this.store.db.prepare(
      "SELECT count(*) AS total FROM thread_messages WHERE thread_id=? AND agent_id=? AND role='assistant' AND status='active' AND deleted_at IS NULL",
    ).get(threadId, agentId) as { total: number }
    return { seq: count.total, items: items.reverse() }
  }
  select(input: SelectionInput): string {
    try {
      return this.pick(input)
    } catch (error) {
      logger.warn(t('logs.agent', '表达层素材挑选失败，本轮不注入'), { error })
      return ''
    }
  }
  private pick(input: SelectionInput): string {
    if (
      !['desktop', 'group'].includes(input.channel) ||
      process.env.INFOS_EXPRESSION_ENABLED === '0'
    )
      return ''
    const materials = this.store.handbook.settings(input.agentId).materials
    if (!materials.enabled) return ''
    const now = input.now ?? Date.now(),
      key = `selection:${input.agentId}:${input.threadId}:${input.generation ?? 1}`
    const state = this.store.readState<State>(key, {
      cooldown: {},
      turn: 0,
      memoryTurn: -2,
      nudge: {},
    })
    const notes = (input.notes ?? []).map(slimNote).filter((v): v is Note => !!v)
    const marks = this.store
      .candidates(input.agentId, input.threadId)
      .map((m) => ({ ...m, quote: this.store.visibleQuote(m) }))
    const replies = input.channel === 'desktop'
      ? this.replyHistory(input.agentId, input.threadId)
      : { seq: 0, items: [] }
    // 同次执行复用素材前核对来源，编辑、撤回或删除后即使执行编号相同也重新选择。
    const sourceKey = createHash('sha256').update(JSON.stringify({
      query: input.query,
      marks,
      notes,
      materials,
      rules: this.store.handbook.rules(input.agentId),
      replies,
    })).digest('hex')
    if (input.runId && state.lastRun === input.runId && state.sourceKey === sourceKey && !input.preview)
      return state.lastContent ?? ''
    const pool = marks.map((m) => ({ id: m.id, narrative: `${m.quote} ${m.note}` }))
    const queryTerms = terms(input.query),
      idf = idfTable(queryTerms, pool)
    const relevant = marks.filter((_m, i) => relevanceOf(pool[i]!, queryTerms, idf) >= 0.34)
    const relevantIds = new Set(relevant.map((mark) => mark.id))
    const feedback = materials.notes
      ? marks.filter((mark, index) =>
          (mark.note || mark.kind === 'robotic') &&
          !this.store.handbook.noteLearned(mark.id, mark.note) &&
          (index < 3 || relevantIds.has(mark.id)),
        ).slice(0, 3)
      : []
    const quotes = (materials.goodQuotes ? relevant : [])
      .filter(
        (m) =>
          m.kind === 'good' &&
          m.quote &&
          now - (state.cooldown[`quote:${m.id}`] ?? 0) >= 48 * 3600000,
      )
      .slice(0, 3)
    const memories =
      materials.memories && state.turn - state.memoryTurn > 1
        ? pickMemories({
            query: input.query,
            candidates: notes,
            ragIds: notes.map((n) => n.id),
            cooldown: state.cooldown,
            now,
            settings,
          })
        : []
    // 持久余温必须再次匹配本轮可见记忆的正文；删除、归档、编辑或隐私变化后不能继续引用旧副本。
    const freshGlows = notes
      .filter((n) => !n.status || n.status === 'active')
      .map((n) => glowFromNote(n, now, settings))
      .filter((g): g is Glow => !!g)
    const storedGlows = this.store
      .readState<Glow[]>(`glows:${input.agentId}`, [])
      .filter((g) => freshGlows.some((n) => n.id === g.id && n.text === g.text))
    const glow = materials.memories
      ? pickGlow(
          mergeGlows(storedGlows, freshGlows, now, settings),
          now,
          settings,
          memories.map((m) => m.id),
        )
      : undefined
    const nudge = materials.repetition
      ? decideNudge({
          patterns: findPatterns(replies.items, settings),
          nudge: state.nudge,
          seq: replies.seq,
          now,
          settings,
        })
      : undefined
    const day = new Date(now).toLocaleDateString('en-CA'),
      start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const dayKey = `day:${input.agentId}`
    const activity =
      materials.activity && this.store.readState(dayKey, '') !== day
        ? this.activities(input.agentId, start.getTime()).find(
            (a) => a.result === 'success' && a.time <= now,
          )
        : undefined
    const lines: { text: string; canClip?: boolean; commit?: () => void }[] = []
    const seenFeedback = new Set<string>()
    for (const mark of feedback) {
      const note = mark.note || '这条回复被标为人机'
      const key = normalizeExpressionQuote(note)
      if (seenFeedback.has(key)) continue
      seenFeedback.add(key)
      lines.push({
        text: `用户${mark.kind === 'good' ? '喜欢' : '希望调整'}的表达（消息 ${mark.messageId}）：` +
          `${clip(note, 120)}${mark.quote ? `；对应「${clip(mark.quote, 40)}」` : ''}`,
        canClip: true,
      })
    }
    for (const quote of quotes) {
      // 对味原话不截断，保证是原文；过长的留待用户选择较短的句子。
      if ([...quote.quote].length <= 70)
        lines.push({
          text: `对味原话：${quote.quote}`,
          commit: () => {
            state.cooldown[`quote:${quote.id}`] = now
          },
        })
    }
    const memory = compose({ memories, glow, now, maxChars: 145 })
    if (memory)
      lines.push({
        text: memory,
        commit: () => {
          for (const m of memories) state.cooldown[m.id] = now
          if (memories.length) state.memoryTurn = state.turn
        },
      })
    if (nudge)
      lines.push({
        text: nudgeLine(nudge),
        commit: () => {
          state.nudge = markNudge(state.nudge, nudge, replies.seq, now, settings)
        },
      })
    if (activity)
      lines.push({
        text: `今日真实活动：${clip(activity.action, 20)}；${clip(activity.objects.join('、'), 35)}`,
        commit: () => {
          this.store.writeState(dayKey, day)
        },
      })
    // 说话标准只有选中真实素材时出现，不制造空注入。总预算含外层 package_context 标签。
    let result = '本轮表达参考，按语境理解用户偏好，原话仅作表达示例。'
    const commits: (() => void)[] = []
    let count = 0
    for (const line of lines) {
      const remaining = materials.maxChars - 37 - [...result].length - 1
      if (remaining < 30) continue
      const text = line.canClip ? clip(line.text, remaining) : line.text
      if ([...text].length <= remaining) {
        result += '\n' + text
        count++
        if (line.commit) commits.push(line.commit)
      }
    }
    if (!count) result = ''
    if (!input.preview) {
      commits.forEach((fn) => fn())
      state.turn++
      state.lastRun = input.runId
      state.lastContent = result
      state.sourceKey = sourceKey
      this.store.writeState(key, state)
    }
    return result
  }
}
