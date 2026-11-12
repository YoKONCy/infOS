import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** 生活实体各有稳定身份和修订，公开事件正文复用房间消息及亲历来源。 */
export const strongholdLifeRecords = sqliteTable('stronghold_life_records', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  roomId: text('room_id').notNull(),
  agentId: text('agent_id'),
  threadId: text('thread_id'),
  generation: integer('generation'),
  revision: integer('revision').notNull().default(1),
  sourceMessageId: integer('source_message_id'),
  sourcePairId: text('source_pair_id'),
  dataJson: text('data_json').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  index('idx_stronghold_life_room').on(table.roomId, table.kind),
  index('idx_stronghold_life_thread').on(table.threadId, table.generation),
  index('idx_stronghold_life_source').on(table.sourceMessageId),
])
