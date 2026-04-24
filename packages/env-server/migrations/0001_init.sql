-- env-server initial schema.

CREATE TABLE IF NOT EXISTS env_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  env_token_hash TEXT,
  paired_at TEXT,
  opencode_port INTEGER,
  opencode_password_hash TEXT
);

-- Pairing request rows; short-lived. Cleared on successful pair.
CREATE TABLE IF NOT EXISTS pair_sessions (
  session_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Interactive shell sessions (human-attached PTYs). Run-once shells are
-- transient and not persisted.
CREATE TABLE IF NOT EXISTS shell_sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  owner_kind TEXT NOT NULL DEFAULT 'human'
    CHECK (owner_kind IN ('human','agent')),
  owner_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Repos cloned into workingDir. Identity holds the config templates;
-- this table tracks the per-env instantiation.
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  config_id TEXT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  origin_url TEXT NOT NULL,
  ref TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('github','url')),
  github_repo_id TEXT,
  github_full_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Background jobs (clone, restart, etc). Subset of the central jobs table.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','succeeded','failed','cancelled')),
  progress_pct INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
