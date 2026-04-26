CREATE TABLE IF NOT EXISTS recent_folders (
  path TEXT PRIMARY KEY,
  label TEXT,
  last_opened_at TEXT NOT NULL
);
