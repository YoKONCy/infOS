/**
 * 工具审批 API 模块（全局安全基础设施，跨 Tab 共享）。
 *
 * @module packages/frontend/src/api/modules/approvalsApi
 */

import { apiClient } from '../client'
import { getApiResourceUrl, requestApiResource } from '../transport'
import type { CodeSearchNavigation, WorkspaceFileDescriptor } from '@infos/shared'

export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny_once'

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'consumed'

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface ApprovalRequest {
  id: string
  agentId: string
  channel: string
  sessionId: string
  threadId: string
  taskId?: string
  toolName: string
  argsSummary: Record<string, unknown>
  reason: string
  riskLevel: ApprovalRiskLevel
  status: ApprovalStatus
  decision?: ApprovalDecision
  /** 用户决策附言（后端 0010 起持久化） */
  resolutionMessage?: string
  createdAt: string
  resolvedAt?: string
}

export interface ApprovalAuditRecord {
  id: string
  approvalId: string | null
  event:
    | 'requested'
    | 'resolved'
    | 'consumed'
    | 'session_cleared'
    | 'restart_rejected'
    | 'shutdown_rejected'
    | 'cancelled'
  agentId: string
  sessionId: string
  toolName: string
  detail: Record<string, unknown>
  createdAt: string
}

export const approvalsApi = {
  /** 按条件列出审批请求 */
  list: (filter: { status?: ApprovalStatus; agentId?: string; sessionId?: string } = {}) => {
    const params = new URLSearchParams()
    if (filter.status) params.set('status', filter.status)
    if (filter.agentId) params.set('agentId', filter.agentId)
    if (filter.sessionId) params.set('sessionId', filter.sessionId)
    const query = params.toString()
    return apiClient.get<{ requests: ApprovalRequest[]; total: number }>(
      `/approvals${query ? `?${query}` : ''}`,
    )
  },

  /** 获取审批的 append-only 审计历史。 */
  audit: (filter: { approvalId?: string; sessionId?: string } = {}) => {
    const params = new URLSearchParams()
    if (filter.approvalId) params.set('approvalId', filter.approvalId)
    if (filter.sessionId) params.set('sessionId', filter.sessionId)
    const query = params.toString()
    return apiClient.get<{ records: ApprovalAuditRecord[]; total: number }>(
      `/approvals/audit${query ? `?${query}` : ''}`,
    )
  },

  /** 决策（可附言，空串不下发） */
  resolve: (id: string, decision: ApprovalDecision, message?: string) =>
    apiClient.post<ApprovalRequest>(`/approvals/${id}/resolve`, {
      decision,
      ...(message?.trim() ? { message: message.trim() } : {}),
    }),
}

/**
 * Workspace API（与 Agent 执行会话根目录强绑定）。
 */
export interface WorkspaceFileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modifiedAt?: string
}

export interface WorkspaceReadResult {
  content: string
  encoding: string
  eol: string
  totalBytes: number
  hash: string
  truncated: boolean
  nextOffset?: number
  lineStart?: number
  lineEnd?: number
}

export interface WorkspaceSearchMatch {
  file: string
  line: number
  content: string
}

interface SessionRef {
  agentId: string
  threadId: string
}

