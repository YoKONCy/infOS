import type { WorkContextBoundary } from '../../repositories/workContextClear.repo'
import type { ChatMessage } from '../llm/types'
import { omitPerceptionMessages, redactPerception } from '../conversation/perceptionContext'
import type { ModelConfig } from '../llm/llmService'
import type { ThreadMessageInfo } from '../thread/threadService'
import { promptFingerprint } from '../llm/promptCache'
import { stripBase64DataUris } from '../llm/sanitize'
import { prependConversationTime } from './conversationTime'
import { tokenCounter } from '../tokenizer/tokenCounter'

/** 单轮原始执行记录；不包含系统提示词，也不重复保存前序轮次。 */
export interface WorkContextRecord {
  clearToolCallId?: string
  version: 1
  threadId: string
  agentId: string
  channel: string
  pairId: string
  taskId?: string
  inputHash: string
  inputKind?: 'proactive'
  replyHash?: string
  modelKey?: string
  historyRevisions?: Array<[number, number]>
  input?: ChatMessage
  messages: ChatMessage[]
}

export interface WorkContextScope {
  boundary?: WorkContextBoundary
  threadId: string
  agentId: string
  channel: string
  taskId?: string
  modelKey?: string
}

/** 当前清理调用所属的原生工具批次完整保留，后续过程从该批次继续积累。 */
export function workMessagesAfterClear(messages: ChatMessage[], toolCallId: string): ChatMessage[] {
  const index = messages.findIndex((message) => message.role === 'assistant' &&
    message.toolCalls?.some((call) => call.id === toolCallId))
  return index < 0 ? [] : messages.slice(index)
}

/** 短期读取资料与持久轨迹使用相同边界，避免文件状态从消息审计再次进入请求。 */
export function workSourceMessages(messages: ThreadMessageInfo[], boundary?: WorkContextBoundary): ThreadMessageInfo[] {
  if (!boundary) return messages
  const cleared = new Set(boundary.messageIds)
  return messages.filter((message) => !cleared.has(message.id)).map((message) => {
    if (message.pairId !== boundary.pairId || message.role !== 'assistant') return message
    const data = metadata(message)
    if ((data.workContext as WorkContextRecord | undefined)?.clearToolCallId === boundary.toolCallId) return message
    const calls = Array.isArray(data.toolCalls) ? data.toolCalls : []
    const index = calls.findIndex((call) => call.callId === boundary.toolCallId)
    const selected = index < 0 ? [] : calls.slice(index)
    const allowed = new Set(selected.map((call) => call.callId))
    return { ...message, metadataJson: JSON.stringify({ ...data,
      fileWorkingState: [], toolCalls: selected,
      toolSources: Array.isArray(data.toolSources) ? data.toolSources.filter((source) => allowed.has(source.callId)) : [],
    }) }
  })
}

/** 模型身份不包含 API Key；跨模型只重放普通会话，不迁移签名推理。 */
export function workContextModelKey(config: ModelConfig): string {
  return promptFingerprint([
    config.provider,
    config.apiBase ?? '',
    config.modelId,
    config.wireApi ?? 'chat_completions',
    config.reasoningDialect ?? 'auto',
  ])
}

/** 原图由附件服务保存；正文与工具协议保持原样，工作副本不再复制 Base64。 */
export function persistentWorkMessage(message: ChatMessage): ChatMessage {
  const content = Array.isArray(message.content)
    ? message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n') +
      (message.content.some((part) => part.type !== 'text')
        ? '\n【历史媒体】媒体字节未重复保存；图片按原附件引用读取，桌面画面请重新观察。'
        : '')
    : typeof message.content === 'string'
      ? stripBase64DataUris(message.content)
      : message.content
  return structuredClone({ ...message, content, cacheControl: undefined })
}

function metadata(message: ThreadMessageInfo): Record<string, unknown> {
  try {
    return JSON.parse(message.metadataJson) ?? {}
  } catch {
    return {}
  }
}

