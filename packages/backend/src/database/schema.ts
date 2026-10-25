/**
 * Drizzle ORM Schema 定义
 *
 * 数据库 Schema 定义，表名遵循 snake_case 复数。
 * 列名 snake_case。
 *
 * @module packages/backend/src/database/schema
 */

import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/** 每日用户牌与角色回应分开保存，切换角色仍沿用当天用户牌。 */
export const tarotDays = sqliteTable('tarot_days', {
  day: text('day').primaryKey(),
  timeZone: text('time_zone').notNull(),
  question: text('question').notNull(),
  userCardJson: text('user_card_json').notNull(),
  createdAt: text('created_at').notNull(),
})
export const tarotReadings = sqliteTable(
  'tarot_readings',
  {
    id: text('id').primaryKey(),
    day: text('day')
      .notNull()
      .references(() => tarotDays.day, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    readingJson: text('reading_json').notNull(),
    persona: text('persona').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_tarot_day_agent').on(table.day, table.agentId),
    index('idx_tarot_agent_created').on(table.agentId, table.createdAt),
  ],
)

/** 独立于聊天历史的调用账本，不保存提示词、输出或密钥。时间统一使用 UTC 毫秒。 */
export const llmUsageRecords = sqliteTable(
  'llm_usage_records',
  {
    id: text('id').primaryKey(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at').notNull(),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    agentId: text('agent_id'),
    purpose: text('purpose').notNull(),
    status: text('status').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    cachedReadTokens: integer('cached_read_tokens'),
    cachedWriteTokens: integer('cached_write_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    channel: text('channel'),
    threadId: text('thread_id'),
    applicationId: text('application_id'),
    executionId: text('execution_id'),
    step: integer('step'),
    promptHash: text('prompt_hash'),
    prefixHash: text('prefix_hash'),
    toolsHash: text('tools_hash'),
  },
  (table) => [
    index('idx_llm_usage_started').on(table.startedAt),
    index('idx_llm_usage_agent_started').on(table.agentId, table.startedAt),
    index('idx_llm_usage_channel_started').on(table.channel, table.startedAt),
  ],
)

/** 每个 Thread 保留计划历史，当前计划由未归档记录确定。 */
export const taskPlans = sqliteTable(
  'task_plans',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    agentId: text('agent_id').notNull(),
    taskId: text('task_id'),
    taskRevision: integer('task_revision'),
    revision: integer('revision').default(1).notNull(),
    title: text('title').notNull(),
    status: text('status').default('active').notNull(),
    stepsJson: text('steps_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_task_plans_thread').on(table.threadId, table.createdAt)],
)

/** 计划变更按对话轮次留存前后快照，用于失败与消息撤回。 */
export const taskPlanMutations = sqliteTable(
  'task_plan_mutations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    threadId: text('thread_id').notNull(),
    agentId: text('agent_id').notNull(),
    pairId: text('pair_id').notNull(),
    callId: text('call_id'),
    beforeJson: text('before_json').notNull(),
    afterJson: text('after_json').notNull(),
    status: text('status').default('active').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_task_plan_mutations_thread_pair').on(table.threadId, table.pairId)],
)

/** 文档原文与整理状态是持久权威源；文本镜像和检索索引均可由这里重建。 */
export const knowledgeDocuments = sqliteTable(
  'knowledge_documents',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    sourceKind: text('source_kind').notNull(),
    source: text('source').default('').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    tokenCount: integer('token_count').notNull(),
    revision: integer('revision').default(1).notNull(),
    status: text('status').default('queued').notNull(),
    vectorStatus: text('vector_status').default('skipped').notNull(),
    modelName: text('model_name'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_knowledge_document_status').on(table.status, table.updatedAt)],
)

export const knowledgeParts = sqliteTable(
  'knowledge_parts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    keywordsJson: text('keywords_json').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    tokenCount: integer('token_count').notNull(),
    embeddingJson: text('embedding_json'),
    embeddingKey: text('embedding_key'),
  },
  (table) => [uniqueIndex('uq_knowledge_part_ordinal').on(table.documentId, table.ordinal)],
)

// ─────────────────────────────────────────────
// Observer Service与Agent State派生资源
// ─────────────────────────────────────────────

export const observerProcessedEvents = sqliteTable('observer_processed_events', {
  eventId: text('event_id').primaryKey(),
  processedAt: text('processed_at').notNull(),
})

export const agentStateMeasurements = sqliteTable(
  'agent_state_measurements',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    metric: text('metric').notNull(),
    value: real('value').notNull(),
    confidence: real('confidence').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    sourceEventType: text('source_event_type').notNull(),
    explanation: text('explanation').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_agent_state_source_metric').on(table.sourceEventId, table.metric),
    index('idx_agent_state_agent_observed').on(table.agentId, table.observedAt),
  ],
)

export const observerPolicies = sqliteTable('observer_policies', {
  agentId: text('agent_id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  injectContext: integer('inject_context', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
})

// ─────────────────────────────────────────────
// 逻辑微内核事件 Outbox
// ─────────────────────────────────────────────

/** 领域事务提交后等待发布的 Durable Event。 */
export const kernelOutboxEvents = sqliteTable(
  'kernel_outbox_events',
  {
    eventId: text('event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    durability: text('durability').default('durable').notNull(),
    principalId: text('principal_id').notNull(),
    processId: text('process_id'),
    executionId: text('execution_id'),
    correlationId: text('correlation_id'),
    causationId: text('causation_id'),
    objectType: text('object_type'),
    objectId: text('object_id'),
    objectGeneration: integer('object_generation'),
    payloadJson: text('payload_json').notNull(),
    occurredAt: text('occurred_at').notNull(),
    status: text('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    nextAttemptAt: text('next_attempt_at'),
    createdAt: text('created_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
    publishedAt: text('published_at'),
  },
  (table) => [
    index('idx_kernel_outbox_status_created').on(table.status, table.createdAt),
    index('idx_kernel_outbox_execution').on(table.executionId, table.createdAt),
    index('idx_kernel_outbox_correlation').on(table.correlationId),
  ],
)

// ─────────────────────────────────────────────
// Resource Foundation
// ─────────────────────────────────────────────

/** 可审计 Asset 元数据；文件正文保存在专用 Store。 */
export const kernelAssets = sqliteTable(
  'kernel_assets',
  {
    assetId: text('asset_id').primaryKey(),
    objectType: text('object_type').default('asset').notNull(),
    objectGeneration: integer('object_generation').default(1).notNull(),
    ownerPrincipalId: text('owner_principal_id').notNull(),
    kind: text('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    source: text('source').notNull(),
    storageRef: text('storage_ref').notNull(),
    retention: text('retention').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_kernel_assets_owner').on(table.ownerPrincipalId, table.createdAt),
    index('idx_kernel_assets_sha256').on(table.sha256),
  ],
)

/** Transfer Kernel Object 的持久元数据。 */
export const kernelTransfers = sqliteTable(
  'kernel_transfers',
  {
    transferId: text('transfer_id').primaryKey(),
    objectGeneration: integer('object_generation').default(1).notNull(),
    direction: text('direction').notNull(),
    state: text('state').notNull(),
    sourceRefJson: text('source_ref_json'),
    destinationRefJson: text('destination_ref_json'),
    bytesTotal: integer('bytes_total'),
    bytesTransferred: integer('bytes_transferred').default(0).notNull(),
    checksum: text('checksum'),
    resultAssetRefJson: text('result_asset_ref_json'),
    principalId: text('principal_id').notNull(),
    processId: text('process_id'),
    executionId: text('execution_id'),
    correlationId: text('correlation_id').notNull(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_kernel_transfers_principal').on(table.principalId, table.createdAt),
    index('idx_kernel_transfers_state').on(table.state, table.createdAt),
    index('idx_kernel_transfers_execution').on(table.executionId, table.createdAt),
  ],
)

// ─────────────────────────────────────────────
// 对话系统
// ─────────────────────────────────────────────

/**
 * Thread 表 — 交互线程
 *
 * 替代旧版 Session 概念。每个 Thread 是主 Agent 与用户（或外部平台）的一次交互线程。
 * channel 是 Thread 的持久属性，创建时确定，不可变。
 * channel 决定该 Thread 的 ContextPolicy 和 MemoryPolicy。
 */
export const threads = sqliteTable(
  'threads',
  {
    id: text('id').primaryKey(),
    /** 归属的主 Agent */
    agentId: text('agent_id').notNull(),
    /** 对话场景：desktop / social / group */
    channel: text('channel').notNull().default('desktop'),
    /** 外部平台标识（social/group 专用）：qq / discord / webhook */
    platform: text('platform'),
    /** 外部平台的会话标识（群号 / 用户QQ号等） */
    platformIdentifier: text('platform_identifier'),
    /** Thread 标题（自动生成或用户命名） */
    title: text('title').default(''),
    /** 消息数量（冗余计数，加速查询） */
    messageCount: integer('message_count').default(0),
    /** 聊天对数量（pairCount，用于 Dashboard 统计） */
    pairCount: integer('pair_count').default(0),
    /** 最后一条消息时间 */
    lastMessageAt: text('last_message_at'),
    /** Thread 状态 */
    status: text('status').default('active'),
    /**
     * ContextPolicy（JSON 序列化的 ChannelPolicy）
     * null 表示使用 DEFAULT_POLICIES 中该 channel 的默认策略
     * 非空时覆盖默认策略，允许 Thread 级别自定义上下文窗口/记忆检索等行为
     */
    contextPolicy: text('context_policy'),
    /** Thread 级禁用工具列表（JSON 字符串）；只能屏蔽 Channel 已允许工具，不能扩权。 */
    disabledToolsJson: text('disabled_tools_json').default('[]').notNull(),
    interactionMode: text('interaction_mode')
      .$type<'minimal' | 'chat' | 'work'>()
      .default('chat')
      .notNull(),
    /** 自动执行模式仅跳过可审批决策，不跳过拒绝、终端与越界删除审批。 */
    autoExecuteTools: integer('auto_execute_tools', { mode: 'boolean' }).default(false).notNull(),
    executionMode: text('execution_mode').default('manual').notNull(),
    /** 空值跟随全局主模型；删除模型卡片时恢复默认。 */
    modelConfigId: integer('model_config_id').references(() => aiModelConfigs.id, {
      onDelete: 'set null',
    }),
    reasoningEffort: text('reasoning_effort').$type<import('@infos/shared').ReasoningEffort>(),
    /**
     * M05 §3.2: Thread 用途：conversation / background_task
     * 普通聊天为 conversation；后台任务使用 background_task 与聊天历史隔离
     */
    purpose: text('purpose').default('conversation'),
    /** 创建时间 */
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
    /** 更新时间 */
    updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [
    index('idx_threads_agent_id').on(table.agentId),
    index('idx_threads_channel').on(table.channel),
    index('idx_threads_platform').on(table.platform),
    index('idx_threads_status').on(table.status),
    index('idx_threads_purpose').on(table.purpose),
  ],
)

export const flowStates = sqliteTable(
  'flow_states',
  {
    threadId: text('thread_id').notNull(),
    agentId: text('agent_id').notNull(),
    currentGoal: text('current_goal').default('').notNull(),
    privateFacts: text('private_facts').default('').notNull(),
    revision: integer('revision').default(1).notNull(),
    updatedByPairId: text('updated_by_pair_id'),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_flow_states_thread_agent').on(table.threadId, table.agentId),
    index('idx_flow_states_thread_id').on(table.threadId),
  ],
)

/** 心流修订记录：用于对话回滚时恢复 Agent 当时的私有临时状态。 */
export const flowStateRevisions = sqliteTable(
  'flow_state_revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    threadId: text('thread_id').notNull(),
    agentId: text('agent_id').notNull(),
    pairId: text('pair_id'),
    beforeCurrentGoal: text('before_current_goal').default('').notNull(),
    beforePrivateFacts: text('before_private_facts').default('').notNull(),
    afterCurrentGoal: text('after_current_goal').default('').notNull(),
    afterPrivateFacts: text('after_private_facts').default('').notNull(),
    createdAt: text('created_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
  },
  (table) => [
    index('idx_flow_revisions_thread_id').on(table.threadId),
    index('idx_flow_revisions_pair_id').on(table.pairId),
  ],
)

// ─────────────────────────────────────────────
// M05 统一任务中心
// ─────────────────────────────────────────────

/**
 * 后台任务表 — 持久业务实体（区别于 RuntimeStateService 的短生命周期 TaskState）
 *
 * 生命周期遵循 M05 §4 状态机：
 * queued → running ⇄ paused / waiting_input → completed / failed / cancelled
 *
 * 每个任务显式绑定 agentId + 独立 background_task Thread，
 * 不随前台 activeAgentId 变化（M05 §1 核心原则）。
 */
export const backgroundTasks = sqliteTable(
  'background_tasks',
  {
    id: text('id').primaryKey(),
    /** 任务执行者（显式指定，不读取全局 activeAgent） */
    agentId: text('agent_id').notNull(),
    /** 任务专属 Thread（purpose='background_task'） */
    threadId: text('thread_id').notNull(),
    /** send_to_chat 时的原聊天 Thread */
    targetThreadId: text('target_thread_id'),
    /** 任务标题（用户可读） */
    title: text('title').notNull(),
    /** 派发给 Agent 的原始指令 */
    instruction: text('instruction').notNull(),
    /** 用户意图修订；执行器只能提交自己开始时的版本。 */
    revision: integer('revision').default(1).notNull(),
    /** 长期目标、交接摘要、等待条件、预算与来源。 */
    lifecycleJson: text('lifecycle_json'),
    /** 任务状态：queued/running/paused/waiting_input/completed/failed/cancelled */
    status: text('status').default('queued').notNull(),
    /** 进度百分比 0-100（Agent 主动上报，null 表示未知） */
    progress: integer('progress'),
    /** 当前阶段描述（如"检索资料中"） */
    currentStage: text('current_stage'),
    /** 最终结果摘要 */
    result: text('result'),
    /** 失败原因 */
    errorMessage: text('error_message'),
    /** 工具调用次数（冗余计数） */
    toolCallCount: integer('tool_call_count').default(0).notNull(),
    /** 优先级 1-10（越小越优先，默认 5） */
    priority: integer('priority').default(5).notNull(),
    /** 父任务 ID；受限委派、结果交接和取消沿此关系传递。 */
    parentTaskId: text('parent_task_id'),
    /** 任务来源：user / agent / scheduler / runtime */
    requestedBy: text('requested_by').default('user').notNull(),
    /** 完成后行为：notify / open_result / send_to_chat */
    completionAction: text('completion_action').default('notify').notNull(),
    /** 任务类别：agent_task / resident；resident 仅供任务中心只读展示。 */
    category: text('category').default('agent_task').notNull(),
    /** 待用户输入的问题。 */
    inputQuestion: text('input_question'),
    /** 待用户输入上下文（JSON）。 */
    inputContextJson: text('input_context_json'),
    /** M05-A2: ReAct 中断存档（JSON，续跑时重放已成功步骤） */
    checkpointJson: text('checkpoint_json'),
    /** 扩展元数据 */
    metadataJson: text('metadata_json').default('{}').notNull(),
    /** 创建时间 */
    createdAt: text('created_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
    /** 开始执行时间 */
    startedAt: text('started_at'),
    /** 完成/失败/取消时间 */
    completedAt: text('completed_at'),
    /** 更新时间 */
    updatedAt: text('updated_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
    /** 历史记录阅读时间；null 表示未读。 */
    readAt: text('read_at'),
  },
  (table) => [
    index('idx_background_tasks_agent_id').on(table.agentId),
    index('idx_background_tasks_status').on(table.status),
    index('idx_background_tasks_thread_id').on(table.threadId),
    index('idx_background_tasks_target_thread_id').on(table.targetThreadId),
    index('idx_background_tasks_created_at').on(table.createdAt),
  ],
)

/** 任务通知按渠道投递；发送结果不明时保留 uncertain，避免自动重复外部副作用。 */
export const taskDeliveries = sqliteTable(
  'task_deliveries',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    channel: text('channel').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: text('next_attempt_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_task_deliveries_pending').on(table.status, table.nextAttemptAt)],
)

/** 自治应用调用与结果交付记录；任务执行状态仍由子应用持有。 */
export const applicationCalls = sqliteTable(
  'application_calls',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    agentId: text('agent_id').notNull(),
    threadId: text('thread_id').notNull(),
    requestJson: text('request_json').notNull(),
    runId: text('run_id'),
    state: text('state').notNull().default('submitting'),
    revision: integer('revision').notNull().default(0),
    messageId: integer('message_id'),
    deliveryStatus: text('delivery_status').notNull().default('pending'),
    resultJson: text('result_json'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_application_calls_run').on(table.appId, table.runId),
    index('idx_application_calls_owner').on(table.agentId, table.createdAt),
  ],
)

/**
 * Thread 消息表 — 不可变事件流
 *
 * 消息一旦写入，内容不可修改。编辑通过新增 revision 实现。
 * 删除通过软删除（status=deleted）实现，不物理删除。
 * pairId 把"用户提问 + Agent回复"绑成一个可操作单元。
 */
export const threadMessages = sqliteTable(
  'thread_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 所属 Thread */
    threadId: text('thread_id').notNull(),
    /** 消息角色 */
    role: text('role').notNull(), // user | assistant | system | tool
    /** 消息正文 */
    content: text('content').notNull(),
    /** 原始转写（含 Thinking 块，仅 assistant） */
    rawContent: text('raw_content'),
    /** 消息状态：active / deleted */
    status: text('status').default('active'),
    /** pairId：用户消息和对应回复共享同一 pairId */
    pairId: text('pair_id'),
    /** 发送者 ID（群聊场景：谁说的） */
    senderId: text('sender_id'),
    /** 消息 revision（编辑时递增，默认 1） */
    revision: integer('revision').default(1),
    /** 归属 Agent（群聊多 Agent 场景：谁回复的） */
    agentId: text('agent_id'),
    /** 元数据（model、tokenUsage、toolCalls 等） */
    metadataJson: text('metadata_json').default('{}'),
    /**
     * Scorer 处理状态（AIOS: 替代 conversation_logs.scorer_status）
     * - pending: 待 Scorer 提炼
     * - analyzed: 已提炼为记忆
     * - failed: 提炼失败
     * - skipped: 跳过（如纯工具调用消息）
     * 仅 assistant 消息会有此状态，user 消息通过 pairId 关联
     */
    scorerStatus: text('scorer_status').default('pending'),
    /** 消息时间 */
    timestamp: text('timestamp').default(sql`(datetime('now', 'localtime'))`),
    /** 删除时间（软删除标记） */
    deletedAt: text('deleted_at'),
    /** 删除者 */
    deletedBy: text('deleted_by'),
  },
  (table) => [
    index('idx_thread_messages_thread_id').on(table.threadId),
    index('idx_thread_messages_pair_id').on(table.pairId),
    index('idx_thread_messages_status').on(table.status),
    index('idx_thread_messages_agent_id').on(table.agentId),
    // AIOS: Scorer 查询待处理对话对的索引
    index('idx_thread_messages_scorer_status').on(table.scorerStatus),
  ],
)

/**
 * 文件变更快照表
 *
 * 按 pairId（对话轮次）和 filePath 合并同一轮对同一文件的多次修改：
 * originalContent/originalSha256 始终保留该轮首次修改前的状态，
 * finalSha256 与 callId 随后续工具调用持续更新。
 * operation 预留 modify/create/delete/rename，renameTargetPath 用于重命名目标。
 */
export const fileChangeSnapshots = sqliteTable(
  'file_change_snapshots',
  {
    id: text('id').primaryKey(),
    /** 所属 Thread */
    threadId: text('thread_id').notNull(),
    /** 对话轮次 ID */
    pairId: text('pair_id').notNull(),
    /** 最近一次更新该快照的工具调用 ID */
    callId: text('call_id').notNull(),
    /** 文件路径（同一轮内作为合并键） */
    filePath: text('file_path').notNull(),
    /** 操作类型：modify/create/delete/rename */
    operation: text('operation').notNull().default('modify'),
    /** 重命名后的目标路径，仅 operation=rename 时使用 */
    renameTargetPath: text('rename_target_path'),
    /** 该轮首次修改前的文件内容；创建文件时为 null */
    originalContent: text('original_content'),
    /** 该轮首次修改前的内容哈希；创建文件时为 null */
    originalSha256: text('original_sha256'),
    /** 当前最终内容哈希；删除文件时为 null */
    finalSha256: text('final_sha256'),
    /** 同轮写入历史是否连续；null 表示旧记录缺少校验依据。 */
    historyContinuous: integer('history_continuous', { mode: 'boolean' }).default(true),
    createdAt: text('created_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_file_change_snapshots_pair_file').on(table.pairId, table.filePath),
    index('idx_file_change_snapshots_thread_id').on(table.threadId),
    index('idx_file_change_snapshots_pair_id').on(table.pairId),
    index('idx_file_change_snapshots_call_id').on(table.callId),
  ],
)

export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    messageId: integer('message_id'),
    kind: text('kind').notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    contextPolicy: text('context_policy').notNull().default('once'),
    status: text('status').notNull().default('uploaded'),
    extractedText: text('extracted_text'),
    tokenEstimate: integer('token_estimate'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
    boundAt: text('bound_at'),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    index('idx_message_attachments_message_id').on(table.messageId),
    index('idx_message_attachments_thread_id').on(table.threadId),
    index('idx_message_attachments_status').on(table.status),
  ],
)

/**
 * Thread 摘要表 — 滚动摘要
 *
 * @deprecated 已废弃（2026-08-05 决策）。超出上下文窗口的早期消息由长记忆系统兜底，
 * 不再生成滚动摘要。保留 schema 仅为兼容已有数据库迁移，运行时不再读写。
 * 决策详见 .docs/archived/03-context-runtime.md 第 0 节。
 */
export const threadSummaries = sqliteTable(
  'thread_summaries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 所属 Thread */
    threadId: text('thread_id').notNull(),
    /** 摘要内容 */
    content: text('content').notNull(),
    /** 覆盖的消息 ID 列表（JSON 数组） */
    coversMessageIds: text('covers_message_ids').default('[]'),
    /** 摘要 revision（随着覆盖范围变化递增） */
    revision: integer('revision').default(1),
    /** 是否过期（覆盖的消息被删除/编辑后标记 stale） */
    isStale: integer('is_stale', { mode: 'boolean' }).default(false),
    /** 创建时间 */
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [
    index('idx_thread_summaries_thread_id').on(table.threadId),
    index('idx_thread_summaries_stale').on(table.isStale),
  ],
)

/** 对话日志表（旧版兼容，保留数据迁移用） */
export const conversationLogs = sqliteTable(
  'conversation_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    source: text('source').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    rawContent: text('raw_content'),
    timestamp: text('timestamp').default(sql`(datetime('now', 'localtime'))`),
    metadataJson: text('metadata_json').default('{}'),
    pairId: text('pair_id'),

    // Scorer 元数据
    sentiment: text('sentiment'),
    importance: integer('importance'),
    memoryId: integer('memory_id'),

    // Scorer 状态
    analysisStatus: text('analysis_status').default('pending'),
    retryCount: integer('retry_count').default(0),
    lastError: text('last_error'),

    agentId: text('agent_id').notNull().default('pero'),
  },
  (table) => [
    index('idx_conversation_logs_session_id').on(table.sessionId),
    index('idx_conversation_logs_source').on(table.source),
    index('idx_conversation_logs_pair_id').on(table.pairId),
    index('idx_conversation_logs_agent_id').on(table.agentId),
  ],
)

// ─────────────────────────────────────────────
// Agent / 宠物状态
// ─────────────────────────────────────────────

// 无需 DB 表。

/** 会话角色状态变更日志；撤回记录阻止在途工具重新写回。 */
export const threadCharacterStateEvents = sqliteTable(
  'thread_character_state_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    threadId: text('thread_id').notNull(),
    agentId: text('agent_id').notNull(),
    kind: text('kind', { enum: ['update', 'retract', 'clear'] }).notNull(),
    pairId: text('pair_id'),
    toolCallId: text('tool_call_id'),
    patchJson: text('patch_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_thread_character_state_scope').on(table.threadId, table.agentId, table.id),
    uniqueIndex('idx_thread_character_state_call').on(
      table.threadId,
      table.agentId,
      table.toolCallId,
    ),
  ],
)

/** 旧全局宠物状态表，仅保留兼容数据，不作为新会话状态来源。 */
export const petStates = sqliteTable(
  'pet_states',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull().default('pero'),
    mood: text('mood').default('开心'),
    vibe: text('vibe').default('活泼'),
    mind: text('mind').default('正在发呆...'),
    clickMessagesJson: text('click_messages_json').default('{}'),
    idleMessagesJson: text('idle_messages_json').default('[]'),
    backMessagesJson: text('back_messages_json').default('[]'),
    /** finish_task 追加的临时台词过期时间；为空表示没有有效临时台词。 */
    textExpiresAt: text('text_expires_at'),
    updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [index('idx_pet_states_agent_id').on(table.agentId)],
)

// ─────────────────────────────────────────────
// 模型与语音配置
// ─────────────────────────────────────────────

/** 可复用的服务商连接，同品牌可保存多个独立实例。 */
export const providerConnections = sqliteTable('provider_connections', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  brand: text('brand').notNull(),
  protocol: text('protocol').notNull().default('openai'),
  apiBase: text('api_base').notNull().default(''),
  authMode: text('auth_mode').notNull().default('api_key'),
  apiKey: text('api_key').notNull().default(''),
})

/** AI 模型卡配置表 */
export const aiModelConfigs = sqliteTable(
  'ai_model_configs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    modelId: text('model_id').notNull(),
    provider: text('provider').default('openai'),
    providerType: text('provider_type').default('global'),
    providerConnectionId: text('provider_connection_id').references(() => providerConnections.id, {
      onDelete: 'restrict',
    }),
    connectionOverride: integer('connection_override', { mode: 'boolean' })
      .notNull()
      .default(false),
    connectionProtocol: text('connection_protocol'),
    connectionAuthMode: text('connection_auth_mode').notNull().default('api_key'),
    apiKey: text('api_key'),
    apiBase: text('api_base'),
    temperature: real('temperature'),
    topP: real('top_p'),
    maxTokens: integer('max_tokens'),
    /** 模型完整上下文窗口，用于输入预算计算，不等同于最大输出 Token。 */
    contextWindowTokens: integer('context_window_tokens'),
    maxReActTurns: integer('max_react_turns'),
    reasoningEffort: text('reasoning_effort'),
    returnNativeReasoning: integer('return_native_reasoning', { mode: 'boolean' }).default(false),
    wireApi: text('wire_api').default('chat_completions'),
    reasoningDialect: text('reasoning_dialect').default('auto'),
    stream: integer('stream', { mode: 'boolean' }).default(true),
    enableVision: integer('enable_vision', { mode: 'boolean' }).default(false),
    enableAudioInput: integer('enable_audio_input', { mode: 'boolean' }).default(false),
    enableVoice: integer('enable_voice', { mode: 'boolean' }).default(false),
    enableVideo: integer('enable_video', { mode: 'boolean' }).default(false),
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [uniqueIndex('uq_ai_model_configs_name').on(table.name)],
)

// 无需独立表。

// ─────────────────────────────────────────────
// 群聊 / 据点
// ─────────────────────────────────────────────

/** 群聊房间表 */
export const groupChatRooms = sqliteTable('group_chat_rooms', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
  creatorId: text('creator_id').notNull(),
})

/** 群聊成员表 */
export const groupChatMembers = sqliteTable(
  'group_chat_members',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    roomId: text('room_id').notNull(),
    agentId: text('agent_id').notNull(),
    joinedAt: text('joined_at').default(sql`(datetime('now', 'localtime'))`),
    role: text('role').default('member'),
  },
  (table) => [
    index('idx_group_chat_members_room_id').on(table.roomId),
    index('idx_group_chat_members_agent_id').on(table.agentId),
  ],
)

/** 群聊消息表 */
export const groupChatMessages = sqliteTable(
  'group_chat_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    roomId: text('room_id').notNull(),
    senderId: text('sender_id').notNull(),
    content: text('content').notNull(),
    role: text('role').notNull(),
    timestamp: text('timestamp').default(sql`(datetime('now', 'localtime'))`),
    mentionsJson: text('mentions_json').default('[]'),
    /** pairId：用户本轮发言与其全部 Agent/system 回复共享同一关联键。 */
    pairId: text('pair_id'),
    updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [
    index('idx_group_chat_messages_room_id').on(table.roomId),
    index('idx_group_chat_messages_sender_id').on(table.senderId),
    index('idx_group_chat_messages_pair_id').on(table.pairId),
  ],
)

// ─────────────────────────────────────────────
// 据点系统
// ─────────────────────────────────────────────

/** 据点设施表 */
export const strongholdFacilities = sqliteTable('stronghold_facilities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
})

/** 据点房间表 (关联设施 + 群聊房间) */
export const strongholdRooms = sqliteTable(
  'stronghold_rooms',
  {
    /** 与 groupChatRooms.id 相同，实现 1:1 关联 */
    id: text('id').primaryKey(),
    facilityId: integer('facility_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** 允许进入的 Agent 列表 (JSON 数组, 空=全部允许) */
    allowedAgentsJson: text('allowed_agents_json').default('[]'),
    /** 环境变量 (JSON 对象: 光照/温度/音乐等) */
    environmentJson: text('environment_json').default('{}'),
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [index('idx_stronghold_rooms_facility_id').on(table.facilityId)],
)

/** 据点角色对完整群聊回合的亲历关系；仅记录可见性，不复制消息正文。 */
export const strongholdAgentPairVisibility = sqliteTable(
  'stronghold_agent_pair_visibility',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    roomId: text('room_id').notNull(),
    pairId: text('pair_id').notNull(),
    observedAt: text('observed_at').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [
    uniqueIndex('uq_stronghold_agent_pair_visibility').on(table.agentId, table.pairId),
    index('idx_stronghold_visibility_agent_observed').on(table.agentId, table.observedAt),
    index('idx_stronghold_visibility_pair').on(table.pairId),
  ],
)

/** Agent 位置表 (当前在哪个房间) */
export const agentLocations = sqliteTable('agent_locations', {
  agentId: text('agent_id').primaryKey(),
  roomId: text('room_id').notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
})

/** 管家配置表 */
export const butlerConfigs = sqliteTable('butler_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().default('Butler'),
  persona: text('persona'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
})

// ─────────────────────────────────────────────
// 社交消息
// ─────────────────────────────────────────────

/**
 * 社交消息表
 *
 * 存储来自外部平台 (QQ/Discord/...) 的原始消息，
 * 与 conversationLogs (Agent 对话对) 互补:
 * - socialMessages: 记录平台上 **所有人** 说的话 (含非 Agent 回复)
 * - conversationLogs: 只记录 Agent 参与的对话对 (source='social')
 */
export const socialMessages = sqliteTable(
  'social_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 平台消息 ID */
    msgId: text('msg_id').notNull(),
    /** 平台名称 (qq / discord / ...) */
    platform: text('platform').notNull().default('qq'),
    /** 平台账号 ID（多账号同步与去重使用） */
    accountId: text('account_id').notNull().default(''),
    /** 会话 ID (群号 / 用户 QQ 号) */
    channelId: text('channel_id').notNull(),
    /** 会话类型 */
    channelType: text('channel_type').notNull(),
    /** 发送者 ID */
    senderId: text('sender_id').notNull(),
    /** 发送者显示名 */
    senderName: text('sender_name').default(''),
    /** 消息正文 (已清洗) */
    content: text('content').notNull(),
    /** 关联的 Agent ID */
    agentId: text('agent_id').notNull().default('pero'),
    /** 原始平台事件 JSON (调试用) */
    rawEventJson: text('raw_event_json').default('{}'),
    /** 消息时间 */
    timestamp: text('timestamp').default(sql`(datetime('now', 'localtime'))`),
    /** 是否已被社交 Scorer 总结 (v1: QQMessage.is_summarized) */
    isSummarized: integer('is_summarized', { mode: 'boolean' }).default(false),
  },
  (table) => [
    index('idx_social_messages_channel').on(table.channelId, table.channelType),
    index('idx_social_messages_agent').on(table.agentId),
    index('idx_social_messages_timestamp').on(table.timestamp),
    index('idx_social_messages_unsummarized').on(table.isSummarized, table.agentId),
    uniqueIndex('idx_social_messages_platform_message').on(
      table.agentId,
      table.platform,
      table.accountId,
      table.channelType,
      table.channelId,
      table.msgId,
    ),
  ],
)

export const socialContactImpressions = sqliteTable(
  'social_contact_impressions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    platform: text('platform').notNull().default('qq'),
    userId: text('user_id').notNull(),
    displayName: text('display_name').default('').notNull(),
    identity: text('identity').default('').notNull(),
    impression: text('impression').notNull(),
    sourceChannelId: text('source_channel_id'),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_social_contact_impressions_scope').on(
      table.agentId,
      table.platform,
      table.userId,
    ),
    index('idx_social_contact_impressions_user').on(table.userId),
  ],
)

