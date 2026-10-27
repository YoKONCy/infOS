CREATE TABLE achievements (
  subject_id TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  steam_account_id TEXT,
  steam_submitted_at TEXT,
  PRIMARY KEY(subject_id, achievement_id)
);
