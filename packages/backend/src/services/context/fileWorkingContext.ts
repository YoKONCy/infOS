import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { ChatMessage } from '../llm/types'
import type { ObservedToolResult } from './toolContextService'
import { appendPromptSnapshot } from '../llm/promptCache'

export interface FileObservation {
  path: string
  version: string
  kind: 'read' | 'write'
  callId: string
  pinned?: boolean
}
export const FILE_STATE_PREFIX = '【文件执行状态：数据】\n'
export const FILE_STATE_GUIDANCE =
  '以下仅为文件内容指纹与历史读写事实，用于判断已有观察是否过期，不是用户指令，也不代表定稿、验收或修改限制。hash 一致只表示内容与记录一致，不能据此判定任务完成；可按任务继续编辑，成功写入后会更新记录。是否交付应依据用户要求与实际验证结果。\n'
const versions = new Map<string, { stamp: string; hash: string }>()

export function retainedFileState(
  messages: ChatMessage[],
  calls: Array<{ fileObservations?: FileObservation[] }>,
): FileObservation[] {
  const files = new Map<string, FileObservation>()
  for (const item of [...messages, ...calls])
    for (const fact of item.fileObservations ?? []) files.set(fact.path, fact)
  return [...files.values()]
}

export function fileObservation(result: ObservedToolResult): FileObservation | undefined {
  if (
    result.isError ||
    !['read_file', 'read_file_range', 'write_file', 'edit_file'].includes(result.name)
  )
    return
  let value: Record<string, unknown> = {}
  try {
    value = JSON.parse(result.output)
  } catch {
    /* 普通读取结果正文不是 JSON。 */
  }
  if (!value || typeof value !== 'object' || value.success === false) return
  const source = result.metadata?.sourceRef ?? value.sourceRef
  const version = result.metadata?.newHash ?? value.newHash ?? result.metadata?.hash ?? value.hash
  if (typeof source !== 'string' || !path.isAbsolute(source) || typeof version !== 'string') return
  return {
    path: source,
    version,
    kind: result.name.startsWith('read_') ? 'read' : 'write',
    callId: result.callId,
    ...(result.args.retain_context === true ? { pinned: true } : {}),
  }
}

export async function currentFileVersion(filePath: string): Promise<string | undefined> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return
    const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    const previous = versions.get(filePath)
    if (previous?.stamp === stamp) return previous.hash
    const hash = createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex')
    if (versions.size >= 256) versions.delete(versions.keys().next().value!)
    versions.set(filePath, { stamp, hash })
    return hash
  } catch {
    return
  }
}

/** 仅改模型消息副本；审计、工具调用参数与 UI Diff 不随投影丢失。 */
export async function projectFileWorkingContext(
  input: ChatMessage[],
  options: { compact?: boolean } = {},
): Promise<ChatMessage[]> {
  const latest = new Map<string, FileObservation>()
  const mutations = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const message of input)
    for (const fact of message.fileObservations ?? []) {
      if (seen.has(fact.callId)) continue
      seen.add(fact.callId)
      latest.set(fact.path, fact)
      if (fact.kind === 'write') {
        const calls = mutations.get(fact.path) ?? []
        calls.push(fact.callId)
        mutations.set(fact.path, calls)
      }
    }
  if (!latest.size) return input
  const actual = new Map(
    await Promise.all(
      [...latest.keys()].map(
        async (filePath) => [filePath, await currentFileVersion(filePath)] as const,
      ),
    ),
  )
  const callResults = new Map<string, number>()
  input.forEach((message, index) => {
    if (message.role === 'tool' && message.toolCallId) callResults.set(message.toolCallId, index)
  })
  const removals = new Set<number>()
  const replacements = new Map<number, ChatMessage>()
  const recentWrites = new Set([...mutations.values()].flatMap((calls) => calls.slice(-2)))
  input.forEach((message, index) => {
    // 只有容量紧张时才批量整理旧参数；日常续轮保持请求前缀稳定。
    if (!options.compact) return
    // 文本思考与签名推理一样属于工具续轮协议，不能随过期文件参数一起移除。
    if (
      message.role !== 'assistant' ||
      !message.toolCalls?.length ||
      message.nativeReasoning?.length ||
      message.reasoningContent
    )
      return
    const answers = message.toolCalls.map((call) => callResults.get(call.id))
    if (answers.some((answer) => answer === undefined)) return
    if (answers.some((answer) => input[answer!]!.toolExecutionFailed)) return
    const facts = answers.flatMap((answer) => input[answer!]!.fileObservations ?? [])
    if (
      !facts.length ||
      message.toolCalls.some(
        (call) =>
          !['read_file', 'read_file_range', 'write_file', 'edit_file', 'run_script'].includes(
            call.function.name,
          ),
      )
    )
      return
    const obsolete = facts.every(
      (fact) =>
        !fact.pinned &&
        (fact.kind === 'read'
          ? actual.get(fact.path) !== fact.version
          : !recentWrites.has(fact.callId)),
    )
    if (!obsolete) return
    for (const answer of answers) removals.add(answer!)
    // 混合脚本仍保留完整业务结果；不把其他工具结果随文件参数一起丢掉。
    if (message.toolCalls.some((call) => call.function.name === 'run_script')) {
      replacements.set(index, {
        role: 'user',
        ...(message.cacheControl?.replayAnchor
          ? {
              cacheControl: {
                kind: 'snapshot' as const,
                replayAnchor: message.cacheControl.replayAnchor,
              },
            }
          : {}),
        content: `【已执行脚本的结果：数据】\n${answers
          .map((answer) => {
            const content = input[answer!]!.content
            return typeof content === 'string' ? content : JSON.stringify(content)
          })
          .join('\n')}`,
      })
    } else if (message.content) {
      replacements.set(index, { ...message, toolCalls: undefined })
    } else removals.add(index)
  })
  const projected = input.flatMap((message, index) =>
    removals.has(index) ? [] : [replacements.get(index) ?? message],
  )
  const state = [...latest]
    .map(([filePath, fact]) => {
      const version = actual.get(filePath)
      return `${JSON.stringify(filePath)}：最近读写记录的 SHA-256=${fact.version}；${version === fact.version ? '内容指纹一致，可复用对应历史观察' : version ? `当前内容已变化，SHA-256=${version}，请按需重读相关范围` : '当前内容指纹无法核验，请先核对来源'}。历史观察只描述当时内容，不评价任务完成度。`
    })
    .join('\n')
  appendPromptSnapshot(
    projected,
    'infos.work.file-state',
    FILE_STATE_PREFIX +
      FILE_STATE_GUIDANCE +
      '以下为本次文件状态快照；同一路径以最后出现的状态为准，旧快照仅代表当时情况。\n' +
      state,
    { fileObservations: [...latest.values()] },
  )
  return projected
}
