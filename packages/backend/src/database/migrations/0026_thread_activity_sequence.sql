ALTER TABLE threads ADD activity_seq integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 旧记录无法还原同秒内的真实先后；只在升级时沿用原有排序，之后统一使用活动序号。
WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY updated_at, created_at, rowid) AS seq
  FROM threads
)
UPDATE threads SET activity_seq = (SELECT seq FROM ranked WHERE ranked.id = threads.id);
--> statement-breakpoint
-- 单行时钟不随会话删除回退；SQLite 写事务保证并发连接分配序号时不会重复。
CREATE TABLE thread_activity_clock (
  id integer PRIMARY KEY CHECK (id = 1),
  sequence integer NOT NULL
);
--> statement-breakpoint
INSERT INTO thread_activity_clock (id, sequence)
SELECT 1, coalesce(max(activity_seq), 0) FROM threads;
--> statement-breakpoint
CREATE TRIGGER threads_activity_insert AFTER INSERT ON threads
BEGIN
  UPDATE thread_activity_clock SET sequence = sequence + 1 WHERE id = 1;
  UPDATE threads SET activity_seq = (SELECT sequence FROM thread_activity_clock WHERE id = 1)
  WHERE id = NEW.id;
END;
--> statement-breakpoint
-- 覆盖现有更新时间入口及直接修改会话设置的写入；内部 activity_seq 更新不会再次触发。
CREATE TRIGGER threads_activity_update AFTER UPDATE OF
  updated_at, title, interaction_mode, execution_mode, auto_execute_tools,
  model_config_id, reasoning_effort, disabled_tools_json, context_policy,
  message_count, pair_count, last_message_at ON threads
BEGIN
  UPDATE thread_activity_clock SET sequence = sequence + 1 WHERE id = 1;
  UPDATE threads SET activity_seq = (SELECT sequence FROM thread_activity_clock WHERE id = 1)
  WHERE id = NEW.id;
END;
