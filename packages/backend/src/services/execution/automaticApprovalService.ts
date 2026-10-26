import path from 'node:path'
import { open, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { ChatMessage } from '../llm/types'
import { TASK_PROMPTS } from '../prompt/taskPrompts'
import type { LlmService, ModelConfig } from '../llm/llmService'
import type { AutomaticApprovalRecord } from '@infos/shared'
import {
  getProductivityRuntime,
  resolveExecutionSession,
} from '../../tools/productivityRuntimeHolder'

export interface AutomaticApprovalInput {
  toolName: string
  args: Record<string, unknown>
  agentId: string
  threadId: string
  channel: string
  taskId?: string
  messages?: ChatMessage[]
  signal?: AbortSignal
}

export interface AutomaticApprovalDecision extends AutomaticApprovalRecord {
  /** 审批只对本次读取到的参数、脚本和路径有效。 */
  validate?: () => Promise<boolean>
}

const REVIEW_PROMPT = TASK_PROMPTS['execution.approval']!.body

class AutomaticApprovalError extends Error {
  constructor(
    readonly code: AutomaticApprovalRecord['errorCode'],
    message: string,
  ) {
    super(message)
  }
}

function textContent(message: ChatMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : (message.content
        ?.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n') ?? '')
}

function bounded(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[内容已截断]` : value
}

function localPath(root: string, value: string): string {
  return path.resolve(root, value.replace(/^@principal[\\/]/i, ''))
}

/** 限量读取，避免将大文件、设备或二进制内容带入审批请求。 */
async function scriptSnapshot(file: string) {
  const actual = await realpath(file)
  if (!(await stat(actual)).isFile()) throw new Error('脚本不是普通文件')
  const handle = await open(actual, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('脚本不是普通文件')
    const buffer = Buffer.alloc(Math.min(info.size, 24_001))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const data = buffer.subarray(0, bytesRead)
    if (data.includes(0)) throw new Error('脚本包含二进制内容')
    return {
      path: file,
      actual,
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash: createHash('sha256').update(data).digest('hex'),
      content: bounded(data.toString('utf8'), 24_000),
      truncated: info.size > bytesRead || bytesRead > 24_000,
    }
  } finally {
    await handle.close()
  }
}

/** 单次审批不写入用户授权缓存，不授予后续调用的通行凭证。 */
export class AutomaticApprovalService {
  constructor(
    private llm: LlmService,
    private getModel: () => Promise<ModelConfig | null>,
  ) {}

  async review(input: AutomaticApprovalInput): Promise<AutomaticApprovalDecision> {
    input.signal?.throwIfAborted()
    const controller = new AbortController()
    let rejectCancelled: (reason: unknown) => void = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject
    })
    const abort = () => {
      controller.abort(input.signal?.reason)
      rejectCancelled(input.signal?.reason ?? new Error('自动审批已取消'))
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new AutomaticApprovalError('timeout', '自动审批超过 60 秒'))
      }, 60_000)
    })
    try {
      return await Promise.race([
        this.evaluate({ ...input, signal: controller.signal }),
        timeout,
        cancelled,
      ])
    } catch (error) {
      input.signal?.throwIfAborted()
      return {
        source: 'automatic_reviewer',
        decision: 'deny',
        errorCode: timedOut
          ? 'timeout'
          : error instanceof AutomaticApprovalError
            ? error.code
            : 'model_error',
        reason: `自动审批异常，本次操作未执行：${bounded(error instanceof Error ? error.message : String(error), 240)}`,
      }
    } finally {
      if (timer) clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
    }
  }

  private async evaluate(input: AutomaticApprovalInput): Promise<AutomaticApprovalDecision> {
    const config = await this.getModel()
    if (!config) throw new AutomaticApprovalError('model_error', '未配置可用的审批模型或主模型')
    const remote = input.toolName.startsWith('remote_terminal_')
    const session = await resolveExecutionSession(input)
    let cwd = localPath(session.workspaceRoot, String(input.args.cwd ?? '.'))
    let terminal: unknown
    if (input.toolName === 'terminal_write') {
      const runtime = getProductivityRuntime()
      const snapshot = runtime.terminals.get(String(input.args.terminal_id), session.id)
      cwd = snapshot.cwd
      terminal = {
        ...snapshot,
        output: runtime.terminals.read(
          snapshot.id,
          session.id,
          Math.max(0, snapshot.outputLength - 3000),
          3000,
        ),
      }
    }
    const actualCwd = remote ? undefined : await realpath(cwd)
    const command = String(input.args.command ?? input.args.data ?? '')
    const scripts: Awaited<ReturnType<typeof scriptSnapshot>>[] = []
    const missingScripts: string[] = []
    // 收集常见脚本供模型追踪间接副作用；缺失与截断仍由下方完整性检查拦截。
    const candidates = [
      ...command.matchAll(
        /"([^"\r\n]+\.(?:py|ps1|sh|bash|js|mjs|cjs|ts|bat|cmd))"|'([^'\r\n]+\.(?:py|ps1|sh|bash|js|mjs|cjs|ts|bat|cmd))'|([^\s"'|;&<>]+\.(?:py|ps1|sh|bash|js|mjs|cjs|ts|bat|cmd))(?=\s|$|[;&|])/gi,
      ),
    ]
    for (const match of candidates.slice(0, 4)) {
      const reference = match[1] ?? match[2] ?? match[3]!
      if (remote || /[$`*?]|:\/\//.test(reference)) {
        missingScripts.push(reference)
        continue
      }
      try {
        scripts.push(await scriptSnapshot(localPath(cwd, reference)))
      } catch {
        missingScripts.push(reference)
      }
    }
    if (candidates.length > 4) missingScripts.push('其余脚本超出本次读取上限')
    let target: { requested: string; actual: string; fingerprint: string } | undefined
    if (input.toolName === 'delete_file') {
      const requested = localPath(session.workspaceRoot, String(input.args.file_path ?? ''))
      const actual = await realpath(requested)
      const info = await stat(actual)
      target = {
        requested,
        actual,
        fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
      }
    }
    const messages = input.messages ?? []
    const request = [...messages].reverse().find((message) => message.role === 'user')
    const recent = messages
      .filter((message) => message.role !== 'system')
      .slice(-8)
      .map((message) => ({
        role: message.role,
        name: message.name,
        content: bounded(textContent(message), 1800),
        toolCalls: message.toolCalls?.map((call) => ({
          name: call.function.name,
          arguments: bounded(call.function.arguments, 1400),
        })),
      }))
    const packet = JSON.stringify({
      userRequest: request
        ? bounded(textContent(request), 6000)
        : '未提供独立用户请求，请结合已有上下文确认任务目标与明确约束。',
      recent,
      toolName: input.toolName,
      args: input.args,
      platform: remote ? '远程节点，以参数和上下文为准' : process.platform,
      cwd: remote ? input.args.cwd : actualCwd,
      terminal,
      target,
      scripts,
      missingScripts,
    })
    if (packet.length > 64_000)
      throw new AutomaticApprovalError('context_unavailable', '待审内容过大，无法完整核实')
    input.signal?.throwIfAborted()
    const completion = await this.llm.chat(
      { ...config, usagePurpose: 'system', usageAgentId: input.agentId },
      [
        { role: 'system', content: REVIEW_PROMPT },
        { role: 'user', content: packet },
      ],
      {
        promptTask: 'execution.approval',
        promptChannel: input.channel,
        promptVariables: { agent_id: input.agentId },
        temperature: 0,
        maxTokens: 1000,
        timeout: 60_000,
        signal: input.signal,
      },
    )
    const raw =
      completion.choices[0]?.message.content
        ?.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '') ?? ''
    let verdict: { decision?: unknown; reason?: unknown } | null
    try {
      verdict = JSON.parse(raw) as typeof verdict
    } catch {
      throw new AutomaticApprovalError('invalid_response', '审批模型没有返回有效 JSON 结论')
    }
    if (
      !verdict ||
      !['allow', 'deny'].includes(String(verdict.decision)) ||
      typeof verdict.reason !== 'string' ||
      !verdict.reason.trim()
    ) {
      throw new AutomaticApprovalError('invalid_response', '审批模型没有返回有效的通过或拒绝结论')
    }
    if (
      verdict.decision === 'allow' &&
      (missingScripts.length || scripts.some((script) => script.truncated))
    ) {
      return {
        source: 'automatic_reviewer',
        decision: 'deny',
        errorCode: 'context_unavailable',
        reason: '相关脚本未完整读取，无法完成自动审批，本次操作未执行',
        modelId: config.modelId,
      }
    }
    return {
      source: 'automatic_reviewer',
      decision: verdict.decision as AutomaticApprovalDecision['decision'],
      reason: verdict.reason.trim().slice(0, 600),
      modelId: config.modelId,
      validate: async () => {
        try {
          if (!remote && (await realpath(cwd)) !== actualCwd) return false
          for (const before of scripts) {
            const after = await scriptSnapshot(before.path)
            if (
              after.actual !== before.actual ||
              after.hash !== before.hash ||
              after.size !== before.size ||
              after.mtimeMs !== before.mtimeMs
            )
              return false
          }
          if (target) {
            if ((await realpath(target.requested)) !== target.actual) return false
            const info = await stat(target.actual)
            if (`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` !== target.fingerprint)
              return false
          }
          return true
        } catch {
          return false
        }
      },
    }
  }
}
