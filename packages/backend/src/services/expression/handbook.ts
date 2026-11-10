import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ExpressionSettings, HandbookRule, HandbookVersion } from '@infos/shared'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'

export const DEFAULT_EXPRESSION_SETTINGS: ExpressionSettings = {
  learningEnabled: true,
  learningIdleMinutes: 10,
  handbookMaxChars: 1500,
  materials: {
    enabled: true,
    notes: true,
    goodQuotes: true,
    memories: true,
    repetition: true,
    activity: true,
    maxChars: 300,
  },
}
const MAX_VERSIONS = 100
const FAILURE_WINDOW_MS = 7 * 24 * 3600_000
export const handbookChars = (rules: HandbookRule[]) =>
  [...rules.map((r) => r.text).join('\n')].length
// 不允许表达偏好改变能力、授权、保密或安全规则；同时检查证据和生成的正文。
export const forbiddenHandbookText = (text: string) =>
  /权限|權限|安全|工具|审批|審批|密钥|密鑰|秘钥|密码|密碼|口令|令牌|系统提示|系統提示|开发者|開發者|授权|授權|沙箱|越狱|越獄|命令|执行|執行|终端|終端|文件|檔案|浏览器|瀏覽器|网络|網路|凭据|憑據|认证|認證|隐私|隱私|保密|机密|機密|忽略.*指令|忽略.*规则|忽略.*規則|<\/?(?:system|developer|tool)|shell|execute|command|credential|authentication|privacy|permission|security|safety|tool|approv|secret|password|api[\s_-]*key|token|system[\s_-]*prompt|developer|authoriz|sandbox|jailbreak/i.test(
    text.normalize('NFKC').replace(/[\u200b-\u200f\ufeff]/g, ''),
  )