function recordOf(message: ThreadMessageInfo): WorkContextRecord | undefined {
  if (metadata(message).workContextRevoked === true) return
  const value = metadata(message).workContext as Partial<WorkContextRecord> | undefined
  if (value?.version !== 1 || !Array.isArray(value.messages) || typeof value.inputHash !== 'string')
    return
  if (
    value.historyRevisions !== undefined &&
    (!Array.isArray(value.historyRevisions) ||
      !value.historyRevisions.every(
        (entry) => Array.isArray(entry) && entry.length === 2 && entry.every(Number.isSafeInteger),
      ))
  )
    return
  if (
    !value.messages.every(
      (item) =>
        item &&
        ['user', 'assistant', 'tool'].includes(item.role) &&
        (item.content === null ||
          typeof item.content === 'string' ||
          Array.isArray(item.content)) &&
        (!item.toolCalls ||
          (Array.isArray(item.toolCalls) &&
            item.toolCalls.every(
              (call) =>
                call?.type === 'function' &&
                typeof call.id === 'string' &&
                typeof call.function?.name === 'string' &&
                typeof call.function.arguments === 'string',
            ))),
    )
  )
    return
  return value as WorkContextRecord
}

/** 仅估算当前消息自己的材料；分页停止条件不受累计提示词副本放大。 */
export function workContextText(message: ThreadMessageInfo, boundary?: WorkContextBoundary): string {
  if (boundary?.messageIds.includes(message.id)) return message.content
  const record = recordOf(message)
  if (record && boundary && record.pairId === boundary.pairId && record.clearToolCallId !== boundary.toolCallId)
    return JSON.stringify(workMessagesAfterClear(record.messages, boundary.toolCallId)) + message.content
  const calls = metadata(message).toolCalls
  return record
    ? JSON.stringify(record.messages) + JSON.stringify(record.input ?? '')
    : Array.isArray(calls) && calls.length
      ? JSON.stringify(calls) + message.content
      : message.content
}

function legacyRecord(
  message: ThreadMessageInfo,
  user: ThreadMessageInfo,
  scope: WorkContextScope,
): WorkContextRecord | undefined {
  if (scope.taskId || metadata(message).workContextRevoked === true) return
  const calls = metadata(message).toolCalls
  if (!Array.isArray(calls) || !calls.length) return
  const messages: ChatMessage[] = []
  for (const call of calls) {
    if (
      typeof call?.name !== 'string' ||
      typeof call.callId !== 'string' ||
      !call.args ||
      typeof call.args !== 'object' ||
      typeof call.result !== 'string'
    )
      return
    messages.push(
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: call.callId,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: call.callId,
        content: call.result,
        toolExecutionFailed: call.isError === true,
        fileObservations: Array.isArray(call.fileObservations) ? call.fileObservations : undefined,
      },
    )
  }
  messages.push({
    role: 'user',
    content:
      '【旧版执行记录：数据】以上恢复自已保存的工具记录。旧版只保留来源的结果无法恢复为全文，需要时按来源读取；不要重新执行已经完成的操作。',
  })
  return {
    ...scope,
    version: 1,
    pairId: message.pairId!,
    inputHash: promptFingerprint(user.content),
    replyHash: promptFingerprint(message.content),
    messages,
  }
}

/** 调试提示词引用已有执行原件，不在后续每条消息里再次保存整段旧轨迹。 */
export function auditWorkMessages(messages: ChatMessage[]): ChatMessage[] {
  return redactPerception(omitPerceptionMessages(messages)).map((message) =>
    message.cacheControl?.key?.includes(':work:')
      ? {
          role: 'user',
          content: `【历史执行引用】messageId=${message.cacheControl.historyMessageId}；${message.cacheControl.key}`,
          cacheControl: message.cacheControl,
        }
      : message,
  )
}

/** 未完成批次保留已执行结果，对未返回项注明没有完成，恢复绝不重放副作用。 */
export function closeWorkToolGroups(input: ChatMessage[]): ChatMessage[] {
  const output: ChatMessage[] = []
  const ids = new Set<string>()
  for (let index = 0; index < input.length; index++) {
    const message = input[index]!
    if (message.role === 'tool') continue
    if (!message.toolCalls?.length) {
      output.push(message)
      continue
    }
    const calls = message.toolCalls.filter((call) => !ids.has(call.id))
    if (!calls.length) continue
    calls.forEach((call) => ids.add(call.id))
    output.push({ ...message, toolCalls: calls })
    let end = index + 1
    while (end < input.length && !input[end]!.toolCalls?.length && input[end]!.role !== 'assistant')
      end++
    const tail = input.slice(index + 1, end)
    for (const call of calls)
      output.push(
        tail.find((item) => item.role === 'tool' && item.toolCallId === call.id) ?? {
          role: 'tool',
          toolCallId: call.id,
          toolExecutionFailed: true,
          content:
            '该调用没有已提交的完成结果；可能已中断，不得当作成功，也不要自动重放有副作用的操作。请先核对实际状态。',
        },
      )
    output.push(...tail.filter((item) => item.role !== 'tool'))
    index = end - 1
  }
  return output
}

