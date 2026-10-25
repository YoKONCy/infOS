import { t as __t } from '../../lib/i18n'
/**
 * Context Compiler — 上下文编译器 (AIOS 版)
 *
 * 从各一等资源只读消费，编译成一次 LLM 调用的输入。
 * Compiler 是只读编译器，不反向修改任何资源。
 *
 * AIOS 版本变更：
 * - 不再硬编码拼装 5 段消息，改为调用 MdpEngine 渲染 slots 模板系统
 * - services/mdp/prompts/slots/ 下的 13 个槽位模板由 MdpEngine 统一渲染
 * - 原代码硬编码的 state/memory/tools 等内容作为 Nunjucks 变量注入模板
 * - 渲染出的 RenderedMessage[] 转换为 LlmMessage[]，再追加 Thread 活跃消息
 *
 * 设计原则：
 * - 纯只读数据组装，零 LLM 介入
 * - MdpEngine 保留渲染能力，Compiler 调用 MDP 渲染模板
 * - 超出窗口的早期消息由长记忆系统兜底（Scorer + RAG），不生成滚动摘要
 *
 * 输入（读取）：
 * - From Identity:   人格常量（system_prompt.md → persona_definition 变量）
 * - From MdpEngine:  slots 模板 + system_core 规则组件
 * - From Thread:     最近 N 条 active 消息
 * - From Memory:     RAG 检索到的相关记忆（向量查询，无 LLM）
 * - From Tools:      可用工具描述（ToolRegistry 读取）
 * - From State:      mood/vibe/mind/时间/主人名（ConfigRepo 读取）
 * - From User:       当前用户输入（最后一条 user 消息）
 *
 * 输出：
 * - LLM Messages     按 slots 槽位排列的最终消息链 + 活跃对话消息
 * - Context Manifest 编译清单（本轮使用了哪些资源）
 *
 * @module packages/backend/src/services/context/contextCompiler
 */

import { createHash, randomUUID } from 'node:crypto'
import { DEFAULT_CHARACTER_STATE, resourceFromToolResult } from '@infos/shared'
import type { PetStateService } from '../agent/petStateService'
import { readFileSync } from 'node:fs'
import type {
  ContextRegion,
  ContextRegionKind,
  ContextRegionManifestEntry,
  ContextRegionTrust,
  KernelObjectId,
  InteractionMode,
} from '@infos/shared'
import { ContextRegionRegistry, ContextRegionSelector } from './contextRegionRuntime'
import { hostname, platform, arch, release, uptime, totalmem } from 'node:os'
import type { ThreadService, ThreadMessageInfo } from '../thread/threadService'
import type { AgentManager } from '../agent/agentManager'
import type { ConfigRepository } from '../../repositories/config.repo'
import type { FlowStateService } from '../flow/flowStateService'
import { AutomaticRagStageError, type EventMemoryService } from '../memory/eventMemoryService'
import type { EventNote } from '@infos/shared'
import { loadMemoryRuntimeConfig, shouldRunAutoRag } from '../memory/memoryRuntimeConfig'
import type { ThreadChannel } from '../../repositories/thread.repo'
import type { CapabilityScope } from '../../capabilities/types'
import { isAdvancedTool } from '../../tools/advancedTools'
import { SYSTEM_PROTOCOL_TOOLS, isSystemProtocolTool } from '../../tools/systemProtocolTools'
import type { MdpEngine, RenderedMessage } from '../prompt/mdpEngine'
import type { PromptWorkspace } from '../prompt/promptWorkspace'
import type { CapabilityGate } from '../../capabilities/capabilityGate'
import type { ChatMessage } from '../llm/types'
import { historyKey } from '../llm/promptCache'
import { taskResultContext } from './taskResultContext'
import { createLogger } from '../../lib/logger'
import { AppError } from '../../lib/appError'
import { tokenCounter } from '../tokenizer/tokenCounter'
import type { ToolContextService } from './toolContextService'
import { projectWorkHistory } from './workContext'
import { formatEventTime } from '../memory/eventMemoryTime'
import { splitSpokenReply } from '../../nit/spokenReplyFilter'
import type { KnowledgeRecallService } from '../knowledge/knowledgeRecallService'

const logger = createLogger('ContextCompiler')

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

/** LLM 消息 */
export type LlmMessage = ChatMessage

/** Channel 上下文策略 */
export interface ChannelPolicy {
  /** 最近消息窗口大小 */
  messageWindow: number
  /** 是否检索长期记忆 */
  enableMemoryRetrieval: boolean
  /** 是否注入工具描述 */
  enableToolDescriptions: boolean
  /** 是否注入 Agent 状态（mood/vibe/时间等） */
  enableStateInjection: boolean
  /** Token 预算（0 = 不限制） */
  tokenBudget: number
  /** 是否允许派生Observer State进入上下文；默认关闭。 */
  enableObserver: boolean
  /** 是否加入同一 Agent 的其他 conversation Thread 连续上下文。 */
  enableContinuity: boolean
  /** Continuity 最多读取的消息数。 */
  continuityMessages: number
  /** Continuity 时间范围（小时）。 */
  continuityHours: number
}

/**
 * ContextPolicy 别名（语义上等价于 ChannelPolicy）
 *
 * 第六阶段 #3：Thread 可持久化自己的 ContextPolicy 覆盖默认策略，
 * 此类型用于明确表达"Thread 级别策略"的语义。
 */
export type ContextPolicy = ChannelPolicy

/** 编译结果 */
export interface CompiledContext {
  promptVariableCommit?: import('@infos/shared').PromptVariableCommit
  /** 发送给 LLM 的消息列表 */
  messages: LlmMessage[]
  /** 当前输入的位置；框架可在它之后继续插入指令。 */
  currentMessageIndex?: number
  /** 编译清单 */
  manifest: ContextManifest
}

/** 上下文清单 */
export interface ContextManifest {
  documentRecallHitCount?: number
  factRecallHitCount?: number
  promptRevision?: string
  promptFrameworkId?: string
  promptSegments?: Array<{ id: string; source: string; role: string; tokens: number }>
  /** 使用的 Agent */
  agentId: string
  /** Thread ID */
  threadId: string
  /** Channel */
  channel: ThreadChannel
  /** 消息窗口大小 */
  messageWindow: number
  /** 实际加载的消息数 */
  loadedMessageCount: number
  /** 是否包含记忆检索 */
  hasMemoryRetrieval: boolean
  /** 检索到的记忆条数 */
  memoryHitCount: number
  /** 使用的工具数量 */
  toolCount: number
  /** 本 Thread 明确禁用的工具名。 */
  disabledTools: string[]
  interactionMode: InteractionMode
  /** 是否注入状态 */
  hasStateInjection: boolean
  /** Region 选择和淘汰清单。 */
  regions: ContextRegionManifestEntry[]
  /** Region 预算使用量（粗估 Token）。 */
  regionTokenUsage: number
  /** 编译时间 */
  compiledAt: string
}

