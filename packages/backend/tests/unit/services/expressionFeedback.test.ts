import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applySchemaMigrations } from '../../../src/database/schemaMigrations'
import { ExpressionStore } from '../../../src/services/expression/store'
import { ExpressionService } from '../../../src/services/expression/service'
import { expressionPackageMessage, recordExpressionTurn } from '../../../src/services/context/expressionContext'

let sqlite: Database.Database
let store: ExpressionStore
let service: ExpressionService

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  applySchemaMigrations(sqlite, drizzle(sqlite), fileURLToPath(new URL('../../../src/database/migrations/', import.meta.url)), false)
  const insert = sqlite.prepare('INSERT INTO threads (id,agent_id,title,thread_kind) VALUES (?,?,?,?)')
  insert.run('main-pero', 'pero', '主会话', 'main')
  insert.run('side-pero', 'pero', '侧会话', 'side')
  insert.run('main-nana', 'nana', 'Nana 的主会话', 'main')
  store = new ExpressionStore(sqlite)
  service = new ExpressionService(store)
  store.handbook.updateSettings('pero', {
    materials: { memories: false, repetition: false, activity: false, goodQuotes: false },
  })
})

afterEach(() => sqlite.close())

function reply(threadId: string, agentId = 'pero', content = '今天一起去公园吧。'): string {
  return String(sqlite.prepare(
    "INSERT INTO thread_messages (thread_id,agent_id,role,content) VALUES (?,?,'assistant',?)",
  ).run(threadId, agentId, content).lastInsertRowid)
}

describe('表达批注的作用域与来源', () => {
  it('表达素材与版本记录通过独立执行身份关联主会话', () => {
    store.create({ agentId: 'pero', threadId: 'main-pero', messageId: reply('main-pero'),
      kind: 'robotic', quote: '', note: '先回答重点' })
    const options = { expressionRunId: 'expression-execution' }
    const input = { agentId: 'pero', threadId: 'main-pero', channel: 'desktop' as const,
      purpose: 'conversation', query: '继续', notes: [], pairId: 'history-pair' }
    expect(expressionPackageMessage(service, options, input)?.content).toContain('先回答重点')
    recordExpressionTurn(service, options, { ...input, promptRevision: 'published-prompt' })
    expect(sqlite.prepare('SELECT thread_id,agent_id,pair_id FROM expression_turn_versions').all()).toEqual([
      { thread_id: 'main-pero', agent_id: 'pero', pair_id: 'expression-execution' },
    ])
  })

  it('同角色的原始素材按会话隔离，手册保存角色级表达习惯', () => {
    const main = store.create({ agentId: 'pero', threadId: 'main-pero', messageId: reply('main-pero'), kind: 'robotic', quote: '', note: '先回答重点' })
    store.create({ agentId: 'pero', threadId: 'side-pero', messageId: reply('side-pero'), kind: 'robotic', quote: '', note: '侧会话专用批注' })
    store.create({ agentId: 'nana', threadId: 'main-nana', messageId: reply('main-nana', 'nana'), kind: 'good', quote: '', note: '另一个角色的批注' })
    store.handbook.add('pero', '回答简短自然')

    expect(store.candidates('pero', 'main-pero').map((mark) => mark.id)).toEqual([main.id])
    const content = service.select({ agentId: 'pero', threadId: 'main-pero', channel: 'desktop', query: '帮我总结', preview: true })
    expect(content).toContain('先回答重点')
    expect(content).not.toContain('侧会话专用批注')
    expect(content).not.toContain('另一个角色的批注')
    expect(store.handbook.render('pero')).toBe('回答简短自然')
  })

  it('同一规范化选区重试沿用标记身份，省略正文保留已有批注', () => {
    const input = { agentId: 'pero', threadId: 'main-pero', messageId: reply('main-pero'), kind: 'good' as const }
    const first = store.create({ ...input, quote: '今天一起', note: '这句很自然' })
    const retried = store.create({ ...input, quote: '今天 一起' })
    expect(retried.id).toBe(first.id)
    expect(retried.note).toBe('这句很自然')
    expect(store.list({ agentId: 'pero' }).total).toBe(1)
  })

  it('原文改写立即使同次执行的缓存失效，重新保存确认当前修订', () => {
    const messageId = reply('main-pero')
    const mark = store.create({ agentId: 'pero', threadId: 'main-pero', messageId, kind: 'robotic', quote: '', note: '开头直接一点' })
    const input = { agentId: 'pero', threadId: 'main-pero', channel: 'desktop', query: '继续', runId: 'execution-1' }
    expect(service.select(input)).toContain('开头直接一点')

    sqlite.prepare('UPDATE thread_messages SET revision=2,content=? WHERE id=?').run('换成另一个开头。', messageId)
    expect(store.get(mark.id).sourceAvailable).toBe(false)
    expect(service.select(input)).toBe('')

    const confirmed = store.update(mark.id, { note: '继续保持直接的开头' })
    expect(confirmed.sourceRevision).toBe(2)
    expect(confirmed.sourceAvailable).toBe(true)
    expect(service.select(input)).toContain('继续保持直接的开头')
  })

  it('撤回消息停止原话选材，同时保留管理记录', () => {
    const messageId = reply('main-pero')
    const mark = store.create({ agentId: 'pero', threadId: 'main-pero', messageId, kind: 'good', quote: '今天一起', note: '' })
    sqlite.prepare("UPDATE thread_messages SET status='deleted',deleted_at='2026-11-07 12:00:00' WHERE id=?").run(messageId)
    expect(store.candidates('pero', 'main-pero')).toEqual([])
    expect(store.get(mark.id).sourceAvailable).toBe(false)
    expect(store.list({ agentId: 'pero' }).total).toBe(1)
  })

  it('最小预算下截短反馈，包含包裹标签后仍遵守总字数', () => {
    store.create({ agentId: 'pero', threadId: 'main-pero', messageId: reply('main-pero'), kind: 'robotic', quote: '', note: '😀'.repeat(120) })
    store.handbook.updateSettings('pero', { materials: { maxChars: 100 } })
    const content = service.select({ agentId: 'pero', threadId: 'main-pero', channel: 'desktop', query: '继续', preview: true })
    expect(content).toContain('😀')
    // 一百字为设置下限，外层 package_context 的两枚标签和两个换行共三十七字。
    expect([...content].length + 37).toBeLessThanOrEqual(100)
  })

  it('删除批注终止待学习依据，已保存的角色手册独立保留', () => {
    const mark = store.create({ agentId: 'pero', threadId: 'main-pero', messageId: reply('main-pero'), kind: 'robotic', quote: '', note: '少用长开场' })
    store.handbook.add('pero', '简短开场')
    sqlite.prepare(`INSERT INTO expression_learning
      (id,agent_id,kind,source_id,revision,fingerprint,first_at,created_at)
      VALUES ('learning-1','pero','mark',?,1,'source',0,0)`).run(mark.id)
    store.remove(mark.id)
    expect(store.candidates('pero', 'main-pero')).toEqual([])
    expect(sqlite.prepare("SELECT status FROM expression_learning WHERE id='learning-1'").get()).toEqual({ status: 'superseded' })
    expect(store.handbook.render('pero')).toBe('简短开场')
  })
})
