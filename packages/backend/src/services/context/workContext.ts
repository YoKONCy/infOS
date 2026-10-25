import type { ChatMessage } from '../llm/types'
import type { ModelConfig } from '../llm/llmService'
import type { ThreadMessageInfo } from '../thread/threadService'
import { promptFingerprint } from '../llm/promptCache'
import { stripBase64DataUris } from '../llm/sanitize'
import { prependConversationTime } from './conversationTime'

/** 单轮原始执行记录；不包含系统提示词，也不重复保存前序轮次。 */
export interface WorkContextRecord {
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
  threadId: string
  agentId: string
  channel: string
  taskId?: string
  modelKey?: string
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
export function workContextText(message: ThreadMessageInfo): string {
  const record = recordOf(message)
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
  return messages.map((message) =>
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
  const records = new Map<number, WorkContextRecord>()
  const inputRecords = new Map<number, WorkContextRecord>()
  const revisions = new Map(history.map((message) => [message.id, message.revision]))
  const firstId = history[0]?.id ?? 0
  let changed = false
  for (const message of history) {
    if (message.revision > 1) changed = true
    if (message.role !== 'assistant' || message.agentId !== scope.agentId) continue
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
    if (record.input && user) inputRecords.set(user.id, record)
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
    const restored: ChatMessage[] = closeWorkToolGroups(items).map((item, index) => ({
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

/** 列表接口只返回展示数据，内部轨迹按模型需要恢复，避免聊天页面重复装载大正文。 */
export function publicWorkMetadata(raw: string): string {
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'workContext')) return raw
    const { workContext: _context, ...display } = value
    return JSON.stringify(display)
  } catch {
    return raw
  }
}
