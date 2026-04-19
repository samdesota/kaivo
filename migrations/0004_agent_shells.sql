-- Phase 5 schema: agent-owned shell sessions + auth tokens.

ALTER TABLE shell_sessions
  ADD COLUMN IF NOT EXISTS owner_kind TEXT NOT NULL DEFAULT 'human';
ALTER TABLE shell_sessions
  ADD COLUMN IF NOT EXISTS owner_session_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shell_sessions_owner_kind_chk'
  ) THEN
    ALTER TABLE shell_sessions
      ADD CONSTRAINT shell_sessions_owner_kind_chk
      CHECK (owner_kind IN ('human','agent'));
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS agent_shell_tokens (
  token_hash TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_shell_tokens_sandbox_idx
  ON agent_shell_tokens (sandbox_id);
