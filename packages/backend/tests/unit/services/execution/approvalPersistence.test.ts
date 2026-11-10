import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'
import * as schema from '@infos/backend/database/schema'
import { ToolApprovalRepository } from '@infos/backend/repositories/toolApproval.repo'
import { ApprovalService } from '@infos/backend/services/execution/approvalService'

function createRepository() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE tool_approval_requests (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel TEXT NOT NULL,
      session_id TEXT NOT NULL, thread_id TEXT NOT NULL, task_id TEXT,
      tool_name TEXT NOT NULL, args_summary_json TEXT NOT NULL,
      args_fingerprint TEXT NOT NULL, reason TEXT NOT NULL, risk_level TEXT DEFAULT 'low' NOT NULL,
      status TEXT NOT NULL, decision TEXT, resolution_message TEXT, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE tool_approval_audit_logs (
      id TEXT PRIMARY KEY, approval_id TEXT, event TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL, tool_name TEXT NOT NULL, detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  return { sqlite, repository: new ToolApprovalRepository(drizzle(sqlite, { schema })) }
}

const input = {
  agentId: 'pero',
  channel: 'desktop',
  sessionId: 'thread-db',
  threadId: 'thread-db',
  toolName: 'terminal_execute',
  args: { command: 'git status' },
  reason: '需要审批',
}

describe('ApprovalService SQLite', () => {
  it('持久化审批、消费和审计生命周期', () => {
    const { sqlite, repository } = createRepository()
    const service = new ApprovalService(repository)
    const request = service.create(input)
    service.resolve(request.id, 'allow_once')
    expect(service.authorize(input)).toBe('allow')

    const restored = new ApprovalService(repository)
    expect(restored.get(request.id)?.status).toBe('consumed')
    expect(restored.listAudit({ approvalId: request.id }).map((item) => item.event)).toEqual([
      'requested',
      'resolved',
      'consumed',
    ])
    sqlite.close()
  })

  it('Daemon 重启后自动拒绝遗留 pending 审批', () => {
    const { sqlite, repository } = createRepository()
    const service = new ApprovalService(repository)
    const request = service.create(input)

    const restored = new ApprovalService(repository)
    expect(restored.get(request.id)).toMatchObject({
      status: 'denied',
      decision: 'deny_once',
    })
    expect(restored.listAudit({ approvalId: request.id }).map((item) => item.event)).toEqual([
      'requested',
      'restart_rejected',
    ])
    sqlite.close()
  })

  it('Daemon 重启后不会保留本轮对话授权', () => {
    const { sqlite, repository } = createRepository()
    const service = new ApprovalService(repository)
    const sessionInput = { ...input, toolName: 'demo.run', args: { value: 1 } }
    const request = service.create(sessionInput)
    service.resolve(request.id, 'allow_session')
    expect(service.authorize(sessionInput)).toBe('allow')
    expect(new ApprovalService(repository).authorize(sessionInput)).toBe('none')
    sqlite.close()
  })
})