export const socialHistoryTombstones = sqliteTable(
  'social_history_tombstones',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    platform: text('platform').notNull(),
    accountId: text('account_id').notNull().default(''),
    channelType: text('channel_type').notNull().default('*'),
    channelId: text('channel_id').notNull().default('*'),
    deletedBefore: integer('deleted_before').notNull(),
    createdAt: text('created_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_social_history_tombstone_scope').on(
      table.agentId,
      table.platform,
      table.accountId,
      table.channelType,
      table.channelId,
    ),
  ],
)

export const socialSyncCursors = sqliteTable(
  'social_sync_cursors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    platform: text('platform').notNull(),
    accountId: text('account_id').notNull(),
    lastSuccessfulSyncAt: integer('last_successful_sync_at').notNull().default(0),
    syncStartedAt: integer('sync_started_at'),
    status: text('status').notNull().default('idle'),
    lastError: text('last_error'),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now', 'localtime'))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_social_sync_cursor_scope').on(table.agentId, table.platform, table.accountId),
  ],
)

// ─────────────────────────────────────────────
// 任务调度 / 配置 / 运维
// ─────────────────────────────────────────────

/** 定时任务表 */
export const scheduledTasks = sqliteTable(
  'scheduled_tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    time: text('time').notNull(),
    content: text('content').notNull(),
    isTriggered: integer('is_triggered', { mode: 'boolean' }).default(false),
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
    agentId: text('agent_id').notNull().default('pero'),
    status: text('status').notNull().default('pending'),
    threadId: text('thread_id'),
    planId: text('plan_id'),
    planStepId: text('plan_step_id'),
    reason: text('reason'),
    sourceExecutionId: text('source_execution_id'),
    claimToken: text('claim_token'),
    leaseUntil: text('lease_until'),
    nextAttemptAt: text('next_attempt_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    taskId: text('task_id'),
    settledAt: text('settled_at'),
    /** 固定间隔周期计划；空值表示一次性任务。 */
    repeatIntervalMinutes: integer('repeat_interval_minutes'),
  },
  (table) => [
    index('idx_scheduled_tasks_agent_id').on(table.agentId),
    index('idx_scheduled_tasks_due').on(table.status, table.time),
  ],
)

