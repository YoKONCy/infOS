import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** 家领域按实体种类隔离；业务校验归服务，持久化与索引归仓储。 */
export const homeRecords = sqliteTable(
  'home_records',
  {
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.id] }),
    index('idx_home_records_scope').on(table.kind, table.agentId, table.sessionId, table.createdAt),
  ],
)
