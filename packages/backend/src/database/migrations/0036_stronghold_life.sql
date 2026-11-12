CREATE TABLE stronghold_life_records (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  room_id TEXT NOT NULL,
  agent_id TEXT,
  thread_id TEXT,
  generation INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  source_message_id INTEGER,
  source_pair_id TEXT,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_stronghold_life_room ON stronghold_life_records(room_id, kind);
--> statement-breakpoint
CREATE INDEX idx_stronghold_life_thread ON stronghold_life_records(thread_id, generation);
--> statement-breakpoint
CREATE INDEX idx_stronghold_life_source ON stronghold_life_records(source_message_id);