/** Agent 提出的行动建议；采纳后关联唯一后台任务。 */
export const proactiveSuggestions = sqliteTable(
  'proactive_suggestions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    threadId: text('thread_id').notNull(),
    title: text('title').notNull(),
    instruction: text('instruction').notNull(),
    reason: text('reason').notNull(),
    sourceExecutionId: text('source_execution_id'),
    status: text('status').notNull().default('open'),
    taskId: text('task_id'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (table) => [index('idx_proactive_suggestions_agent_status').on(table.agentId, table.status)],
)

/** 全局键值配置表 */
export const configs = sqliteTable('configs', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
})

/** MCP 服务器配置表 */
export const mcpConfigs = sqliteTable(
  'mcp_configs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type').default('stdio'),
    command: text('command'),
    args: text('args').default('[]'),
    env: text('env').default('{}'),
    url: text('url'),
    enabled: integer('enabled', { mode: 'boolean' }).default(true),
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [uniqueIndex('uq_mcp_configs_name').on(table.name)],
)

// ─────────────────────────────────────────────
// 新版事件记忆系统
// ─────────────────────────────────────────────

export const eventNotes = sqliteTable(
  'event_notes',
  {
    id: text('id').primaryKey(),
    tdbId: integer('tdb_id').notNull(),
    agentId: text('agent_id').notNull(),
    narrative: text('narrative').notNull(),
    eventAt: text('event_at').notNull(),
    createdAt: text('created_at').notNull(),
    importance: integer('importance').notNull(),
    affectJson: text('affect_json').notNull(),
    participantsJson: text('participants_json').notNull().default('[]'),
    placesJson: text('places_json').notNull().default('[]'),
    objectsJson: text('objects_json').notNull().default('[]'),
    topicsJson: text('topics_json').notNull().default('[]'),
    originJson: text('origin_json').notNull(),
    status: text('status').notNull().default('active'),
    replacedBy: text('replaced_by'),
  },
  (table) => [
    uniqueIndex('uq_event_notes_tdb_id').on(table.tdbId),
    index('idx_event_notes_agent_event').on(table.agentId, table.eventAt),
    index('idx_event_notes_agent_status').on(table.agentId, table.status),
  ],
)

