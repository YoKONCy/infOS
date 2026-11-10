CREATE TABLE expression_handbooks (agent_id TEXT PRIMARY KEY NOT NULL, rules TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE expression_handbook_versions (
 id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL, reason TEXT NOT NULL,
 summary TEXT NOT NULL, created_at INTEGER NOT NULL, rules TEXT NOT NULL, mark_links TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX expression_handbook_versions_agent ON expression_handbook_versions(agent_id,created_at);
--> statement-breakpoint
CREATE TABLE expression_settings (scope TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE expression_learning (
 id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
 source_id TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 decision TEXT, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
 UNIQUE(agent_id,kind,source_id,fingerprint)
);
--> statement-breakpoint
CREATE TABLE expression_mark_rules (
 mark_id TEXT NOT NULL REFERENCES expression_marks(id) ON DELETE CASCADE,
 rule_id TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY(mark_id,rule_id)
);