export class HandbookStore {
  /** 设置变了，学习队列要重算时间。 */
  onSettingsChanged?: () => void
  constructor(readonly db: Database.Database) {}
  private setting(scope: string): Partial<ExpressionSettings> {
    const row = this.db
      .prepare('SELECT value FROM expression_settings WHERE scope=?')
      .get(scope) as { value: string } | undefined
    return row ? JSON.parse(row.value) : {}
  }
  settings(agentId: string): ExpressionSettings {
    const global = this.setting('global'),
      local = this.setting(`agent:${agentId}`)
    return {
      ...structuredClone(DEFAULT_EXPRESSION_SETTINGS),
      ...global,
      ...local,
      materials: { ...DEFAULT_EXPRESSION_SETTINGS.materials, ...global.materials },
    }
  }
  updateSettings(
    agentId: string,
    patch: Partial<Omit<ExpressionSettings, 'materials'>> & {
      materials?: Partial<ExpressionSettings['materials']>
    },
  ) {
    const result = this.db.transaction(() => {
      const before = this.settings(agentId)
      const next = { ...before, ...patch, materials: { ...before.materials, ...patch.materials } }
      if (handbookChars(this.rules(agentId)) > next.handbookMaxChars)
        throw new AppError('INVALID_PARAMETER')
      const write = this.db.prepare(
        'INSERT INTO expression_settings VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value',
      )
      write.run(
        'global',
        JSON.stringify({ materials: next.materials }),
      )
      write.run(
        `agent:${agentId}`,
        JSON.stringify({
          learningEnabled: next.learningEnabled,
          learningIdleMinutes: next.learningIdleMinutes,
          handbookMaxChars: next.handbookMaxChars,
        }),
      )
      return next
    })()
    this.onSettingsChanged?.()
    return result
  }
  rules(agentId: string): HandbookRule[] {
    const row = this.db
      .prepare('SELECT rules FROM expression_handbooks WHERE agent_id=?')
      .get(agentId) as { rules: string } | undefined
    return row ? JSON.parse(row.rules) : []
  }
  render(agentId: string): string {
    if (process.env.INFOS_EXPRESSION_ENABLED === '0') return ''
    // 只发送正文，分数和时间不改变提示词；顺序沿用存储，不按热度每轮重排。
    return this.rules(agentId)
      .map((r) => r.text)
      .join('\n')
  }
  list(agentId: string) {
    const rules = this.rules(agentId)
    return {
      rules,
      usedChars: handbookChars(rules),
      maxChars: this.settings(agentId).handbookMaxChars,
      learningFailures: (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM expression_learning WHERE agent_id=? AND status='failed' AND last_error='model' AND created_at>?",
          )
          .get(agentId, Date.now() - FAILURE_WINDOW_MS) as { n: number }
      ).n,
    }
  }
  versions(agentId: string): { items: HandbookVersion[] } {
    return {
      items: this.db
        .prepare(
          'SELECT id,agent_id AS agentId,reason,summary,created_at AS createdAt FROM expression_handbook_versions WHERE agent_id=? ORDER BY created_at DESC,rowid DESC',
        )
        .all(agentId) as HandbookVersion[],
    }
  }
  /** summary 为 null 时只存手册，不记版本。 */
  save(
    agentId: string,
    rules: HandbookRule[],
    reason: HandbookVersion['reason'],
    summary: string | null,
  ) {
    if (handbookChars(rules) > this.settings(agentId).handbookMaxChars)
      throw new AppError('INVALID_PARAMETER')
    this.db
      .prepare(
        'INSERT INTO expression_handbooks VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET rules=excluded.rules',
      )
      .run(agentId, JSON.stringify(rules))
    // 删除、合并、回退后不存在的规则不再压制原批注素材。
    const ids = new Set(rules.map((r) => r.id))
    const links = this.db
      .prepare(
        'SELECT mark_id AS markId,rule_id AS ruleId FROM expression_mark_rules WHERE mark_id IN (SELECT id FROM expression_marks WHERE agent_id=?)',
      )
      .all(agentId) as { markId: string; ruleId: string }[]
    for (const link of links)
      if (!ids.has(link.ruleId))
        this.db
          .prepare('DELETE FROM expression_mark_rules WHERE mark_id=? AND rule_id=?')
          .run(link.markId, link.ruleId)
    if (summary === null) return
    const snapshotLinks = this.db
      .prepare(
        'SELECT mark_id AS markId,rule_id AS ruleId,note FROM expression_mark_rules WHERE mark_id IN (SELECT id FROM expression_marks WHERE agent_id=?)',
      )
      .all(agentId)
    this.db
      .prepare('INSERT INTO expression_handbook_versions VALUES (?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        agentId,
        reason,
        summary,
        Date.now(),
        JSON.stringify(rules),
        JSON.stringify(snapshotLinks),
      )
    this.db
      .prepare(
        `DELETE FROM expression_handbook_versions WHERE agent_id=? AND id NOT IN (
        SELECT id FROM expression_handbook_versions WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?)`,
      )
      .run(agentId, agentId, MAX_VERSIONS)
  }
  private checkedText(text: string) {
    const result = text.trim()
    if (!result) throw new AppError('INVALID_PARAMETER')
    return result
  }
  add(agentId: string, text: string) {
    return this.db.transaction(() => {
      const now = Date.now(),
        rule: HandbookRule = {
          id: randomUUID(),
          agentId,
          text: this.checkedText(text),
          score: 0,
          source: { kind: 'chat', quote: '手动添加' },
          lastMatchedAt: null,
          createdAt: now,
          updatedAt: now,
        }
      this.save(
        agentId,
        [...this.rules(agentId), rule],
        'manual',
        t('server.routers', '手动添加规律'),
      )
      return rule
    })()
  }
  private find(id: string) {
    const rows = this.db
      .prepare('SELECT agent_id AS agentId,rules FROM expression_handbooks')
      .all() as { agentId: string; rules: string }[]
    for (const row of rows) {
      const rules: HandbookRule[] = JSON.parse(row.rules)
      const rule = rules.find((r) => r.id === id)
      if (rule) return { rule, rules, agentId: row.agentId }
    }
    throw new AppError('NOT_FOUND')
  }
  edit(id: string, text: string) {
    return this.db.transaction(() => {
      const { rule, rules, agentId } = this.find(id)
      rule.text = this.checkedText(text)
      rule.updatedAt = Date.now()
      this.db.prepare('DELETE FROM expression_mark_rules WHERE rule_id=?').run(id)
      this.save(agentId, rules, 'manual', t('server.routers', '手动修改规律'))
      return rule
    })()
  }
  remove(id: string) {
    return this.db.transaction(() => {
      const { rules, agentId } = this.find(id)
      this.save(
        agentId,
        rules.filter((r) => r.id !== id),
        'manual',
        t('server.routers', '手动删除规律'),
      )
      return { ok: true }
    })()
  }
  restore(agentId: string, id: string) {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT rules,mark_links AS links FROM expression_handbook_versions WHERE id=? AND agent_id=?',
        )
        .get(id, agentId) as { rules: string; links: string } | undefined
      if (!row) throw new AppError('NOT_FOUND')
      const rules: HandbookRule[] = JSON.parse(row.rules)
      this.db
        .prepare(
          'DELETE FROM expression_mark_rules WHERE mark_id IN (SELECT id FROM expression_marks WHERE agent_id=?)',
        )
        .run(agentId)
      for (const link of JSON.parse(row.links) as {
        markId: string
        ruleId: string
        note: string
      }[]) {
        if (
          rules.some((r) => r.id === link.ruleId) &&
          this.db
            .prepare('SELECT 1 FROM expression_marks WHERE id=? AND agent_id=? AND note=?')
            .get(link.markId, agentId, link.note)
        )
          this.db
            .prepare('INSERT OR REPLACE INTO expression_mark_rules VALUES (?,?,?)')
            .run(link.markId, link.ruleId, link.note)
      }
      this.save(agentId, rules, 'rollback', t('server.routers', '回退说话手册'))
      return { rules }
    })()
  }
  noteLearned(markId: string, note: string) {
    return !!this.db
      .prepare('SELECT 1 FROM expression_mark_rules WHERE mark_id=? AND note=? LIMIT 1')
      .get(markId, note)
  }
}
