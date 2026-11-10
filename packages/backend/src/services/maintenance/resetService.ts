import { t as __t } from '../../lib/i18n'
/**
 * ResetService — 危险区域重置服务
 *
 * 提供三种分级重置，入口要求确认短语：
 * - clearLogs()     清空记录与侧线，保留主线身份并推进代次
 * - resetMemories() 重置 EventNote、Coverage、Reflection、DailyNotes 与 Facts 账本
 * - factoryReset()  恢复出厂设置（清空全部用户数据）
 *
 * 说明：
 * - 角色定义（agent.json / mdp 目录）保存在磁盘，不受数据库重置影响。
 * - TDB 文件由 StoreRegistry 独立重置，本服务只负责 SQLite 完整备份与事务账本。
 *
 * @module packages/backend/src/services/maintenance/resetService
 */

import type { DrizzleDb } from '../../database'
import { sql, eq } from 'drizzle-orm'
import {
  threads,
  threadMessages,
  threadCharacterStateEvents,
  agentCharacterStateEvents,
  agentExperiences,
  conversationExecutions,
  conversationExpectations,
  conversationMessageSources,
  flowStates,
  flowStateRevisions,
  threadSummaries,
  conversationLogs,
  groupChatMessages,
  messageAttachments,
  fileChangeSnapshots,
  eventNotes,
  eventNoteCoverages,
  eventMemoryCoverageClaims,
  eventMemoryOperations,
  eventMemoryRelations,
  eventMemoryTimers,
  eventMemoryDailyNoteTasks,
  eventMemoryReflectionTasks,
  eventMemoryQueryAudits,
  factMemoryOperations,
  factObjects,
  factRecords,
  llmUsageRecords,
  applicationCalls,
  taskPlans,
  taskPlanMutations,
  tarotReadings,
  tarotDays,
  durableNotifications,
  notificationFeed,
  notificationDeviceReceipts,
  achievements,
  configs,
  homeRecords,
} from '../../database/schema'
import { createLogger } from '../../lib/logger'
import { disposeExecutionOwner } from '../../tools/productivityRuntimeHolder'
import { invalidatePromptReplay } from '../llm/promptCache'

const logger = createLogger('ResetService')

/** 重置结果 */
export interface ResetResult {
  operation: 'clear_logs' | 'reset_memories' | 'factory_reset'
  /** 实际清空的行数摘要 */
  cleared: Record<string, number>
}

export class ResetService {
  constructor(private readonly db: DrizzleDb) {}

  /** 清空对话记录（记忆与配置不受影响）。 */
  async clearLogs(variables?: { key: string; value: string }): Promise<ResetResult> {
    await disposeExecutionOwner({})
    invalidatePromptReplay(undefined, true)
    const cleared = this.db.transaction((tx) => {
      const counts: Record<string, number> = {}
      counts.threads = tx.delete(threads).where(eq(threads.threadKind, 'side')).run().changes
      tx.update(threads).set({
        generation: sql`${threads.generation} + 1`, messageCount: 0, pairCount: 0, lastMessageAt: null,
      }).run()
      const tables = [
        ['conversation_executions', conversationExecutions], ['conversation_expectations', conversationExpectations],
        ['conversation_message_sources', conversationMessageSources],
        ['thread_messages', threadMessages], ['thread_character_state_events', threadCharacterStateEvents],
        ['agent_experiences', agentExperiences], ['flow_states', flowStates],
        ['flow_state_revisions', flowStateRevisions], ['thread_summaries', threadSummaries],
        ['conversation_logs', conversationLogs], ['group_chat_messages', groupChatMessages],
        ['message_attachments', messageAttachments], ['file_change_snapshots', fileChangeSnapshots],
        ['task_plan_mutations', taskPlanMutations], ['task_plans', taskPlans],
      ] as const
      for (const [name, table] of tables) counts[name] = tx.delete(table).run().changes
      for (const name of ['expression_turn_versions', 'expression_state', 'expression_learning', 'expression_learning_batches'])
        counts[name] = tx.run(sql.raw(`DELETE FROM ${name}`)).changes
      // 通知正文同属对话派生数据，清空记录后不能再向离线手机补发。
      counts.conversation_notifications = tx.delete(durableNotifications).where(
        sql`json_extract(${durableNotifications.metadataJson}, '$.target.kind') = 'conversation'`,
      ).run().changes
      if (variables) tx.insert(configs).values(variables)
        .onConflictDoUpdate({ target: configs.key, set: { value: variables.value } }).run()
      return counts
    })
    logger.info(__t('logs.maintenance', '对话记录已清空: {0}', [JSON.stringify(cleared)]))
    return { operation: 'clear_logs', cleared }
  }