// ─────────────────────────────────────────────
// 默认 Channel 策略
// ─────────────────────────────────────────────

/**
 * 默认 Channel 策略（PUBLIC，供外部读取/参考）
 *
 * 第六阶段 #3：Thread 可通过 contextPolicy 字段覆盖此默认值，
 * ContextCompiler.compile() 会优先读取 Thread.contextPolicy。
 */
export const DEFAULT_POLICIES: Record<ThreadChannel, ChannelPolicy> = {
  desktop: {
    messageWindow: 20,
    enableMemoryRetrieval: true,
    enableToolDescriptions: true,
    enableStateInjection: true,
    tokenBudget: 0,
    enableObserver: false,
    enableContinuity: true,
    continuityMessages: 12,
    continuityHours: 72,
  },
  // group是infOS主应用Stronghold内部多Agent群聊。
  group: {
    messageWindow: 30,
    enableMemoryRetrieval: true,
    enableToolDescriptions: true,
    enableStateInjection: true,
    tokenBudget: 0,
    enableObserver: false,
    enableContinuity: true,
    continuityMessages: 12,
    continuityHours: 72,
  },
}

// ─────────────────────────────────────────────
//静态环境信息（启动时采集一次）
// ─────────────────────────────────────────────

/** 平台名称映射 */
const PLATFORM_NAMES: Record<string, string> = {
  win32: 'Windows',
  linux: 'Linux',
  darwin: 'macOS',
  freebsd: 'FreeBSD',
}

/** 运行时检测 */
function detectRuntime(): string {
  const g = globalThis as Record<string, unknown>
  if (g.Bun && typeof g.Bun === 'object' && 'version' in (g.Bun as object)) {
    return `Bun ${(g.Bun as { version: string }).version}`
  }
  return `Node.js ${process.version}`
}

/** 内存格式化 */
function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

/** 部署模式检测 */
function detectDeployMode(): string {
  if (process.env.PERO_DOCKER) return 'Docker 容器'
  if (process.env.ELECTRON_RUN_AS_NODE || process.versions.electron) return 'Electron 桌面'
  return '独立进程'
}

/** 采集静态环境信息（模块加载时执行一次） */
function collectEnvironmentInfo(): string {
  const os = PLATFORM_NAMES[platform()] ?? platform()
  const osVersion = release()
  const cpuArch = arch()
  const runtime = detectRuntime()
  const totalMemory = formatBytes(totalmem())
  const deployMode = detectDeployMode()

  return [
    `操作系统: ${os} ${osVersion} (${cpuArch})`,
    `主机名: ${hostname()}`,
    `运行时: ${runtime}`,
    `总内存: ${totalMemory}`,
    `部署模式: ${deployMode}`,
  ].join('\n')
}

function escapeConversationXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const STATIC_ENV_INFO = collectEnvironmentInfo()

// ─────────────────────────────────────────────
// Context Compiler
// ─────────────────────────────────────────────

/** 群聊等外部历史源可覆盖检索查询，并选择不重复追加空壳 Thread 消息。 */
export interface ContextCompileOptions {
  signal?: AbortSignal
  /** 预算预览不触发文档与事实的自动召回，与事件记忆开关独立。 */
  disableReferenceRetrieval?: boolean
  workContextModelKey?: string
  workContextTaskId?: string
  disableWorkContext?: boolean
  variableSessionId?: string
  modelName?: string
  modelContextTokens?: number
  modelOutputTokens?: number
  generationType?: import('@infos/shared').PromptGenerationType
  /** 临时输入也参加框架的深度编排，但不持久化到历史。 */
  currentInput?: LlmMessage
  retrievalQuery?: string
  appendThreadMessages?: boolean
  /** 模型可用输入窗口；不足时优先逐轮移除最久远的工作上下文。 */
  maxInputTokens?: number
  /** 当前触发轮次；该pair只保留user原生API消息，不进入XML历史。 */
  currentPairId?: string
  /** 请求级关闭跨Thread连续性；用于已有独立视角状态机的场景。 */
  disableContinuity?: boolean
  /** 预算预览只统计本地上下文，不请求 Embedding 或 Reranker。 */
  disableMemoryRetrieval?: boolean
  /** 后台任务和临时调用使用各自执行上下文，不继承日常对话的工具正文。 */
  disableToolContext?: boolean
  /** Realm执行使用最小主应用上下文，不继承Desktop历史、记忆、心流或Continuity。 */
  realmExecution?: boolean
  /** 请求级能力作用域；只能收窄当前 Channel 的能力。 */
  capabilityScope?: CapabilityScope
  /** 自动 RAG 各阶段的真实进度，只用于当前请求的实时界面。 */
  onRagProgress?: (
    progress: import('../memory/eventMemoryService').AutomaticRagProgress,
  ) => void | Promise<void>
}

export class ContextCompiler {
  private isPetVisible: (agentId: string) => boolean = () => false

  setPetVisibilityProvider(provider: (agentId: string) => boolean): void {
    this.isPetVisible = provider
  }
  private planService?: import('../task/taskPlanService').TaskPlanService
  setTaskPlanService(service: import('../task/taskPlanService').TaskPlanService): void {
    this.planService = service
  }
  private petStateService?: Pick<PetStateService, 'get'>

  setPetStateService(service: Pick<PetStateService, 'get'>): void {
    this.petStateService = service
  }
  private weatherService?: import('../weather/weatherService').WeatherService

  setWeatherService(service: import('../weather/weatherService').WeatherService): void {
    this.weatherService = service
  }

  constructor(
    private threadService: ThreadService,
    private agentManager: AgentManager,
    private configRepo: ConfigRepository,
    /** MdpEngine 模板引擎，用于渲染 slots 槽位模板 */
    private mdpEngine: MdpEngine,
    /** CapabilityGate 能力门控：解析 (Agent, Channel) → 能力上下文，填充工具描述/Skill 菜单/能力片段 */
    private capabilityGate: CapabilityGate,
    /** 当前 Thread 中该 Agent 的私有临时心流。 */
    private flowStateService: FlowStateService,
    /** 可插拔只读 Region Provider；缺省时保持既有编译行为。 */
    private regionRegistry?: ContextRegionRegistry,
    private regionSelector = new ContextRegionSelector(),
  ) {}

  setEventMemoryService(service: EventMemoryService): void {
    this.eventMemory = service
  }

  private promptWorkspace?: PromptWorkspace
  setPromptWorkspace(workspace: PromptWorkspace): void {
    this.promptWorkspace = workspace
  }
  async commitPromptVariables(change: import('@infos/shared').PromptVariableCommit): Promise<void> {
    if (!this.promptWorkspace)
      throw new AppError('CONFIG_ERROR', { message: '酒馆变量提交服务不可用' })
    await this.promptWorkspace.variableStore.commit(change)
  }

