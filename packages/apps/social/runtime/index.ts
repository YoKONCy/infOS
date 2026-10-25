import { t as __t } from './i18n'
/**
 * SocialAppRuntime — 社交应用运行时
 *
 * 实现 AgentAppRuntime 接口，接入 AIOS 应用层。
 *
 * 职责：
 * - 管理 SocialBridge 生命周期（适配器连接/断开）
 * - 管理 SocialSessionManager + SocialScheduler（由 SocialBridge 内部创建）
 * - 通过 SocialAppCompiler 独立编译上下文（方案 B）
 * - 不调用主 Agent 的 AgentService.chat，完全独立
 * - 社交消息走应用自己的 LLM 调用
 *
 * 启动流程：
 *   AppManager.launch → SocialAppRuntime.initialize
 *     ├─ 创建 SocialAppCompiler
 *     ├─ 创建 SocialBridge（含 SessionManager + Scheduler）
 *     ├─ 从连接配置创建平台适配器并注册
 *     ├─ 启动 SocialBridge
 *     └─ 通过宿主注入的传输入口注册平台传输，供 WS 升级使用
 *
 * 关闭流程：
 *   AppManager.stop → SocialAppRuntime.onStop
 *     ├─ 停止 SocialBridge（含调度器 + 适配器断开）
 *     └─ 生成最终检查点
 *
 * @module packages/apps/social/runtime
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SOCIAL_DELEGATED_TURN_PREFIX, isAgentBrowserRead } from '@infos/shared'
import type {
  AgentAppRuntime,
  AppCheckpoint,
  AppCommandRequest,
  AppCommandResult,
  AppEvent,
  AppRuntimeContext,
  ToolDefinition,
} from '@infos/backend/applicationHostAbi'
import {
  createLogger,
  promptFingerprint,
  stableHistoryWindow,
  invalidatePromptReplay,
  ToolLoopGuard,
} from '@infos/backend/applicationHostAbi'
import { SocialAppCompiler, type SocialHistoryMessage } from './compiler'
import { SocialBridge } from './socialBridge'
import type {
  DeferredSocialIntent,
  FlushReason,
  ParticipationState,
  SocialTurnOutcome,
} from './socialSessionManager'
import type { SocialStoragePort } from '@infos/shared'
import { ImageCacheManager } from './imageCacheManager'
import { executeSocialSticker } from '../tools/sticker'
import { SocialScorerService } from './socialScorer'
import type { AbstractSocialAdapter } from '../adapters/ISocialAdapter'
import {
  createSocialAdapters,
  socialConnectionSpecs,
  BUILTIN_SOCIAL_ADAPTERS,
  type SocialAdapterFactory,
} from '../adapters/registry'
import {
  setSocialMessagingProvider,
  setSocialModeControlProvider,
  socialSetOwnerPrivateOnlyTool,
  socialSendMessageTool,
  socialGetContactsTool,
  socialGetGroupsTool,
  socialGetContactInfoTool,
  socialGetGroupInfoTool,
  socialGetGroupMembersTool,
  socialHandleRequestTool,
  socialReadForwardMsgTool,
  socialReadImageTool,
  socialReadDiaryTool,
  socialRememberContactImpressionTool,
  socialGetContactHistoryTool,
  setSocialImageReaderProvider,
  setSocialDiaryReaderProvider,
  setSocialContactMemoryProvider,
  type SocialImageReaderProvider,
  type SocialContactMemoryProvider,
} from '../tools'
import { SocialDataService } from './socialDataService'
import {
  currentSocialRecovery,
  currentSocialStep,
  runSocialStep,
  socialRateGateOptions,
} from './socialRecovery'
import { SocialOrchestration, type SocialActResult } from './socialOrchestration'
import { SocialLoopGuard, DEFAULT_LOOP_POLICY, normalizeLoopPolicy } from './socialLoopGuard'
import { socialActDefinition } from './socialActDefinition'
import { createSocialRouter } from './social.router'
import { SocialStatusCardService } from './statusCardService'
import { DEFAULT_STATUS_CARD_DESIGN } from '@infos/shared'
import { SOCIAL_BUSINESS_TOOLS, type SocialBusinessTool } from '@infos/shared'
import {
  DEFAULT_SOCIAL_SCHEDULER_CONFIG,
  normalizeSocialSchedulerConfig,
  normalizeSocialGroupPolicies,
  socialGroupPolicyKey,
  type SocialGroupPolicies,
} from '@infos/shared'
import {
  SocialOperations,
  type SocialOperationScope,
  type SocialOperationDependencies,
} from './socialOperations'
import { restoreSocialMessage } from './socialMessageContext'
import { SocialCommonOperations } from './socialCommonOperations'
import { scopedSocialStorage, currentSocialScope } from './socialStorageScope'
import type { NativeEmojiScope } from './nativeEmoji'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const logger = createLogger('SocialAppRuntime')

/**
 * 社交应用自己的模板根目录
 *
 * 解析方式：从当前文件 (runtime/index.ts) 向上一级到应用根目录，再进入 prompts/
 * 即 packages/apps/social/prompts/
 *
 * AIOS：社交应用通过 MdpEngine.addTemplateRoot() 注册自己的模板目录，
 * 前缀为 "apps/social"，用于隔离应用模板与主 Agent 模板。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 便携/打包环境（单文件 bundle 后 import.meta 失效）通过 PERO_APP_ROOT 定位内置应用；
// 开发/独立部署环境回退到源码树相对定位。
const appRoot = process.env.PERO_APP_ROOT
const SOCIAL_PROMPTS_DIR = appRoot
  ? path.resolve(appRoot, 'apps', 'social', 'prompts')
  : path.resolve(__dirname, '../prompts')

// ─────────────────────────────────────────────
// SocialAppRuntime
// ─────────────────────────────────────────────

export class SocialAppRuntime implements AgentAppRuntime {
  /** 运行时上下文（initialize 时注入） */
  private ctx?: AppRuntimeContext
  /** 应用自己的编译器 */
  private compiler?: SocialAppCompiler
  /** 社交桥接 */
  private socialBridge?: SocialBridge
  private statusCards?: SocialStatusCardService
  private operations?: SocialOperations
  private operationDeps?: SocialOperationDependencies
  private adapterUpdates: Promise<unknown> = Promise.resolve()
  private stopped = false
  private lifetime = new AbortController()
  /** 已装配的平台网关。 */
  private adapters: AbstractSocialAdapter[] = []
  constructor(
    private readonly adapterFactories: readonly SocialAdapterFactory[] = BUILTIN_SOCIAL_ADAPTERS,
  ) {}

  private adapter(platform?: string): AbstractSocialAdapter | undefined {
    return platform
      ? this.adapters.find((item) => item.platform === platform)
      : this.adapters.length === 1
        ? this.adapters[0]
        : undefined
  }
  private identityListed(ids: string[], id: string, platform?: string): boolean {
    return (
      ids.includes(`${platform}:${id}`) ||
      (!!platform &&
        this.adapters.some(
          (adapter) => adapter.platform === platform && adapter.legacyConfiguration,
        ) &&
        ids.includes(id))
    )
  }

  private hasPlatformEntries(ids: string[], platform?: string): boolean {
    return ids.some(
      (id) =>
        id.startsWith(`${platform}:`) ||
        (!id.includes(':') &&
          this.adapters.some(
            (adapter) => adapter.platform === platform && adapter.legacyConfiguration,
          )),
    )
  }

  private isOwnerSession(session: {
    platform?: string
    channelType: string
    peerId?: string
    checkpoint?: Record<string, unknown>
  }): boolean {
    const peerId =
      session.peerId ??
      (session.checkpoint?.inbound as Array<{ senderId: string }> | undefined)?.at(-1)?.senderId
    return (
      session.channelType === 'private' && !!peerId && peerId === this.ownerFor(session.platform)
    )
  }

  private ownerFor(platform?: string): string | undefined {
    return this.adapter(platform)?.getOwnerId()
  }
  private async resolveNativeEmoji(scope: NativeEmojiScope, reference: string) {
    const adapter = this.adapter(scope.platform)
    const provider =
      this.socialMessageRepo && this.ctx?.configRepo
        ? adapter?.createNativeEmojiProvider(this.socialMessageRepo, this.ctx.configRepo)
        : undefined
    if (!provider) throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
    return provider.resolve(scope, reference)
  }

  private releaseSocialTransport?: () => void
  /** 社交消息仓库 */
  private socialMessageRepo?: SocialStoragePort
  private socialScorer?: SocialScorerService
  private socialScorerRunning = new Set<string>()
  private loopGuard?: SocialLoopGuard
  private configWriteQueue: Promise<unknown> = Promise.resolve()
  /**
   * 可用工具定义列表（从 manifest.json 解析为 OpenAI function calling 格式）
   * 传给 compiler.generateReply → llmService.chat(tools) 让 LLM 能发起 FC 调用
   */
  private toolDefinitions: ToolDefinition[] = []
  /**
   * 社交工具执行器（name → execute 映射）
   * 当 LLM 返回 toolCalls 时，compiler 通过此函数执行对应社交工具
   */
  private toolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string>
  /** 已注册的 Grant ID 列表（onStop 时撤销用） */
  private grantIds: string[] = []
  /** 是否已运行 */
  private running = false
  /** 当前单实例 Social 绑定的角色，由配置界面指定。 */
  private socialAgentId = 'pero'
  /**
   * 主人的平台账号（从 social 配置读取）
   *
   * 用途：
   * 1. 注入到平台适配器 用于识别入站消息是否来自主人
   * 2. 注入到 compiler 的 system prompt，让 Agent 知道主人是谁
   * 3. 通过 generateReply 传递给 compiler，按是否主人调整权限提示
   */
  private releaseTaskDelivery?: () => void
  private modeConfig = {
    ...DEFAULT_SOCIAL_SCHEDULER_CONFIG,
    groupPolicies: {} as SocialGroupPolicies,
    strangerPolicy: 'allow' as 'allow' | 'ignore',
    groupWhitelist: [] as string[],
    groupBlacklist: [] as string[],
    userBlacklist: [] as string[],
    ownerPrivateOnlyAgentIds: [] as string[],
    loopGuard: { ...DEFAULT_LOOP_POLICY },
  }

  /** 统计信息 */
  private stats = {
    messagesProcessed: 0,
    repliesSent: 0,
  }

  // ── 生命周期 ──

  async initialize(ctx: AppRuntimeContext): Promise<{ success: boolean; error?: string }> {
    this.ctx = ctx
    this.lifetime = new AbortController()

    try {
      // 校验必要依赖
      if (!ctx.socialStorage) {
        throw new Error('社交应用需要SocialStoragePort')
      }
      if (!ctx.storeRegistry) {
        throw new Error(
          '社交应用需要 storeRegistry 依赖（访问 social.tdb），请在 AppManager 中注入',
        )
      }
      if (!ctx.socialEvents || !ctx.socialExecutions) {
        throw new Error('社交应用需要SocialEventPort和SocialExecutionPort')
      }
      if (!ctx.registerSocialTransport) throw new Error('社交应用缺少宿主 WebSocket 传输入口')
      if (!ctx.configRepo) {
        throw new Error('社交应用需要 configRepo 依赖，请在 AppManager 中注入')
      }

      const initialSocialConfig = await this.readSocialConfig(ctx)
      const configuredAgentId =
        typeof initialSocialConfig.agentId === 'string'
          ? initialSocialConfig.agentId
          : ctx.hostAgentId
      if (!ctx.agentManager.getAgent(configuredAgentId)) {
        throw new Error(`社交配置指定的角色不存在: ${configuredAgentId}`)
      }
      this.socialAgentId = configuredAgentId
      this.statusCards = new SocialStatusCardService(ctx.configRepo, ctx.statusCards)
      if (initialSocialConfig.agentId !== configuredAgentId || 'bindings' in initialSocialConfig) {
        initialSocialConfig.agentId = configuredAgentId
        delete initialSocialConfig.bindings
        await ctx.configRepo.set('social', JSON.stringify(initialSocialConfig))
      }

      // 注册社交应用自己的模板根目录，所有模板都由当前角色主模型消费。
      ctx.mdpEngine.addTemplateRoot(SOCIAL_PROMPTS_DIR, 'apps/social')

      // 1. 创建应用自己的编译器（方案 B 核心）
      // AIOS 隔离原则：Compiler 不依赖 memoryProvider（主 Agent RAG），
      // 只通过 storeRegistry 访问应用自己的 social.tdb（PEDSA 社交图谱）
      this.compiler = new SocialAppCompiler(
        ctx.grantRegistry,
        ctx.agentManager,
        ctx.mdpEngine,
        ctx.storeRegistry!,
        (agentId) => ctx.socialStorage!.memoryAvailable(agentId),
      )
      this.compiler.setLlmService(ctx.llmService)

      // 2. 注册资源授权（仅 persona）
      // AIOS 隔离原则：subagent 不直接读主 Agent 记忆（RAG/CanonicalMemory），
      // 只继承人格投影；记忆交换通过 Checkpoint.memoryCandidates 走 MemoryGate 审核
      await this.registerGrants(ctx)

      // 3. 绑定Kernel提供的收窄存储Port。
      this.socialMessageRepo = scopedSocialStorage(ctx.socialStorage)

      // 4. 创建图片缓存管理器
      const imageCacheManager = ctx.pathResolver
        ? new ImageCacheManager({
            cacheDir: ctx.pathResolver.resolve('@data/social_images'),
            requestContext: (url) => {
              const scope = currentSocialScope()
              return {
                partition: JSON.stringify([scope?.platform, scope?.accountId]),
                headers: this.adapter(scope?.platform)?.mediaHeaders(url, scope?.accountId),
              }
            },
          })
        : undefined

      // 6. 创建社交 Scorer 服务（可选，依赖 storeRegistry + 社交炼化模型）
      if (ctx.storeRegistry && ctx.getSocialScorerModel) {
        this.socialScorer = new SocialScorerService(
          ctx.socialStorage,
          ctx.storeRegistry,
          ctx.llmService,
          ctx.getSocialScorerModel,
          ctx.mdpEngine,
          ctx.agentManager,
        )
      }

      // 7. 创建 SocialBridge（内部自动创建 SessionManager + Scheduler）
      if (!ctx.configRepo) throw new Error('社交互聊保护需要可持久化的配置服务')
      this.loopGuard = new SocialLoopGuard(
        ctx.configRepo,
        () =>
          normalizeLoopPolicy(
            this.modeConfig.loopGuard,
            this.adapters.find((adapter) => adapter.legacyConfiguration)?.platform,
          ),
        (platform) => this.adapter(platform)?.getConnectedAccountIds() ?? [],
        (platform) => this.ownerFor(platform),
        async (change) =>
          (await this.updateModeConfig((current) => ({ loopGuard: change(current.loopGuard) })))
            .loopGuard,
        () => this.adapters.find((adapter) => adapter.legacyConfiguration)?.platform,
      )
      this.socialBridge = new SocialBridge({
        loopGuard: this.loopGuard,
        getAgentId: () => this.socialAgentId,
        getOwnerId: (platform) => this.ownerFor(platform),
        legacyPlatform: () =>
          this.adapters.find((adapter) => adapter.legacyConfiguration)?.platform,
        socialEvents: ctx.socialEvents,
        executions: ctx.socialExecutions,
        socialMessageRepo: this.socialMessageRepo,
        imageCacheManager,
        getStickerService: (platform) => this.adapter(platform)?.getStickerService(),
        resolveNativeEmoji: (scope, reference) => this.resolveNativeEmoji(scope, reference),
        inboundRouteRepo: ctx.inboundRouteRepo,
        shouldAcceptInbound: (message) => {
          // 单实例 Social 始终由配置角色处理，频道路由不得跨角色改派。
          message.agentId = this.socialAgentId
          if (this.modeConfig.ownerPrivateOnlyAgentIds.includes(message.agentId)) {
            return message.channelType === 'private' && message.isOwner === true
          }
          if (
            this.identityListed(this.modeConfig.userBlacklist, message.senderId, message.platform)
          )
            return false
          if (message.channelType === 'group') {
            if (
              this.identityListed(
                this.modeConfig.groupBlacklist,
                message.channelId,
                message.platform,
              )
            )
              return false
            if (
              this.hasPlatformEntries(this.modeConfig.groupWhitelist, message.platform) &&
              !this.identityListed(
                this.modeConfig.groupWhitelist,
                message.channelId,
                message.platform,
              )
            )
              return false
          }
          if (
            message.channelType === 'private' &&
            this.modeConfig.strangerPolicy === 'ignore' &&
            !message.isOwner
          )
            return false
          return true
        },
        shouldAllowSession: (session) =>
          session.agentId === this.socialAgentId &&
          (!this.modeConfig.ownerPrivateOnlyAgentIds.includes(session.agentId) ||
            this.isOwnerSession(session)) &&
          (session.channelType !== 'group' ||
            (!this.identityListed(
              this.modeConfig.groupBlacklist,
              session.channelId,
              session.platform,
            ) &&
              (!this.hasPlatformEntries(this.modeConfig.groupWhitelist, session.platform) ||
                this.identityListed(
                  this.modeConfig.groupWhitelist,
                  session.channelId,
                  session.platform,
                )))),
        onMessagePersisted: async (agentId) => {
          if (!this.socialScorer || this.socialScorerRunning.has(agentId)) return
          this.socialScorerRunning.add(agentId)
          try {
            if (!(await this.socialScorer.shouldProcess(agentId))) return
            if (ctx.socialExecutions) {
              await ctx.socialExecutions.run({
                taskId: `social-scorer:${agentId}:${Date.now()}`,
                class: 'background',
                priority: 1,
                resourceKey: `social-scorer:${agentId}`,
                maxDurationMs: 10 * 60_000,
                run: async ({ signal }) => this.socialScorer!.checkAndProcess(agentId, signal),
              })
            } else {
              await this.socialScorer.checkAndProcess(agentId)
            }
          } finally {
            this.socialScorerRunning.delete(agentId)
          }
        },
        generateReply: async (params) => this.generateReply(params),
      })

      // 8. 从连接配置创建平台适配器并注册
      await this.setupSocialAdapters(ctx)

      // 9. 启动 SocialBridge
      await this.socialBridge.start(this.lifetime.signal)
      this.releaseTaskDelivery = ctx.registerTaskDelivery?.({
        authorizeOrigin: async (origin) => {
          const adapter = this.adapter(origin.platform)
          return adapter &&
            origin.accountId &&
            origin.channelId &&
            origin.messageId &&
            origin.channelType === 'private' &&
            origin.senderId === adapter.getOwnerId() &&
            adapter.getConnectedAccountIds().includes(origin.accountId) &&
            ctx.agentManager.getAgent(this.socialAgentId)
            ? this.socialAgentId
            : undefined
        },
        sendResources: async (origin, content, resources) => {
          if (!this.socialBridge || origin.senderId !== this.ownerFor(origin.platform))
            throw new Error('社交绑定已变化')
          await this.socialBridge.sendReply(origin.platform, {
            accountId: origin.accountId,
            channelType: 'private',
            channelId: origin.channelId,
            content,
            attachments: resources,
          })
          try {
            await this.socialMessageRepo?.insert({
              turnId: currentSocialRecovery()?.record.id,
              msgId: `creative_${crypto.randomUUID()}`,
              platform: origin.platform,
              accountId: origin.accountId,
              channelId: origin.channelId,
              channelType: 'private',
              senderId: 'self',
              senderName: this.socialAgentId,
              content: content || '[创作结果]',
              agentId: this.socialAgentId,
            })
          } catch {
            ctx.logger.warn(__t('apps.social.logs', '创作结果已发送，但社交历史记录未保存'))
          }
        },
        ready: async (origin) => {
          if (
            !this.running ||
            origin.senderId !== this.ownerFor(origin.platform) ||
            !this.adapter(origin.platform)
          )
            return false
          return (
            (await this.adapter(origin.platform)!.getStatus()).connected &&
            this.adapter(origin.platform)!.getConnectedAccountIds().includes(origin.accountId) &&
            (
              await this.adapter(origin.platform)!.getSendReadiness({
                accountId: origin.accountId,
                channelId: origin.channelId,
                channelType: 'private',
                content: '',
              })
            ).ready
          )
        },
        send: async (origin, content, delivery) => {
          const agentId = this.socialAgentId
          const signal = this.lifetime.signal
          if (delivery && delivery.agentId !== agentId)
            throw Object.assign(new Error('SOCIAL_PERSONA_BINDING_INVALID'), {
              code: 'DELIVERY_NOT_SENT',
            })
          if (!this.socialBridge || origin.senderId !== this.ownerFor(origin.platform))
            throw new Error('社交绑定已变化，不能向旧来源发送')
          // 先记下已生成的结果，后续社交回合能读取；投递状态仍由宿主账本独立记录。
          if (delivery) {
            try {
              await this.socialMessageRepo!.insert({
                msgId: `task-result:${delivery.deliveryId}`,
                platform: origin.platform,
                accountId: origin.accountId,
                channelId: origin.channelId,
                channelType: 'private',
                senderId: 'self',
                senderName: agentId,
                agentId,
                content: __t('apps.social.ui', '【后台任务结果已生成】\n{0}', [content]),
              })
            } catch (error) {
              throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
                code: 'DELIVERY_NOT_SENT',
              })
            }
          }
          signal.throwIfAborted()
          await this.socialBridge.sendReply(
            origin.platform,
            {
              accountId: origin.accountId,
              channelType: 'private',
              channelId: origin.channelId,
              content,
            },
            signal,
          )
        },
      })

      // 10. 注入社交工具 Provider（供 socialOps 工具使用）
      if (this.socialBridge.hasActiveAdapter()) {
        const socialProvider = this.socialBridge.createMessagingProvider()
        if (socialProvider) {
          setSocialMessagingProvider(socialProvider)
          ctx.logger.info(
            __t('apps.social.logs', '社交工具 Provider 已注入 (平台: {0})', [
              socialProvider.platform,
            ]),
          )
        }
      }
      setSocialModeControlProvider({
        setOwnerPrivateOnly: (agentId, enabled) => this.setOwnerPrivateOnly(agentId, enabled),
      })
      const operationDeps: SocialOperationDependencies = {
        active: (agentId) => this.running && agentId === this.socialAgentId,
        config: ctx.configRepo,
        storage: this.socialMessageRepo,
        groupState: (scope, groupId) =>
          this.getGroupState(scope.agentId, scope.accountId, groupId, scope.platform),
        configureGroupState: async (scope, groupId, policy, reset) => {
          const key = socialGroupPolicyKey(scope.agentId, scope.accountId, groupId, scope.platform)
          await this.updateModeConfig((current) => {
            scope.signal?.throwIfAborted()
            const groupPolicies = { ...current.groupPolicies }
            const oldKey = socialGroupPolicyKey(scope.agentId, scope.accountId, groupId)
            const legacy =
              this.adapter(scope.platform)?.legacyConfiguration === true
                ? groupPolicies[oldKey]
                : undefined
            if (reset) delete groupPolicies[key]
            else groupPolicies[key] = { ...legacy, ...groupPolicies[key], ...policy }
            if (this.adapter(scope.platform)?.legacyConfiguration) delete groupPolicies[oldKey]
            return { groupPolicies }
          })
          return this.getGroupState(scope.agentId, scope.accountId, groupId, scope.platform)
        },
        markBot: async (scope, input) => {
          if (!this.loopGuard) throw new Error('社交互聊保护尚未就绪')
          return this.loopGuard.markBot(scope, input)
        },
        send: async (scope, message) => {
          if (!this.socialBridge) throw new Error('社交发送服务尚未就绪')
          if (!scope.platform) throw new Error('SOCIAL_PLATFORM_REQUIRED')
          return this.socialBridge.sendReply(scope.platform, message, scope.signal)
        },
        prepareImage: async (source, scope) => {
          if (!ctx.resources) throw new Error('资源服务未就绪')
          const prepared = await ctx.resources.prepare({
            agentId: scope.host ? ctx.hostAgentId : scope.agentId,
            threadId:
              scope.threadId ||
              (await ctx.threadService.getOrCreateLatest(scope.agentId, 'group', 'app_internal'))
                .id,
            source,
            callId: scope.callId,
            allowLocal: scope.owner,
          })
          if (prepared.resource.kind !== 'image') throw new Error('此操作需要图片资源')
          scope.signal?.throwIfAborted()
          const adapter = this.adapter(scope.platform)
          if (!adapter) throw new Error('SOCIAL_PLATFORM_REQUIRED')
          return adapter.prepareImage(prepared.filePath)
        },
      }
      this.operationDeps = operationDeps
      this.operations = new SocialOperations()
      for (const adapter of this.adapters) {
        const provider = adapter.createOperations(operationDeps)
        this.operations.register(
          adapter.platform,
          new SocialCommonOperations(
            operationDeps,
            () => adapter.getConnectedAccountIds(),
            provider,
          ),
        )
      }

      // 12. 读取社交工具 manifest，解析为 ToolDefinition[] 供 LLM function calling 使用
      //     路径: packages/apps/social/tools/manifest.json（与 prompts/ 同级）
      try {
        const manifestPath = path.resolve(SOCIAL_PROMPTS_DIR, '../tools/manifest.json')
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
          tools?: Array<{
            name: string
            description: string
            parameters?: Record<string, unknown>
          }>
        }
        if (manifest.tools?.length) {
          this.toolDefinitions = manifest.tools
            .filter((tool) => tool.name === 'manage_task')
            .map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters ?? { type: 'object', properties: {} },
              },
            }))
          const flowTool: ToolDefinition = {
            type: 'function',
            function: {
              name: 'update_flow_state',
              description: __t(
                'apps.social.ui',
                '维护当前社交会话的私有临时心流。仅在跨轮目标或私有事实发生变化时调用。',
              ),
              parameters: {
                type: 'object',
                properties: {
                  current_goal: {
                    type: 'string',
                    description: __t(
                      'apps.social.ui',
                      '当前持续目标；省略表示保留，空字符串表示清空。',
                    ),
                  },
                  private_facts: {
                    type: 'string',
                    description: __t(
                      'apps.social.ui',
                      '不应直接向用户透露的短期关键事实；省略表示保留。',
                    ),
                  },
                },
                additionalProperties: false,
              },
            },
          }
          this.toolDefinitions.push(flowTool)
          this.toolDefinitions.push({
            type: 'function',
            function: {
              name: 'communicate_with_host',
              description: __t(
                'apps.social.ui',
                '与宿主主 Agent 建立临时通信，用于核验可疑请求、申请审批、请求资源或汇报结果。',
              ),
              parameters: {
                type: 'object',
                properties: {
                  mode: {
                    type: 'string',
                    enum: [
                      'consult',
                      'verify',
                      'approval',
                      'request_resource',
                      'report',
                      'clarify',
                      'complete',
                    ],
                  },
                  summary: { type: 'string' },
                  context: { type: 'object' },
                },
                required: ['mode', 'summary'],
              },
            },
          })
          ctx.logger.info(
            __t('apps.social.logs', '社交能力目录已加载: {0} 个，由统一编排入口调用', [
              this.toolDefinitions.length,
            ]),
          )
        }
      } catch {
        // 静默，工具列表保持为空
      }

      // 12b. 构建社交工具执行器（name → execute 映射）
      //      compiler.generateReply 在 LLM 返回 toolCalls 时通过此执行器调用对应工具
      //      社交工具内部通过 requireProvider() 获取已注入的 SocialMessagingProvider，
      //      不依赖 ctx 参数，故传入空壳 ctx 即可
      {
        const socialTools = [
          socialSetOwnerPrivateOnlyTool,
          socialSendMessageTool,
          socialGetContactsTool,
          socialGetGroupsTool,
          socialGetContactInfoTool,
          socialGetGroupInfoTool,
          socialGetGroupMembersTool,
          socialHandleRequestTool,
          socialReadForwardMsgTool,
          socialReadImageTool,
          socialReadDiaryTool,
          socialRememberContactImpressionTool,
          socialGetContactHistoryTool,
        ]
        // 构建 name → tool 实例映射
        const toolMap = new Map<string, (args: Record<string, unknown>) => Promise<string>>()
        for (const tool of socialTools) {
          toolMap.set(tool.name, async (args) => {
            const result = await tool.execute(args, {
              agentId: this.socialAgentId,
              sessionId: ctx.realm.descriptor.realmId,
              source: 'application',
              threadId: ctx.realm.descriptor.realmId,
              channel: 'application',
            })
            return typeof result === 'string' ? result : JSON.stringify(result)
          })
        }
        // 执行器：根据工具名查找并执行，未知工具返回错误 JSON
        this.toolExecutor = async (name, args) => {
          const fn = toolMap.get(name)
          if (!fn) {
            return JSON.stringify({ error: `未知社交工具: ${name}` })
          }
          try {
            return await fn(args)
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            return JSON.stringify({ error: `工具 ${name} 执行失败: ${errMsg}` })
          }
        }
        ctx.logger.info(
          __t('apps.social.logs', '社交工具执行器已构建: {0} 个工具', [socialTools.length]),
        )

        // ── 注入图片读取 Provider ──
        // social_read_image 工具通过此 Provider 按 message_id 从 DB 查询消息，
        // 提取图片 URL，下载并转 data URL 返回给工具
        if (this.socialMessageRepo && imageCacheManager) {
          const repo = this.socialMessageRepo
          const imgCache = imageCacheManager
          const decode = (row: Parameters<AbstractSocialAdapter['restoreMessage']>[0]) =>
            this.adapter(row.platform)?.restoreMessage(row) ?? restoreSocialMessage(row)
          const imageReader: SocialImageReaderProvider = {
            async readImages(
              agentId: string,
              messageIds: string[],
              maxImages = 3,
            ): Promise<string[]> {
              const images: string[] = []
              const collectedUrls = new Set<string>() // 去重

              for (const msgId of messageIds) {
                if (images.length >= maxImages) break
                try {
                  const accountId = currentSocialRecovery()?.record.accountId
                  if (!accountId) throw new Error('图片读取缺少当前社交账号')
                  const row = await repo.getByMsgId(agentId, msgId, accountId)
                  if (row?.accountId !== accountId) continue
                  if (!row?.rawEventJson || row.rawEventJson === '{}') continue
                  const urls = (decode(row).attachments ?? [])
                    .filter((item) => item.type === 'image')
                    .flatMap((item) => (item.url ? [item.url] : []))
                  for (const url of urls) {
                    if (images.length >= maxImages) break
                    if (collectedUrls.has(url)) continue
                    const localPath = await imgCache.download(url)
                    if (localPath) {
                      const dataUrl = imgCache.readAsDataUrl(localPath)
                      if (dataUrl) {
                        images.push(dataUrl)
                        collectedUrls.add(url)
                      }
                    }
                  }
                } catch {
                  // 单条消息查询失败不影响其他消息
                }
              }
              return images
            },
          }
          setSocialImageReaderProvider(imageReader)
          ctx.logger.info(__t('apps.social.logs', '社交图片读取 Provider 已注入'))
        }

        if (ctx.hostDiaryReader) {
          setSocialDiaryReaderProvider(ctx.hostDiaryReader)
          ctx.logger.info(__t('apps.social.logs', '宿主Agent日记只读Provider已注入'))
        }

        if (this.socialMessageRepo) {
          const repo = this.socialMessageRepo
          const contactMemoryProvider: SocialContactMemoryProvider = {
            async rememberImpression(input) {
              await repo.upsertContactImpression({
                ...input,
                platform:
                  currentSocialScope()?.platform ??
                  (() => {
                    throw new Error('SOCIAL_PLATFORM_REQUIRED')
                  })(),
                turnId: currentSocialRecovery()?.record.id,
              })
            },
            async getContactHistory(input: {
              agentId: string
              userId: string
              groupId?: string
              privateLimit?: number
              groupLimit?: number
              selfMessageLimit?: number
            }) {
              const privateMessages = await repo.getRecentPrivateBySender(
                input.agentId,
                input.userId,
                input.privateLimit ?? 20,
              )
              const commonGroupIds = await repo.getRecentGroupsByContact(
                input.agentId,
                input.userId,
                5,
              )
              const selfMessagesByGroup = await Promise.all(
                commonGroupIds.map(async (groupId) => ({
                  groupId,
                  messages: (
                    await repo.getRecentSelfGroupMessages(
                      input.agentId,
                      groupId,
                      input.selfMessageLimit ?? 5,
                    )
                  ).map((message) => ({
                    content: message.content,
                    timestamp: message.timestamp,
                  })),
                })),
              )
              const groupMessages = input.groupId
                ? await repo.getContactGroupMessages(
                    input.agentId,
                    input.userId,
                    input.groupId,
                    input.groupLimit ?? 30,
                  )
                : []
              const impression = await repo.getContactImpression(
                input.agentId,
                currentSocialScope()?.platform ?? '',
                input.userId,
              )
              return {
                contact: {
                  userId: input.userId,
                  displayName:
                    impression?.displayName ||
                    privateMessages.find((message) => message.senderId === input.userId)
                      ?.senderName ||
                    groupMessages[0]?.senderName ||
                    '',
                  identity: impression?.identity ?? '',
                  impression: impression?.impression ?? '',
                },
                commonGroups: selfMessagesByGroup,
                privateMessages: privateMessages.map((message) => ({
                  sender: message.senderName || message.senderId,
                  senderId: message.senderId,
                  content: message.content,
                  timestamp: message.timestamp,
                })),
                groupMessages: groupMessages.map((message) => ({
                  groupId: message.channelId,
                  sender: message.senderName || message.senderId,
                  senderId: message.senderId,
                  content: message.content,
                  timestamp: message.timestamp,
                })),
              }
            },
          }
          setSocialContactMemoryProvider(contactMemoryProvider)
          ctx.logger.info(__t('apps.social.logs', '社交联系人印象与历史 Provider 已注入'))
        }
      }

      // 13. 动态挂载社交 HTTP 路由到主 app
      // AIOS sub app 路由挂载机制：通过 ctx.mountRouter 注册 HTTP 端点，
      // 不直接接触主 app 实例（隔离原则）。
      // 暴露 /api/social/status（适配器状态）和 /api/social/send（调试发消息）给前端 Dashboard。
      if (ctx.mountRouter) {
        const dataService = new SocialDataService({
          getPlatforms: () => this.adapters.map((adapter) => adapter.platform),
          cancelTasks: (agentId, address) => {
            this.socialBridge?.closeSessionsExcept(
              (session) =>
                session.agentId !== agentId ||
                Boolean(
                  address &&
                  (session.platform !== address.platform ||
                    session.accountId !== address.accountId ||
                    session.channelType !== address.channelType ||
                    session.channelId !== address.channelId),
                ),
            )
            this.socialScorer?.cancel(agentId)
          },
          storage: ctx.socialStorage!,
          getAgentName: (agentId) => ctx.agentManager.getAgent(agentId)?.name,
        })
        const socialRouter = createSocialRouter(this.socialBridge, {
          statusCards: this.statusCards!,
          resolveStickers: (platform) => this.adapter(platform)?.getStickerService(),
          getStickerConnections: () =>
            this.adapters.flatMap((adapter) =>
              adapter.getStickerService()
                ? adapter
                    .getConnectedAccountIds()
                    .map((accountId) => ({ platform: adapter.platform, accountId }))
                : [],
            ),
          getConnections: () =>
            this.adapters.map((adapter) => ({
              id: adapter.connectionId,
              adapter: adapter.adapterType,
              platform: adapter.platform,
              name: adapter.displayName,
              ownerId: adapter.getOwnerId(),
              accounts: adapter.getConnectedAccountIds(),
              capabilities: adapter.capabilities,
            })),
          getPlatforms: () =>
            this.adapterFactories.map((factory) => ({
              type: factory.type,
              platform: factory.platform,
            })),
          enablePlatform: (type) => this.enablePlatform(type),
          management: async (id, action, input) => {
            const adapter = this.adapters.find((item) => item.connectionId === id)
            if (!adapter) throw new Error('SOCIAL_CONNECTION_INVALID')
            const owner = adapter.getOwnerId()
            const result = action
              ? await adapter.manage(action, input ?? {})
              : await adapter.managementSnapshot()
            if (owner !== adapter.getOwnerId())
              this.socialBridge?.closeSessionsExcept(
                (session) => session.platform !== adapter.platform,
              )
            else if (typeof result.changedAccountId === 'string')
              this.socialBridge?.closeSessionsExcept(
                (session) =>
                  session.platform !== adapter.platform ||
                  session.accountId !== result.changedAccountId,
              )

            return result
          },
          updateOwner: (id, ownerId) => this.updateConnectionOwner(id, ownerId),
          getHostAgentId: () => ctx.hostAgentId,
          dataService,
          getAgentConfig: () => ({ agentId: this.socialAgentId }),
          updateAgentConfig: (agentId) => this.setSocialAgent(agentId),
          getModeConfig: () => ({ ...this.modeConfig }),
          updateModeConfig: (config) => this.updateModeConfig(config),
        })
        ctx.mountRouter('/api/social', socialRouter)
      } else {
        ctx.logger.warn(
          __t(
            'apps.social.logs',
            'ctx.mountRouter 未注入，社交 HTTP 路由未挂载（前端 /api/social/* 将 404）',
          ),
        )
      }

      // 全部初始化成功后才向宿主发布；使用注入的函数跨越独立 bundle 边界。
      this.publishTransports()
      this.running = true
      ctx.logger.info(__t('apps.social.logs', '社交应用运行时已初始化（已接入真实组件）'))
      return { success: true }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      ctx.logger.error(__t('apps.social.logs', '社交应用初始化失败: {0}', [errMsg]))
      await this.onStop().catch((error) =>
        ctx.logger.warn(__t('apps.social.logs', '清理初始化失败的社交运行时失败: {0}', [error])),
      )
      return { success: false, error: errMsg }
    }
  }

  /**
   * 注册资源授权（仅 persona）
   *
   * AIOS 资源隔离原则：
   * - persona grant：读取当前社交角色的 system_prompt.md 作为人格基础（只读投影）
   * - **不注册 memory grant**：subagent 不直接读主 Agent 的 RAG/CanonicalMemory
   * - 记忆交换：社交应用产生有价值的记忆时，通过 Checkpoint.memoryCandidates
   *   提交给主 Agent 的 MemoryGate 审核，通过后才并入 CanonicalMemory
   *
   * 授权为 auto 级别（应用启动自动授予），onStop 时统一撤销。
   */
  private async registerGrants(ctx: AppRuntimeContext): Promise<void> {
    const { grantRegistry, instanceId } = ctx
    const agentId = this.socialAgentId

    // 人格跟随当前社交角色；应用最初的宿主不决定切换后的角色身份。
    const personaGrantId = await grantRegistry.grant({
      ownerAgentId: agentId,
      holderId: instanceId,
      holderType: 'app',
      resource: {
        kind: 'persona',
        agentId,
        allowAppPatch: false,
      },
      permissions: ['read'],
      grantedBy: 'auto',
      note: '社交应用自动授权：读取当前社交角色人格投影',
    })
    this.grantIds.push(personaGrantId)

    ctx.logger.info(
      __t('apps.social.logs', '人格授权已注册: holder={0}, agent={1}, host={2}', [
        instanceId,
        agentId,
        ctx.hostAgentId,
      ]),
    )
  }

  /**
   * 撤销所有已注册的资源授权
   *
   * onStop 时调用，确保社交应用停止后不再持有主 Agent 资源访问权。
   */
  private async revokeGrants(): Promise<void> {
    if (!this.ctx || this.grantIds.length === 0) return

    const { grantRegistry } = this.ctx
    let revokedCount = 0

    for (const grantId of this.grantIds) {
      try {
        const ok = await grantRegistry.revoke(grantId)
        if (ok) revokedCount++
      } catch (err) {
        this.ctx.logger.warn(
          __t('apps.social.logs', '撤销授权失败: grantId={0}, {1}', [grantId, err]),
        )
      }
    }

    this.grantIds = []
    this.ctx.logger.info(__t('apps.social.logs', '资源授权已撤销: {0} 条', [revokedCount]))
  }

  private publishTransports(): void {
    this.releaseSocialTransport?.()
    this.releaseSocialTransport = undefined
    const releases: Array<() => void> = []
    try {
      for (const adapter of this.adapters) {
        const transport = adapter.getWebSocketTransport()
        if (transport)
          releases.push(this.ctx!.registerSocialTransport!(transport, adapter.platform))
      }
      this.releaseSocialTransport = () => {
        for (const release of releases) release()
      }
    } catch (error) {
      for (const release of releases) release()
      throw error
    }
  }

  async onConfigChanged(keys: readonly string[]): Promise<void> {
    if (!keys.includes('social') || !this.ctx || this.stopped) return
    const update = this.adapterUpdates
      .catch(() => {})
      .then(async () => {
        if (!this.ctx || this.stopped) return
        const config = await this.readSocialConfig(this.ctx)
        if (this.stopped) return
        const specs = socialConnectionSpecs(config, this.adapterFactories)
        if (config.mode && typeof config.mode === 'object' && !Array.isArray(config.mode)) {
          this.applyModeConfig(this.normalizeModeConfig(config.mode as Record<string, unknown>))
        }
        const next = specs.map(({ factory, connection }) => {
          const existing = this.adapters.find(
            (adapter) =>
              adapter.platform === factory.platform &&
              adapter.connectionId === connection.id &&
              adapter.adapterType === factory.type,
          )
          const adapter =
            existing ??
            factory.create(connection, this.socialAgentId, {
              privateRoot: this.ctx?.pathResolver?.resolve('@data/social_private'),
            })
          if (adapter.platform !== factory.platform || adapter.connectionId !== connection.id)
            throw new Error('SOCIAL_CONNECTION_INVALID')
          return { adapter, existing, connection }
        })
        const removed = this.adapters.filter(
          (adapter) => !next.some((item) => item.adapter === adapter),
        )
        const changed = new Set<string>()
        if (removed.length || next.some((item) => !item.existing)) {
          this.releaseSocialTransport?.()
          this.releaseSocialTransport = undefined
        }
        for (const adapter of removed) {
          changed.add(adapter.platform)
          this.socialBridge?.closeSessionsExcept((session) => session.platform !== adapter.platform)
          this.socialBridge?.unregisterAdapter(adapter.platform)
          this.operations?.unregister(adapter.platform)
          try {
            await adapter.disconnect()
          } catch (error) {
            this.ctx.logger.warn(
              __t('apps.social.logs', '社交适配器 {0} 停止失败: {1}', [
                adapter.platform,
                String(error),
              ]),
            )
          }
        }
        this.adapters = next.map((item) => item.adapter)
        for (const { adapter, existing, connection } of next) {
          const owner = adapter.getOwnerId()
          adapter.configure(connection)
          if (owner !== adapter.getOwnerId()) changed.add(adapter.platform)
          if (!existing) {
            changed.add(adapter.platform)
            this.socialBridge!.registerAdapter(adapter)
            if (this.operationDeps && this.operations)
              this.operations.register(
                adapter.platform,
                new SocialCommonOperations(
                  this.operationDeps,
                  () => adapter.getConnectedAccountIds(),
                  adapter.createOperations(this.operationDeps),
                ),
              )
            if (this.running) await adapter.connect(this.lifetime.signal)
          }
        }
        if (changed.size) {
          invalidatePromptReplay(`social:${this.ctx.instanceId}:`)
          this.socialBridge?.closeSessionsExcept((session) => !changed.has(session.platform ?? ''))
        }
        if (this.running && !this.releaseSocialTransport) this.publishTransports()
        setSocialMessagingProvider(this.socialBridge?.createMessagingProvider() ?? null)
      })
    this.adapterUpdates = update
    await update
  }

  private async readSocialConfig(ctx: AppRuntimeContext): Promise<Record<string, unknown>> {
    const raw = await ctx.configRepo?.get('social')
    if (!raw) return {}
    try {
      const config: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
      return config && typeof config === 'object' && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  /** 模型添加标记与界面保存串行合并，避免并发丢失名单。 */
  private updateModeConfig(
    config:
      | Record<string, unknown>
      | ((current: typeof this.modeConfig) => Record<string, unknown>),
  ) {
    return this.serializeConfigWrite(async () => {
      if (!this.ctx?.configRepo) throw new Error('社交配置服务尚未就绪')
      const current = await this.readSocialConfig(this.ctx)
      const base =
        current.mode && typeof current.mode === 'object' && !Array.isArray(current.mode)
          ? this.normalizeModeConfig(current.mode as Record<string, unknown>)
          : this.modeConfig
      const patch = typeof config === 'function' ? config(base) : config
      const next = this.normalizeModeConfig(patch, base)
      current.mode = next
      await this.ctx.configRepo.set('social', JSON.stringify(current))
      // 保存失败时不改动运行时；成功后设置页、工具读回和调度器使用同一份归一化结果。
      this.applyModeConfig(next)
      return { ...next }
    })
  }

  private normalizeModeConfig(config: Record<string, unknown>, base = this.modeConfig) {
    const next = {
      ...base,
      ...config,
      ...normalizeSocialSchedulerConfig({ ...base, ...config }),
    }
    next.groupPolicies = normalizeSocialGroupPolicies(next.groupPolicies)
    next.loopGuard = normalizeLoopPolicy(
      {
        ...base.loopGuard,
        ...(config.loopGuard &&
        typeof config.loopGuard === 'object' &&
        !Array.isArray(config.loopGuard)
          ? config.loopGuard
          : {}),
      },
      this.adapters.find((adapter) => adapter.legacyConfiguration)?.platform,
    )
    next.groupWhitelist = Array.isArray(next.groupWhitelist) ? next.groupWhitelist.map(String) : []
    next.groupBlacklist = Array.isArray(next.groupBlacklist) ? next.groupBlacklist.map(String) : []
    next.userBlacklist = Array.isArray(next.userBlacklist) ? next.userBlacklist.map(String) : []
    next.ownerPrivateOnlyAgentIds = Array.isArray(next.ownerPrivateOnlyAgentIds)
      ? [...new Set(next.ownerPrivateOnlyAgentIds.map(String))]
      : []
    return next
  }

  private applyModeConfig(config: typeof this.modeConfig): void {
    this.modeConfig = config
    this.socialBridge?.updateSchedulerConfig(config)
    this.socialBridge?.updateGroupPolicies(config.groupPolicies)
  }

  private getGroupState(
    agentId: string,
    accountId: string,
    groupId: string,
    platform = this.adapter()?.platform,
  ) {
    if (!this.socialBridge) throw new Error('群聊状态机尚未初始化')
    return {
      ...this.socialBridge.getGroupState(agentId, accountId, groupId, platform),
      override: {
        ...this.modeConfig.groupPolicies[
          socialGroupPolicyKey(agentId, accountId, groupId, platform)
        ],
      },
    }
  }

  private async enablePlatform(type: string): Promise<void> {
    const factory = this.adapterFactories.find((item) => item.type === type)
    if (!factory || !this.ctx?.configRepo) throw new Error('SOCIAL_ADAPTER_UNKNOWN')
    await this.serializeConfigWrite(async () => {
      const config = await this.readSocialConfig(this.ctx!)
      const connections = Array.isArray(config.connections)
        ? config.connections
        : [
            {
              id: 'qq',
              adapter: 'napcat',
              ownerId: config.ownerId ?? config.ownerQq,
              autoAcceptFriend: config.autoAcceptFriend,
              legacyConfiguration: true,
            },
          ]
      const existing = connections.find((item: Record<string, unknown>) => item.adapter === type)
      if (existing) existing.enabled = true
      else connections.push({ id: factory.platform, adapter: type, enabled: true })
      await this.ctx!.configRepo!.set('social', JSON.stringify({ ...config, connections }))
    })
    await this.onConfigChanged(['social'])
  }

  private async updateConnectionOwner(id: string, ownerId: string): Promise<void> {
    const adapter = this.adapters.find((item) => item.connectionId === id)
    if (!adapter || !adapter.validateOwnerId(ownerId) || !this.ctx?.configRepo)
      throw new Error('SOCIAL_OWNER_INVALID')
    await this.serializeConfigWrite(async () => {
      const config = await this.readSocialConfig(this.ctx!)
      if (Array.isArray(config.connections)) {
        const connection = config.connections.find(
          (value) =>
            value &&
            typeof value === 'object' &&
            ((value as Record<string, unknown>).id === id ||
              (!(value as Record<string, unknown>).id &&
                (value as Record<string, unknown>).adapter === adapter.adapterType)),
        ) as Record<string, unknown> | undefined
        if (!connection) throw new Error('SOCIAL_CONNECTION_INVALID')
        connection.ownerId = ownerId
      } else config.ownerId = ownerId
      await this.ctx!.configRepo!.set('social', JSON.stringify(config))
    })
    adapter.setOwnerId(ownerId || undefined)
    this.socialBridge?.closeSessionsExcept((session) => session.platform !== adapter.platform)
    invalidatePromptReplay(`social:${this.ctx.instanceId}:`)
  }

  private serializeConfigWrite<T>(write: () => Promise<T>): Promise<T> {
    const pending = this.configWriteQueue.catch(() => {}).then(write)
    this.configWriteQueue = pending
    return pending
  }

  private async setSocialAgent(agentId: string): Promise<{
    agentId: string
    closedSessions: number
  }> {
    if (!this.ctx?.configRepo || !this.socialBridge) throw new Error('社交应用尚未初始化')
    if (!this.ctx.agentManager.getAgent(agentId)) throw new Error(`角色不存在: ${agentId}`)
    if (agentId === this.socialAgentId) {
      const grants = await this.ctx.grantRegistry.queryGrants({
        holderId: this.ctx.instanceId,
        activeOnly: true,
      })
      if (
        grants.some(
          (grant) =>
            grant.resource.kind === 'persona' &&
            grant.resource.agentId === agentId &&
            grant.permissions.includes('read'),
        )
      ) {
        return { agentId, closedSessions: 0 }
      }
      // 同角色再次保存也修复旧版本遗留的宿主人格授权。
    }

    await this.serializeConfigWrite(async () => {
      const current = await this.readSocialConfig(this.ctx!)
      current.agentId = agentId
      delete current.bindings
      await this.ctx!.configRepo!.set('social', JSON.stringify(current))
    })

    this.lifetime.abort(new Error('社交角色已切换'))
    this.lifetime = new AbortController()
    invalidatePromptReplay(`social:${this.ctx.instanceId}:`)
    const closedSessions = this.socialBridge.closeSessionsExcept(() => false)
    await this.revokeGrants()
    this.socialAgentId = agentId
    this.adapters.forEach((adapter) => adapter.setAgentId(agentId))
    await this.registerGrants(this.ctx)
    this.ctx.logger.info(
      __t('apps.social.logs', '[{0}] Social 单实例角色已切换，清理会话 {1} 个', [
        agentId,
        closedSessions,
      ]),
    )
    return { agentId, closedSessions }
  }

  private async setOwnerPrivateOnly(
    agentId: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean; closedSessions: number }> {
    if (!this.ctx?.configRepo || !this.socialBridge) throw new Error('社交应用尚未初始化')
    if (!this.ctx.agentManager.getAgent(agentId)) throw new Error(`角色不存在: ${agentId}`)
    if (enabled && !this.adapters.some((adapter) => adapter.getOwnerId()))
      throw new Error('SOCIAL_OWNER_REQUIRED')

    await this.updateModeConfig((current) => {
      const ids = new Set(current.ownerPrivateOnlyAgentIds)
      if (enabled) ids.add(agentId)
      else ids.delete(agentId)
      return { ownerPrivateOnlyAgentIds: [...ids] }
    })

    const closedSessions = enabled
      ? this.socialBridge.closeSessionsExcept(
          (session) => session.agentId !== agentId || this.isOwnerSession(session),
        )
      : 0
    this.ctx.logger.info(
      __t('apps.social.logs', '[{0}] {1}仅主人私聊激活模式，清理会话 {2} 个', [
        agentId,
        enabled ? '启用' : '关闭',
        closedSessions,
      ]),
    )
    return { enabled, closedSessions }
  }

  /**
   * 装配平台适配器（单实例统一使用配置角色）
   */
  private async setupSocialAdapters(ctx: AppRuntimeContext): Promise<void> {
    const config = await this.readSocialConfig(ctx)
    if (config.mode && typeof config.mode === 'object' && !Array.isArray(config.mode))
      this.applyModeConfig(this.normalizeModeConfig(config.mode as Record<string, unknown>))
    this.adapters = createSocialAdapters(config, this.socialAgentId, this.adapterFactories, {
      privateRoot: ctx.pathResolver?.resolve('@data/social_private'),
    })
    this.applyModeConfig(this.normalizeModeConfig(this.modeConfig))
    for (const adapter of this.adapters) this.socialBridge!.registerAdapter(adapter)
  }

  /**
   * 回复生成回调（方案 B：使用应用自己的 Compiler + LLM）
   *
   * 由 SocialBridge.executeReply 调用。
   */
  private async generateReply(params: {
    platform?: string
    signal?: AbortSignal
    taskOrigin?: import('@infos/shared').TaskOrigin
    agentId: string
    channelType: 'private' | 'group'
    channelId: string
    combinedMessage: string
    trigger: FlushReason
    participation: ParticipationState
    deferredIntent?: DeferredSocialIntent
    routeChannel?: string
    routeThreadId?: string
    isOwner?: boolean
    triggerSenderId?: string
    triggerSenderName?: string
    triggerMessageId?: string
    triggerMessageContent?: string
    flushMsgIds?: string[]
    /** 触发消息中的图片附件（data URL 格式，供多模态 LLM 使用） */
    images?: string[]
    imageSources?: string[]
    /** Bot 自身平台账号（注入到上下文） */
    botSelfId?: string
    /** Bot 自身昵称（注入到上下文） */
    botNickname?: string
  }): Promise<SocialTurnOutcome> {
    if (!this.ctx || !this.compiler) {
      throw new Error('社交应用未初始化，无法唤醒角色 Agent')
    }

    const toolCycleGuard = new ToolLoopGuard()
    params = {
      ...params,
      signal: params.signal
        ? AbortSignal.any([params.signal, toolCycleGuard.signal])
        : toolCycleGuard.signal,
    }

    const { agentId, channelType, channelId, combinedMessage } = params
    const adapter = this.adapter(params.platform ?? params.taskOrigin?.platform)
    if (!adapter) throw new Error('SOCIAL_PLATFORM_REQUIRED')
    const platform = adapter.platform
    const ownerId = adapter.getOwnerId()
    const stickerService = adapter.getStickerService()
    const triggerSenderId = params.triggerSenderId ?? params.taskOrigin?.senderId
    const isOwner = Boolean(ownerId && triggerSenderId === ownerId)
    const stickerAccountId = params.taskOrigin?.accountId || params.botSelfId
    const triggerMessageId =
      params.triggerMessageId ?? params.taskOrigin?.messageId ?? params.flushMsgIds?.at(-1)

    // ── 从 DB 加载本会话最近 50 条聊天记录 ──
    // 无论是一直在线还是刚启动，都从 social_messages 表读取该频道的历史
    // 这样进程重启后 LLM 也能恢复上下文，不再依赖内存 Map
    // 加载量 50 条是 token 占用与上下文完整性的平衡点，后续如需调整只改此处即可
    let history: SocialHistoryMessage[] = []
    let replayCurrentKeys: string[] = []
    if (this.socialMessageRepo) {
      try {
        const dbRows = await this.socialMessageRepo.getRecent(agentId, channelId, channelType, 51)
        // 过滤掉本次 flush 的消息（handleInbound 已持久化到 DB，但 combinedMessage 会单独追加，
        // 不过滤会导致同一条消息在 messages 中出现两次）
        const excludeIds = new Set(params.flushMsgIds ?? [])
        // 标记变化只使相关账号的历史续接失效，避免复用未带提醒的旧轨迹。
        const messageKey = (row: (typeof dbRows)[number]) =>
          promptFingerprint([
            row.msgId,
            row.senderId,
            row.content,
            ...(this.loopGuard?.isBotAccount(row.senderId, platform) ? ['bot·无需刻意回应@'] : []),
          ])
        replayCurrentKeys = dbRows
          .filter(
            (row) =>
              excludeIds.has(row.msgId) &&
              (!stickerAccountId || row.accountId === stickerAccountId),
          )
          .map(messageKey)
        if (replayCurrentKeys.length !== excludeIds.size) replayCurrentKeys = []
        const scopedRows = dbRows.filter(
          (row) =>
            !excludeIds.has(row.msgId) && (!stickerAccountId || row.accountId === stickerAccountId),
        )
        const filteredRows = stableHistoryWindow(
          `social:${JSON.stringify([platform, agentId, stickerAccountId ?? '', channelType, channelId])}`,
          scopedRows,
          50,
          (row) => String(row.id),
          (selected) => {
            const reply = selected.findIndex((row) => row.senderId === 'self')
            return reply >= 0 && reply < selected.length - 1 ? selected.slice(reply + 1) : selected
          },
        )
        // 退出窗口时连同整轮旧回复一起移除，避免以孤立助手消息开头。
        while (filteredRows[0]?.senderId === 'self') filteredRows.shift()
        // 转换为 compiler 需要的 SocialHistoryMessage 格式
        // - senderId='self' 的是 Agent 回复 → role=assistant
        // - 其他都是用户消息 → role=user
        history = filteredRows.map((row) => ({
          key: messageKey(row),
          role: (row.senderId === 'self' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: row.content,
          senderName: row.senderId === 'self' ? undefined : row.senderName || row.senderId,
          senderId: row.senderId,
          messageId: row.msgId,
          timestamp: row.timestamp ?? new Date().toISOString(),
        }))
      } catch (err) {
        logger.warn(__t('apps.social.logs', '从 DB 加载会话历史失败 (非致命): {0}', [err]))
      }
    }

    // ── 跨会话上下文注入：群聊被 @ 时拉取触发者的最近私聊记录 ──
    // 场景：用户 A 在群里 @ Agent，Agent 能看到与 A 的最近私聊作为补充上下文
    // 仅群聊场景需要（私聊时当前会话本身就是私聊，已在 history 中）
    let crossSessionContext: string | undefined
    const contactUserId = triggerSenderId
    const contactImpression = contactUserId
      ? await this.socialMessageRepo?.getContactImpression(agentId, platform, contactUserId)
      : null
    if (channelType === 'group' && params.triggerSenderId && this.socialMessageRepo) {
      try {
        const privateMsgs = await this.socialMessageRepo.getRecentPrivateBySender(
          agentId,
          params.triggerSenderId,
          10,
        )
        if (privateMsgs.length > 0) {
          // 格式化为紧凑的私聊摘要，注入 system prompt
          const lines = privateMsgs
            .filter((message) => !stickerAccountId || message.accountId === stickerAccountId)
            .map((m) => {
              const role = m.senderId === 'self' ? '自己' : m.senderName || m.senderId
              return `[${JSON.stringify(role)} 平台账号:${m.senderId}]${this.loopGuard?.isBotAccount(m.senderId, platform) ? ' [bot·无需刻意回应@]' : ''}: ${m.content}`
            })
          crossSessionContext = lines.join('\n')
          logger.debug(
            __t('apps.social.logs', '跨会话上下文: sender={0}, 私聊记录={1} 条', [
              params.triggerSenderId,
              privateMsgs.length,
            ]),
          )
        }
      } catch (err) {
        // 静默，跨会话上下文是可选的
        logger.debug(__t('apps.social.logs', '跨会话上下文加载失败 (非致命): {0}', [err]))
      }
    }

    // ── Realm私有会话心流，不创建或复用主应用Thread。──
    const realmSessionId = JSON.stringify([
      platform,
      stickerAccountId ?? '',
      channelType,
      channelId,
    ])
    const flowState = await this.ctx.flowStateService.getRealm(
      this.ctx.realm.descriptor.realmId,
      realmSessionId,
      agentId,
    )

    // ── 编译上下文（方案 B：基于 GrantRegistry 授权）──
    const stickersAvailable =
      !!stickerAccountId &&
      !!stickerService &&
      !!adapter?.getConnectedAccountIds().includes(stickerAccountId)
    const model = this.ctx.getAgentModel ? await this.ctx.getAgentModel(agentId) : null
    if (!model) throw new Error('未配置角色主模型，无法处理社交回合')
    const compiled = await this.compiler.compile({
      variableSessionId: `social:${agentId}:${realmSessionId}`,
      modelName: model.modelId,
      modelContextTokens: model.contextWindowTokens,
      modelOutputTokens: model.maxTokens,
      platformName: adapter.displayName,
      platformVariables: adapter.promptVariables(),
      instanceId: this.ctx.instanceId,
      hostAgentId: this.socialAgentId,
      history,
      botAccountIds: this.loopGuard?.botIds(platform) ?? [],
      userMessage:
        !model.enableVision && params.images?.length
          ? `${combinedMessage}\n[图片状态：当前角色模型未开启视觉能力，本轮没有读到图片内容，不要假装已经看过。]`
          : combinedMessage,
      channelType,
      ownerId: ownerId,
      isOwner,
      flowState: { currentGoal: flowState.currentGoal, privateFacts: flowState.privateFacts },
      // 用户称呼：取该 Agent 的 agent.json owner_appellation（兜底"主人"），用于替换社交规则/身份提示中的"主人"占位
      ownerAppellation: this.ctx.agentManager.getOwnerAppellation(this.socialAgentId),
      // 名称读取主应用登记值；未登记时沿用当前角色的专属称呼。
      ownerName: (await this.ctx.configRepo?.get('owner.name')) || this.ctx.agentManager.getOwnerAppellation(this.socialAgentId),
      stickersAvailable,
      contactImpression: contactImpression
        ? {
            userId: contactImpression.userId,
            displayName: contactImpression.displayName,
            identity: contactImpression.identity ?? '',
            impression: contactImpression.impression,
          }
        : undefined,
      crossSessionContext,
      triggerSenderId,
      triggerSenderName: params.triggerSenderName,
      triggerMessageId,
      triggerMessageContent: params.triggerMessageContent,
      images: model.enableVision ? params.images : undefined,
      imageSources: params.imageSources,
      botSelfId: params.botSelfId,
      botNickname: params.botNickname,
    })

    logger.info(
      __t('apps.social.logs', '社交回合身份已绑定: agent={0}, account={1}, ', [
        agentId,
        stickerAccountId || '未知',
      ]) +
        `channel=${channelType}:${channelId}, message=${triggerMessageId || __t('apps.social.logs', '未知')}, ` +
        `sender=${triggerSenderId || __t('apps.social.logs', '未知')}, isOwner=${isOwner}`,
    )

    // 社交回复属于角色自身表达，使用当前角色指派的模型。

    const diaryAllowed = channelType === 'private' && isOwner
    const turnToolDefinitions = diaryAllowed
      ? this.toolDefinitions
      : this.toolDefinitions.filter(
          (tool) => !['social_read_diary', 'social_status_card'].includes(tool.function.name),
        )
    const taskAllowed =
      !!params.taskOrigin && params.taskOrigin.senderId === ownerId && !!this.ctx.taskControl
    const creativeDefinition =
      taskAllowed && params.taskOrigin
        ? await this.ctx.creative?.describe(params.taskOrigin)
        : undefined
    const operationScope: SocialOperationScope = {
      platform,
      agentId,
      accountId: stickerAccountId,
      channelId,
      channelType,
      owner: diaryAllowed,
      enableVision: model.enableVision === true,
      signal: AbortSignal.any([this.lifetime.signal, ...(params.signal ? [params.signal] : [])]),
      callId: currentSocialRecovery()?.record.id ?? crypto.randomUUID(),
    }
    const capabilityDefinitions = [
      ...(taskAllowed && params.taskOrigin
        ? ((await this.ctx.hostCapabilities?.describe(
            params.taskOrigin,
            model.enableVision === true,
          )) ?? [])
        : []),
      ...((await this.operations?.definitions(operationScope)) ?? []),
      ...(taskAllowed
        ? turnToolDefinitions
        : turnToolDefinitions.filter(
            (tool) => !['manage_task', 'communicate_with_host'].includes(tool.function.name),
          )
      ).filter((tool) => stickersAvailable || tool.function.name !== 'social_sticker'),
      ...(creativeDefinition ? [{ type: 'function' as const, function: creativeDefinition }] : []),
    ]
    const activeWork =
      taskAllowed && params.taskOrigin
        ? ((await this.ctx.hostCapabilities?.activity?.(params.taskOrigin)) ?? [])
        : []
    let cardSent = false
    let resourceSent = false
    let resourceUnconfirmed = false
    const sentResources = new Map<string, Promise<string>>()
    const situation = [
      activeWork.length ? `当前正在处理的工作：${JSON.stringify(activeWork)}` : '',
      params.trigger === 'proactive_review' ? '当前是在主动查看群聊，可以按话题决定是否参与。' : '',
      params.deferredIntent
        ? `你之前想稍后重新考虑：${params.deferredIntent.intention}${params.deferredIntent.condition ? `；当时的条件：${params.deferredIntent.condition}` : ''}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
    const last = compiled.messages[compiled.currentMessageIndex ?? compiled.messages.length - 1]
    if (situation && last && typeof last.content === 'string') {
      last.content = `<social_situation>\n${situation}\n</social_situation>\n\n${last.content}`
    } else if (situation && last && Array.isArray(last.content)) {
      last.content = [
        { type: 'text', text: `<social_situation>\n${situation}\n</social_situation>` },
        ...last.content,
      ]
    }

    // 编排入口复用当前角色的能力、权限和取消现场，不创建嵌套 Agent。
    const executeScopedTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<string> => {
      params.signal?.throwIfAborted()
      if (name === 'social_read_image' && !model.enableVision)
        return JSON.stringify({
          success: false,
          error: '当前角色模型未开启视觉能力，无法查看图片内容',
        })
      if (name === 'social_sticker') {
        if (args.action === 'read' && !model.enableVision)
          return JSON.stringify({
            success: false,
            error: '当前社交模型未开启视觉能力，可根据已有描述选用表情',
          })
        if (
          !stickersAvailable ||
          !stickerAccountId ||
          !stickerService ||
          !this.socialMessageRepo ||
          !this.running ||
          agentId !== this.socialAgentId ||
          !adapter?.getConnectedAccountIds().includes(stickerAccountId)
        )
          return JSON.stringify({ success: false, error: '当前账号的收藏表情能力不可用' })
        return executeSocialSticker(
          stickerService,
          this.socialMessageRepo,
          {
            platform,
            agentId,
            accountId: stickerAccountId,
            channelId,
            channelType,
          },
          args,
          (row) => adapter.restoreMessage(row),
        )
      }
      if (name === 'pictoria') {
        if (!creativeDefinition || !params.taskOrigin || !this.ctx?.creative)
          return JSON.stringify({ error: '绘图能力未开放' })
        try {
          return JSON.stringify(
            await this.ctx.creative.invoke(
              params.taskOrigin,
              args,
              `${params.taskOrigin.messageId}:${JSON.stringify(args)}`,
            ),
          )
        } catch (error) {
          return JSON.stringify({ error: error instanceof Error ? error.message : '绘图调用失败' })
        }
      }
      if (name === 'send_file') {
        if (resourceUnconfirmed)
          return JSON.stringify({
            success: false,
            uncertain: true,
            error: '上一份资源可能已送达，请用户确认后再重试',
          })
        if (!this.ctx?.resources || !this.socialBridge || !this.running)
          return JSON.stringify({ success: false, error: '资源发送暂不可用' })
        const key = JSON.stringify([currentSocialStep(), args.source, args.caption])
        if (sentResources.has(key)) return sentResources.get(key)!
        const operation = (async () => {
          let deliveryAttempted = false
          try {
            const source = String(args.source ?? '').trim()
            if (!source || source.length > 2048) throw new Error('资源来源无效')
            const caption =
              typeof args.caption === 'string' ? args.caption.trim().slice(0, 300) : undefined
            const threadId =
              params.routeThreadId ||
              (await this.ctx!.threadService.getOrCreateLatest(agentId, 'group', 'app_internal')).id
            const prepared = await this.ctx!.resources!.prepare({
              agentId,
              threadId,
              source,
              caption,
              callId: currentSocialStep() ?? `social:${crypto.randomUUID()}`,
              allowLocal: channelType === 'private' && isOwner,
            })
            const accountId = params.taskOrigin?.accountId || params.botSelfId
            if (
              !this.running ||
              agentId !== this.socialAgentId ||
              !accountId ||
              !adapter?.getConnectedAccountIds().includes(accountId)
            )
              throw new Error('当前社交账号已断开或角色已变化')
            deliveryAttempted = true
            await this.socialBridge!.sendReply(
              platform,
              {
                accountId,
                channelId,
                channelType,
                content: caption || '',
                attachments: [
                  {
                    type: ['image', 'audio', 'video'].includes(prepared.resource.kind)
                      ? (prepared.resource.kind as 'image' | 'audio' | 'video')
                      : 'file',
                    localPath: prepared.filePath,
                    name: prepared.resource.name,
                    mimeType: prepared.resource.mimeType,
                  },
                ],
              },
              params.signal,
              undefined,
              `[文件] ${prepared.resource.name} · attachment:${prepared.resource.id}${caption ? `\n${caption}` : ''}`,
            )
            resourceSent = true
            // 外部投递已经成功，记录失败只能留下诊断，不能让模型重发。
            try {
              await this.ctx!.resources!.markDelivered(prepared.resource.id, agentId)
              if (!currentSocialRecovery()?.record.checkpoint.orchestration)
                await this.socialMessageRepo?.insert({
                  turnId: currentSocialRecovery()?.record.id,
                  msgId: `resource_${prepared.resource.id}`,
                  platform: platform,
                  accountId,
                  channelId,
                  channelType,
                  senderId: 'self',
                  senderName: agentId,
                  agentId,
                  content: `[文件] ${prepared.resource.name} · attachment:${prepared.resource.id}${caption ? `\n${caption}` : ''}`,
                })
              await this.ctx!.socialEvents?.publish('social_message', {
                platform: platform,
                channelId,
                direction: 'outbound',
                content: `[文件] ${prepared.resource.name}`,
              })
            } catch (error) {
              logger.warn(
                __t('apps.social.logs', '资源发送记录保存失败: {0}', [
                  error instanceof Error ? error.message : String(error),
                ]),
              )
            }
            return JSON.stringify({
              success: true,
              sent: true,
              resource: prepared.resource,
              reference: `attachment:${prepared.resource.id}`,
            })
          } catch (error) {
            if (
              deliveryAttempted &&
              !['DELIVERY_REJECTED', 'DELIVERY_NOT_SENT'].includes(
                (error as { code?: string } | null)?.code ?? '',
              )
            ) {
              resourceUnconfirmed = true
              return JSON.stringify({
                success: false,
                uncertain: true,
                error: '发送结果尚未确认，资源可能已送达；请用户确认后再重试',
              })
            }
            return JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
              code: (error as { code?: string }).code,
              rejected:
                !deliveryAttempted ||
                ['DELIVERY_REJECTED', 'DELIVERY_NOT_SENT'].includes(
                  (error as { code?: string }).code ?? '',
                ),
            })
          }
        })()
        sentResources.set(key, operation)
        return operation
      }
      if (name === 'social_status_card') {
        let deliveryAttempted = false
        if (
          !diaryAllowed ||
          params.triggerSenderId !== ownerId ||
          agentId !== this.socialAgentId ||
          !this.running ||
          !this.statusCards ||
          !this.socialBridge
        )
          return JSON.stringify({ success: false, error: '状态卡片仅对主人私聊开放' })
        try {
          const action = String(args.action ?? 'send')
          if (action === 'get_design')
            return JSON.stringify({
              success: true,
              design: await this.statusCards.getDesign(agentId),
            })
          if (action === 'save_design' || action === 'reset_design') {
            const design = await this.statusCards.saveDesign(
              agentId,
              action === 'reset_design' ? DEFAULT_STATUS_CARD_DESIGN : args.design,
            )
            return JSON.stringify({ success: true, design })
          }
          if (action !== 'send') return JSON.stringify({ success: false, error: '卡片操作无效' })
          if (cardSent) return JSON.stringify({ success: true, sent: true, terminal: true })
          const accountId = params.taskOrigin?.accountId || params.botSelfId
          if (!accountId || !adapter?.getConnectedAccountIds().includes(accountId))
            throw new Error('当前社交账号未连接')
          const image = await this.statusCards.render(
            agentId,
            args.design ?? (await this.statusCards.getDesign(agentId)),
          )
          // 发送目标来自本轮可信会话，工具参数不能改写接收人。
          if (params.triggerSenderId !== ownerId || agentId !== this.socialAgentId || !this.running)
            throw new Error('社交会话已停止或主人配置已变化')
          const s = image.snapshot
          const summary = `[状态卡片] ${s.deviceName} · ${s.capturedAt}；CPU ${s.cpu.percent === null ? '未提供' : `${Math.round(s.cpu.percent)}%`}；内存 ${(s.memory.usedBytes / 1024 ** 3).toFixed(1)} / ${(s.memory.totalBytes / 1024 ** 3).toFixed(1)} GB`
          deliveryAttempted = true
          await this.socialBridge.sendReply(
            platform,
            {
              accountId,
              channelId,
              channelType: 'private',
              content: '',
              attachments: [
                {
                  type: 'image',
                  url: `data:${image.mimeType};base64,${image.imageBase64}`,
                  mimeType: image.mimeType,
                },
              ],
            },
            params.signal,
            undefined,
            summary,
          )
          cardSent = true
          // 投递已成功，历史记录或前端广播失败不能导致工具重发图片。
          try {
            if (!currentSocialRecovery()?.record.checkpoint.orchestration)
              await this.socialMessageRepo?.insert({
                turnId: currentSocialRecovery()?.record.id,
                msgId: `card_${crypto.randomUUID()}`,
                platform: platform,
                channelId,
                channelType: 'private',
                senderId: 'self',
                senderName: agentId,
                content: summary,
                agentId,
              })
            await this.ctx!.socialEvents?.publish('social_message', {
              platform: platform,
              channelId,
              direction: 'outbound',
              content: summary,
            })
          } catch (error) {
            logger.warn(
              __t('apps.social.logs', '状态卡片发送记录保存失败: {0}', [
                error instanceof Error ? error.message : String(error),
              ]),
            )
          }
          return JSON.stringify({
            success: true,
            sent: true,
            capturedAt: image.snapshot.capturedAt,
            message: __t('apps.social.ui', '状态卡片已发送到当前会话'),
          })
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            code: (error as { code?: string }).code,
            rejected:
              !deliveryAttempted ||
              ['DELIVERY_REJECTED', 'DELIVERY_NOT_SENT'].includes(
                (error as { code?: string }).code ?? '',
              ),
            uncertain:
              deliveryAttempted &&
              !['DELIVERY_REJECTED', 'DELIVERY_NOT_SENT'].includes(
                (error as { code?: string }).code ?? '',
              ),
          })
        }
      }
      if (name === 'manage_task') {
        if (!taskAllowed || !params.taskOrigin)
          return JSON.stringify({ success: false, error: '任务控制仅对已绑定主人的私聊开放' })
        try {
          return JSON.stringify(
            await this.ctx!.taskControl!.execute(
              params.taskOrigin,
              args as unknown as import('@infos/shared').TaskControlInput,
              currentSocialRecovery()?.record.id +
                ':' +
                (currentSocialStep() ?? JSON.stringify(args)),
            ),
          )
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (name.startsWith('browser_')) {
        if (!taskAllowed || !params.taskOrigin || !this.ctx?.hostCapabilities)
          return JSON.stringify({ success: false, error: 'SOCIAL_HOST_CAPABILITY_DENIED' })
        return this.ctx.hostCapabilities.execute(params.taskOrigin, name, args, {
          callId: currentSocialStep() ?? `${currentSocialRecovery()?.record.id}:${name}`,
          threadId: realmSessionId,
          enableVision: model.enableVision === true,
          executionId: currentSocialRecovery()?.executionId,
          processId: currentSocialRecovery()?.processId,
          signal: operationScope.signal,
        })
      }
      if (name === 'social_read_diary' && !diaryAllowed) {
        return JSON.stringify({ success: false, error: '只有主人私聊可以读取当前角色的日记' })
      }
      if (name === 'update_flow_state') {
        const currentGoal = typeof args.current_goal === 'string' ? args.current_goal : undefined
        const privateFacts = typeof args.private_facts === 'string' ? args.private_facts : undefined
        if (currentGoal === undefined && privateFacts === undefined) {
          return JSON.stringify({
            success: false,
            error: '至少需要提供 current_goal 或 private_facts',
          })
        }
        const updated = await this.ctx!.flowStateService.updateRealm({
          realmId: this.ctx!.realm.descriptor.realmId,
          sessionId: realmSessionId,
          agentId,
          currentGoal,
          privateFacts,
        })
        return JSON.stringify({
          success: true,
          message: __t('apps.social.ui', '当前社交会话心流已更新'),
          revision: updated.revision,
        })
      }
      if (name === 'communicate_with_host') {
        if (!taskAllowed)
          return JSON.stringify({ success: false, error: 'SOCIAL_HOST_CAPABILITY_DENIED' })
        const mode = String(args.mode ?? 'consult') as
          | 'consult'
          | 'verify'
          | 'approval'
          | 'request_resource'
          | 'report'
          | 'clarify'
          | 'complete'
        return JSON.stringify(
          await this.ctx!.communicateWithHost({
            correlationId: crypto.randomUUID(),
            mode,
            summary: String(args.summary ?? ''),
            context:
              args.context && typeof args.context === 'object' && !Array.isArray(args.context)
                ? (args.context as Record<string, unknown>)
                : undefined,
          }),
        )
      }
      return this.toolExecutor
        ? this.toolExecutor(name, args)
        : JSON.stringify({ success: false, error: `工具执行器不可用: ${name}` })
    }
    const executeUncheckedScopedTool = async (
      name: string,
      args: Record<string, unknown>,
      callId?: string,
    ) => {
      if (!capabilityDefinitions.some((tool) => tool.function.name === name))
        return JSON.stringify({ success: false, error: '此工具未向当前会话开放' })
      if (SOCIAL_BUSINESS_TOOLS.includes(name as SocialBusinessTool)) {
        const result = await this.operations!.execute(
          name as SocialBusinessTool,
          args,
          {
            ...operationScope,
            callId: callId ? `${operationScope.callId}:${callId}` : operationScope.callId,
          },
          executeScopedTool,
        )
        return result
      }
      return executeScopedTool(name, args)
    }
    const scopedToolExecutor = async (
      name: string,
      args: Record<string, unknown>,
      callId?: string,
    ) => {
      params.signal?.throwIfAborted()
      const warning = toolCycleGuard.before(name, args)
      if (warning)
        return JSON.stringify({ success: false, code: 'TOOL_LOOP_WARNING', error: warning })
      const result = await executeUncheckedScopedTool(name, args, callId)
      let failed = false
      try {
        const value = JSON.parse(result) as { success?: boolean; error?: unknown } | null
        failed = value?.success === false || (value?.error !== undefined && value.error !== null)
      } catch {
        /* 非结构化结果不猜测失败，仅由稳定只读工具参与成功重复检测。 */
      }
      toolCycleGuard.observe(name, args, result, failed)
      return result
    }
    const recovery = currentSocialRecovery()
    if (!recovery || !this.socialBridge || !stickerAccountId)
      throw new Error('社交编排的持久化现场或发送账号尚未就绪')
    let actResult: SocialActResult | undefined
    const orchestration = new SocialOrchestration({
      assertAllowed: async () => {
        params.signal?.throwIfAborted()
        await this.loopGuard?.check(recovery.record)
      },
      accountId: stickerAccountId,
      channelId,
      channelType,
      isReadOnly: (name, args) =>
        isAgentBrowserRead(name, args) ||
        this.operations?.isReadOnly(operationScope, name, args) === true,
      triggerMessageId,
      triggerSenderId,
      available: (name, args) => {
        const definition = capabilityDefinitions.find((tool) => tool.function.name === name)
        if (!definition) return false
        if (!SOCIAL_BUSINESS_TOOLS.includes(name as SocialBusinessTool)) return true
        const properties = definition.function.parameters.properties as Record<
          string,
          { enum?: unknown[] }
        >
        return properties.action?.enum?.includes(args.action) === true
      },
      execute: scopedToolExecutor,
      send: (message, key) => this.socialBridge!.sendOrchestratedMessage(message, key),
      sendResource: (source, caption, key) =>
        runSocialStep(key, () => executeScopedTool('send_file', { source, caption })),
    })
    const scopedDefinitions = [socialActDefinition(capabilityDefinitions, this.ctx.agentManager.getOwnerAppellation(this.socialAgentId))]
    const replayMessages = () =>
      Object.values(
        (recovery.record.checkpoint.sentMessages as Record<
          string,
          {
            content: string
            sentAt: number
            messageId?: string
            channelId?: string
            channelType?: string
            accountId?: string
          }
        >) ?? {},
      )
        .filter(
          (message) =>
            (!message.channelId || message.channelId === channelId) &&
            (!message.channelType || message.channelType === channelType) &&
            (!message.accountId || message.accountId === stickerAccountId),
        )
        .sort((a, b) => a.sentAt - b.sentAt)
    params.signal?.throwIfAborted()
    await this.compiler.generateReply(compiled.messages, model, {
      replayScope: `social:${this.ctx.instanceId}:${JSON.stringify([platform, agentId, stickerAccountId ?? '', channelType, channelId])}`,
      replayCurrentKeys,
      replayReply: () =>
        replayMessages()
          .map((message) => message.content)
          .join('\n'),
      replayDeliveries: () =>
        replayMessages().flatMap((message) =>
          message.messageId
            ? [
                {
                  key: promptFingerprint([message.messageId, 'self', message.content]),
                  reply: message.content,
                },
              ]
            : [],
        ),
      usageContext: {
        agentId,
        channel: 'social',
        applicationId: 'social',
        threadId: `social:${realmSessionId}`,
      },
      signal: params.signal,
      beforeModelRequest: async (round) => {
        params.signal?.throwIfAborted()
        await this.loopGuard?.consume(
          recovery.record,
          'requests',
          `model:${round}`,
          socialRateGateOptions(recovery),
        )
      },
      currentMessageIndex: compiled.currentMessageIndex,
      historyMessageIndices: compiled.historyMessageIndices,
      tools: scopedDefinitions,
      orchestrationTool: 'social_act',
      toolExecutor: async (name, args, callId, context) => {
        if (name !== 'social_act')
          return JSON.stringify({ success: false, error: '请通过 social_act 的 call 步骤调用能力' })
        actResult = await orchestration.execute(
          args,
          callId ?? `act-${crypto.randomUUID()}`,
          context?.closing,
        )
        params.signal?.throwIfAborted()
        return JSON.stringify(actResult)
      },
    })
    params.signal?.throwIfAborted()
    actResult ??= orchestration.currentResult()
    if (compiled.variableCommit) await this.compiler.commitVariables(compiled.variableCommit)

    const deliveredReply = Object.values(
      (recovery.record.checkpoint.sentMessages as Record<
        string,
        { content: string; sentAt: number }
      >) ?? {},
    )
      .sort((a, b) => a.sentAt - b.sentAt)
      .map((message) => message.content)
      .join('\n')
    let outcome: SocialTurnOutcome
    if (actResult?.status === 'waiting') {
      outcome = {
        type: 'orchestration',
        wakeAt: actResult.wake_at!,
        expiresAt: actResult.expires_at!,
      }
    } else if (actResult?.status === 'completed') {
      const delivered =
        resourceSent ||
        cardSent ||
        actResult.delivered_messages.length > 0 ||
        Object.values(
          (recovery.record.checkpoint.deliveries ?? {}) as Record<string, string>,
        ).includes('sent')
      outcome = delivered
        ? { type: 'reply', content: deliveredReply, delivered: true }
        : { type: 'pass' }
    } else {
      throw new Error('社交回合尚未通过 social_act 提交参与行为，未发送普通文字')
    }

    this.stats.messagesProcessed++
    if (
      cardSent ||
      resourceSent ||
      (outcome.type === 'reply' && (outcome.delivered || outcome.content.trim()))
    )
      this.stats.repliesSent++

    this.ctx.emitEvent({
      type: 'progress',
      instanceId: this.ctx.instanceId,
      progress: 0,
      message:
        outcome.type === 'reply'
          ? __t('apps.social.ui', '已生成频道 {0} 的回复：{1}', [
              channelId,
              outcome.content.slice(0, 50),
            ])
          : __t('apps.social.ui', '频道 {0} 选择 {1}', [channelId, outcome.type.toUpperCase()]),
      timestamp: new Date().toISOString(),
    })

    return outcome
  }

  /** 获取平台适配器列表（仅用于装配与管理） */
  getAdapters(): readonly AbstractSocialAdapter[] {
    return this.adapters
  }

  async onPause(): Promise<void> {
    invalidatePromptReplay(this.ctx ? `social:${this.ctx.instanceId}:` : 'social:')
    this.running = false
    this.releaseSocialTransport?.()
    this.releaseSocialTransport = undefined
    this.lifetime.abort(new Error('社交应用已暂停'))
    await this.adapterUpdates.catch(() => {})
    for (const agentId of this.socialScorerRunning) this.socialScorer?.cancel(agentId)
    // 暂停时停止调度器（SocialBridge.stop 会停止调度器和适配器）
    if (this.socialBridge) {
      await this.socialBridge.stop()
    }
    this.ctx?.logger.info(__t('apps.social.logs', '社交应用已暂停'))
  }

  async onResume(): Promise<void> {
    this.lifetime = new AbortController()
    await this.onConfigChanged(['social'])
    this.running = true
    // 恢复时重新启动 SocialBridge
    if (this.socialBridge) {
      await this.socialBridge.start(this.lifetime.signal)
    }
    this.publishTransports()
    this.ctx?.logger.info(__t('apps.social.logs', '社交应用已恢复'))
  }

  async onStop(): Promise<AppCheckpoint | undefined> {
    this.stopped = true
    this.running = false
    this.lifetime.abort(new Error('社交应用已停止'))
    await this.adapterUpdates.catch(() => {})
    invalidatePromptReplay(this.ctx ? `social:${this.ctx.instanceId}:` : 'social:')
    this.operations?.close()
    for (const agentId of this.socialScorerRunning) this.socialScorer?.cancel(agentId)
    this.releaseSocialTransport?.()
    this.releaseSocialTransport = undefined

    // 停止 SocialBridge（含调度器 + 适配器断开）
    if (this.socialBridge) {
      await this.socialBridge.stop()
    }

    // 注销全局桥接与工具 Provider，避免应用停止后保留失效引用
    setSocialMessagingProvider(null)
    this.releaseTaskDelivery?.()
    this.releaseTaskDelivery = undefined
    setSocialModeControlProvider(null)
    setSocialImageReaderProvider(null)
    setSocialDiaryReaderProvider(null)
    setSocialContactMemoryProvider(null)

    // 撤销资源授权（仅 persona）
    await this.revokeGrants()

    this.ctx?.logger.info(__t('apps.social.logs', '社交应用已停止'))

    return this.getCheckpoint()
  }

  getCheckpoint(): AppCheckpoint | undefined {
    if (!this.ctx) return undefined

    const connectedPlatforms = this.adapters.map((adapter) => adapter.platform)

    return {
      instanceId: this.ctx.instanceId,
      appId: this.ctx.appId,
      status: this.running ? 'running' : 'completed',
      summary: `社交应用${this.running ? '运行中' : '已停止'}，已处理 ${this.stats.messagesProcessed} 条消息，发送 ${this.stats.repliesSent} 条回复`,
      progress: this.running ? 0.5 : 1,
      fields: {
        connectedPlatforms,
        activeSessions: this.socialBridge?.listSessions().length ?? 0,
        messagesProcessed: this.stats.messagesProcessed,
        repliesSent: this.stats.repliesSent,
      },
      changedArtifacts: [],
      blockers: [],
      nextActions: [],
      updatedAt: new Date().toISOString(),
    }
  }

  // ── 会话管理（supportsMultipleSessions=false，但内部维护多频道历史）──

  async createSession(_params?: { title?: string }): Promise<string> {
    // 社交应用不通过此接口创建会话，会话由入站消息自动创建
    return this.ctx?.instanceId ?? 'unknown'
  }

  async listSessions(): Promise<Array<{ id: string; title: string; status: string }>> {
    return (this.socialBridge?.listSessions() ?? []).map((session) => ({
      id: JSON.stringify([
        session.platform,
        session.agentId,
        session.accountId,
        session.channelType,
        session.channelId,
      ]),
      title: `${session.platform} · ${session.channelType === 'private' ? __t('apps.social.ui', '私聊') : __t('apps.social.ui', '群聊')} ${session.channelId}`,
      status: `${session.participation}:${session.phase}`,
    }))
  }

  private resolveSession(sessionId: string) {
    const sessions = this.socialBridge?.listSessions() ?? []
    const matches = sessions.filter(
      (session) =>
        JSON.stringify([
          session.platform,
          session.agentId,
          session.accountId,
          session.channelType,
          session.channelId,
        ]) === sessionId ||
        `${session.agentId}:${session.channelType}:${session.channelId}` === sessionId,
    )
    return matches.length === 1 ? matches[0] : undefined
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const selected = this.resolveSession(sessionId)
    if (!selected || !this.socialBridge) return false
    return (
      this.socialBridge.closeSessionsExcept(
        (session) =>
          session.platform !== selected.platform ||
          session.agentId !== selected.agentId ||
          session.accountId !== selected.accountId ||
          session.channelType !== selected.channelType ||
          session.channelId !== selected.channelId,
      ) > 0
    )
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const session = this.resolveSession(sessionId)
    if (!session?.platform || !this.socialBridge) throw new Error('SOCIAL_SESSION_UNAVAILABLE')
    await this.socialBridge.sendReply(session.platform, {
      accountId: session.accountId,
      channelId: session.channelId,
      channelType: session.channelType,
      content,
    })
  }

  subscribeSession(_sessionId: string, _handler: (event: AppEvent) => void): () => void {
    // TODO: 应用内部事件流订阅
    return () => {}
  }

  async executeCommand(request: AppCommandRequest): Promise<AppCommandResult> {
    if (request.action === 'get_task' || request.action === 'cancel_task') {
      const id = String(request.input.task_id ?? '')
      const turn = await this.socialMessageRepo?.getTurn(id)
      if (!turn || turn.kind !== 'task' || turn.agentId !== (request.agentId ?? this.socialAgentId))
        return {
          correlationId: request.correlationId,
          status: 'failed',
          summary: __t('apps.social.ui', '社交任务不存在或角色绑定已改变'),
        }
      if (request.action === 'cancel_task') await this.socialBridge?.cancelTurn(id)
      const latest = (await this.socialMessageRepo?.getTurn(id)) ?? turn
      return {
        correlationId: request.correlationId,
        status:
          latest.status === 'completed'
            ? 'completed'
            : ['running', 'waiting', 'retrying'].includes(latest.status)
              ? 'waiting'
              : 'failed',
        summary:
          latest.status === 'completed'
            ? latest.commandResult?.content || __t('apps.social.ui', '社交委派已完成')
            : latest.error || __t('apps.social.ui', '社交委派正在执行或等待'),
        output: {
          taskId: id,
          state: latest.status,
          ...latest.commandResult,
          orchestration: latest.orchestrationSummary,
        },
      }
    }
    // 宿主只可委派任务，不能绕过社交会话权限直接执行内部业务工具。
    if (request.action !== 'chat_in_group') {
      return {
        correlationId: request.correlationId,
        status: 'failed',
        summary: '不支持的社交动作',
        error: request.action,
      }
    }
    if (!this.ctx || !this.socialBridge || !this.socialMessageRepo) {
      return { correlationId: request.correlationId, status: 'failed', summary: '社交应用尚未就绪' }
    }
    const groupId = String(request.input.group_id ?? '').trim()
    if (!groupId) {
      return { correlationId: request.correlationId, status: 'failed', summary: '缺少目标群号' }
    }
    const intent = String(request.input.intent ?? '自然参与当前话题，不强行开启无关话题')
    const outcome = await this.socialBridge.runCommand(
      request.correlationId,
      this.socialAgentId,
      groupId,
      `【主 Agent 委派的单次社交任务】${intent}\n请结合群聊近期记录判断如何自然参与；通过 social_act 提交回复、PASS 或必要的编排。`,
      this.ownerFor(
        typeof request.input.platform === 'string' ? request.input.platform : undefined,
      ) || 'host',
      typeof request.input.platform === 'string' ? request.input.platform : undefined,
      typeof request.input.account_id === 'string' ? request.input.account_id : undefined,
      request.signal,
      request.executionId && request.processId
        ? { executionId: request.executionId, processId: request.processId }
        : undefined,
    )
    if (outcome.type === 'orchestration')
      return {
        correlationId: request.correlationId,
        status: 'waiting',
        summary: __t('apps.social.ui', '社交编排已接收，正在后台等待后续步骤'),
        output: {
          sent: false,
          scheduled: true,
          groupId,
          wakeAt: outcome.wakeAt,
          taskId: `${SOCIAL_DELEGATED_TURN_PREFIX}${createHash('sha256').update(request.correlationId).digest('hex')}`,
        },
      }
    if (outcome.type !== 'reply') {
      return {
        correlationId: request.correlationId,
        status: 'completed',
        summary: '社交 Agent 判断本次无需发言',
        output: { sent: false, groupId },
      }
    }
    const reply = outcome.content.trim()

    return {
      correlationId: request.correlationId,
      status: 'completed',
      summary: `已在群 ${groupId} 完成一次自然参与`,
      output: { sent: true, groupId, content: reply },
    }
  }

  // ── 记忆回流 ──

  /**
   * 获取社交应用在某日产生的记忆摘要列表
   *
   * 实现 AIOS 记忆回流通道：从 social.tdb 读取当日 SocialScorer 炼化的
   * Event 节点（零向量 + payload），返回其 content 字段作为摘要。
   *
   * 这些摘要会被主 Agent 的 DiaryEngine 聚合，与桌面对话摘要合并后
   * 生成带向量的日记节点，从而让社交信息通过日记回流到主 Agent 的 RAG。
   *
   * 设计要点：
   * - social.tdb 的 Event 节点是零向量（省 embedding 开销），不能直接被 RAG 检索
   * - 但通过日记这个"带向量的载体"，社交信息最终可被主 Agent 检索
   * - 主 Agent 不直接读 social.tdb，只消费此方法返回的字符串列表（解耦）
   *
   * @param date ISO 日期字符串（如 "2026-08-08"）
   * @returns 当日社交 Event 的摘要列表
   */
  async getDailySummaries(date: string): Promise<string[]> {
    if (!this.ctx?.storeRegistry) return []
    if (!(await this.socialMessageRepo?.memoryAvailable(this.socialAgentId))) return []

    const summaries: string[] = []
    try {
      const store = this.ctx.storeRegistry.getAgentStore(this.socialAgentId, 'social')
      if (store.nodeCount() === 0) return []

      // 计算当日 00:00 的 Unix 秒数（本地时区）
      const dayStart = new Date(`${date}T00:00:00`)
      const dayStartSec = Math.floor(dayStart.getTime() / 1000)
      const dayEnd = new Date(dayStart)
      dayEnd.setDate(dayEnd.getDate() + 1)
      const dayEndSec = Math.floor(dayEnd.getTime() / 1000)

      // 遍历所有节点，筛选当日 Event 节点
      for (const id of store.allNodeIds()) {
        const node = store.get(id)
        if (!node) continue

        const payload = node.payload as Record<string, unknown>
        if (payload?.type !== 'event') continue

        const ts = (payload?.timestamp as number) ?? 0
        if (ts >= dayStartSec && ts < dayEndSec) {
          const content = (payload?.content as string) ?? ''
          if (content) summaries.push(content)
        }
      }
    } catch (err) {
      logger.warn(__t('apps.social.logs', '读取社交当日记忆摘要失败: {0}', [err]))
    }

    return summaries
  }
}

// ─────────────────────────────────────────────
// 内置应用运行时工厂
// ─────────────────────────────────────────────

/**
 * 应用运行时工厂函数
 *
 * Backend通过受信任的内置Runtime注册表创建SocialAppRuntime实例。
 */
export default function createRuntime(): AgentAppRuntime {
  return new SocialAppRuntime()
}
