DROP INDEX IF EXISTS idx_social_messages_platform_message;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_social_messages_platform_message ON social_messages(agent_id,platform,account_id,channel_type,channel_id,msg_id);
--> statement-breakpoint
ALTER TABLE social_turns ADD COLUMN platform TEXT NOT NULL DEFAULT 'qq';
--> statement-breakpoint
UPDATE social_turns SET platform=CASE WHEN json_valid(record_json) THEN COALESCE(json_extract(record_json,'$.platform'),json_extract(record_json,'$.checkpoint.inbound[0].platform'),'qq') ELSE 'qq' END;
--> statement-breakpoint
CREATE INDEX idx_social_turns_scope ON social_turns(agent_id,platform,account_id,channel_type,channel_id,status);
--> statement-breakpoint
ALTER TABLE social_data_fences ADD COLUMN platform TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE social_data_fences ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE social_inbox RENAME TO social_inbox_legacy;
--> statement-breakpoint
CREATE TABLE social_inbox (
  agent_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  PRIMARY KEY(agent_id,platform,account_id,channel_type,channel_id,msg_id)
);
--> statement-breakpoint
INSERT OR IGNORE INTO social_inbox(agent_id,platform,account_id,channel_type,channel_id,msg_id)
SELECT i.agent_id,m.platform,i.account_id,m.channel_type,m.channel_id,i.msg_id
FROM social_inbox_legacy i JOIN social_messages m ON m.agent_id=i.agent_id AND m.account_id=i.account_id AND m.msg_id=i.msg_id;
--> statement-breakpoint
DROP TABLE social_inbox_legacy;
