CREATE TABLE work_context_clears (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  pair_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  message_ids_json TEXT NOT NULL,
  execution_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_work_context_clear_thread ON work_context_clears(thread_id, generation);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_work_context_clear_call ON work_context_clears(thread_id, generation, pair_id, tool_call_id);