/** 框架先决定历史位置，再按消息身份展开；不绕过自定义框架的历史开关。 */
export function projectWorkHistory(
  compiled: ChatMessage[],
  history: ThreadMessageInfo[],
  scope: WorkContextScope,
  timeAnchors?: ReadonlyMap<number, string>,
): ChatMessage[] {
  const users = new Map(
    history
      .filter((message) => message.role === 'user' && message.pairId)
      .map((message) => [message.pairId!, message]),
  )
  const clearedMessages = new Set(scope.boundary?.messageIds ?? [])
  const records = new Map<number, WorkContextRecord>()
  const inputRecords = new Map<number, WorkContextRecord>()
  const revisions = new Map(history.map((message) => [message.id, message.revision]))
  const firstId = history[0]?.id ?? 0
  let changed = false
  for (const message of history) {
    if (message.revision > 1) changed = true
    if (message.role !== 'assistant' || message.agentId !== scope.agentId || clearedMessages.has(message.id)) continue
    const user = users.get(message.pairId ?? '')
    const record = recordOf(message) ?? (user ? legacyRecord(message, user, scope) : undefined)
    if (!record) continue
    if (
      record.threadId !== scope.threadId ||
      record.agentId !== scope.agentId ||
      record.channel !== scope.channel ||
      record.taskId !== scope.taskId ||
      record.pairId !== message.pairId
    )
      continue
    const anchors = record.historyRevisions
    const stale = Array.isArray(anchors)
      ? anchors.some(([id, revision]) => id >= firstId && revisions.get(id) !== revision)
      : changed
    if (
      stale ||
      message.revision > 1 ||
      (!user && !(record.inputKind === 'proactive' && record.input)) ||
      record.inputHash !== promptFingerprint(user?.content ?? record.input?.content) ||
      record.replyHash !== promptFingerprint(message.content)
    ) {
      changed = true
      continue
    }
    records.set(message.id, record)
    if (record.input && user && scope.boundary?.pairId !== record.pairId) inputRecords.set(user.id, record)
  }
  return compiled.flatMap<ChatMessage>((message) => {
    const cacheControl = message.cacheControl
    const id = cacheControl?.historyMessageId
    if (!id || !cacheControl) return [message]
    const input = inputRecords.get(id)?.input
    if (message.role === 'user' && input) {
      const restoredInput = persistentWorkMessage(input)
      return [
        {
          ...restoredInput,
          content: prependConversationTime(restoredInput.content, timeAnchors?.get(id)),
          cacheControl: {
            ...cacheControl,
            historySourceKey: cacheControl.key,
            key: `${cacheControl.key}:work:input`,
            workContext: true,
          },
        },
      ]
    }
    const record = records.get(id)
    if (!record?.messages.length) return [message]
    const items =
      record.inputKind === 'proactive' && record.input
        ? [record.input, ...record.messages]
        : record.messages
    const selected = scope.boundary?.pairId === record.pairId && record.clearToolCallId !== scope.boundary.toolCallId
      ? workMessagesAfterClear(items, scope.boundary.toolCallId) : items
    const restored: ChatMessage[] = closeWorkToolGroups(selected).map((item, index) => ({
      ...structuredClone(item),
      ...(record.modelKey && record.modelKey === scope.modelKey
        ? {}
        : {
            reasoningContent: undefined,
            nativeReasoning: undefined,
          }),
      cacheControl: {
        ...cacheControl,
        historySourceKey: cacheControl.key,
        reasoningModelKey: record.modelKey,
        key: `${cacheControl.key}:work:${index}`,
        workContext: true,
      },
    }))
    // finish_task 的可见答复可能由运行时生成，执行记录之外仍要保留用户实际看到的正文。
    const last = restored.at(-1)
    if (last?.role !== 'assistant' || last.toolCalls?.length || last.content !== message.content)
      restored.push({
        ...message,
        cacheControl: {
          ...cacheControl,
          historySourceKey: cacheControl.key,
          key: `${cacheControl.key}:reply`,
        },
      })
    return restored
  })
}

