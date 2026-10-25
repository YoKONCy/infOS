import { t as __t } from '../../lib/i18n'
/**
 * run_script — NIT 脚本执行工具
 *
 * 将 NIT 解释器暴露为标准 FC 工具。
 * LLM 通过 Function Calling 调用此工具，传入 NIT 脚本代码，
 * 脚本内部可以编排其他已注册工具的调用（条件/循环/并行）。
 *
 * 设计理念：
 * - NIT 不再是与 FC 并列的"双轨"调用通道
 * - NIT 解释器变成 FC 工具链中的一个"高级编排工具"
 * - LLM 只需要学一种调用方式 (FC)，复杂场景通过 run_script 升级
 *
 * AIOS(Phase4):
 * - 注入 WorkspaceService（setWorkspaceService 模式，共享持有器）
 * - 在 execute 开头按 channel 分级计算 cwd（同 terminalExecutor 逻辑）
 *   desktop 通道可授权使用 args.cwd，其他通道强制 workspace root
 * - run_script 仅接受 inline 脚本（args.code），无脚本文件路径参数，
 *   因此「脚本路径限制在 workspace」不适用；args.code 不做路径检查
 * - CapabilityGate 校验由 ToolExecutor 在调用 run_script 前完成，
 *   脚本内部调用其他工具时由 _toolExecutor 闭包（container.ts 绑定）负责鉴权
 *
 * 第六阶段 #7:
 * - run_script 自身经过 CapabilityGate 校验（由 ToolExecutor 在调用前完成）
 * - 校验 args.cwd 在 ResourceScope.allowedRoots 范围内（若该工具配置了权限）
 * - 内部 _toolExecutor 闭包透传 threadId + channel，让被调用的工具也走
 *   CapabilityGate 鉴权与 ResourceScope 路径校验
 *
 * @module packages/backend/src/tools/runScript
 */

import type { BuiltinTool } from '../index'
import { randomUUID } from 'node:crypto'
import type { ToolExecutionResult } from '../../services/agent/reactLoop'
import type { ToolExecutor } from '../../services/agent/reactLoop'
import { NitLexer, NitParser, NitRuntime } from '../../nit'
import type { NitResult } from '../../nit/types'
import { isAdvancedTool } from '../advancedTools'
import { createLogger } from '../../lib/logger'
import { getWorkspaceService } from '../workspaceServiceHolder'
import { getCapabilityGate } from '../capabilityGateHolder'
import { desktopPauseFromObservation } from '../../services/execution/desktopPause'
import {
  createCancellationScope,
  waitWithSignal,
  waitForCancellationCleanup,
} from '../../services/execution/cancellation'

const logger = createLogger('RunScript')

/** 脚本自身执行预算不含工具等待；总耗时另受父任务和本次截止时间限制。 */
const SCRIPT_TIMEOUT_MS = 30_000
const MAX_SCRIPT_WALL_TIME_MS = 10 * 60_000
const CLEANUP_TIMEOUT_MS = 5_000