  /** 重置全部记忆（对话与配置不受影响）。 */
  async resetMemories(): Promise<ResetResult> {
    const tables = [
      ['event_memory_relations', eventMemoryRelations],
      ['event_memory_coverage_claims', eventMemoryCoverageClaims],
      ['event_note_coverages', eventNoteCoverages],
      ['event_memory_operations', eventMemoryOperations],
      ['event_memory_timers', eventMemoryTimers],
      ['event_memory_daily_note_tasks', eventMemoryDailyNoteTasks],
      ['event_memory_reflection_tasks', eventMemoryReflectionTasks],
      ['event_memory_query_audits', eventMemoryQueryAudits],
      ['event_notes', eventNotes],
      ['fact_memory_operations', factMemoryOperations],
      ['fact_records', factRecords],
      ['fact_objects', factObjects],
    ] as const
    // 清理失败必须抛出并保留恢复任务，不能把部分删除报告为成功。
    const cleared = this.db.transaction((tx) => {
      const counts: Record<string, number> = {}
      for (const [name, table] of tables) counts[name] = tx.delete(table).run().changes
      return counts
    })
    logger.info(__t('logs.maintenance', '记忆已重置: {0}', [JSON.stringify(cleared)]))
    return { operation: 'reset_memories', cleared }
  }

  /** 恢复出厂设置：清空全部用户数据（保留磁盘上的角色定义）。 */
  async factoryReset(): Promise<ResetResult> {
    await disposeExecutionOwner({})
    invalidatePromptReplay(undefined, true)
    // 先清空记忆/对话相关，再清空业务数据，最后清空配置与审批审计。
    // 使用显式表名映射，避免依赖 drizzle 内部 symbol 反射。
    const tables: Array<[string, Parameters<DrizzleDb['delete']>[0]]> = [
      ['home_records', homeRecords],
      ['achievements', achievements],
      ['notification_device_receipts', notificationDeviceReceipts],
      ['notification_feed', notificationFeed],
      ['durable_notifications', durableNotifications],
      ['tarot_readings', tarotReadings],
      ['tarot_days', tarotDays],
      ['llm_usage_records', llmUsageRecords],
      ['application_calls', applicationCalls],
      ['task_plan_mutations', taskPlanMutations],
      ['task_plans', taskPlans],
      ['event_memory_relations', eventMemoryRelations],
      ['event_memory_coverage_claims', eventMemoryCoverageClaims],
      ['event_note_coverages', eventNoteCoverages],
      ['event_memory_operations', eventMemoryOperations],
      ['event_memory_timers', eventMemoryTimers],
      ['event_memory_daily_note_tasks', eventMemoryDailyNoteTasks],
      ['event_memory_reflection_tasks', eventMemoryReflectionTasks],
      ['event_memory_query_audits', eventMemoryQueryAudits],
      ['event_notes', eventNotes],
      ['fact_memory_operations', factMemoryOperations],
      ['fact_records', factRecords],
      ['fact_objects', factObjects],
      ['threads', threads],
      ['thread_character_state_events', threadCharacterStateEvents],
      ['agent_character_state_events', agentCharacterStateEvents],
      ['agent_experiences', agentExperiences],
      ['conversation_executions', conversationExecutions],
      ['conversation_expectations', conversationExpectations],
      ['conversation_message_sources', conversationMessageSources],
      ['flow_states', flowStates],
      ['flow_state_revisions', flowStateRevisions],
      ['thread_messages', threadMessages],
      ['thread_summaries', threadSummaries],
      ['conversation_logs', conversationLogs],
      ['group_chat_messages', groupChatMessages],
      ['message_attachments', messageAttachments],
      ['file_change_snapshots', fileChangeSnapshots],
    ]
    const cleared = this.db.transaction((tx) => {
      const counts: Record<string, number> = {}
      for (const [name, table] of tables) counts[name] = tx.delete(table).run().changes
      for (const name of [
        'expression_mark_rules', 'expression_marks', 'expression_replies',
        'expression_turn_versions', 'expression_state', 'expression_learning',
        'expression_learning_batches', 'expression_handbook_versions',
        'expression_handbooks', 'expression_settings',
      ]) counts[name] = tx.run(sql.raw(`DELETE FROM ${name}`)).changes
      return counts
    })
    logger.info(__t('logs.maintenance', '出厂重置完成: {0}', [JSON.stringify(cleared)]))
    return { operation: 'factory_reset', cleared }
  }

}
