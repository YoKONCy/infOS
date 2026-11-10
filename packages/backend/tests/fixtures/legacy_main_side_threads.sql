-- 早期主侧会话结构，尚未引入连续交流的执行、发言和来源标识。
ALTER TABLE threads ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'side';
--> statement-breakpoint
ALTER TABLE threads ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_threads_main_agent ON threads(agent_id) WHERE thread_kind = 'main';
--> statement-breakpoint
CREATE TABLE agent_character_state_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  tool_call_id TEXT,
  patch_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_agent_character_state_order ON agent_character_state_events(agent_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_agent_character_state_call ON agent_character_state_events(agent_id, thread_id, generation, pair_id, tool_call_id);
--> statement-breakpoint
CREATE TABLE agent_experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  withdrawn INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_agent_experience_source ON agent_experiences(agent_id, source_message_id);
--> statement-breakpoint
CREATE INDEX idx_agent_experience_main ON agent_experiences(thread_id, generation, id);
--> statement-breakpoint
ALTER TABLE group_chat_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE group_chat_messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE INDEX idx_group_chat_reply_pending ON group_chat_messages(id) WHERE status = 'active' AND json_extract(metadata_json, '$.replyIntent.status') = 'pending';
