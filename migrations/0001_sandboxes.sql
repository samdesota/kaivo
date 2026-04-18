-- Phase 2 schema: sandboxes + shell sessions.

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  container_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  opencode_port INTEGER,
  opencode_password_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT sandboxes_status_chk CHECK (status IN ('active','archived','crashed'))
);

CREATE INDEX IF NOT EXISTS sandboxes_status_idx ON sandboxes (status);

CREATE TABLE IF NOT EXISTS shell_sessions (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shell_sessions_sandbox_idx ON shell_sessions (sandbox_id);
