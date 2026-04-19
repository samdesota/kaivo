-- Phase 4 schema: built-in OpenCode agent sessions + transcript mirror.

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  opencode_session_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT agent_sessions_status_chk CHECK (status IN ('active','archived','unavailable'))
);

CREATE INDEX IF NOT EXISTS agent_sessions_sandbox_idx ON agent_sessions (sandbox_id);
CREATE INDEX IF NOT EXISTS agent_sessions_opencode_idx ON agent_sessions (opencode_session_id);

CREATE TABLE IF NOT EXISTS agent_transcripts (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  role TEXT NOT NULL,
  content_json JSONB NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS agent_transcripts_session_idx ON agent_transcripts (session_id);
