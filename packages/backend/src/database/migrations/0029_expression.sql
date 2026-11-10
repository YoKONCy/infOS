CREATE TABLE expression_marks (
 id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 message_id INTEGER NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('good','robotic')), quote TEXT NOT NULL,
 note TEXT NOT NULL, rule_version TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX expression_marks_scope ON expression_marks(agent_id, thread_id, message_id);
--> statement-breakpoint
CREATE TABLE expression_rule (id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL);
--> statement-breakpoint
INSERT INTO expression_rule VALUES (1, 'expression-v1');
--> statement-breakpoint
CREATE TABLE expression_replies (
 message_id INTEGER PRIMARY KEY REFERENCES thread_messages(id) ON DELETE CASCADE,
 rule_version TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE expression_turn_versions (
 thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, pair_id TEXT NOT NULL,
 rule_version TEXT NOT NULL, recorded_at INTEGER NOT NULL,
 PRIMARY KEY(thread_id,agent_id,pair_id)
);
--> statement-breakpoint
CREATE TRIGGER expression_reply_version AFTER INSERT ON thread_messages WHEN NEW.role='assistant'
BEGIN
 INSERT INTO expression_replies(message_id,rule_version)
 SELECT NEW.id,COALESCE((SELECT rule_version FROM expression_turn_versions
 WHERE thread_id=NEW.thread_id AND agent_id=COALESCE(NEW.agent_id,(SELECT agent_id FROM threads WHERE id=NEW.thread_id))
 AND pair_id=COALESCE(NEW.execution_id,NEW.pair_id)),version) FROM expression_rule WHERE id=1;
END;
--> statement-breakpoint
CREATE TABLE expression_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
