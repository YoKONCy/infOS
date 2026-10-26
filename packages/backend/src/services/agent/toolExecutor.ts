import { t as __t } from '../../lib/i18n'
/**
 * Tool Executor — 工具执行器
 *
 * 从 ToolRegistry 查找工具并执行。
 * 内置 finish_task + 动态注册表查询 + CapabilityGate 权限校验。
 *
 * B6 升级:
 * - Hook 事件触发 (before_tool_call / after_tool_call)
 * - Package Hook Bus 事件触发
 *
 * 执行流程:
 * 1. Thread 模式与逐项工具策略校验，再处理 finish_task / load_skill
 * 2. CapabilityGate.isToolAllowed() → 权限校验
 * 3. Hook: before_tool_call → 可拦截/修改参数
 * 4. ToolRegistry.getHandler() → 获取处理函数
 * 5. handler(args, context) → 执行 (带超时保护)
 * 6. Hook: after_tool_call → 可修改/记录结果
 *
 * @module packages/backend/src/services/agent/toolExecutor
 */

import type { ToolExecutor, ToolExecutionResult } from './reactLoop'
import { SOCIAL_BUSINESS_TOOLS, SCREENSHOT_TOOLS } from '@infos/shared'
import type { ToolRegistry, ToolContext } from './toolRegistry'
import { ToolLoopError } from './toolLoopGuard'
import type { ApplicationRealmManager } from '../../applications/applicationRealm'
import type { CapabilityGate } from '../../capabilities/capabilityGate'
import type { CapabilityScope } from '../../capabilities/types'
import type { SkillLoader } from '../../capabilities/skillLoader'
import { isSystemProtocolTool } from '../../tools/systemProtocolTools'
import { isToolAllowedInInteractionMode } from '../../tools/interactionMode'
import {
  EXPAND_ADVANCED_TOOLS,
  isAdvancedTool,
  type AdvancedToolAccess,
} from '../../tools/advancedTools'
import { isStructuredToolResult } from '../execution/toolResult'
import type { ApprovalService } from '../execution/approvalService'
import {
  ALWAYS_APPROVE_EACH_CALL_TOOLS,
  type PolicyEngine,
  type PolicyDecision,
} from '../execution/policyEngine'
import { createLogger } from '../../lib/logger'
import { optionalTaskToolRuntime } from '../../tools/taskControl/runtime'
import {
  getProductivityRuntime,
  resolveExecutionSession,
} from '../../tools/productivityRuntimeHolder'
import type { FileWritePreviewBaseline } from '@infos/shared'
import { resolveExecutionMode, parseAutomaticApproval, type ExecutionMode } from '@infos/shared'
import { realpath } from 'node:fs/promises'
import {
  grantReadOnlyTerminal,
  planReadOnlyTerminal,
  type ReadOnlyTerminalGrant,
} from '../execution/readOnlyTerminal'
import path from 'node:path'
import { getDataDir } from '../../lib/env'
import { protectedResourceWrite } from '../debug/resourceWritePolicy'
import type { ChatMessage } from '../llm/types'
import type { ResourceService } from '../attachment/resourceService'
import { fileToolBusinessOutput, modelToolObservation } from '../execution/toolObservation'
import {
  fileEditOwner,
  prepareFileEditArguments,
  fileEditPreviewReference,
} from '../execution/fileEditing'
import type {
  AutomaticApprovalService,
  AutomaticApprovalDecision,
} from '../execution/automaticApprovalService'

const logger = createLogger('ToolExecutor')

/**
 * 必须先完成协议解析再应用模型预算的工具。
 *
 * 这些工具的输出需要在当前 ReAct 内完整消费：文件读取已经在工具内部按行数或字符数设限，
 * 截图需要下游完整解析 base64，不能先切坏结构。脚本业务输出保持完整；
 * reactLoop 在完成多模态解析后统一生成模型观察，审计仍只保存读取来源。
 */
const SKIP_TRUNCATE_TOOLS = new Set<string>([
  // 文件 Diff 独立交给界面，不能在行文本中截断。
  'write_file',
  'edit_file',
  'read_file',
  'read_file_range',
  'document',
  'search_knowledge',
  // 搜索已限制条数；保留 JSON 完整性，数量和预览由下游单独处理。
  'search_files',
  'glob_files',
  'code_search',
  'take_screenshot',
  'automation_execute',
  'browser_screenshot',
  'browser_page_image',
])

/** 兼容尚未迁移到 StructuredToolResult 的旧工具错误返回。 */
export function isLegacyToolErrorOutput(output: string): boolean {
  const value = output.trim()
  if (!value.startsWith('{')) return false
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return (
      parsed.success === false ||
      parsed.ok === false ||
      (typeof parsed.error === 'string' && parsed.error.trim().length > 0) ||
      (typeof parsed.error === 'object' && parsed.error !== null)
    )
  } catch {
    return false
  }
}

/**
 * 第七阶段 #5: 平台能力工具名单
 *
 * 这些工具不由 Daemon 本地执行，而是通过 CapabilityBridge 委托给
 * 有能力的节点（如 Electron 提供 screen_capture）。
 *
 * 当工具名命中此名单时，ToolExecutor 优先走 CapabilityBridge 路由；
 * 若 CapabilityBridge 未配置或无可用节点，返回友好错误。
 */
const PLATFORM_CAPABILITY_TOOLS = new Set<string>([
  'screen_capture',
  'take_screenshot', // 兼容旧工具名
  'clipboard_read',
  'clipboard_write',
  'get_active_window',
])

/**
 * 第七阶段修复（批次 A2）：工具名 → 能力节点注册的能力名映射
 *
 * 同一能力可被多个工具名调用：
 * - LLM 调用 `take_screenshot`（screenVision 工具集的真实注册名）
 * - 但 Electron 在 CapabilityProvider 里注册的能力名是 `screen_capture`
 *
 * 没有这层映射时，调用 `take_screenshot` 会让 CapabilityBridge
 * 找不到提供 `take_screenshot` 的节点，导致截图永远失败。
 *
 * 此映射表只在"工具名 → 能力名"方向做转换，不影响工具调用的日志、SSE、
 * 权限校验（权限校验仍用原始工具名，因为 capabilities.yaml 里配置的是工具名）。
 */
const TOOL_NAME_TO_DESKTOP_OPERATION: Record<
  string,
  | 'screenCapture'
  | 'clipboardRead'
  | 'clipboardWrite'
  | 'activeWindow'
  | 'listWindows'
  | 'activateWindow'
  | 'mousePosition'
  | 'mouseAction'
  | 'keyboardAction'
> = {
  take_screenshot: 'screenCapture',
  screen_capture: 'screenCapture',
  clipboard_read: 'clipboardRead',
  clipboard_write: 'clipboardWrite',
  get_active_window: 'activeWindow',
}

/**
 * 第七阶段 #5: 能力调用桥接接口
 *
 * ToolExecutor 通过此接口转发平台工具调用到 CapabilityBridge。
 * 使用接口而非直接 import CapabilityBridge，避免循环依赖。
 */