export const eventNoteCoverages = sqliteTable(
  'event_note_coverages',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    threadId: text('thread_id').notNull(),
    pairIdsJson: text('pair_ids_json').notNull(),
    messageIdsJson: text('message_ids_json').notNull(),
    outcome: text('outcome').notNull(),
    eventNoteIdsJson: text('event_note_ids_json').notNull().default('[]'),
    mode: text('mode').notNull(),
    coveredAt: text('covered_at').notNull(),
    invalidatedAt: text('invalidated_at'),
  },
  (table) => [
    index('idx_event_coverages_agent_thread').on(table.agentId, table.threadId),
    index('idx_event_coverages_thread_active').on(table.threadId, table.invalidatedAt),
  ],
)

export const eventMemoryCoverageClaims = sqliteTable(
  'event_memory_coverage_claims',
  {
    agentId: text('agent_id').notNull(),
    threadId: text('thread_id').notNull(),
    pairId: text('pair_id').notNull(),
    ownerId: text('owner_id').notNull(),
    claimedAt: text('claimed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.threadId, table.pairId] }),
    index('idx_event_coverage_claim_owner').on(table.ownerId),
  ],
)

export const eventMemoryOperations = sqliteTable(
  'event_memory_operations',
  {
    operationId: text('operation_id').primaryKey(),
    agentId: text('agent_id').notNull(),
    operation: text('operation').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    committedAt: text('committed_at'),
  },
  (table) => [index('idx_event_operations_status').on(table.status, table.createdAt)],
)

export const eventMemoryRelations = sqliteTable(
  'event_memory_relations',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    sourceId: text('source_id').notNull(),
    targetId: text('target_id').notNull(),
    relation: text('relation').notNull(),
    weight: real('weight').notNull().default(1),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_event_relation_triple').on(table.sourceId, table.targetId, table.relation),
    index('idx_event_relations_agent').on(table.agentId, table.relation),
  ],
)

