-- 旧批注按消息初始修订识别，已改写的来源留待用户重新确认。
ALTER TABLE expression_marks ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1;
