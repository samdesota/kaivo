-- Phase 1 (local envs): identity tokens issued to env servers (container or
-- local) so they can fetch provider keys + repo configs from the central
-- identity service. Two shapes:
--   * service-issued: orchestrator mints when creating a container env.
--   * device-flow: install.sh runs a CLI-style device auth flow against a
--     logged-in browser to obtain a token for a local env.

CREATE TABLE IF NOT EXISTS env_auth_tokens (
  token_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('service','device')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS env_auth_tokens_issued_idx
  ON env_auth_tokens (issued_at);

CREATE TABLE IF NOT EXISTS env_auth_device_requests (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','expired')),
  granted_token_hash TEXT REFERENCES env_auth_tokens(token_hash) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS env_auth_device_requests_expires_idx
  ON env_auth_device_requests (expires_at);