export const eventMemoryDailyNoteTasks = sqliteTable(
  'event_memory_daily_note_tasks',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    date: text('date').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    sourceIncomplete: integer('source_incomplete', { mode: 'boolean' }).notNull().default(false),
    writtenFilesJson: text('written_files_json').notNull().default('[]'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_event_daily_note_agent_date').on(table.agentId, table.date),
    index('idx_event_daily_note_due').on(table.status, table.nextAttemptAt),
  ],
)

export const eventMemoryReflectionTasks = sqliteTable(
  'event_memory_reflection_tasks',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    eventId: text('event_id').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_event_reflection_task_event').on(table.agentId, table.eventId),
    index('idx_event_reflection_task_status').on(table.status, table.updatedAt),
  ],
)

export const eventMemoryQueryAudits = sqliteTable(
  'event_memory_query_audits',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    mode: text('mode').notNull(),
    queryJson: text('query_json').notNull(),
    resultCount: integer('result_count').notNull(),
    returnedTokens: integer('returned_tokens').notNull(),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    queriedAt: text('queried_at').notNull(),
  },
  (table) => [index('idx_event_query_audits_agent_time').on(table.agentId, table.queriedAt)],
)

export const eventMemoryTimers = sqliteTable('event_memory_timers', {
  key: text('key').primaryKey(),
  elapsedSeconds: integer('elapsed_seconds').notNull().default(0),
  checkpointAt: text('checkpoint_at').notNull(),
})