export interface DesktopCapabilityPort {
  invoke(
    operation:
      | 'screenCapture'
      | 'clipboardRead'
      | 'clipboardWrite'
      | 'activeWindow'
      | 'listWindows'
      | 'activateWindow'
      | 'applicationLaunch'
      | 'mousePosition'
      | 'mouseAction'
      | 'keyboardAction',
    input: unknown,
    context: import('@infos/shared').KernelCallContext,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/**
 * 第六阶段 #6: 文件路径相关参数名列表
 *
 * 工具参数中常见的路径字段名（snake_case 与 camelCase 都覆盖）。
 * ToolExecutor 在调用工具前会从 args 中提取这些字段，
 * 用 CapabilityGate.isPathAllowed() 校验是否落在 ResourceScope.allowedRoots 内。
 */
const PATH_PARAM_NAMES = new Set<string>([
  'file_path',
  'filePath',
  'dir_path',
  'dirPath',
  'directory',
  'path',
  'cwd',
  'destination',
  'target_path',
  'targetPath',
  'output_path',
  'outputPath',
])

const DEVICE_READ_TOOLS = new Set([
  'read_file',
  'read_image',
  'read_file_range',
  'get_file_info',
  'list_directory',
  'search_files',
  'glob_files',
  'code_search',
])

const TERMINAL_APPROVAL_TOOLS = new Set(['terminal_execute', 'terminal_create', 'terminal_write'])

/** 只规范设备文件路径，不改写网页路径、扩展参数或应用内部标识。 */
const LOCAL_PATH_TOOLS = new Set([
  ...DEVICE_READ_TOOLS,
  'write_file',
  'edit_file',
  'delete_file',
  'terminal_execute',
  'terminal_create',
  'run_script',
])

const isRemoteTerminalTool = (name: string) => name.startsWith('remote_terminal_')

/** Package Hook Bus 接口。 */
export interface HookEmitter {
  emitHook<T>(event: string, data: T): Promise<T>
}

/**
 * 基于 ToolRegistry 的工具执行器
 *
 * 集成 CapabilityGate 运行时权限校验 (D51):
 * - 每次工具调用前检查 isToolAllowed()
 * - 拒绝调用未授权工具，返回友好错误提示
 * - 系统协议工具同样受 Thread 模式限制
 *
 * 第七阶段 #5: 平台能力工具路由
 * - screen_capture / clipboard_* 等工具通过 CapabilityBridge 委托给节点执行
 * - 能力不可用时返回 isError + 友好错误，复用 ReAct 异常处理机制
 */
export class RegistryToolExecutor implements ToolExecutor {
  private screenshotResources?: ResourceService

  setScreenshotResourceService(service: ResourceService): void {
    this.screenshotResources = service
  }

  private threadPolicyResolver?: (threadId: string) => Promise<{
    interactionMode: import('@infos/shared').InteractionMode
    disabledTools: string[]
    executionMode?: ExecutionMode
    autoExecuteTools?: boolean
  } | null>

  setThreadPolicyResolver(
    resolver: NonNullable<RegistryToolExecutor['threadPolicyResolver']>,
  ): void {
    this.threadPolicyResolver = resolver
  }

  constructor(
    private registry: ToolRegistry,
    private capabilityGate: CapabilityGate | null = null,
    private skillLoader: SkillLoader | null = null,
    private hookEmitter: HookEmitter | null = null,
    private defaultContext: Partial<ToolContext> & { channel?: string } = {},
    /**
     * 第七阶段 #5: 能力调用桥接
     * 用于转发平台工具调用到 CapabilityBridge（Daemon 模式下注入，旧模式为 null）
     */
    private desktopCapabilities: DesktopCapabilityPort | null = null,
    private policyEngine: PolicyEngine | null = null,
    private approvalService: ApprovalService | null = null,
  ) {}

  /**
   * 第七阶段 #5: 延迟注入 CapabilityBridge
   *
   * 因 CapabilityBridge 依赖完整 AppContext（含 toolExecutor），
   * 存在循环依赖，必须延迟注入：
   * 1. container 先创建 toolExecutor（无 bridge）
   * 2. container 创建完 ctx 后创建 CapabilityBridge
   * 3. container 调用此方法注入 bridge 到 toolExecutor
   */
  private pathBoundaryChecker:
    | ((agentId: string, channel: string, inputPath: string) => boolean)
    | null = null

  setPathBoundaryChecker(
    checker: (agentId: string, channel: string, inputPath: string) => boolean,
  ): void {
    this.pathBoundaryChecker = checker
  }

  setPolicyRuntime(policyEngine: PolicyEngine, approvalService: ApprovalService): void {
    this.policyEngine = policyEngine
    this.approvalService = approvalService
  }

  private automaticApproval?: AutomaticApprovalService

  setAutomaticApprovalService(service: AutomaticApprovalService): void {
    this.automaticApproval = service
  }

  private applicationRealms: ApplicationRealmManager | null = null

  setApplicationRealmManager(manager: ApplicationRealmManager): void {
    this.applicationRealms = manager
  }

  setDesktopCapabilities(port: DesktopCapabilityPort): void {
    this.desktopCapabilities = port
    logger.info(__t('logs.agent', 'Desktop Capability Port 已注入 ToolExecutor'))
  }

  /** 只为已开放的工作区写入提供有限旧文；越界路径仍须留到正式调用审批。 */
  async previewFileWrite(
    path: string,
    source: string,
    context: Parameters<NonNullable<ToolExecutor['previewFileWrite']>>[2],
    toolName: 'write_file' | 'edit_file' = 'write_file',
  ): Promise<FileWritePreviewBaseline> {
    const unavailable: FileWritePreviewBaseline = { path, status: 'unavailable' }
    const { agentId, threadId } = context
    const channel = context.channel ?? source
    if (!agentId || !threadId || context.realmId || context.signal?.aborted) return unavailable
    if (!this.registry.getHandler(toolName) || !this.registry.isAllowedInSource(toolName, channel))
      return unavailable
    const policy = await this.threadPolicyResolver?.(threadId)
    if (
      [toolName, 'read_file'].some(
        (name) => context.disabledTools?.includes(name) || policy?.disabledTools.includes(name),
      )
    )
      return unavailable
    if (
      !isToolAllowedInInteractionMode(
        toolName,
        policy?.interactionMode ?? context.interactionMode ?? 'work',
        this.registry,
      )
    )
      return unavailable
    if (
      this.capabilityGate &&
      (!this.capabilityGate.isToolAllowed(
        agentId,
        channel,
        toolName,
        context.sessionId,
        context.capabilityScope,
      ) ||
        !this.capabilityGate.isToolAllowed(
          agentId,
          channel,
          'read_file',
          context.sessionId,
          context.capabilityScope,
        ) ||
        !this.capabilityGate.isPathAllowed(agentId, channel, toolName, path) ||
        !this.capabilityGate.isPathAllowed(agentId, channel, 'read_file', path))
    )
      return unavailable
    if (this.pathBoundaryChecker && !this.pathBoundaryChecker(agentId, channel, path))
      return unavailable
    try {
      const session = await resolveExecutionSession({
        agentId,
        threadId,
        channel,
        taskId: context.taskId,
      })
      const workspace = getProductivityRuntime().virtualWorkspace
      const info = await workspace.fileInfo(session, path)
      if (!info.exists) return { path, status: 'new', content: '' }
      if (!info.isFile || info.size > 128_000 || context.signal?.aborted) return unavailable
      const read = await workspace.read(session, path, { limit: 128_000 })
      if (read.truncated || context.signal?.aborted) return unavailable
      return { path, status: 'ready', content: read.content, hash: read.hash }
    } catch {
      return unavailable
    }
  }

  async previewFileEdit(
    args: Record<string, unknown>,
    source: string,
    context: Parameters<NonNullable<ToolExecutor['previewFileWrite']>>[2],
  ): Promise<FileWritePreviewBaseline> {
    const unavailable: FileWritePreviewBaseline = {
      path: String(args.path ?? ''),
      status: 'unavailable',
    }
    if (!context.agentId || !context.threadId || context.realmId || context.signal?.aborted)
      return unavailable
    try {
      const session = await resolveExecutionSession({
        agentId: context.agentId,
        threadId: context.threadId,
        channel: context.channel ?? source,
        taskId: context.taskId,
      })
      const owner = fileEditOwner(session)
      const prepared = prepareFileEditArguments(args, owner)
      const baseline = await this.previewFileWrite(
        String(prepared.path),
        source,
        context,
        'edit_file',
      )
      if (baseline.status !== 'ready' || context.signal?.aborted) return baseline
      if (prepared.expected_hash && prepared.expected_hash !== baseline.hash) return unavailable
      const text = baseline.content ?? ''
      const selections: Record<string, string> = Object.create(null)
      let selectionCharacters = 0
      for (const item of Array.isArray(args.steps) ? args.steps : [args]) {
        if (!item || typeof item !== 'object' || typeof item.read_ref !== 'string') continue
        if (selections[item.read_ref] !== undefined) continue
        const target = fileEditPreviewReference(item.read_ref, owner)
        if (target.hash !== baseline.hash) return unavailable
        const selection = target.range
          ? text.slice(target.range.start, target.range.end)
          : text
              .split(/(?<=\n)|(?<=\r)(?!\n)/)
              .slice(target.lines!.start - 1, target.lines!.end)
              .join('')
              .replace(/(?:\r\n|\n|\r)$/, '')
        // 非法重叠引用不能让预览正文随步骤数无限复制，真实执行仍独立校验整批。
        if (selectionCharacters + selection.length > 128_000) continue
        selections[item.read_ref] = selection
        selectionCharacters += selection.length
      }
      return { ...baseline, selections }
    } catch {
      return unavailable
    }
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    source: string,
    runtimeContext?: NonNullable<Parameters<ToolExecutor['execute']>[3]>,
  ): Promise<ToolExecutionResult> {
    runtimeContext?.signal?.throwIfAborted()
    const guard = runtimeContext?.loopGuard
    const observationVersion = guard?.observationVersion
    let warning: string | undefined
    let stopped: ToolLoopError | undefined
    try {
      warning = guard?.before(name, args)
    } catch (error) {
      if (!(error instanceof ToolLoopError)) throw error
      stopped = error
    }
    const result: ToolExecutionResult = stopped
      ? {
          output: JSON.stringify({
            success: false,
            code: 'TOOL_LOOP_STOPPED',
            message: stopped.message,
          }),
          isError: true,
          shouldTerminate: false,
          durationMs: 0,
        }
      : warning
        ? {
            output: JSON.stringify({ success: false, code: 'TOOL_LOOP_WARNING', message: warning }),
            isError: true,
            shouldTerminate: false,
            durationMs: 0,
          }
        : await this.executeInternal(
            name,
            args,
            source,
            guard
              ? {
                  ...runtimeContext,
                  signal: runtimeContext?.signal
                    ? AbortSignal.any([runtimeContext.signal, guard.signal])
                    : guard.signal,
                }
              : runtimeContext,
          )
    if (!warning && !stopped)
      guard?.observe(name, args, result.output, result.isError, observationVersion)
    if (
      !result.isError &&
      this.screenshotResources &&
      !runtimeContext?.inlineImages &&
      runtimeContext?.agentId &&
      runtimeContext.threadId &&
      SCREENSHOT_TOOLS.some((tool) => tool === name)
    ) {
      try {
        const original = result.output
        result.output = await this.screenshotResources.captureScreenshotPreviews(
          {
            agentId: runtimeContext.agentId,
            threadId: runtimeContext.threadId,
            pairId: runtimeContext.pairId,
            taskId: runtimeContext.taskId,
            toolCallId: runtimeContext.toolCallId,
            signal: runtimeContext.signal,
          },
          original,
        )
        if (result.modelOutput === original) result.modelOutput = result.output
      } catch (error) {
        runtimeContext.signal?.throwIfAborted()
        logger.warn(__t('logs.agent', '截图预览保存失败，仍保留模型实际取得的画面'), {
          name,
          error,
        })
      }
    }
    try {
      await runtimeContext?.onToolObserved?.({
        name,
        args,
        output: result.output,
        displayOutput: result.displayOutput,
        isError: result.isError,
        callId: runtimeContext?.toolCallId ?? '',
        metadata: result.metadata,
        durationMs: result.durationMs,
      })
    } catch (error) {
      logger.warn(__t('logs.agent', '工具观察记录失败，执行结果仍按真实副作用返回'), {
        name,
        error,
      })
    }
    return result
  }

  private async executeInternal(
    name: string,
    args: Record<string, unknown>,
    source: string,
    runtimeContext?: {
      threadId?: string
      channel?: string
      agentId?: string
      sessionId?: string
      signal?: AbortSignal
      loopGuard?: import('./toolLoopGuard').ToolLoopGuard
      taskId?: string
      realmId?: string
      browserScope?: import('@infos/shared').AgentBrowserScope
      requestedBy?: 'user' | 'agent'
      inlineImages?: boolean
      executionId?: import('@infos/shared').KernelExecutionId
      processId?: import('@infos/shared').KernelProcessId
      deadline?: string
      pairId?: string
      toolCallId?: string
      disabledTools?: string[]
      interactionMode?: import('@infos/shared').InteractionMode
      advancedToolAccess?: AdvancedToolAccess
      autoExecuteTools?: boolean
      executionMode?: ExecutionMode
      reviewMessages?: ChatMessage[]
      onExecutionStatus?: (message: string) => void
      onNestedToolCall?: (call: import('./reactLoop').NestedToolCall) => void
      onToolObserved?: (
        result: import('../context/toolContextService').ObservedToolResult,
      ) => void | Promise<void>
      capabilityScope?: CapabilityScope
    },
  ): Promise<ToolExecutionResult> {
    runtimeContext?.signal?.throwIfAborted()
    const startTime = Date.now()
    // 第七阶段修复（批次 B1）：agentId 必须从 runtimeContext 传入
    // 原实现读 this.defaultContext.agentId（构造时注入且从不更新的共享状态），
    // 而 container.ts 创建 ToolExecutor 时根本没传 defaultContext，
    // 导致所有 Agent 的工具权限校验都用硬编码兜底值 'pero' 的配置 —— 多 Agent 隔离完全失效。
    // 现在优先取 runtimeContext.agentId，仅在缺失时告警并兜底（过渡期保留兜底避免炸调用方）。
    let agentId = runtimeContext?.agentId ?? this.defaultContext.agentId
    if (!agentId) {
      logger.warn(
        __t(
          'logs.agent',
          "工具 {0} 调用未提供 agentId，权限校验将退回 'pero' 配置（调用方应透传 agentId）",
          [name],
        ),
      )
      agentId = 'pero'
    }
    // AIOS: 优先使用 runtimeContext.channel，回退到 defaultContext.channel，最后回退到 source
    const channel = runtimeContext?.channel ?? this.defaultContext.channel ?? source
    // sessionId 同样优先取 runtimeContext（Skill 解锁状态按会话隔离，不能共用 'default'）
    const sessionId = runtimeContext?.sessionId ?? this.defaultContext.sessionId ?? 'default'
    // AIOS: threadId 优先使用 runtimeContext.threadId，回退到 sessionId（向后兼容）
    const threadId = runtimeContext?.threadId ?? sessionId

    // ToolRegistry通道约束既用于工具定义注入，也必须在执行时再次校验，防止手工FC绕过。
    if (!this.registry.isAllowedInSource(name, channel)) {
      logger.warn(__t('logs.agent', '工具 {0} 不允许在通道 {1} 执行', [name, channel]))
      return {
        output: `工具“${name}”不允许在当前通道 (${channel}) 使用。`,
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }

    if (name !== 'finish_task' && this.applicationRealms) {
      const realmId = runtimeContext?.realmId
      const realmTool = this.applicationRealms.ownsTool(name)
      const hostProjection = this.applicationRealms.isHostProjection(name)
      if (
        (realmId && !this.applicationRealms.allowsTool(realmId, name)) ||
        (!realmId && realmTool && !hostProjection)
      ) {
        logger.warn(
          __t('logs.agent', '工具 {0} 被Application Realm拒绝 (realm={1})', [
            name,
            realmId ?? 'none',
          ]),
        )
        return {
          output: `工具“${name}”不属于当前Application Realm。`,
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      }
      if (realmId && !realmTool && !this.applicationRealms.hasHostToolGrant(realmId, name)) {
        return {
          output: `当前Application Realm不允许调用主应用工具“${name}”。`,
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      }
    }

    // 从 Thread 读取权威策略，脚本内部调用也不能丢失模式和逐项工具限制。
    const threadPolicy = runtimeContext?.realmId
      ? null
      : await this.threadPolicyResolver?.(threadId)
    const interactionMode =
      threadPolicy?.interactionMode ?? runtimeContext?.interactionMode ?? 'work'
    if (
      !runtimeContext?.realmId &&
      !isToolAllowedInInteractionMode(name, interactionMode, this.registry)
    ) {
      return {
        output: `当前${interactionMode === 'minimal' ? '极简' : '聊天'}模式未开放此操作，请在该 Thread 中调整执行模式。`,
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }

    if (!runtimeContext?.realmId && isAdvancedTool(name)) {
      const entryDisabled =
        runtimeContext?.disabledTools?.includes(EXPAND_ADVANCED_TOOLS) ||
        threadPolicy?.disabledTools.includes(EXPAND_ADVANCED_TOOLS)
      const access = runtimeContext?.advancedToolAccess
      const unavailable = access && (!access.expanded || !access.names.has(name))
      if (entryDisabled || unavailable) {
        return {
          output: entryDisabled
            ? '本会话已关闭高级工具，请由用户在会话工具中重新启用展开入口。'
            : '此高级工具尚未在当前执行中开放。请先在脚本外直接调用 expand_advanced_tools，取得定义后再使用。',
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      }
    }

    // 模式与用户逐项设置独立，系统协议豁免不适用于模式门控。
    if (
      (runtimeContext?.disabledTools?.includes(name) ||
        threadPolicy?.disabledTools.includes(name)) &&
      !isSystemProtocolTool(name)
    ) {
      logger.warn(
        __t('logs.agent', '工具 {0} 被 Thread 策略禁用 (thread={1}, channel={2})', [
          name,
          threadId,
          channel,
        ]),
      )
      return {
        output: `工具“${name}”已在本会话中禁用。请由用户在 CHAR OPS 工具管理中重新启用。`,
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }

    // ── 内置: finish_task (始终可用, CapabilityGate 豁免) ──
    // 必须走真正的工具实现 (finishTaskTool.execute) 才能更新角色状态 (mood/vibe/mind 等)
    // 并广播 state_update 到前端；绝不能在此短路返回，否则状态更新逻辑会被整体跳过。
    // 执行完毕 (无论成败) 都强制终止 ReAct 循环。
    if (name === 'finish_task') {
      const handler = this.registry.getHandler('finish_task')
      if (!handler) {
        // 兜底：注册表缺失时退回最简终止行为，至少保证循环能正常结束
        logger.warn(
          __t('logs.agent', 'finish_task 未在注册表中找到，退回最简终止行为 (状态更新被跳过)'),
        )
        return {
          output: (args.summary as string) ?? '任务完成',
          durationMs: Date.now() - startTime,
          isError: false,
          shouldTerminate: true,
        }
      }
      try {
        if (runtimeContext?.taskId)
          await optionalTaskToolRuntime()?.beforeTool(
            runtimeContext.taskId,
            runtimeContext.executionId,
            name,
            runtimeContext.toolCallId ?? '',
          )
        const context: ToolContext = {
          source,
          agentId,
          sessionId,
          threadId,
          channel,
          signal: runtimeContext?.signal,
          taskId: runtimeContext?.taskId,
          executionId: runtimeContext?.executionId,
          processId: runtimeContext?.processId,
          deadline: runtimeContext?.deadline,
          pairId: runtimeContext?.pairId,
          toolCallId: runtimeContext?.toolCallId,
        }
        const result = await handler(args, context)
        const failed =
          typeof result !== 'string' &&
          (isStructuredToolResult(result) ? !result.ok : result.isError)
        if (failed) {
          logger.error(
            __t('logs.agent', 'finish_task 执行失败: {0}', [
              typeof result === 'string' ? result : result.output,
            ]),
          )
          return {
            output: typeof result === 'string' ? result : result.output,
            durationMs: Date.now() - startTime,
            isError: true,
            shouldTerminate: false,
          }
        }
        const output = typeof result === 'string' ? result : result.output
        logger.info(
          __t('logs.agent', '工具 finish_task 执行完成 ({0}ms)', [Date.now() - startTime]),
        )
        return { output, durationMs: Date.now() - startTime, isError: false, shouldTerminate: true }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error(__t('logs.agent', 'finish_task 执行失败: {0}', [errMsg]))
        return {
          output: `执行失败: ${errMsg}`,
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      }
    }

    // ── 内置: load_skill（ambient 作用域禁止动态解锁能力） ──
    if (name === 'load_skill') {
      if (runtimeContext?.capabilityScope && runtimeContext.capabilityScope !== 'default') {
        return {
          output: '当前低权限环境不允许动态加载技能。',
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      }
      return await this.handleLoadSkill(args, sessionId, startTime)
    }

    // ── CapabilityGate 权限校验 ──
    // 第七阶段修复（批次 B5）：平台能力工具（如 take_screenshot）必须先过 CapabilityGate 白名单
    // 原实现在 CapabilityGate 之前返回，导致社交/群聊等通道可绕过白名单调用截图等敏感工具
    // 现在所有非内置工具（含平台能力工具）统一受白名单约束
    if (this.capabilityGate && !runtimeContext?.realmId) {
      const allowed =
        this.capabilityGate.isToolAllowed(
          agentId,
          channel,
          name,
          sessionId,
          runtimeContext?.capabilityScope,
        ) &&
        (!isAdvancedTool(name) ||
          this.capabilityGate.isToolAllowed(
            agentId,
            channel,
            EXPAND_ADVANCED_TOOLS,
            sessionId,
            runtimeContext?.capabilityScope,
          ))
      if (!allowed) {
        logger.warn(
          __t('logs.agent', '工具 {0} 被 CapabilityGate 拒绝 (agent={1}, channel={2})', [
            name,
            agentId,
            channel,
          ]),
        )
        return {
          output: `你没有权限使用工具 "${name}"。当前通道 (${channel}) 不允许此操作。`,
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      }

      // ResourceScope 路径越界不在这里直接拒绝；Hook 可能修改参数，最终参数会在
      // Hook 后进入强制审批。工具白名单本身仍然保持 fail-closed。
    }

    // ── 从 Registry 查找 ──
    // 第七阶段修复（批次 B5）：平台工具路由已移到 CapabilityGate 校验之后
    // 只有通过白名单校验的平台工具才会走到这里
    if (PLATFORM_CAPABILITY_TOOLS.has(name)) {
      return this.handlePlatformCapability(
        name,
        { ...args, __desktopCaller: { agentId, threadId, taskId: runtimeContext?.taskId } },
        startTime,
        {
          principalId: agentId,
          correlationId: runtimeContext?.toolCallId ?? `platform-tool:${name}:${Date.now()}`,
          executionId: runtimeContext?.executionId,
          processId: runtimeContext?.processId,
          deadline: runtimeContext?.deadline,
        },
        runtimeContext?.signal,
      )
    }

    const handler = this.registry.getHandler(name)
    if (!handler) {
      logger.warn(__t('logs.agent', '未知工具: {0}', [name]))
      return {
        output: `未找到工具: ${name}`,
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }

    // ── Hook: before_tool_call ──
    if (this.hookEmitter) {
      try {
        const hookData = await this.hookEmitter.emitHook('chat:beforeToolCall', {
          name,
          args,
          source,
          agentId,
          threadId,
          channel,
          realmId: runtimeContext?.realmId,
          taskId: runtimeContext?.taskId,
          capabilityScope: runtimeContext?.capabilityScope,
        })
        // Hook 可以修改参数
        if (hookData && typeof hookData === 'object' && 'args' in hookData) {
          const candidate = (hookData as { args: Record<string, unknown> }).args
          if (candidate && typeof candidate === 'object' && !Array.isArray(candidate))
            args = candidate
        }
      } catch (err) {
        logger.warn(__t('logs.agent', 'before_tool_call Hook 执行失败: {0}', [err]))
      }
    }

    if (name === 'edit_file') {
      try {
        const session = await resolveExecutionSession({
          agentId,
          threadId,
          channel,
          taskId: runtimeContext?.taskId,
        })
        args = prepareFileEditArguments(args, fileEditOwner(session, runtimeContext?.realmId))
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
          durationMs: Date.now() - startTime,
          shouldTerminate: false,
        }
      }
    }
    const remoteTerminalTool = isRemoteTerminalTool(name)
    const isDeviceReadTool = DEVICE_READ_TOOLS.has(name)
    const isSkillTool =
      typeof this.capabilityGate?.isSkillUnlockedTool === 'function' &&
      this.capabilityGate.isSkillUnlockedTool(sessionId, name)
    // 远程节点路径由节点侧解释，不能拿 Server Workspace 边界误判。
    let pathViolation =
      !remoteTerminalTool && !isDeviceReadTool
        ? this.checkPathAllowed(name, args, agentId, channel)
        : null
    // 相对路径以本次执行会话为准；真实路径检查覆盖 Junction 和符号链接。
    if (name === 'delete_file' || TERMINAL_APPROVAL_TOOLS.has(name)) {
      try {
        const session = await resolveExecutionSession({
          agentId,
          threadId,
          channel,
          taskId: runtimeContext?.taskId,
        })
        const inputPath = name === 'delete_file' ? args.file_path : args.cwd
        if (typeof inputPath === 'string') {
          const resolved = path.resolve(
            session.workspaceRoot,
            inputPath.replace(/^@principal[\\/]/i, ''),
          )
          const actual = await realpath(resolved)
          const root = await realpath(session.workspaceRoot)
          const relative = path.relative(root, actual)
          const outside =
            relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
          pathViolation = outside
            ? actual
            : this.checkPathAllowed(
                name,
                { ...args, [name === 'delete_file' ? 'file_path' : 'cwd']: actual },
                agentId,
                channel,
              )
        }
      } catch {
        // 无法解析的路径交给实际工具报告；外部删除的词法越界标记仍保留。
      }
    }
    if (pathViolation) {
      logger.warn(
        __t(
          'logs.agent',
          '工具 {0} 请求 ResourceScope 外路径，按当前执行模式处理: {1} (agent={2}, channel={3})',
          [name, pathViolation, agentId, channel],
        ),
      )
    }

    // 参数与审批策略必须基于 Hook 修改后的最终参数执行。
    let approvalObservation:
      | { decision: string; userMessage?: string; source?: 'automatic_reviewer' }
      | undefined
    let approvedSensitiveAction = false
    let approvedOutsideWorkspace = false
    const executionMode = threadPolicy
      ? resolveExecutionMode(threadPolicy.executionMode, threadPolicy.autoExecuteTools)
      : resolveExecutionMode(runtimeContext?.executionMode, runtimeContext?.autoExecuteTools)
    const fullAccess = executionMode === 'full'
    const autoExecuteTools = executionMode !== 'manual'
    if (!fullAccess && TERMINAL_APPROVAL_TOOLS.has(name)) {
      const denied = this.approvalService?.consumeDeniedOnce({
        agentId,
        sessionId,
        threadId,
        taskId: runtimeContext?.taskId,
        toolName: name,
        args,
      })
      if (denied)
        return {
          output: JSON.stringify({
            code: 'APPROVAL_DENIED',
            source: 'user',
            message: __t('server.agent', '用户拒绝了本次工具调用'),
            userMessage: denied,
          }),
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
    }
    let readOnlyTerminal: ReadOnlyTerminalGrant | undefined
    if (
      !fullAccess &&
      this.policyEngine &&
      !pathViolation &&
      !isSkillTool &&
      !this.registry.isRuntimeScoped(name) &&
      ['terminal_execute', 'terminal_create'].includes(name)
    ) {
      const definition = this.registry.getDefinition(name)
      const permission = this.capabilityGate?.getToolPermission(agentId, channel, name)
      const plan = planReadOnlyTerminal(args)
      const allowed = permission?.paramPolicy?.allowedCommands?.map((command) =>
        command.toLowerCase(),
      )
      if (
        plan &&
        !definition?.requiresApproval &&
        !permission?.requiresApproval &&
        !definition?.actionPermissions?.[String(args.action)]?.requiresApproval &&
        (!allowed?.length ||
          plan.commands.every((command) => allowed.includes(command.toLowerCase()))) &&
        this.policyEngine.evaluate({
          agentId,
          channel,
          sessionId,
          threadId,
          taskId: runtimeContext?.taskId,
          toolName: name,
          args,
          permission,
          readOnlyTerminal: true,
        }).action === 'allow'
      ) {
        // 固定 Hook 后参数；只读授权随本次调用传递，不写入用户审批记录。
        args = JSON.parse(JSON.stringify(args)) as Record<string, unknown>
        const session = await resolveExecutionSession({
          agentId,
          threadId,
          channel,
          taskId: runtimeContext?.taskId,
        })
        readOnlyTerminal =
          (await grantReadOnlyTerminal(
            plan,
            session.workspaceRoot,
            args.cwd,
            (target) =>
              this.checkPathAllowed(name, { file_path: target }, agentId, channel) === null,
            runtimeContext?.signal,
          )) ?? undefined
      }
    }
    const needsAutomaticReview =
      executionMode === 'auto_approve' &&
      ((name === 'runtime_debug' && typeof args.code === 'string' && !!args.code.trim()) ||
        this.registry.isRuntimeScoped(name) ||
        (TERMINAL_APPROVAL_TOOLS.has(name) && !readOnlyTerminal) ||
        [
          'remote_terminal_create',
          'remote_terminal_write',
          'remote_terminal_interrupt',
          'remote_terminal_kill',
          'remote_terminal_close',
        ].includes(name) ||
        (name === 'delete_file' && pathViolation !== null))
    let automaticReview: AutomaticApprovalDecision | undefined
    if (needsAutomaticReview) {
      const denied = this.approvalService?.consumeDeniedOnce({
        agentId,
        sessionId,
        taskId: runtimeContext?.taskId,
        threadId,
        toolName: name,
        args,
      })
      if (denied)
        return {
          output: JSON.stringify({
            code: 'APPROVAL_DENIED',
            source: 'user',
            message: __t('server.agent', '用户拒绝了本次工具调用'),
            userMessage: denied,
          }),
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      runtimeContext?.onExecutionStatus?.('正在自动审批……')
      // Hook 后冻结本次参数，审批期间不得悄悄换成另一条命令。
      args = JSON.parse(JSON.stringify(args)) as Record<string, unknown>
      try {
        automaticReview = this.automaticApproval
          ? await this.automaticApproval.review({
              toolName: name,
              args,
              agentId,
              threadId,
              channel,
              taskId: runtimeContext?.taskId,
              messages: runtimeContext?.reviewMessages,
              signal: runtimeContext?.signal,
            })
          : {
              source: 'automatic_reviewer',
              decision: 'deny',
              errorCode: 'model_error',
              reason: '自动审批服务不可用，本次操作未执行',
            }
        // 审批服务的无效结果同样不得落入人工审批或执行分支。
        if (!parseAutomaticApproval(automaticReview)) {
          automaticReview = {
            source: 'automatic_reviewer',
            decision: 'deny',
            errorCode: 'invalid_response',
            reason: '自动审批服务没有返回有效结论，本次操作未执行',
          }
        }
        if (
          automaticReview.decision === 'allow' &&
          automaticReview.validate &&
          !(await automaticReview.validate())
        ) {
          automaticReview = {
            ...automaticReview,
            decision: 'deny',
            errorCode: 'context_changed',
            reason: '审批期间脚本或目标路径发生变化，本次操作未执行',
          }
        }
      } catch (error) {
        runtimeContext?.signal?.throwIfAborted()
        automaticReview = {
          source: 'automatic_reviewer',
          decision: 'deny',
          errorCode: 'model_error',
          reason: `自动审批异常，本次操作未执行：${(error instanceof Error ? error.message : String(error)).slice(0, 240)}`,
        }
      }
      runtimeContext?.signal?.throwIfAborted()
      if (automaticReview.decision === 'deny') {
        const failed = !!automaticReview.errorCode
        runtimeContext?.onExecutionStatus?.(
          failed ? '自动审批异常，本次操作未执行' : '自动审批员拒绝了本次操作',
        )
        return {
          output: JSON.stringify({
            code: failed ? 'AUTOMATIC_APPROVAL_ERROR' : 'AUTOMATIC_APPROVAL_DENIED',
            source: 'automatic_reviewer',
            message: failed
              ? __t(
                  'server.agent',
                  '自动审批发生异常，本次调用未执行。这不是用户拒绝，也不代表审批员认定该操作不允许。异常原因：{0}',
                  [automaticReview.reason],
                )
              : __t(
                  'server.agent',
                  '自动审批员拒绝了本次调用。这是自动审批员的判断，不是用户拒绝或用户的新指令。理由：{0}',
                  [automaticReview.reason],
                ),
            reason: automaticReview.reason,
            ...(failed ? { errorCode: automaticReview.errorCode } : {}),
            suggestedAction: failed
              ? '根据审批异常原因重试或调整方案，继续能够执行的事项；不要称为用户拒绝，也不要等待人工审批。'
              : '根据自动审批员的理由调整方案；不要将该结论归因于用户，也不要原样重复调用。',
          }),
          metadata: { automaticApproval: parseAutomaticApproval(automaticReview) },
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      }
      if (automaticReview.decision === 'allow') {
        approvedSensitiveAction = true
        approvedOutsideWorkspace = pathViolation !== null
        approvalObservation = {
          decision: 'allow',
          source: 'automatic_reviewer',
          userMessage: automaticReview.reason,
        }
        runtimeContext?.onExecutionStatus?.('自动审批通过，正在执行工具……')
      }
    }
    const skipApprovalPolicy = fullAccess || automaticReview?.decision === 'allow'
    const pathRequiresApproval =
      !skipApprovalPolicy && pathViolation !== null && (!autoExecuteTools || name === 'delete_file')
    const forceApprovalEachCall =
      (name === 'runtime_debug' && typeof args.code === 'string' && !!args.code.trim()) ||
      this.registry.isRuntimeScoped(name) ||
      (!autoExecuteTools && remoteTerminalTool) ||
      (!remoteTerminalTool &&
        (pathRequiresApproval ||
          (TERMINAL_APPROVAL_TOOLS.has(name) && !readOnlyTerminal) ||
          (!autoExecuteTools && ALWAYS_APPROVE_EACH_CALL_TOOLS.has(name) && !readOnlyTerminal)))
    if (!skipApprovalPolicy && forceApprovalEachCall && !this.policyEngine) {
      return {
        output: JSON.stringify({
          code: 'APPROVAL_UNAVAILABLE',
          message: __t('server.agent', '该敏感工具调用必须经过用户审批，但策略引擎当前不可用'),
        }),
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }
    if (this.policyEngine && !fullAccess) {
      const permission = this.capabilityGate?.getToolPermission(agentId, channel, name)
      const actionPermission =
        typeof args.action === 'string'
          ? this.registry.getDefinition(name)?.actionPermissions?.[args.action]
          : undefined
      const declaredPermission =
        this.registry.getDefinition(name)?.requiresApproval ||
        actionPermission?.requiresApproval ||
        (!actionPermission && SOCIAL_BUSINESS_TOOLS.some((tool) => tool === name))
          ? {
              toolName: name,
              resourceScope: permission?.resourceScope ?? {
                allowedRoots: [],
                deniedPaths: [],
                scope: 'system' as const,
              },
              paramPolicy: permission?.paramPolicy,
              requiresApproval: true,
            }
          : permission
      const basePolicyDecision = this.policyEngine.evaluate({
        agentId,
        channel,
        sessionId,
        threadId,
        taskId: runtimeContext?.taskId,
        toolName: name,
        args,
        permission: declaredPermission,
        readOnlyTerminal: !!readOnlyTerminal,
      })
      const policyDecision = remoteTerminalTool
        ? autoExecuteTools
          ? { action: 'allow' as const }
          : {
              action: 'require_approval' as const,
              reason: `远程能力节点工具 ${name} 在非自动执行模式下必须逐次审批`,
              riskLevel: 'high' as const,
            }
        : autoExecuteTools &&
            basePolicyDecision.action === 'require_approval' &&
            !TERMINAL_APPROVAL_TOOLS.has(name) &&
            !(name === 'delete_file' && pathViolation !== null) &&
            name !== 'runtime_debug' &&
            !this.registry.isRuntimeScoped(name)
          ? { action: 'allow' as const }
          : isSkillTool && executionMode !== 'auto_approve' && basePolicyDecision.action === 'allow'
            ? {
                action: 'require_approval' as const,
                reason: `工具 ${name} 由Skill临时解锁，首次执行需要用户确认`,
                riskLevel: 'medium' as const,
              }
            : basePolicyDecision
      let decision: PolicyDecision = policyDecision
      if (automaticReview?.decision === 'allow') {
        decision = basePolicyDecision.action === 'deny' ? basePolicyDecision : { action: 'allow' }
      } else if (pathRequiresApproval) {
        decision = {
          action: 'require_approval',
          reason: `工具 ${name} 请求访问工作区或资源范围外路径：${pathViolation}`,
          riskLevel: 'high',
        }
      }
      if (decision.action === 'deny') {
        return {
          output: JSON.stringify({ code: decision.code, message: decision.reason }),
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      }
      if (decision.action === 'require_approval') {
        // 自动审批模式不能因遗留策略落入等待用户的分支。
        if (executionMode === 'auto_approve')
          return {
            output: JSON.stringify({
              code: 'EXECUTION_POLICY_DENIED',
              source: 'execution_policy',
              message: __t(
                'server.agent',
                '执行策略未放行本次操作，工具未执行：{0}。此结果不是用户拒绝，自动审批模式不会挂起等待人工审批。',
                [decision.reason],
              ),
            }),
            durationMs: Date.now() - startTime,
            isError: true,
            shouldTerminate: false,
          }
        if (!this.approvalService) {
          return {
            output: JSON.stringify({
              code: 'APPROVAL_UNAVAILABLE',
              message: __t('server.agent', '该工具调用需要用户审批，但审批服务当前不可用'),
            }),
            durationMs: Date.now() - startTime,
            isError: true,
            shouldTerminate: false,
          }
        }
        const deniedOnceMessage = this.approvalService.consumeDeniedOnce({
          agentId,
          sessionId,
          toolName: name,
          args,
        })
        if (deniedOnceMessage) {
          return {
            output: JSON.stringify({
              code: 'APPROVAL_DENIED',
              message: __t('server.agent', '用户拒绝了本次工具调用'),
              userMessage: deniedOnceMessage,
              suggestedAction: '根据用户附言调整方案，不要原样重试。',
            }),
            durationMs: Date.now() - startTime,
            isError: true,
            shouldTerminate: false,
          }
        }
        const storedAuthorization = this.approvalService.authorize({
          agentId,
          sessionId,
          toolName: name,
          args,
        })
        const authorization =
          forceApprovalEachCall && !runtimeContext?.taskId && storedAuthorization === 'allow'
            ? 'none'
            : storedAuthorization
        if (authorization === 'deny') {
          // 若用户留过拒绝附言，把理由一并回传给 Agent，避免原样盲目重试。
          const userMessage = this.approvalService.findDeniedMessage({
            agentId,
            sessionId,
            toolName: name,
            args,
          })
          return {
            output: JSON.stringify({
              code: 'APPROVAL_DENIED',
              message: __t('server.agent', '该工具调用已被用户拒绝'),
              ...(userMessage
                ? { userMessage, suggestedAction: '根据用户附言调整方案，不要原样重试。' }
                : {}),
            }),
            durationMs: Date.now() - startTime,
            isError: true,
            shouldTerminate: false,
          }
        }
        if (authorization !== 'allow') {
          const approval = this.approvalService.create({
            agentId,
            channel,
            sessionId,
            threadId,
            taskId: runtimeContext?.taskId,
            toolName: name,
            args,
            reason: decision.reason,
            riskLevel: decision.riskLevel,
          })
          if (runtimeContext?.taskId) {
            return {
              output: JSON.stringify({
                code: 'APPROVAL_PENDING',
                approvalId: approval.id,
                message: __t('server.agent', '等待用户决定后，按原参数重新调用此工具。'),
              }),
              metadata: automaticReview
                ? { automaticApproval: parseAutomaticApproval(automaticReview) }
                : undefined,
              durationMs: Date.now() - startTime,
              isError: false,
              shouldTerminate: true,
            }
          }
          runtimeContext?.onExecutionStatus?.('正在等待你的审批，尚未执行工具……')
          const resolved = await this.approvalService.waitForResolution(
            approval.id,
            runtimeContext?.signal,
          )
          if (resolved.status !== 'approved' || !resolved.decision?.startsWith('allow_')) {
            runtimeContext?.onExecutionStatus?.('本次操作未获允许，正在回传决策……')
            return {
              output: JSON.stringify({
                code: 'APPROVAL_DENIED',
                message: __t('server.agent', '用户拒绝了本次工具调用'),
                ...(resolved.resolutionMessage
                  ? {
                      userMessage: resolved.resolutionMessage,
                      suggestedAction: '根据用户附言调整方案，不要原样重试。',
                    }
                  : {}),
              }),
              durationMs: Date.now() - startTime,
              isError: true,
              shouldTerminate: false,
            }
          }
          runtimeContext?.signal?.throwIfAborted()
          runtimeContext?.onExecutionStatus?.('已允许，正在执行工具并等待结果……')
          // waitForResolution 已确认本次原调用，因此直接续行；allow_once 在此消费。
          if (resolved.decision === 'allow_once') {
            this.approvalService.authorize({ agentId, sessionId, toolName: name, args })
          }
          approvalObservation = {
            decision: resolved.decision,
            userMessage: resolved.resolutionMessage,
          }
          approvedSensitiveAction = remoteTerminalTool || ALWAYS_APPROVE_EACH_CALL_TOOLS.has(name)
          approvedOutsideWorkspace = pathViolation !== null
        }
        if (authorization === 'allow') {
          approvedSensitiveAction = remoteTerminalTool || ALWAYS_APPROVE_EACH_CALL_TOOLS.has(name)
          approvedOutsideWorkspace = pathViolation !== null
        }
      }
    }

    if (fullAccess) {
      approvedSensitiveAction = true
      approvedOutsideWorkspace = true
    }

    if (autoExecuteTools && remoteTerminalTool) {
      approvedSensitiveAction = true
    }
    if (autoExecuteTools && name === 'delete_file' && pathViolation === null) {
      approvedSensitiveAction = true
    }
    if (autoExecuteTools && pathViolation !== null && name !== 'delete_file') {
      approvedOutsideWorkspace = true
    }

    // 工具只受调用方取消信号和各工具自身契约控制；全局执行器不设置超时。
    try {
      if (
        approvedOutsideWorkspace &&
        LOCAL_PATH_TOOLS.has(name) &&
        [...PATH_PARAM_NAMES].some((key) => typeof args[key] === 'string' && args[key])
      ) {
        const session = await resolveExecutionSession({
          agentId,
          threadId,
          channel,
          taskId: runtimeContext?.taskId,
        })
        args = { ...args }
        for (const key of PATH_PARAM_NAMES) {
          if (typeof args[key] === 'string' && args[key]) {
            args[key] = path.resolve(
              session.workspaceRoot,
              String(args[key]).replace(/^@principal[\\/]/i, ''),
            )
          }
        }
      }
      runtimeContext?.signal?.throwIfAborted()
      if (
        ['write_file', 'edit_file', 'delete_file'].includes(name) &&
        typeof args.file_path === 'string'
      ) {
        const session = await resolveExecutionSession({
          agentId,
          threadId,
          channel,
          taskId: runtimeContext?.taskId,
        })
        const target = path.resolve(
          session.workspaceRoot,
          args.file_path.replace(/^@principal[\\/]/i, ''),
        )
        const resource = await protectedResourceWrite(getDataDir(), target)
        if (resource)
          return {
            output: JSON.stringify({
              code: 'RESOURCE_CANDIDATE_REQUIRED',
              resource,
              message: __t(
                'server.resource-versions',
                '请先创建资源候选并编辑候选目录，再由用户应用。调试模式可用 debug.resources.checkout，也可从资源版本页创建。',
              ),
            }),
            durationMs: Date.now() - startTime,
            isError: true,
            shouldTerminate: false,
          }
      }
      // AIOS: 透传 threadId + channel 给工具处理函数
      const context: ToolContext = {
        requestedBy: runtimeContext?.requestedBy,
        source,
        agentId,
        sessionId,
        threadId,
        channel,
        signal: runtimeContext?.signal,
        loopGuard: runtimeContext?.loopGuard,
        executionMode,
        interactionMode,
        disabledTools: threadPolicy?.disabledTools ?? runtimeContext?.disabledTools,
        advancedToolAccess: runtimeContext?.advancedToolAccess,
        realmId: runtimeContext?.realmId,
        browserScope: runtimeContext?.browserScope,
        capabilityScope: runtimeContext?.capabilityScope,
        reviewMessages: runtimeContext?.reviewMessages,
        onExecutionStatus: runtimeContext?.onExecutionStatus,
        onNestedToolCall: runtimeContext?.onNestedToolCall,
        onToolObserved: runtimeContext?.onToolObserved,
        taskId: runtimeContext?.taskId,
        executionId: runtimeContext?.executionId,
        processId: runtimeContext?.processId,
        deadline: runtimeContext?.deadline,
        pairId: runtimeContext?.pairId,
        toolCallId: runtimeContext?.toolCallId,
        ...(approvedSensitiveAction ? { approvedSensitiveAction: true } : {}),
        ...(readOnlyTerminal ? { readOnlyTerminal } : {}),
        ...(isDeviceReadTool ? { deviceReadScope: true } : {}),
        ...(approvedOutsideWorkspace ? { approvedOutsideWorkspace: true } : {}),
      }

      if (context.taskId)
        await optionalTaskToolRuntime()?.beforeTool(
          context.taskId,
          context.executionId,
          name,
          context.toolCallId ?? '',
          !!readOnlyTerminal,
        )
      const rawResult = await handler(args, context)
      if (context.taskId)
        await optionalTaskToolRuntime()?.afterTool(
          context.taskId,
          context.executionId,
          context.toolCallId ?? '',
        )
      const durationMs = Date.now() - startTime
      const structuredResult = typeof rawResult === 'string' ? null : rawResult
      const rawOutput = typeof rawResult === 'string' ? rawResult : rawResult.output
      const isError = isStructuredToolResult(structuredResult)
        ? !structuredResult.ok
        : (structuredResult?.isError ?? isLegacyToolErrorOutput(rawOutput))
      logger.info(
        __t('logs.agent', '工具 {0} 执行完成 ({1}ms, error={2})', [name, durationMs, isError]),
      )

      // 截图等需要下游解析的工具输出不能截断：
      // take_screenshot 返回的完整 base64 必须交给 reactLoop 解析后转成 image_url 内容块，
      // 若被 truncate 砍断会导致 JSON 解析失败、base64 残片污染上下文、模型读不到图片。
      // reactLoop 会在提取后剥离 base64，不会把超长数据灌进上下文，因此此处放行是安全的。
      const output = fileToolBusinessOutput(name, rawOutput)
      const modelOutput = SKIP_TRUNCATE_TOOLS.has(name)
        ? output
        : modelToolObservation(output, {
            agentId,
            threadId,
            taskId: runtimeContext?.taskId,
            channel,
            realmId: runtimeContext?.realmId,
          })

      // ── Hook: after_tool_call ──
      if (this.hookEmitter) {
        try {
          await this.hookEmitter.emitHook('chat:afterToolCall', {
            threadId,
            agentId,
            channel,
            realmId: runtimeContext?.realmId,
            taskId: runtimeContext?.taskId,
            capabilityScope: runtimeContext?.capabilityScope,
            name,
            args,
            output,
            durationMs,
            isError,
          })
        } catch {
          // after Hook 失败不影响结果
        }
      }

      return {
        output,
        modelOutput,
        ...(output !== rawOutput ? { displayOutput: rawOutput } : {}),
        durationMs,
        isError,
        metadata: {
          ...(readOnlyTerminal ? { readOnly: true } : {}),
          ...(isStructuredToolResult(structuredResult) ? structuredResult.metadata : {}),
          ...(automaticReview
            ? { automaticApproval: parseAutomaticApproval(automaticReview) }
            : {}),
        },
        shouldTerminate:
          structuredResult && 'shouldTerminate' in structuredResult
            ? (structuredResult.shouldTerminate ?? false)
            : false,
        approvalObservation: approvalObservation
          ? `【${approvalObservation.source === 'automatic_reviewer' ? '自动审批员结论，非用户决定' : '用户审批'}】决策：${approvalObservation.decision}${approvalObservation.userMessage ? `；说明：${approvalObservation.userMessage}` : ''}`
          : undefined,
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const durationMs = Date.now() - startTime
      logger.error(__t('logs.agent', '工具 {0} 执行失败 ({1}ms): {2}', [name, durationMs, errMsg]))

      // ── Hook: after_tool_call (错误) ──
      if (this.hookEmitter) {
        try {
          await this.hookEmitter.emitHook('chat:afterToolCall', {
            threadId,
            agentId,
            channel,
            realmId: runtimeContext?.realmId,
            taskId: runtimeContext?.taskId,
            capabilityScope: runtimeContext?.capabilityScope,
            name,
            args,
            output: errMsg,
            durationMs,
            isError: true,
          })
        } catch {
          // after Hook 失败不影响结果
        }
      }

      return {
        output: truncate(`执行失败: ${errMsg}`),
        durationMs,
        isError: true,
        metadata: automaticReview
          ? { automaticApproval: parseAutomaticApproval(automaticReview) }
          : undefined,
        approvalObservation: approvalObservation
          ? `【${approvalObservation.source === 'automatic_reviewer' ? '自动审批员结论，非用户决定' : '用户审批'}】决策：${approvalObservation.decision}${approvalObservation.userMessage ? `；说明：${approvalObservation.userMessage}` : ''}`
          : undefined,
        shouldTerminate: false,
      }
    }
  }

  // ── 平台能力工具路由（第七阶段 #5）──

  /**
   * 处理平台能力工具调用
   *
   * 通过 CapabilityBridge 转发到有能力的节点（如 Electron）执行。
   * - capabilityBridge 未配置：返回友好错误（旧模式兼容）
   * - 无可用节点：返回友好错误（能力降级，LLM 自行处理）
   * - 调用成功/失败：透传节点返回的结果
   *
   * 注意：平台能力工具跳过 CapabilityGate 白名单校验，
   * 因为这些工具的可用性由"是否有节点注册"决定，而非 channel 配置。
   */
  private async handlePlatformCapability(
    toolName: string,
    args: Record<string, unknown>,
    startTime: number,
    context: import('@infos/shared').KernelCallContext,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (!this.desktopCapabilities) {
      return {
        output: `工具 "${toolName}" 在当前运行环境不可用，请连接 Electron Client。`,
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }
    const operation = TOOL_NAME_TO_DESKTOP_OPERATION[toolName]
    if (!operation) {
      return {
        output: `工具 "${toolName}" 没有对应的 Desktop Capability Operation。`,
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }
    logger.info(
      __t('logs.agent', '平台能力工具调用: {0} → desktop.environment/{1}', [toolName, operation]),
    )
    try {
      const output = await this.desktopCapabilities.invoke(operation, args, context, signal)
      return {
        output: typeof output === 'string' ? output : JSON.stringify(output),
        durationMs: Date.now() - startTime,
        isError: false,
        shouldTerminate: false,
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(__t('logs.agent', '平台能力工具 {0} 调用异常: {1}', [toolName, errMsg]))
      return {
        output: `工具 "${toolName}" 调用失败: ${errMsg}`,
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }
  }

  // ── ResourceScope 路径校验（第六阶段 #6）──

  /**
   * 校验工具参数中的路径是否落在 ResourceScope 允许范围内
   *
   * 从 args 中按 PATH_PARAM_NAMES 提取路径参数，
   * 对每个非空字符串路径调用 CapabilityGate.isPathAllowed() 校验。
   *
   * @returns 拒绝原因字符串（首个被拒路径），全部通过时返回 null
   */
  private checkPathAllowed(
    toolName: string,
    args: Record<string, unknown>,
    agentId: string,
    channel: string,
  ): string | null {
    for (const [key, value] of Object.entries(args)) {
      if (!PATH_PARAM_NAMES.has(key)) continue
      if (typeof value !== 'string' || value.length === 0) continue

      const withinWorkspace = this.pathBoundaryChecker?.(agentId, channel, value) ?? true
      const withinResourceScope =
        this.capabilityGate?.isPathAllowed(agentId, channel, toolName, value) ?? true
      if (!withinWorkspace || !withinResourceScope) {
        return `${key}=${value}`
      }
    }
    return null
  }

  // ── 内置工具: load_skill ──

  private async handleLoadSkill(
    args: Record<string, unknown>,
    sessionId: string,
    startTime: number,
  ): Promise<ToolExecutionResult> {
    const skillId = (args.skill_id as string) ?? (args.skillId as string)
    if (!skillId) {
      return {
        output: '缺少参数 skill_id',
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }

    if (!this.skillLoader) {
      return {
        output: 'Skill 系统未初始化',
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }

    try {
      const params = (args.params as Record<string, string>) ?? undefined
      const fullContent = this.skillLoader.loadSkillContentWithParams(skillId, params)
      if (!fullContent) {
        return {
          output: `Skill "${skillId}" 不存在或加载失败`,
          durationMs: Date.now() - startTime,
          isError: true,
          shouldTerminate: false,
        }
      }

      if (this.capabilityGate) {
        this.unlockSkillToolsRecursive(sessionId, skillId, new Set())
      }

      const paramKeys = params ? Object.keys(params) : []
      const paramInfo = paramKeys.length > 0 ? ` (已注入参数: ${paramKeys.join(', ')})` : ''
      logger.info(
        __t('logs.agent', 'Skill {0} 已加载{1} (session={2})', [skillId, paramInfo, sessionId]),
      )

      return {
        output: fullContent,
        durationMs: Date.now() - startTime,
        isError: false,
        shouldTerminate: false,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(__t('logs.agent', 'Skill {0} 加载异常: {1}', [skillId, message]))
      return {
        output: `Skill "${skillId}" 加载失败: ${message}`,
        durationMs: Date.now() - startTime,
        isError: true,
        shouldTerminate: false,
      }
    }
  }

  /**
   * 递归解锁 Skill 及其依赖子 Skill 的工具
   *
   * visited 防止循环依赖导致的无限递归。
   */
  private unlockSkillToolsRecursive(
    sessionId: string,
    skillId: string,
    visited: Set<string>,
  ): void {
    if (visited.has(skillId)) return
    visited.add(skillId)

    // 解锁当前 Skill 的工具
    this.capabilityGate!.unlockSkillTools(sessionId, skillId)

    // 获取子 Skill 列表并递归解锁
    if (!this.skillLoader) return
    const manifest = this.skillLoader.getManifest(skillId)
    if (!manifest?.dependsOnSkills?.length) return

    for (const childSkillId of manifest.dependsOnSkills) {
      this.unlockSkillToolsRecursive(sessionId, childSkillId, visited)
      logger.debug(
        __t('logs.agent', '子 Skill {0} 工具已递归解锁 (parent={1}, session={2})', [
          childSkillId,
          skillId,
          sessionId,
        ]),
      )
    }
  }
}

/** 截断过长文本 */
function truncate(text: string): string {
  return modelToolObservation(text, {})
}