export const runScriptTool: BuiltinTool = {
  name: 'run_script',

  async execute(args, ctx) {
    ctx.signal?.throwIfAborted()
    const code = args.code as string
    if (!code?.trim()) {
      throw new Error('脚本内容为空')
    }
    const program = new NitParser(new NitLexer(code).tokenize()).parse()
    const access = ctx.advancedToolAccess
    if (access && !ctx.realmId) {
      const unavailable = new Set<string>()
      // 在任何副作用之前检查整棵语法树；字符串、注释中的工具名不参与匹配。
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        if (Array.isArray(value)) {
          value.forEach(visit)
          return
        }
        const node = value as Record<string, unknown>
        if (
          node.type === 'FunctionCall' &&
          typeof node.name === 'string' &&
          isAdvancedTool(node.name) &&
          (!access.expanded || !access.names.has(node.name))
        )
          unavailable.add(node.name)
        Object.values(node).forEach(visit)
      }
      visit(program)
      if (unavailable.size)
        throw new Error(
          `脚本尚未执行任何工具；以下高级工具未开放：${[...unavailable].join('、')}。请先在脚本外直接调用 expand_advanced_tools，取得当前定义后再编排。若仍不在菜单中，请检查会话开关与权限，不要重复已完成的操作。`,
        )
    }

    // AIOS(Phase4): 按 channel 分级计算 cwd（同 terminalExecutor 逻辑）
    // - desktop 通道可授权使用 args.cwd（已存在的目录），否则回退 workspace root
    // - 其他通道强制使用 workspace root，忽略 args.cwd
    // 注：NIT 解释器本身不直接消费 cwd，此处计算用于：
    //   1. 强制 channel 策略生效（companion/social/group 不可逃逸 workspace）
    //   2. 记录到日志便于审计脚本执行环境
    //   3. 后续可通过 NitToolExecutor 闭包向下传递给被调用的工具
    const workspaceService = getWorkspaceService()
    const cwd = workspaceService?.resolveTerminalCwd(
      ctx.agentId,
      args.cwd as string | undefined,
      ctx.channel,
    )

    // 第六阶段 #7: ResourceScope 校验
    // 若 run_script 在 (agentId, channel) 下配置了 ToolPermission，
    // 校验 cwd 是否落在 allowedRoots 内（system 级别不限制）。
    // 注：ToolExecutor 在调用 run_script 前已做 isToolAllowed 白名单校验，
    // 此处只补 cwd 的 ResourceScope 校验（防止脚本通过 args.cwd 逃逸到 workspace 外）。
    if (cwd) {
      const capabilityGate = getCapabilityGate()
      if (capabilityGate) {
        const allowed =
          ctx.approvedOutsideWorkspace ||
          capabilityGate.isPathAllowed(ctx.agentId, ctx.channel, 'run_script', cwd)
        if (!allowed) {
          logger.warn(
            __t(
              'logs.tools',
              'run_script cwd 被 ResourceScope 拒绝: cwd={0} (agent={1}, channel={2})',
              [cwd, ctx.agentId, ctx.channel],
            ),
          )
          throw new Error(`脚本工作目录被资源范围策略拒绝: ${cwd}`)
        }
      }
    }

    logger.info(
      __t('logs.tools', '执行 NIT 脚本 ({0} 字符, source={1}, channel={2}, cwd={3})', [
        code.length,
        ctx.source,
        ctx.channel,
        cwd ?? '未注入',
      ]),
    )

    const requestedTimeout =
      args.timeout_ms === undefined ? MAX_SCRIPT_WALL_TIME_MS : Number(args.timeout_ms)
    if (
      !Number.isInteger(requestedTimeout) ||
      requestedTimeout < 1 ||
      requestedTimeout > MAX_SCRIPT_WALL_TIME_MS
    )
      throw new Error('NIT 总耗时上限必须在 1 至 600000 毫秒之间')
    const scope = createCancellationScope({
      signal: ctx.signal,
      deadline: ctx.deadline,
      timeoutMs: requestedTimeout,
      timeoutMessage: 'NIT 已达到本次或父任务的截止时间，正在取消内部工具',
    })
    const { controller, signal } = scope
    const expiresAt = Math.min(
      Date.now() + requestedTimeout,
      ctx.deadline ? Date.parse(ctx.deadline) : Infinity,
    )
    const deadline = Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : ctx.deadline
    let timer: ReturnType<typeof setTimeout> | undefined
    let remainingMs = SCRIPT_TIMEOUT_MS
    let resumedAt = Date.now()
    let waitingTools = 0
    const resumeTimer = () => {
      if (signal.aborted) return
      if (remainingMs <= 0) {
        controller.abort(new Error('NIT 脚本自身执行预算已耗尽'))
        return
      }
      resumedAt = Date.now()
      timer = setTimeout(
        () => {
          controller.abort(
            new Error(`NIT 脚本执行超时 (${SCRIPT_TIMEOUT_MS}ms，不含工具与审批等待)`),
          )
        },
        Math.max(1, remainingMs),
      )
    }
    const pendingTools = new Set<Promise<ToolExecutionResult>>()
    const toolSignals = new Set<AbortSignal>([signal])
    let scriptPromise: Promise<NitResult> | undefined
    let scriptSettled = false
    const reviewMessages = [...(ctx.reviewMessages ?? [])]
    resumeTimer()
    try {
      signal.throwIfAborted()
      scriptPromise = new NitRuntime(
        async (name, toolArgs, branchSignal = signal) => {
          if (name === 'expand_advanced_tools')
            throw new Error('请在脚本外直接调用 expand_advanced_tools，取得工具定义后再编排脚本')
          if (name === 'read_image') throw new Error('请直接调用 read_image，以便将原图交给模型')
          if (name === 'run_script')
            throw new Error('NIT 不允许嵌套运行 run_script，请在同一脚本中编排')
          // 通过闭包获取外部的 ToolExecutor — 此处需要在注册时注入
          // run_script 工具的 toolExecutor 在 container.ts 中通过闭包绑定
          // AIOS: _toolExecutor 闭包负责 CapabilityGate 鉴权（在 container.ts 中接线）
          // 第六阶段 #7: 透传 ctx.threadId + ctx.channel，让被调用的工具也走
          // CapabilityGate 鉴权与 ResourceScope 路径校验
          branchSignal.throwIfAborted()
          toolSignals.add(branchSignal)
          if (waitingTools++ === 0) {
            if (timer) clearTimeout(timer)
            remainingMs -= Date.now() - resumedAt
          }
          let result: ToolExecutionResult
          try {
            if (!runScriptTool._toolExecutor) throw new Error('NIT 工具执行器尚未绑定')
            const callId = `nit-${randomUUID()}`
            if (ctx.toolCallId) {
              try {
                ctx.onNestedToolCall?.({
                  callId,
                  parentCallId: ctx.toolCallId,
                  name,
                  args: toolArgs,
                })
              } catch (error) {
                logger.warn(__t('logs.tools', 'NIT 子工具开始事件记录失败，仍继续执行工具'), {
                  name,
                  error,
                })
              }
            }
            const operation = runScriptTool._toolExecutor(name, toolArgs, ctx.source, {
              threadId: ctx.threadId,
              channel: ctx.channel,
              agentId: ctx.agentId,
              sessionId: ctx.sessionId,
              signal: branchSignal,
              loopGuard: ctx.loopGuard,
              taskId: ctx.taskId,
              realmId: ctx.realmId,
              browserScope: ctx.browserScope,
              requestedBy: ctx.requestedBy,
              executionId: ctx.executionId,
              processId: ctx.processId,
              deadline,
              pairId: ctx.pairId,
              toolCallId: callId,
              executionMode: ctx.executionMode,
              interactionMode: ctx.interactionMode,
              disabledTools: ctx.disabledTools,
              advancedToolAccess: ctx.advancedToolAccess,
              capabilityScope: ctx.capabilityScope,
              reviewMessages,
              onExecutionStatus: ctx.onExecutionStatus,
              onNestedToolCall: ctx.onNestedToolCall,
              onToolObserved: ctx.onToolObserved,
            })
            pendingTools.add(operation)
            const remove = () => {
              pendingTools.delete(operation)
            }
            void operation.then(remove, remove)
            result = await waitWithSignal(operation, branchSignal)
            branchSignal.throwIfAborted()
            reviewMessages.push({
              role: 'tool',
              name,
              content: result.modelOutput ?? result.output,
            })
          } finally {
            if (--waitingTools === 0) resumeTimer()
          }
          if (result.isError) {
            if (desktopPauseFromObservation({ name, output: result.output, isError: true }))
              controller.abort(
                new Error('桌面已被接管，脚本和内部工具已暂停，请确认当前状态后继续'),
              )
            throw new Error(result.output)
          }
          return result.output
        },
        { signal },
      ).execute(program)
      const markSettled = () => {
        scriptSettled = true
      }
      void scriptPromise.then(markSettled, markSettled)

      const result = await waitWithSignal(scriptPromise, signal)
      signal.throwIfAborted()

      const outputStr =
        typeof result.value === 'string' ? result.value : JSON.stringify(result.value ?? null)

      logger.info(__t('logs.tools', 'NIT 脚本执行完成: {0} 次工具调用', [result.toolCalls.length]))

      return JSON.stringify({
        success: true,
        value: outputStr,
        toolCallCount: result.toolCalls.length,
        toolCalls: result.toolCalls.map((tc) => ({
          name: tc.name,
          result: '内部调用已执行；详细结果由 value、工具来源与文件状态提供。',
        })),
      })
    } catch (err) {
      controller.abort(err)
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(__t('logs.tools', 'NIT 脚本执行失败: {0}', [errMsg]))
      throw new Error(`NIT 脚本执行失败: ${errMsg}`)
    } finally {
      if (timer) clearTimeout(timer)
      // 成功、失败和取消都不能留下本脚本创建的后台工具进程。
      controller.abort(new Error('NIT 已结束，正在回收内部工具'))
      scope.dispose()
      try {
        await Promise.all([...toolSignals].map(waitForCancellationCleanup))
      } finally {
        if (pendingTools.size || (scriptPromise && !scriptSettled)) {
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              Promise.allSettled([...pendingTools, ...(scriptPromise ? [scriptPromise] : [])]),
              new Promise<void>((resolve) => {
                cleanupTimer = setTimeout(resolve, CLEANUP_TIMEOUT_MS)
              }),
            ])
            if (pendingTools.size || (scriptPromise && !scriptSettled))
              logger.warn(
                __t('logs.tools', 'NIT 已发出取消，仍有 {0} 个工具或脚本清理尚未确认结束', [
                  pendingTools.size,
                ]),
              )
          } finally {
            if (cleanupTimer) clearTimeout(cleanupTimer)
          }
        }
      }
    }
  },

  /**
   * 内部工具执行器引用
   * 在 container.ts 注册时通过 `bindToolExecutor` 注入
   *
   * 第六阶段 #7: 签名增加可选的 runtimeContext 参数（threadId + channel），
   * 透传给 ToolExecutor.execute，让被调用的工具也走 CapabilityGate 鉴权。
   */
  _toolExecutor: null as
    | ((
        name: string,
        args: Record<string, unknown>,
        source: string,
        runtimeContext?: Parameters<ToolExecutor['execute']>[3],
      ) => Promise<ToolExecutionResult>)
    | null,

  /**
   * 绑定工具执行器（在 container.ts 初始化时调用）
   *
   * 第六阶段 #7: 签名增加可选的 runtimeContext 参数。
   */
  bindToolExecutor(
    executor: (
      name: string,
      args: Record<string, unknown>,
      source: string,
      runtimeContext?: Parameters<ToolExecutor['execute']>[3],
    ) => Promise<ToolExecutionResult>,
  ) {
    runScriptTool._toolExecutor = executor
  },
}