export const workspaceApi = {
  searchResultFile: (input: CodeSearchNavigation & { file: string; line?: number }) =>
    apiClient.post<{ descriptor: WorkspaceFileDescriptor; read: WorkspaceReadResult }>(
      '/workspace/search-result-file',
      input,
    ),
  describeFile: (session: SessionRef, path: string) =>
    apiClient.get<WorkspaceFileDescriptor>(
      `/workspace/file?${new URLSearchParams({ ...session, path })}`,
    ),
  contentUrl: (session: SessionRef, path: string, version: string, download = false) =>
    getApiResourceUrl(
      '/workspace/content',
      new URLSearchParams({ ...session, path, version, ...(download ? { download: '1' } : {}) }),
    ),
  fileContent: (session: SessionRef, path: string, version: string, signal?: AbortSignal) =>
    requestApiResource(
      '/workspace/content',
      new URLSearchParams({ ...session, path, version }),
      signal,
    ),
  openFile: (session: SessionRef, path: string, openOnNode = false) =>
    apiClient.post<{ path: string; name: string }>('/workspace/open-file', {
      ...session,
      path,
      openOnNode,
    }),
  listDir: (session: SessionRef, path?: string) => {
    const params = new URLSearchParams({ agentId: session.agentId, threadId: session.threadId })
    if (path) params.set('path', path)
    return apiClient.get<{ root: string; parent: string; nodes: WorkspaceFileNode[] }>(
      `/workspace/tree?${params}`,
    )
  },

  /** 在实际执行节点上使用系统文件管理器打开 workspace 根目录。 */
  reveal: (session: SessionRef, openOnNode = false) =>
    apiClient.post<{ path: string; platform: string; location: 'execution-node' }>(
      '/workspace/reveal',
      { ...session, openOnNode },
    ),

  readFile: (
    session: SessionRef,
    input: {
      path: string
      offset?: number
      limit?: number
      lineStart?: number
      lineEnd?: number
      tailLines?: number
    },
  ) => apiClient.post<WorkspaceReadResult>('/workspace/read', { ...session, ...input }),

  writeFile: (
    session: SessionRef,
    input: { path: string; content: string; expectedHash?: string },
  ) =>
    apiClient.post<{ hash: string; bytes: number; operation: 'create' | 'overwrite' }>(
      '/workspace/write',
      { ...session, ...input },
    ),

  /** 重命名工作区普通文件（固定在原目录，禁止覆盖）。 */
  renameFile: (session: SessionRef, input: { path: string; newName: string }) =>
    apiClient.post<{ oldPath: string; newPath: string; name: string }>('/workspace/rename', {
      ...session,
      ...input,
    }),

  /** 删除工作区普通文件（不递归删除目录）。 */
  deleteFile: (session: SessionRef, input: { path: string }) =>
    apiClient.post<{ path: string }>('/workspace/delete', { ...session, ...input }),

  search: (
    session: SessionRef,
    input: {
      query: string
      isRegex?: boolean
      fileType?: string
      path?: string
    },
  ) =>
    apiClient.post<{ matches: WorkspaceSearchMatch[]; total: number; engine: string }>(
      '/workspace/search',
      { ...session, ...input },
    ),
}

export type TerminalStatus = 'running' | 'exited' | 'killed' | 'failed'

export interface TerminalInfo {
  outputLength?: number
  id: string
  executionSessionId: string
  title: string
  command?: string
  cwd: string
  pid: number | null
  status: TerminalStatus
  startedAt: string
  exitedAt?: string
  exitCode?: number | null
  backend: 'pty' | 'pipe'
  cols: number
  rows: number
  owner?: 'agent' | 'user'
  pinned?: boolean
  archivedAt?: string
  exitReason?: 'exit' | 'timeout' | 'cancelled' | 'killed'
}

export interface TerminalReadResult {
  output: string
  cursor: number
  nextCursor: number
  hasMore: boolean
  /** 客户端落后于服务端保留窗口时被丢弃的字符数。 */
  droppedChars?: number
  status: TerminalStatus
  exitCode?: number | null
}

export const terminalsApi = {
  list: (session: SessionRef) => {
    const params = new URLSearchParams({ agentId: session.agentId, threadId: session.threadId })
    return apiClient.get<{ terminals: TerminalInfo[]; history: TerminalInfo[] }>(
      `/terminals?${params}`,
    )
  },

  create: (
    session: SessionRef,
    input: {
      command?: string
      cwd?: string
      title?: string
      cols?: number
      rows?: number
    },
  ) => apiClient.post<TerminalInfo>('/terminals', { ...session, ...input }),

  read: (session: SessionRef, terminalId: string, cursor = 0, limit = 16_000) => {
    const params = new URLSearchParams({
      agentId: session.agentId,
      threadId: session.threadId,
      cursor: String(cursor),
      limit: String(limit),
    })
    return apiClient.get<TerminalReadResult>(`/terminals/${terminalId}/read?${params}`)
  },

  write: (session: SessionRef, terminalId: string, data: string) =>
    apiClient.post<{ written: boolean }>(`/terminals/${terminalId}/write`, { ...session, data }),

  resize: (session: SessionRef, terminalId: string, cols: number, rows: number) =>
    apiClient.post<{ resized: boolean }>(`/terminals/${terminalId}/resize`, {
      ...session,
      cols,
      rows,
    }),

  pin: (session: SessionRef, terminalId: string, pinned: boolean) =>
    apiClient.post<TerminalInfo>(`/terminals/${terminalId}/pin`, { ...session, pinned }),

  cleanup: (session: SessionRef, action: 'archive_completed' | 'stop_agent' | 'close_all') =>
    apiClient.post('/terminals/cleanup', { ...session, action }),

  action: (
    session: SessionRef,
    terminalId: string,
    action: 'interrupt' | 'kill' | 'close' | 'archive',
  ) => apiClient.post(`/terminals/${terminalId}/${action}`, session),
}