  private eventMemory?: EventMemoryService
  private knowledgeRecallService?: KnowledgeRecallService
  setKnowledgeRecallService(service: KnowledgeRecallService): void {
    this.knowledgeRecallService = service
  }
  private toolContextService?: ToolContextService

  setToolContextService(service: ToolContextService): void {
    this.toolContextService = service
  }

  async getMessageWindow(threadId: string): Promise<number> {
    const thread = await this.threadService.getThread(threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
    const channel = thread.channel as ThreadChannel
    const memoryRuntimeConfig = await loadMemoryRuntimeConfig(this.configRepo)
    const fallbackPolicy = {
      ...(DEFAULT_POLICIES[channel] ?? DEFAULT_POLICIES.desktop),
      messageWindow:
        memoryRuntimeConfig.channels[channel]?.contextPairs ??
        (DEFAULT_POLICIES[channel] ?? DEFAULT_POLICIES.desktop).messageWindow,
    }
    return this.resolvePolicy(thread.contextPolicy, fallbackPolicy).messageWindow
  }

  /**
   * 编译上下文
   *
   * 从 Thread 加载历史消息，从 Identity 加载人格，
   * 按 ChannelPolicy 可选注入记忆/工具/状态，组装成 Nunjucks 变量，
   * 调用 MdpEngine 渲染 slots 模板生成 system 消息，再追加活跃对话消息。
   *
   * 超出窗口的早期消息由长记忆系统兜底（Scorer 后台提炼 + RAG 检索），
   * Compiler 不再读取/生成滚动摘要。
   *
   * @param threadId  Thread ID
   * @param agentId   Agent ID（可覆盖 Thread 默认 Agent）
   */
  async compile(
    threadId: string,
    agentId: string,
    options: ContextCompileOptions = {},
  ): Promise<CompiledContext> {
    const promptSnapshot = this.promptWorkspace?.snapshot()
    // ── 1. 获取 Thread 信息 + Channel 策略 ──
    const thread = await this.threadService.getThread(threadId)
    if (!thread) {
      throw new AppError('NOT_FOUND', { message: `Thread 不存在: ${threadId}` })
    }

    if (String(thread.channel) === 'social') {
      throw new AppError('FORBIDDEN', {
        message: 'social channel必须通过 SocialAppRuntime 处理，禁止进入主 Agent ContextCompiler',
      })
    }
    const channel = thread.channel as ThreadChannel

    // Thread自定义策略优先；未配置时使用全局Channel默认值。
    const memoryRuntimeConfig = await loadMemoryRuntimeConfig(this.configRepo)
    const channelMemoryConfig = memoryRuntimeConfig.channels[channel]
    const fallbackPolicy = {
      ...(DEFAULT_POLICIES[channel] ?? DEFAULT_POLICIES.desktop),
      messageWindow:
        channelMemoryConfig?.contextPairs ??
        (DEFAULT_POLICIES[channel] ?? DEFAULT_POLICIES.desktop).messageWindow,
    }
    const policy = options.realmExecution
      ? {
          ...fallbackPolicy,
          messageWindow: 0,
          enableMemoryRetrieval: false,
          enableToolDescriptions: false,
          enableStateInjection: false,
          tokenBudget: 0,
          enableObserver: false,
          enableContinuity: false,
          continuityMessages: 0,
          continuityHours: 0,
        }
      : this.resolvePolicy(thread.contextPolicy, fallbackPolicy)

    // ── 2. 加载活跃消息（短上下文窗口） ──
    // 按完整 pair 读取最近对话轮次，避免消息行 limit 截断用户/助手半轮。
    const detailedWorkContext =
      channel === 'desktop' &&
      thread.interactionMode === 'work' &&
      !options.realmExecution &&
      !options.disableWorkContext
    const messages =
      detailedWorkContext && this.threadService.getWorkingMessagePairs
        ? await this.threadService.getWorkingMessagePairs(threadId, options.maxInputTokens ?? 0)
        : await this.threadService.getActiveMessagePairs(threadId, policy.messageWindow, true)
    const currentMessage = options.currentInput
      ? undefined
      : this.resolveCurrentUserMessage(messages, options.currentPairId)
    const historyMessages = currentMessage
      ? messages.filter((message) => message.id !== currentMessage.id)
      : messages
    // 只对已入库的历史用户消息注入时间。当前输入沿用动态状态中的当前时间。
    const historyTimeAnchors =
      options.appendThreadMessages === false ||
      !historyMessages.some((message) => message.role === 'user')
        ? new Map<number, string>()
        : await this.threadService.getConversationTimeAnchors(
            threadId,
            historyMessages.reduce((latest, message) => Math.max(latest, message.id), 0),
          )
    const ownerName = (await this.configRepo.get('owner.name')) ?? '用户'
    const conversationHistory = this.formatConversationHistory(
      historyMessages,
      ownerName,
      agentId,
      historyTimeAnchors,
    )

    // ── 3. 提取最后一条 user 消息作为检索查询 ──
    const lastUserMessage = options.retrievalQuery?.trim() || this.extractLastUserMessage(messages)

    // ── 4. [可选] RAG 记忆检索 → memory_context 字符串 ──
    let memoryContext = ''
    let memoryHitCount = 0
    const enableAutoRag =
      !options.disableMemoryRetrieval &&
      shouldRunAutoRag(policy.enableMemoryRetrieval, channelMemoryConfig) &&
      Boolean(lastUserMessage)
    if (enableAutoRag) {
      try {
        const eventNotes = this.eventMemory
          ? await this.eventMemory.automaticRag(
              agentId,
              lastUserMessage,
              channelMemoryConfig?.retrievalLimit ?? 10,
              channel,
              options.currentPairId,
              options.onRagProgress,
            )
          : []
        if (eventNotes.length) {
          memoryContext = this.formatEventNotes(eventNotes)
          memoryHitCount = eventNotes.length
        }
      } catch (error) {
        const failureKind = error instanceof AutomaticRagStageError ? error.failureKind : 'rag'
        const message =
          failureKind === 'embedding'
            ? 'Embedding 生成失败，已跳过记忆检索并继续对话'
            : 'RAG 检索失败，已跳过记忆注入并继续对话'
        const coolingDown =
          error instanceof AutomaticRagStageError &&
          error.cause instanceof AppError &&
          (error.cause.data as { cooldown?: boolean } | undefined)?.cooldown === true
        const detail = `${message}: ${error instanceof Error ? error.message : String(error)}`
        if (coolingDown) logger.debug(detail)
        else logger.warn(detail)
        try {
          await options.onRagProgress?.({
            stage: failureKind === 'embedding' ? 'embedding' : 'retrieval',
            status: 'failed',
            failureKind,
            message,
          })
        } catch (progressError) {
          logger.warn(
            __t('logs.context', '发送 RAG 失败轨迹失败: {0}', [
              progressError instanceof Error ? progressError.message : String(progressError),
            ]),
          )
        }
      }
    }

    // ── 5. 能力门控解析：(Agent, Channel) → 能力上下文 ──
    // CapabilityGate 是能力解析的单一权威来源，统一返回工具白名单/Skills/prompt_fragments/
    // 工具描述/Skill 菜单。ContextCompiler 与 ToolExecutor 都通过此方法获取能力。
    // ability_fragments 的渲染需要用到 vars（含 owner_name 等），故此处先取 ResolvedCapability，
    // 具体渲染延迟到 vars 组装完成后进行。
    const capability = this.capabilityGate.resolve(
      agentId,
      channel,
      undefined,
      options.capabilityScope,
    )
    const disabledTools = new Set(
      (thread.disabledTools ?? []).filter((name) => !isSystemProtocolTool(name)),
    )
    const protocolTools =
      options.capabilityScope && options.capabilityScope !== 'default'
        ? ['finish_task']
        : [...SYSTEM_PROTOCOL_TOOLS]
    const enabledTools = new Set(
      [...capability.allowedTools, ...protocolTools].filter(
        (name) =>
          !disabledTools.has(name) &&
          this.capabilityGate.isToolAllowedInMode(name, thread.interactionMode),
      ),
    )

    // 工具描述：改用 CapabilityGate 已按 channel 过滤白名单的版本（替代原 toolRegistry 直取逻辑）
    // 仅当 Channel 策略启用时才注入工具描述；请求级 ambient 会进一步收窄工具集。
    let toolsDescription = ''
    let toolCount = 0
    if (policy.enableToolDescriptions) {
      toolsDescription = this.capabilityGate.describeTools(
        new Set([...enabledTools].filter((name) => !isAdvancedTool(name))),
        thread.interactionMode,
      )
      toolCount = [...enabledTools].filter((name) => !isAdvancedTool(name)).length
    }

    const referenceContext =
      !options.realmExecution && !options.disableReferenceRetrieval && this.knowledgeRecallService
        ? await this.knowledgeRecallService.recall(lastUserMessage, enabledTools, options.signal)
        : { knowledge: '', facts: '', documentHits: 0, factHits: 0 }

    // ── 6. [可选] 状态注入 → 组装状态变量对象 ──
    // buildStateSection 返回 current_time/mood/vibe/mind/owner_name/environment_info/user_persona 等变量
    let stateVars: Record<string, string> = {}
    if (policy.enableStateInjection) {
      stateVars = await this.buildStateSection(agentId, threadId)
    }

    // ── 7. 读取 agent.promptPath 的 system_prompt.md 内容 → persona_definition 变量 ──
    // 人设是显式模板来源，由所选框架的数据装配决定是否渲染。
    const personaDefinition = this.loadSystemPrompt(agentId)

    // 模板内部构造由框架声明，编译器只提供数据。
    const systemCore = ''

    const flowState = await this.flowStateService.get(threadId, agentId)
    const taskPlanEnabled =
      channel === 'desktop' &&
      !options.realmExecution &&
      options.capabilityScope !== 'ambient' &&
      enabledTools.has('update_plan')
    const plan = taskPlanEnabled ? this.planService?.get(threadId, agentId) : null

    // ── 9. 组装 vars 对象，调用 MdpEngine 渲染 slots 模板 ──
    const vars: Record<string, unknown> = {
      // Agent 标识（用于模板覆盖解析）
      agent_id: agentId,
      agent_name: this.agentManager.getAgent(agentId)?.name ?? agentId,
      channel,
      realm_execution: Boolean(options.realmExecution),
      capability_fragments: capability.promptFragments,
      native_history:
        options.appendThreadMessages === false
          ? []
          : this.assembleMessages({
              slotMessages: [],
              messages: historyMessages,
              timeAnchors: historyTimeAnchors,
            }).map((message) =>
              message.role === 'system'
                ? { role: 'user', content: `[图片档案]\n${message.content}` }
                : message,
            ),
      current_message:
        options.currentInput ??
        (options.appendThreadMessages === false || !currentMessage
          ? undefined
          : this.assembleMessages({ slotMessages: [], messages: [currentMessage] })[0]),
      generation_type: options.generationType ?? (options.realmExecution ? 'quiet' : 'normal'),
      prompt_seed: `${threadId}:${currentMessage?.id ?? randomUUID()}:${promptSnapshot?.id ?? 'default'}`,
      model: options.modelName ?? '',
      max_prompt: options.maxInputTokens ?? 0,
      max_context_tokens: options.modelContextTokens ?? 0,
      max_response_tokens: options.modelOutputTokens ?? 0,
      // 人格与规则
      system_core: systemCore,
      persona_definition: personaDefinition,
      // 当前 Thread × Agent 私有临时心流
      flow_state: { currentGoal: flowState.currentGoal, privateFacts: flowState.privateFacts },
      task_plan_enabled: taskPlanEnabled,
      task_plan: plan
        ? {
            id: plan.id,
            revision: plan.revision,
            title: plan.title,
            status: plan.status,
            steps: plan.steps,
          }
        : null,
      // 状态变量（来自 buildStateSection）
      ...stateVars,
      // 记忆上下文（RAG 检索结果）
      memory_context: memoryContext,
      knowledge_context: referenceContext.knowledge,
      facts_context: referenceContext.facts,
      // 已完成历史轮次以XML嵌套在750号Slot；当前触发消息仍是唯一原生user。
      conversation_history: conversationHistory,
      // 图谱记忆上下文（预留，暂不注入）
      graph_context: '',
      // 工具描述（来自 CapabilityGate，已按 channel 过滤白名单）
      tools_description: toolsDescription,
      // 能力片段（先留空，vars 组装完成后渲染，因为片段内可能引用 owner_name 等变量）
      ability_fragments: '',
      // 技能菜单（来自 CapabilityGate，L1 摘要）
      skill_menu: enabledTools.has('load_skill') ? capability.skillMenuText : '',
      interaction_mode: thread.interactionMode,
      owner_name: stateVars.owner_name ?? (await this.configRepo.get('owner.name')) ?? '用户',
      // Channel 补丁（第六阶段 #1: 按 channel 从 AgentProfile.channelPatches 取补丁注入）
      channel_patch: this.resolveChannelPatch(agentId, channel),
      // 用户画像（来自 ConfigRepo，可选）
      user_persona: stateVars.user_persona ?? '',
      // 输出格式约束（先留空，vars 组装完成后渲染，因为片段内可能引用 owner_name 等变量）
      output_format: '',
      spoken_reply_enabled:
        channel === 'desktop' && !options.realmExecution && this.isPetVisible(agentId)
          ? 'true'
          : '',
    }

    // 发布版本已在编译开始时固定；整轮 ReAct 复用本次装配结果。
    const assembly =
      promptSnapshot && this.promptWorkspace
        ? await this.promptWorkspace.prepare(
            promptSnapshot,
            channel,
            agentId,
            vars,
            options.variableSessionId ?? `${channel}:${agentId}:${threadId}`,
          )
        : undefined
    const renderedMessages =
      assembly?.messages ??
      this.mdpEngine.renderSlots(this.mdpEngine.buildDefaultSlots(agentId), vars)

    // 保留框架声明的消息角色，过滤空内容。
    const validSlotMessages = renderedMessages.filter(
      (m) => m.currentMessage || m.content.trim().length > 0,
    )

    const budgets = [policy.tokenBudget, options.maxInputTokens ?? 0].filter((budget) => budget > 0)
    const contextBudget = budgets.length ? Math.min(...budgets) : 0
    const toolRegions =
      this.toolContextService &&
      channel === 'desktop' &&
      thread.interactionMode === 'work' &&
      !options.realmExecution &&
      !options.disableToolContext
        ? await this.toolContextService.regions(threadId, agentId, messages)
        : []
    // ── 11 + 12. 将既有来源与动态 Provider 收敛为 Region，再组装最终消息 ──
    const builtInRegions = this.createBuiltInRegions({
      agentId,
      threadId,
      personaDefinition,
      systemCore,
      stateVars,
      memoryContext,
      toolsDescription,
      flowState: { currentGoal: flowState.currentGoal, privateFacts: flowState.privateFacts },
      slotMessages: validSlotMessages.filter((message) => !message.currentMessage),
      messages:
        options.appendThreadMessages === false ? [] : currentMessage ? [currentMessage] : [],
      currentInput: options.currentInput,
    })
    const providedRegions = this.regionRegistry
      ? await this.regionRegistry.collect({
          agentId,
          threadId,
          channel,
          tokenBudget: contextBudget,
          retrievalQuery: lastUserMessage,
          enabledKinds: [
            ...(policy.enableContinuity && !options.disableContinuity
              ? (['continuity'] as const)
              : []),
            ...(policy.enableObserver ? (['observer'] as const) : []),
          ],
          limits: {
            continuityMessages: policy.continuityMessages,
            continuityHours: policy.continuityHours,
          },
          now: new Date().toISOString(),
        })
      : []
    const regionCompilation = await this.regionSelector.compileAsync(
      [...builtInRegions, ...providedRegions, ...toolRegions],
      // 工作请求最终由包含工具定义及推理协议的统一窗口计费，不能在 Region 阶段提前拒绝。
      detailedWorkContext ? 0 : contextBudget,
    )
    const regionMessages: LlmMessage[] = regionCompilation.selected
      .filter(
        (region) => region.delivery === 'system' || region.providerId === 'infos.context.tools',
      )
      .map((region) => ({
        role:
          assembly?.format === 'sillytavern' && region.delivery === 'system' ? 'system' : 'user',
        content: region.content,
        cacheControl: { kind: 'snapshot' },
        ...(region.regionId === 'file-working-state'
          ? {
              fileObservations: region.provenance
                .fileObservations as import('./fileWorkingContext').FileObservation[],
            }
          : {}),
      }))
    const firstConversationSlot = validSlotMessages.findIndex(
      (message) => message.role !== 'system',
    )
    const leadingSlotCount =
      firstConversationSlot < 0 ? validSlotMessages.length : firstConversationSlot
    let llmMessages =
      assembly?.format === 'sillytavern'
        ? [
            ...regionMessages.filter((message) => message.role === 'system'),
            ...this.assembleMessages({
              slotMessages: validSlotMessages.slice(0, leadingSlotCount),
              messages: [],
            }),
            ...regionMessages.filter((message) => message.role !== 'system'),
            ...this.assembleMessages({
              slotMessages: validSlotMessages.slice(leadingSlotCount),
              messages: [],
            }),
            ...(assembly.includesCurrentMessage
              ? []
              : options.currentInput
                ? [options.currentInput]
                : options.appendThreadMessages === false || !currentMessage
                  ? []
                  : this.assembleMessages({ slotMessages: [], messages: [currentMessage] })),
          ]
        : [
            ...this.assembleMessages({
              slotMessages: validSlotMessages.filter((m) => m.role === 'system'),
              messages: [],
            }),
            ...regionMessages.filter((m) => m.role === 'system'),
            ...this.assembleMessages({
              slotMessages: validSlotMessages.filter((m) => m.role !== 'system'),
              messages: [],
            }),
            ...regionMessages.filter((m) => m.role !== 'system'),
            ...(!assembly && options.appendThreadMessages !== false
              ? this.assembleMessages({
                  slotMessages: [],
                  messages: historyMessages,
                  timeAnchors: historyTimeAnchors,
                })
              : []),
            ...(options.currentInput
              ? [options.currentInput]
              : options.appendThreadMessages === false || !currentMessage
                ? []
                : this.assembleMessages({ slotMessages: [], messages: [currentMessage] })),
          ]

    if (assembly?.preview.frameworkId === 'builtin.main' && !options.realmExecution) {
      const current = llmMessages.at(-1)
      if (current?.role === 'user' && (currentMessage || options.currentInput)) {
        current.cacheControl = { kind: 'current', currentKeys: [historyKey(current)] }
      }
    }

    // ── 13. 生成清单 ──
    const manifest: ContextManifest = {
      promptRevision: promptSnapshot?.id,
      promptFrameworkId: assembly?.preview.frameworkId,
      promptSegments: assembly?.preview.segments.map(
        ({ content: _content, ...segment }) => segment,
      ),
      agentId,
      threadId,
      channel,
      messageWindow: policy.messageWindow,
      loadedMessageCount: messages.length,
      hasMemoryRetrieval: enableAutoRag,
      memoryHitCount,
      documentRecallHitCount: referenceContext.documentHits,
      factRecallHitCount: referenceContext.factHits,
      toolCount,
      disabledTools: [...disabledTools],
      interactionMode: thread.interactionMode,
      hasStateInjection: policy.enableStateInjection,
      regions: regionCompilation.manifest.map((entry) => ({
        ...entry,
        sourceObjectRefs: entry.sourceObjectRefs.map((ref) => ({ ...ref })),
      })),
      regionTokenUsage: regionCompilation.usedTokens,
      compiledAt: new Date().toISOString(),
    }

    logger.debug(
      __t('logs.context', '上下文已编译: thread={0}, agent={1}, channel={2}, ', [
        threadId,
        agentId,
        channel,
      ]) +
        `messages=${messages.length}, memory=${memoryHitCount}, tools=${toolCount}, ` +
        `slots=${validSlotMessages.length}`,
    )

    const slotCurrentIndex = validSlotMessages.findIndex((message) => message.currentMessage)
    let currentMessageIndex =
      assembly?.format === 'sillytavern' && slotCurrentIndex >= 0
        ? regionMessages.length + slotCurrentIndex
        : options.currentInput || (options.appendThreadMessages !== false && currentMessage)
          ? llmMessages.length - 1
          : undefined
    const currentInputMessage =
      currentMessageIndex === undefined ? undefined : llmMessages[currentMessageIndex]
    if (detailedWorkContext) {
      llmMessages = projectWorkHistory(
        llmMessages,
        historyMessages,
        {
          threadId,
          agentId,
          channel,
          taskId: options.workContextTaskId,
          modelKey: options.workContextModelKey,
        },
        historyTimeAnchors,
      )
      if (currentInputMessage) currentMessageIndex = llmMessages.indexOf(currentInputMessage)
    }
    if (currentInputMessage && !options.realmExecution) {
      currentInputMessage.cacheControl = {
        ...currentInputMessage.cacheControl,
        kind: 'current',
        currentKeys: [
          currentMessage
            ? `${currentMessage.id}:${currentMessage.revision}:${historyKey({
                role: currentMessage.role as LlmMessage['role'],
                content: this.conversationContent(currentMessage),
              })}`
            : historyKey(currentInputMessage),
        ],
      }
    }
    // 请求策略属于编译结果；检查点恢复时沿用，不重新读取全局设置。
    if (
      llmMessages[0] &&
      (assembly?.preview.requestPlan?.assistantPrefill || llmMessages[0].promptPlan)
    )
      llmMessages[0] = { ...llmMessages[0], promptPlan: assembly?.preview.requestPlan ?? {} }
    return {
      messages: llmMessages,
      manifest,
      currentMessageIndex,
      promptVariableCommit: assembly?.variableCommit,
    }
  }

  // ─────────────────────────────────────────
  // 人格加载
  // ─────────────────────────────────────────

  /**
   * 解析当前 channel 的人格补丁（第六阶段 #1）
   *
   * 从 AgentProfile.channelPatches 中按 channel 取出对应补丁文本。
   * 缺失或空字符串时返回空串（slots/600_channel_patch.md 会因 skipEmpty 被过滤掉）。
   */
  private resolveChannelPatch(agentId: string, channel: ThreadChannel): string {
    const agent = this.agentManager.getAgent(agentId)
    if (!agent) return ''
    return agent.channelPatches[channel] ?? ''
  }

  /**
   * 加载 Agent 人格
   *
   * 读取 system_prompt.md 内容作为 persona_definition 变量返回。
   * Channel 差异统一由 slots/600_channel_patch.md 模板处理。
   * 若需要可后续扩展 channel_patch 变量。
   *
   * 注：social 的 persona 补丁由社交子 Agent 应用独立管理；
   * group 是内部据点，由 ContextCompiler 正常处理 channel patch。
   */
  private loadSystemPrompt(agentId: string): string {
    const agent = this.agentManager.getAgent(agentId)
    if (!agent) {
      logger.warn(__t('logs.context', 'Agent 未找到: {0}，使用空人格', [agentId]))
      return ''
    }

    try {
      return readFileSync(agent.promptPath, 'utf-8')
    } catch {
      logger.warn(__t('logs.context', '人格文件读取失败: {0}', [agent.promptPath]))
      return ''
    }
  }

  // ─────────────────────────────────────────
  // 记忆检索
  // ─────────────────────────────────────────

  /** 提取最后一条 user 消息作为检索查询 */
  private extractLastUserMessage(messages: ThreadMessageInfo[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        return messages[i]!.content
      }
    }
    return ''
  }