export const factMemoryOperations = sqliteTable(
  'fact_memory_operations',
  {
    operationId: text('operation_id').primaryKey(),
    operation: text('operation').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    committedAt: text('committed_at'),
  },
  (table) => [index('idx_fact_operations_status').on(table.status, table.createdAt)],
)

export const factObjects = sqliteTable(
  'fact_objects',
  {
    id: text('id').primaryKey(),
    tdbId: integer('tdb_id').notNull(),
    standardName: text('standard_name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    aliasesJson: text('aliases_json').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_fact_objects_tdb_id').on(table.tdbId),
    uniqueIndex('uq_fact_objects_normalized').on(table.normalizedName),
  ],
)

export const factRecords = sqliteTable(
  'fact_records',
  {
    id: text('id').primaryKey(),
    tdbId: integer('tdb_id').notNull(),
    objectId: text('object_id').notNull(),
    statement: text('statement').notNull(),
    status: text('status').notNull().default('active'),
    observedAt: text('observed_at').notNull(),
    createdAt: text('created_at').notNull(),
    source: text('source'),
    confidence: real('confidence'),
    createdByAgentId: text('created_by_agent_id').notNull(),
    supersededBy: text('superseded_by'),
  },
  (table) => [
    uniqueIndex('uq_fact_records_tdb_id').on(table.tdbId),
    index('idx_fact_records_object_status').on(table.objectId, table.status),
  ],
)

