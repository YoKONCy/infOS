/**
 * Chat API 模块
 *
 * AIOS 第三阶段：基于 Thread 的对话接口。
 * 非流式聊天走 ApiClient；流式走 streamRequest。
 */

import type {
  ConversationProjectionSnapshot,
  ConversationSurfaceDescriptor,
  ConversationQueueSnapshot,
  QueuedConversationInput,
} from '@infos/shared'
import { apiClient } from '../client'
import { streamRequest } from '../stream'
import type { SseEvents } from '../stream'
import { createClientUuid } from '../../lib/clientPlatform'

export interface ChatWorkspaceContext {
  filePath?: string
  fileHash?: string
  fileDirty?: boolean
  terminalId?: string
  selection?: { text: string; startLine: number; endLine: number }
}

export interface RewindPreview {
  scope?: 'message' | 'execution'
  messageIds?: number[]
  threadId: string
  agentId?: string
  wholeThread: boolean
  targetMessageId?: number
  pairIds: string[]
  pairCount: number
  createdCount: number
  editedCount: number
  preservedCount: number
  files: Array<{
    path: string
    preservedReason?: 'content_changed' | 'history_gap' | 'incomplete_snapshot' | 'unavailable'
    action:
      | 'delete_created'
      | 'restore_edited'
      | 'restore_deleted'
      | 'restore_renamed'
      | 'preserve_changed'
  }>
  forceWarning: boolean
}

export interface RewindResult {
  preview: RewindPreview
  workspace: {
    files: RewindPreview['files']
    rolledBackCount: number
    preservedCount: number
  }
  deletedMessageIds: number[]
  projection?: ConversationProjectionSnapshot
}

export interface ChatRequest {
  generationType?: import('@infos/shared').PromptGenerationType
  threadId: string
  content: string
  attachmentIds?: string[]
  imageMode?: 'auto' | 'native' | 'relay'
  workspaceContext?: ChatWorkspaceContext
  agentId?: string
}

export interface StopRequest {
  threadId: string
}

export interface ChatSendResponse {
  executionPause?: import('@infos/shared').ConversationExecutionPause
  executionId?: string
  threadId: string
  messageId: string
  surface: ConversationSurfaceDescriptor
}

async function historyRequest<T>(
  threadId: string,
  request: Promise<T>,
  discardPending: boolean,
): Promise<T> {
  const result = await request
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent('infos:conversation-history-changed', {
        detail: { threadId, discardPending },
      }),
    )
  return result
}

export const chatApi = {
  regenerate: (
    threadId: string,
    messageId: number,
    revision: number,
    clientMessageId = createClientUuid(),
  ) =>
    apiClient.post<ConversationQueueSnapshot>(`/chat/threads/${encodeURIComponent(threadId)}/regenerate`, {
      messageId,
      revision,
      clientMessageId,
    }),
  queueLive: (threadId: string, signal?: AbortSignal) =>
    apiClient.request<ConversationSurfaceDescriptor | null>(
      `/chat/queue/${encodeURIComponent(threadId)}/live`,
      { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) },
    ),
  queue: (threadId: string, signal?: AbortSignal) =>
    apiClient.request<ConversationQueueSnapshot>(`/chat/queue/${encodeURIComponent(threadId)}`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    }),
  enqueue: (input: QueuedConversationInput, clientMessageId: string) =>
    apiClient.post<ConversationQueueSnapshot>(`/chat/queue/${encodeURIComponent(input.threadId)}`, {
      ...input,
      clientMessageId,
    }),
  changeQueued: (
    threadId: string,
    id: string,
    revision: number,
    action: 'edit' | 'cancel' | 'immediate' | 'draft',
    content?: string,
  ) =>
    apiClient.patch<ConversationQueueSnapshot>(
      `/chat/queue/${encodeURIComponent(threadId)}/items/${encodeURIComponent(id)}`,
      { revision, action, content },
    ),
  controlQueue: (threadId: string, paused: boolean) =>
    apiClient.post<ConversationQueueSnapshot>(
      `/chat/queue/${encodeURIComponent(threadId)}/control`,
      { paused },
    ),
  reorderQueue: (threadId: string, order: Array<{ id: string; revision: number }>) =>
    apiClient.post<ConversationQueueSnapshot>(`/chat/queue/${encodeURIComponent(threadId)}/order`, {
      order,
    }),
  /** 非流式聊天返回与历史、流式提交同构的 committed Surface。 */
  send: (data: ChatRequest) => apiClient.post<ChatSendResponse>('/chat', data),

  /** 流式聊天只传输 Internal Surface Frame 与执行终态。 */
  stream: (data: ChatRequest, events: SseEvents) => streamRequest('/chat/stream', data, events),

  stop: (data: StopRequest) => apiClient.post<void>('/chat/stop', data),
  activeTasks: () =>
    apiClient.request<Array<{ threadId: string; state: string }>>('/chat/tasks', {
      signal: AbortSignal.timeout(10_000),
    }),

  editMessage: (threadId: string, msgId: string, content: string, expectedRevision?: number) =>
    historyRequest(
      threadId,
      apiClient.patch<ConversationProjectionSnapshot>(
        `/chat/threads/${threadId}/messages/${msgId}`,
        {
          content,
          expectedRevision,
        },
      ),
      false,
    ),

  deleteMessage: (threadId: string, msgId: string) =>
    historyRequest(
      threadId,
      apiClient.delete<ConversationProjectionSnapshot>(
        `/chat/threads/${threadId}/messages/${msgId}`,
      ),
      true,
    ),

  deleteMessagePair: (threadId: string, msgId: string) =>
    historyRequest(
      threadId,
      apiClient.delete<{ deletedCount: number }>(
        `/chat/threads/${threadId}/messages/${msgId}/pair`,
      ),
      true,
    ),

  previewRewind: (threadId: string, input: { messageId?: number; wholeThread?: boolean; preserveInputAttachments?: boolean; restoreFiles?: boolean }) =>
    apiClient.post<RewindPreview>(`/chat/threads/${threadId}/rewind-preview`, input),

  rewind: (
    threadId: string,
    input: { messageId?: number; wholeThread?: boolean; preserveInputAttachments?: boolean; restoreFiles?: boolean },
  ) =>
    historyRequest(
      threadId,
      apiClient.post<RewindResult>(`/chat/threads/${threadId}/rewind`, input),
      true,
    ),

  pauseTask: (threadId: string) => apiClient.post<void>('/chat/tasks/pause', { threadId }),

  resumeTask: (threadId: string) => apiClient.post<void>('/chat/tasks/resume', { threadId }),

  injectInstruction: (threadId: string, instruction: string) =>
    apiClient.post<void>('/chat/tasks/inject', { threadId, instruction }),
}
