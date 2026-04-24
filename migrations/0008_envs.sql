-- Phase 2 (local envs): orchestrator registry. Each row is "an environment"
-- whether it's a docker container spawned by the orchestrator or a local
-- machine a user paired with install.sh. The env server process (cc-env)
-- owns all per-env state (shells, agent sessions, repos); the orchestrator
-- only keeps URL + metadata.

CREATE TABLE IF NOT EXISTS envs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('container','local')),
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','archived','crashed','unreachable')),
  container_id TEXT,
  identity_token_hash TEXT REFERENCES env_auth_tokens(token_hash) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS envs_kind_idx ON envs (kind);
CREATE INDEX IF NOT EXISTS envs_status_idx ON envs (status);