  private formatEventNotes(notes: EventNote[]): string {
    if (!notes.length) return ''
    const lines = ['<memory_context kind="event_notes">']
    for (const note of notes) {
      lines.push(
        `<event_note id="${note.id}" event_at="${formatEventTime(note.eventAt)}">` +
          note.narrative +
          '</event_note>',
      )
    }
    lines.push('</memory_context>')
    return lines.join('\n')
  }

  // ─────────────────────────────────────────
  // 工具描述
  // ─────────────────────────────────────────

  // AIOS: formatToolDescriptions 已移除（工具描述现由 CapabilityGate.toolsDescription 提供，
  // 已按 channel 过滤白名单，无需在 Compiler 内重复格式化）

  // ─────────────────────────────────────────
  // 状态注入
  // ─────────────────────────────────────────

  /**
   * 构建状态注入变量
   *
   * 返回 Nunjucks 变量对象（而非拼接好的字符串），供 slots 模板渲染使用。
   *
   * 包含变量：
   * - current_time:     当前时间（中文友好格式）
   * - mood:             Agent 心情
   * - vibe:             Agent 氛围
   * - mind:             Agent 心理活动
   * - owner_name:       用户名字
   * - owner_appellation: 用户称呼（如 主人/哥哥/老师，来自 agent.json 的 owner_appellation，默认 主人）
   * - environment_info: 环境信息（静态 + 运行时长）
   * - user_persona:     用户画像（可选，来自 owner.persona）
   */
  private async buildStateSection(
    agentId: string,
    threadId: string,
  ): Promise<Record<string, string>> {
    // 当前时间（中文友好格式）
    const now = new Date()
    const weekdays = ['日', '一', '二', '三', '四', '五', '六']
    const weekday = weekdays[now.getDay()] ?? '?'
    const currentTime =
      `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ` +
      `星期${weekday} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

    // 状态严格取当前会话，不继承其他会话或旧全局状态。
    const characterState = await this.petStateService?.get(agentId, threadId)
    const mood = characterState?.mood ?? DEFAULT_CHARACTER_STATE.mood
    const vibe = characterState?.vibe ?? DEFAULT_CHARACTER_STATE.vibe
    const mind = characterState?.mind ?? DEFAULT_CHARACTER_STATE.mind
    const ownerName = (await this.configRepo.get('owner.name')) ?? '用户'
    // 称呼：AI 对用户的亲密称谓，各角色独立配置（来自 agent.json 的 owner_appellation，未配置时兜底"主人"）
    const ownerAppellation = this.agentManager.getAgent(agentId)?.ownerAppellation ?? '主人'

    // 用户画像（可选，来自 owner.persona 配置）
    const userPersona = (await this.configRepo.get('owner.persona')) ?? ''

    // 环境信息 = 静态部分 + 动态运行时长
    const uptimeHours = (uptime() / 3600).toFixed(1)
    const environmentInfo = `${STATIC_ENV_INFO}\n系统运行时长: ${uptimeHours} 小时`

    return {
      current_time: currentTime,
      ...this.weatherService?.promptFields(),
      mood,
      vibe,
      mind,
      owner_name: ownerName,
      owner_appellation: ownerAppellation,
      environment_info: environmentInfo,
      user_persona: userPersona,
    }
  }

  private createBuiltInRegions(input: {
    agentId: string
    threadId: string
    personaDefinition: string
    systemCore: string
    stateVars: Record<string, string>
    memoryContext: string
    toolsDescription: string
    flowState: { currentGoal: string; privateFacts: string }
    slotMessages: RenderedMessage[]
    messages: ThreadMessageInfo[]
    currentInput?: LlmMessage
  }): ContextRegion[] {
    const source = (
      kind: ContextRegionKind,
      content: string,
      trust: ContextRegionTrust,
      priority: number,
    ): ContextRegion =>
      this.region({
        regionId: `${kind}:${input.agentId}:${input.threadId}`,
        kind,
        content,
        trust,
        priority,
        required: false,
        delivery: 'manifest-only',
        tokenEstimate: 0,
        sourceObjectRefs: [],
      })
    const renderedSystem = input.slotMessages.map((message) => message.content).join('\n\n')
    const threadContent =
      input.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => `${message.role}:${this.conversationContent(message)}`)
        .join('\n') +
      (input.currentInput
        ? `\n${input.currentInput.role}:${typeof input.currentInput.content === 'string' ? input.currentInput.content : JSON.stringify(input.currentInput.content)}`
        : '')
    return [
      source('identity', input.personaDefinition, 'principal', 900),
      source('rules', input.systemCore, 'system', 1000),
      source('state', JSON.stringify(input.stateVars), 'authority', 700),
      source('memory', input.memoryContext, 'derived', 500),
      source('capability', input.toolsDescription, 'authority', 800),
      source('flow', JSON.stringify(input.flowState), 'authority', 650),
      this.region({
        regionId: `rendered-system:${input.agentId}:${input.threadId}`,
        kind: 'rules',
        content: renderedSystem,
        trust: 'system',
        priority: 1000,
        required: true,
        delivery: 'manifest-only',
        tokenEstimate: this.estimateTokens(renderedSystem),
        sourceObjectRefs: [],
      }),
      this.region({
        regionId: `thread:${input.threadId}`,
        kind: 'thread',
        content: threadContent,
        trust: 'authority',
        priority: 950,
        required: true,
        delivery: 'conversation',
        tokenEstimate: this.estimateTokens(threadContent),
        sourceObjectRefs: input.messages.map((message) => ({
          objectType: 'thread-message',
          objectId: String(message.id) as KernelObjectId,
          generation: message.revision,
          ownerPrincipalId: input.agentId,
        })),
      }),
    ]
  }

  private region(
    input: Omit<ContextRegion, 'providerId' | 'contentHash' | 'provenance'>,
  ): ContextRegion {
    return {
      ...input,
      providerId: 'infos.context.builtin',
      contentHash: createHash('sha256').update(input.content).digest('hex'),
      provenance: { compiler: 'ContextCompiler' },
      deduplicationKey: input.deduplicationKey ?? input.regionId,
    }
  }

  private estimateTokens(value: string): number {
    return tokenCounter.countTokens(value)
  }

  private resolveCurrentUserMessage(
    messages: ThreadMessageInfo[],
    currentPairId?: string,
  ): ThreadMessageInfo | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.role === 'user' && (!currentPairId || message.pairId === currentPairId)) {
        return message
      }
    }
    return undefined
  }

  private formatConversationHistory(
    messages: ThreadMessageInfo[],
    ownerName: string,
    fallbackAgentId: string,
    timeAnchors?: ReadonlyMap<number, string>,
  ): string {
    return messages
      .flatMap((message) => {
        let tag: string | null = null
        if (message.role === 'user') tag = ownerName
        else if (message.role === 'assistant') tag = message.agentId || fallbackAgentId
        else if (message.role === 'system') {
          if (taskResultContext(message)) tag = 'background_task_result'
          try {
            const metadata = JSON.parse(message.metadataJson) as { kind?: string }
            if (metadata.kind === 'image_transcription') tag = 'image_transcription'
          } catch {
            // 非受控System消息不进入对话历史。
          }
        }
        if (!tag) return []
        const safeTag = this.normalizeConversationTag(tag)
        return [
          `<${safeTag}>${escapeConversationXml(taskResultContext(message) ?? this.historicalConversationContent(message, timeAnchors))}</${safeTag}>`,
        ]
      })
      .join('\n')
  }

  private normalizeConversationTag(value: string): string {
    const normalized = value.trim().replace(/[^\p{L}\p{N}_-]/gu, '_')
    return normalized || 'unknown'
  }

  private historicalConversationContent(
    message: ThreadMessageInfo,
    timeAnchors?: ReadonlyMap<number, string>,
  ): string {
    const content = this.conversationContent(message)
    const anchor = message.role === 'user' ? timeAnchors?.get(message.id) : undefined
    return anchor ? `${anchor}\n${content}` : content
  }

  /** 历史携带图片、文档与音频引用；不重复注入正文或媒体。 */
  private conversationContent(message: ThreadMessageInfo): string {
    if (message.role !== 'user' && message.role !== 'assistant') return message.content
    let content =
      message.role === 'assistant' ? splitSpokenReply(message.content).content : message.content
    const images = new Map<string, string>()
    const documents = new Map<string, string>()
    const audios = new Map<string, string>()
    try {
      const metadata = JSON.parse(message.metadataJson)
      if (message.role === 'assistant' && metadata?.executionPause?.kind === 'desktop') {
        const pause = metadata.executionPause
        content += `\n【执行状态：桌面操作暂停，任务尚未完成】\n${String(pause.message ?? '').slice(0, 500)}\n继续时保留已成功的工作，桌面操作前重新观察，不自动重放旧操作。`
      }
      if (Array.isArray(metadata?.attachments)) {
        for (const item of metadata.attachments) {
          if (item?.kind === 'image' && typeof item.id === 'string')
            images.set(item.id, String(item.originalName ?? '图片'))
          if (item?.kind === 'audio' && typeof item.id === 'string')
            audios.set(item.id, String(item.originalName ?? '音频'))
          if (['file', 'pdf'].includes(item?.kind) && typeof item.id === 'string')
            documents.set(item.id, String(item.originalName ?? '文档'))
        }
      }
      if (Array.isArray(metadata?.toolCalls)) {
        for (const call of metadata.toolCalls) {
          const resource = resourceFromToolResult(call?.name, call?.result)
          if (resource?.kind === 'image' && resource.id) images.set(resource.id, resource.name)
          if (resource?.kind === 'audio' && resource.id) audios.set(resource.id, resource.name)
          if (resource?.id && !['image', 'audio'].includes(resource.kind))
            documents.set(resource.id, resource.name)
        }
      }
    } catch {
      /* 旧消息没有附件元数据。 */
    }
    const refs = [...images]
      .filter(([id]) => /^[0-9a-f-]{36}$/i.test(id))
      .slice(0, 5)
      .map(([id, name]) => `${JSON.stringify(name.slice(0, 180))} — attachment:${id}`)
    const documentRefs = [...documents]
      .filter(([id]) => /^[0-9a-f-]{36}$/i.test(id))
      .slice(0, 5)
      .map(([id, name]) => `${JSON.stringify(name.slice(0, 180))} — attachment:${id}`)
    if (refs.length) content += `\n【图片附件】\n${refs.join('\n')}`
    if (documentRefs.length) content += `\n【文档附件】\n${documentRefs.join('\n')}`
    const audioRefs = [...audios]
      .filter(([id]) => /^[0-9a-f-]{36}$/i.test(id))
      .slice(0, 5)
      .map(([id, name]) => `${JSON.stringify(name.slice(0, 180))} — attachment:${id}`)
    if (audioRefs.length) content += `\n【音频附件】\n${audioRefs.join('\n')}`
    return content
  }

  // ─────────────────────────────────────────
  // 消息组装
  // ─────────────────────────────────────────

  /**
   * 组装 LLM 消息
   *
   * 新逻辑（AIOS 版）：
   * 1. 先放渲染好的 slots system 消息（renderSlots 已合并相邻 system，
   *    通常为一条合并后的 system 消息）
   * 2. 追加 user/assistant 活跃消息（时间正序，原生角色）
   *
   * 注：超出窗口的早期消息由长记忆系统兜底，不再注入滚动摘要。
   * 注：history 槽位（5000_history.md）因未提供 social_history/desktop_history
   *     变量会渲染为空，被 skipEmpty 过滤，对话历史改由末尾原生消息承载。
   */
  private assembleMessages(params: {
    /** 渲染后的 slots system 消息（已过滤空内容） */
    slotMessages: RenderedMessage[]
    /** Thread 活跃消息（时间正序） */
    messages: ThreadMessageInfo[]
    /** 仅历史路径传入，当前输入不得附带历史时间标记。 */
    timeAnchors?: ReadonlyMap<number, string>
  }): LlmMessage[] {
    const { slotMessages, messages, timeAnchors } = params
    const llmMessages: LlmMessage[] = []

    // 槽位 system 消息（renderSlots 已合并相邻同角色消息，通常为一条）
    for (const slot of slotMessages) {
      llmMessages.push({
        role: slot.role,
        content: slot.nativeContent ?? slot.content,
        ...(slot.historyMessage
          ? { cacheControl: { ...slot.historyCache, kind: 'history' as const } }
          : slot.role === 'system'
            ? {}
            : { cacheControl: { kind: 'snapshot' as const, key: `prompt-slot:${slot.slotId}` } }),
      })
    }

    // 活跃消息（user/assistant 原生角色，时间正序）
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        const content = this.historicalConversationContent(msg, timeAnchors)
        llmMessages.push({
          role: msg.role,
          content,
          cacheControl: {
            kind: 'history',
            key: `${msg.id}:${msg.revision}:${historyKey({ role: msg.role, content })}`,
            edited: msg.revision > 1,
            historyMessageId: msg.id,
            historyRevision: msg.revision,
            pairId: msg.pairId ?? undefined,
          },
        })
        continue
      }
      if (msg.role === 'system') {
        const taskResult = taskResultContext(msg)
        if (taskResult) {
          llmMessages.push({
            role: 'user',
            content: taskResult,
            cacheControl: {
              kind: 'history',
              key: `${msg.id}:${msg.revision}:${historyKey({ role: 'user', content: taskResult })}`,
              historyMessageId: msg.id,
              historyRevision: msg.revision,
            },
          })
          continue
        }
        try {
          const metadata = JSON.parse(msg.metadataJson) as { kind?: string }
          if (metadata.kind === 'image_transcription') {
            llmMessages.push({ role: 'system', content: msg.content })
          }
        } catch {
          // 普通系统消息不进入 LLM 历史；这里只恢复受控的图片文字档案。
        }
      }
    }

    return llmMessages
  }

  /**
   * 解析 Thread 的 ContextPolicy
   *
   * 第六阶段 #3: 优先使用 Thread.contextPolicy（JSON 字符串），失败或为空时回退默认策略。
   *
   * @param contextPolicyJson  Thread 持久化的 ContextPolicy JSON 字符串
   * @param channel            Thread channel（用于 fallback 到对应默认策略）
   */
  private resolvePolicy(
    contextPolicyJson: string | null | undefined,
    fallback: ChannelPolicy,
  ): ChannelPolicy {
    if (!contextPolicyJson) return fallback
    try {
      const parsed = JSON.parse(contextPolicyJson) as Partial<ChannelPolicy>
      // 合并默认策略：parsed 中存在的字段覆盖默认值，缺失字段用默认值兜底
      // 避免解析出的对象缺字段导致运行时崩溃
      return {
        messageWindow:
          typeof parsed.messageWindow === 'number' ? parsed.messageWindow : fallback.messageWindow,
        enableMemoryRetrieval:
          typeof parsed.enableMemoryRetrieval === 'boolean'
            ? parsed.enableMemoryRetrieval
            : fallback.enableMemoryRetrieval,
        enableToolDescriptions:
          typeof parsed.enableToolDescriptions === 'boolean'
            ? parsed.enableToolDescriptions
            : fallback.enableToolDescriptions,
        enableStateInjection:
          typeof parsed.enableStateInjection === 'boolean'
            ? parsed.enableStateInjection
            : fallback.enableStateInjection,
        tokenBudget:
          typeof parsed.tokenBudget === 'number' ? parsed.tokenBudget : fallback.tokenBudget,
        enableObserver:
          typeof parsed.enableObserver === 'boolean'
            ? parsed.enableObserver
            : fallback.enableObserver,
        enableContinuity:
          typeof parsed.enableContinuity === 'boolean'
            ? parsed.enableContinuity
            : fallback.enableContinuity,
        continuityMessages:
          typeof parsed.continuityMessages === 'number'
            ? Math.max(0, Math.min(100, Math.floor(parsed.continuityMessages)))
            : fallback.continuityMessages,
        continuityHours:
          typeof parsed.continuityHours === 'number'
            ? Math.max(0, Math.min(24 * 30, Math.floor(parsed.continuityHours)))
            : fallback.continuityHours,
      }
    } catch (err) {
      logger.warn(
        __t('logs.context', 'Thread ContextPolicy JSON 解析失败，回退到默认策略: {0}', [err]),
      )
      return fallback
    }
  }

  /** 获取 Channel 策略 */
  getChannelPolicy(channel: ThreadChannel): ChannelPolicy {
    return DEFAULT_POLICIES[channel] ?? DEFAULT_POLICIES.desktop
  }
}
