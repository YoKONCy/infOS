CREATE TABLE home_records (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT DEFAULT '' NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
--> statement-breakpoint
CREATE INDEX idx_home_records_scope ON home_records(kind, agent_id, session_id, created_at);
