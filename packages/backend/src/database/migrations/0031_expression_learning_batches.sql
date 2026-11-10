CREATE TABLE expression_learning_new (
 id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL,
 revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 batch_id TEXT, first_at INTEGER NOT NULL, rule_ids TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, created_at INTEGER NOT NULL,
 UNIQUE(agent_id,kind,source_id,revision)
);
--> statement-breakpoint
INSERT INTO expression_learning_new(id,agent_id,kind,source_id,revision,fingerprint,status,first_at,attempts,last_error,created_at)
SELECT id,agent_id,kind,source_id,
 ROW_NUMBER() OVER (PARTITION BY agent_id,kind,source_id ORDER BY rowid),
 fingerprint,
 CASE WHEN status='pending' AND rowid<>MAX(rowid) OVER (PARTITION BY agent_id,kind,source_id) THEN 'superseded' ELSE status END,
 created_at,attempts,last_error,created_at
FROM expression_learning;
--> statement-breakpoint
UPDATE expression_learning_new SET rule_ids=(
 SELECT json_group_array(rule_id) FROM expression_mark_rules WHERE mark_id=expression_learning_new.source_id
) WHERE kind='mark' AND status='done' AND EXISTS (
 SELECT 1 FROM expression_mark_rules WHERE mark_id=expression_learning_new.source_id
);
--> statement-breakpoint
DROP TABLE expression_learning;
--> statement-breakpoint
ALTER TABLE expression_learning_new RENAME TO expression_learning;
--> statement-breakpoint
CREATE INDEX expression_learning_pending ON expression_learning(status,agent_id,first_at);
--> statement-breakpoint
CREATE TABLE expression_learning_batches (
 id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, base TEXT, decision TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, created_at INTEGER NOT NULL
);