/** 主线按独立来源恢复执行过程，正式发言保留自己的历史位置。 */
export function projectConversationExecutions(
  compiled: ChatMessage[], history: ThreadMessageInfo[],
  executions: Array<{ id: string; status: string; metadataJson: string; inputSourcesJson: string }>,
  budget: number, modelKey?: string, boundary?: WorkContextBoundary,
): ChatMessage[] {
  const revisions = new Map(history.map((message) => [message.id, message.revision]))
  const firstId = history[0]?.id ?? 0
  const insertions = new Map<number, ChatMessage[]>()
  let used = tokenCounter.countMessages(compiled.filter((message) => message.cacheControl?.kind === 'history'))
  const clearedExecutions = new Set(boundary?.executionIds ?? [])
  for (const execution of executions) {
    if (clearedExecutions.has(execution.id) && execution.id !== boundary?.pairId) continue
    if (['running', 'revoked', 'reset'].includes(execution.status)) continue
    const publications = history.filter((message) => message.executionId === execution.id && message.role === 'assistant')
    let record: {
      executionMessages?: ChatMessage[]
      historyRevisions?: Array<[number, number]>
      publicationRevisions?: import('@infos/shared').ConversationSource[]
      modelKey?: string
      workContextRevoked?: boolean
      workContextClearCallId?: string
    }
    let sources: import('@infos/shared').ConversationSource[]
    try {
      record = JSON.parse(execution.metadataJson)
      sources = JSON.parse(execution.inputSourcesJson)
    } catch {
      continue
    }
    const sourceIds = new Set(sources.map((source) => source.messageId))
    const anchor = publications.at(-1) ?? history.filter((message) => sourceIds.has(message.id)).at(-1)
    if (!anchor) continue
    if (!record || record.workContextRevoked || !Array.isArray(record.executionMessages) || !record.executionMessages.length ||
        publications.some((message) => message.revision > 1) ||
        record.publicationRevisions?.some((source) =>
          source.messageId >= firstId && revisions.get(source.messageId) !== source.revision) ||
        record.historyRevisions?.some(([id, revision]) =>
          id >= firstId && revisions.get(id) !== revision)) continue
    const selected = boundary?.pairId === execution.id && record.workContextClearCallId !== boundary.toolCallId
      ? workMessagesAfterClear(record.executionMessages, boundary.toolCallId) : record.executionMessages
    const messages = closeWorkToolGroups(selected)
      .filter((message) => message.role !== 'assistant' || message.toolCalls?.length)
      .map((message, index): ChatMessage => ({
        ...persistentWorkMessage(message),
        ...(record.modelKey === modelKey ? {} : { reasoningContent: undefined, nativeReasoning: undefined }),
        cacheControl: { kind: 'history', workContext: true, key: `execution:${execution.id}:${index}`,
          historyMessageId: anchor.id, historyRevision: anchor.revision },
      }))
    const tokens = tokenCounter.countMessages(messages)
    if (used + tokens > budget) continue
    insertions.set(anchor.id, [...messages, ...(insertions.get(anchor.id) ?? [])])
    used += tokens
  }
  return compiled.flatMap((message) => [message, ...(insertions.get(message.cacheControl?.historyMessageId ?? 0) ?? [])])
}

/**
 * 普通消息列表不下发的内部字段：工作轨迹原件，
 * 以及保存完整模型请求的调试副本。
 */
const INTERNAL_METADATA_KEYS = [
  'workContext',
  'initialPromptMessages',
  'modelRequests',
] as const
/** 显式调试读取（对话日志）额外保留的请求副本字段。 */
const DEBUG_METADATA_KEYS: ReadonlySet<string> = new Set(['initialPromptMessages', 'modelRequests'])

/**
 * 列表接口只返回展示数据，内部轨迹按模型需要恢复，避免聊天页面重复装载大正文。
 *
 * @param options.debug 显式调试读取时保留请求副本，供对话日志查看实际发送的请求
 */
export function publicWorkMetadata(raw: string, options: { debug?: boolean } = {}): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return raw
    const hidden = INTERNAL_METADATA_KEYS.filter(
      (key) => Object.hasOwn(value, key) && !(options.debug && DEBUG_METADATA_KEYS.has(key)),
    )
    if (!hidden.length) return raw
    for (const key of hidden) delete value[key]
    return JSON.stringify(value)
  } catch {
    return raw
  }
}