// ─────────────────────────────────────────────
// 节点能力注册（第七阶段）
// ─────────────────────────────────────────────

/**
 * NodeCapabilityRegistration 表 — 节点能力注册表
 *
 * Daemon 维护的"谁能提供什么能力"注册表。
 * Electron/Mobile/CLI 等节点启动时向 Daemon 注册自己的能力，
 * Daemon 调用平台工具时查此表找到提供者节点并转发调用。
 *
 * 节点离线时 status 标记为 offline，能力变为 unavailable。
 *
 * 设计见 .docs/archived/10-node-architecture.md §3
 */
export const nodeCapabilityRegistrations = sqliteTable(
  'node_capability_registrations',
  {
    /** 节点 ID（UUID，节点首次启动时生成并持久化） */
    nodeId: text('node_id').primaryKey(),
    /** 节点类型：electron / mobile / cli / remote-daemon */
    nodeType: text('node_type').notNull(),
    /** 远程节点的连接地址（本地节点为 null） */
    url: text('url'),
    /** 该节点能提供的能力列表（JSON 数组，如 ["screen_capture","desktop_notify"]） */
    capabilities: text('capabilities').notNull().default('[]'),
    /** 节点状态：online / offline */
    status: text('status').notNull().default('online'),
    /** 注册时间 */
    registeredAt: text('registered_at').default(sql`(datetime('now', 'localtime'))`),
    /** 最后心跳时间 */
    lastHeartbeat: text('last_heartbeat').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [
    index('idx_node_capability_registrations_status').on(table.status),
    index('idx_node_capability_registrations_type').on(table.nodeType),
  ],
)

/**
 * InboundRoute 表 — 入站路由表
 *
 * 替代"全局活跃 Agent"对外部消息的决定作用。
 * 外部消息（QQ/Discord/Webhook）进来时查此表，找到归属 Agent 和 channel。
 *
 * 设计见 .docs/archived/10-node-architecture.md §7
 */
export const inboundRoutes = sqliteTable(
  'inbound_routes',
  {
    /** 主键（UUID） */
    id: text('id').primaryKey(),
    /** 消息来源：qq_private / qq_group / discord / webhook / monitor */
    source: text('source').notNull(),
    /** 来源标识（QQ号、群号、webhook path 等） */
    identifier: text('identifier').notNull(),
    /** 归属 Agent ID */
    agentId: text('agent_id').notNull(),
    /** 创建什么类型的 Thread：desktop / social / group / companion */
    channel: text('channel').notNull().default('social'),
    /** 可选：固定到特定 Thread */
    threadId: text('thread_id'),
    /** 额外配置（JSON 对象） */
    config: text('config').default('{}'),
    /** 创建时间 */
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
    /** 更新时间 */
    updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
  },
  (table) => [
    index('idx_inbound_routes_source').on(table.source),
    index('idx_inbound_routes_agent').on(table.agentId),
    uniqueIndex('uq_inbound_routes_source_identifier').on(table.source, table.identifier),
  ],
)

// ─────────────────────────────────────────────
// Agent 应用层（AgentApplication + GrantRegistry）
// ─────────────────────────────────────────────

/**
 * 已安装应用注册表
 *
 * 记录所有已安装的 Agent 应用（官方自带 + 社区应用）。
 * 安装时扫描应用目录，读取 app.manifest.json，注册到此表。
 */
export const appRegistry = sqliteTable('app_registry', {
  /** 应用 ID（主键，如 'coding' / 'research'） */
  appId: text('app_id').primaryKey(),
  /** 显示名称 */
  name: text('name').notNull(),
  /** 版本号 */
  version: text('version').notNull(),
  /** 应用文件目录（绝对路径） */
  installPath: text('install_path').notNull(),
  /** 完整 Manifest 的 JSON 序列化 */
  manifestJson: text('manifest_json').notNull(),
  /** 安装时间 */
  installedAt: text('installed_at').default(sql`(datetime('now', 'localtime'))`),
  /** 更新时间 */
  updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
})

/**
 * 应用实例表
 *
 * 每次 launch 创建一条记录，记录实例状态与任务上下文。
 * 实例停止后保留记录（便于审计），可通过 listInstances 查询历史。
 */
export const appInstances = sqliteTable(
  'app_instances',
  {
    /** 实例 ID（UUID） */
    instanceId: text('instance_id').primaryKey(),
    /** 应用 ID */
    appId: text('app_id').notNull(),
    /** 启动此实例的主 Agent ID */
    hostAgentId: text('host_agent_id').notNull(),
    /** 当前状态：launching/running/paused/stopped/error */
    status: text('status').default('launching'),
    /** 工作区路径（dynamic 模式下用户指定） */
    workspacePath: text('workspace_path'),
    /** 任务上下文（JSON 序列化） */
    taskContextJson: text('task_context_json'),
    /** 启动方：user / host_agent */
    launchedBy: text('launched_by'),
    /** 启动时间 */
    launchedAt: text('launched_at').default(sql`(datetime('now', 'localtime'))`),
    /** 停止时间 */
    stoppedAt: text('stopped_at'),
    /** 错误信息（status='error' 时有值） */
    error: text('error'),
  },
  (table) => [
    index('idx_app_instances_host').on(table.hostAgentId, table.status),
    index('idx_app_instances_app').on(table.appId, table.status),
  ],
)

/**
 * 应用检查点表
 *
 * 每个实例最新检查点（一对一）。
 * 主 Agent 通过此表读取应用任务状态，不需要读取应用内部的所有消息。
 */
export const appCheckpoints = sqliteTable('app_checkpoints', {
  /** 实例 ID（主键，与 app_instances 一对一） */
  instanceId: text('instance_id').primaryKey(),
  /** 任务状态：running/waiting/completed/failed */
  status: text('status').notNull(),
  /** 摘要（人类可读） */
  summary: text('summary').notNull(),
  /** 完成进度（0-1） */
  progress: real('progress').default(0),
  /** 检查点字段（JSON，按 Manifest.checkpointSchema） */
  fieldsJson: text('fields_json').notNull(),
  /** 修改的产出物列表（JSON 数组） */
  changedArtifactsJson: text('changed_artifacts_json'),
  /** 阻塞问题（JSON 数组） */
  blockersJson: text('blockers_json'),
  /** 下一步行动（JSON 数组） */
  nextActionsJson: text('next_actions_json'),
  /** 更新时间 */
  updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`),
})

export const durableNotifications = sqliteTable(
  'durable_notifications',
  {
    notificationId: text('notification_id').primaryKey(),
    principalId: text('principal_id').notNull(),
    audienceJson: text('audience_json').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    level: text('level').default('info').notNull(),
    status: text('status').default('unread').notNull(),
    revision: integer('revision').default(1).notNull(),
    createdAt: text('created_at').notNull(),
    readAt: text('read_at'),
    metadataJson: text('metadata_json').default('{}').notNull(),
    expiresAt: text('expires_at'),
  },
  (table) => [
    index('idx_durable_notifications_principal_status').on(
      table.principalId,
      table.status,
      table.createdAt,
    ),
  ],
)

/** 跨重启保留的通知游标，不复用内存 Gateway 事件序号。 */
export const notificationFeed = sqliteTable('notification_feed', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  notificationId: text('notification_id')
    .notNull()
    .unique()
    .references(() => durableNotifications.notificationId, { onDelete: 'cascade' }),
})

export const notificationDeviceReceipts = sqliteTable(
  'notification_device_receipts',
  {
    deviceId: text('device_id').notNull(),
    notificationId: text('notification_id')
      .notNull()
      .references(() => durableNotifications.notificationId, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    receivedAt: text('received_at').notNull(),
    presentedAt: text('presented_at'),
    readAt: text('read_at'),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.notificationId] })],
)

export const subscriptionCursors = sqliteTable(
  'subscription_cursors',
  {
    streamId: text('stream_id').notNull(),
    consumerId: text('consumer_id').notNull(),
    sequence: integer('sequence').default(0).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.streamId, table.consumerId] })],
)

export const agentInputRequests = sqliteTable(
  'agent_input_requests',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    channel: text('channel').notNull(),
    sessionId: text('session_id').notNull(),
    threadId: text('thread_id').notNull(),
    taskId: text('task_id'),
    question: text('question').notNull(),
    context: text('context'),
    optionsJson: text('options_json').default('[]').notNull(),
    questionsJson: text('questions_json').default('[]').notNull(),
    answersJson: text('answers_json').default('[]').notNull(),
    allowFreeText: integer('allow_free_text', { mode: 'boolean' }).default(true).notNull(),
    required: integer('required', { mode: 'boolean' }).default(false).notNull(),
    status: text('status').notNull(),
    selectedOptionIdsJson: text('selected_option_ids_json').default('[]').notNull(),
    responseMessage: text('response_message'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (table) => [
    index('idx_agent_input_status').on(table.status, table.createdAt),
    index('idx_agent_input_thread').on(table.threadId, table.status),
    index('idx_agent_input_session').on(table.sessionId, table.status),
  ],
)

export const toolApprovalRequests = sqliteTable(
  'tool_approval_requests',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    channel: text('channel').notNull(),
    sessionId: text('session_id').notNull(),
    threadId: text('thread_id').notNull(),
    taskId: text('task_id'),
    toolName: text('tool_name').notNull(),
    argsSummaryJson: text('args_summary_json').notNull(),
    argsFingerprint: text('args_fingerprint').notNull(),
    reason: text('reason').notNull(),
    riskLevel: text('risk_level').default('low').notNull(),
    status: text('status').notNull(),
    decision: text('decision'),
    /** 用户决策附言（告知 Agent 同意/拒绝的理由，可选） */
    resolutionMessage: text('resolution_message'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (table) => [
    index('idx_tool_approval_status').on(table.status, table.expiresAt),
    index('idx_tool_approval_session').on(table.sessionId, table.toolName),
    index('idx_tool_approval_agent').on(table.agentId, table.toolName),
  ],
)

/** 工具审批审计事件只追加、不更新，用于追踪完整授权生命周期。 */
export const toolApprovalAuditLogs = sqliteTable(
  'tool_approval_audit_logs',
  {
    id: text('id').primaryKey(),
    approvalId: text('approval_id'),
    event: text('event').notNull(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull(),
    toolName: text('tool_name').notNull(),
    detailJson: text('detail_json').default('{}').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_tool_approval_audit_approval').on(table.approvalId),
    index('idx_tool_approval_audit_session').on(table.sessionId, table.createdAt),
  ],
)

/**
 * 资源授权表
 *
 * GrantRegistry 的持久化层。
 * 记录主 Agent 对应用/会话的资源访问授权（owner, holder, resource, permission）。
 * 授权的是"资源引用"，不是"编译后的上下文"。
 */
export const appResourceGrants = sqliteTable(
  'app_resource_grants',
  {
    /** Grant ID（UUID） */
    id: text('id').primaryKey(),
    /** 授权方（主 Agent ID） */
    ownerAgentId: text('owner_agent_id').notNull(),
    /** 被授权方（应用实例 ID 或应用内会话 ID） */
    holderId: text('holder_id').notNull(),
    /** 被授权方类型：app / app_session */
    holderType: text('holder_type').notNull(),
    /** 资源类型：memory/messages/workspace/persona/task */
    resourceKind: text('resource_kind').notNull(),
    /** 资源引用的 JSON 序列化 */
    resourceJson: text('resource_json').notNull(),
    /** 权限列表（逗号分隔：read,activate,derive,write） */
    permissions: text('permissions').notNull(),
    /** 授权来源：host_agent / user / auto */
    grantedBy: text('granted_by').default('host_agent'),
    /** 备注 */
    note: text('note'),
    /** 创建时间 */
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
    /** 过期时间（NULL = 永不过期） */
    expiresAt: text('expires_at'),
    /** 是否已撤销（0=有效, 1=已撤销） */
    revoked: integer('revoked').default(0),
    /** 撤销时间 */
    revokedAt: text('revoked_at'),
  },
  (table) => [
    index('idx_grants_holder').on(table.holderId, table.revoked),
    index('idx_grants_owner').on(table.ownerAgentId),
  ],
)
/** 用户预提交的消息队列；执行状态与历史消息分开持久化。 */
export const conversationQueueThreads = sqliteTable('conversation_queue_threads', {
  threadId: text('thread_id').primaryKey(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  reason: text('reason'),
})

export const conversationQueueItems = sqliteTable(
  'conversation_queue_items',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    revision: integer('revision').notNull().default(1),
    position: integer('position').notNull(),
    state: text('state').notNull().default('queued'),
    inputJson: text('input_json').notNull(),
    immediate: integer('immediate', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    error: text('error'),
    checkpointJson: text('checkpoint_json'),
  },
  (table) => [
    index('idx_conversation_queue_thread').on(table.threadId, table.state, table.position),
  ],
)
