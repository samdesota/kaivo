-- Phase 3 schema: GitHub App install, repos per sandbox, clone/track jobs.

CREATE TABLE IF NOT EXISTS github_install (
  id INTEGER PRIMARY KEY DEFAULT 1,
  installation_id TEXT,
  app_id TEXT NOT NULL,
  app_slug TEXT,
  org_login TEXT,
  encrypted_private_key_ref TEXT NOT NULL,
  encrypted_webhook_secret_ref TEXT,
  client_id TEXT,
  encrypted_client_secret_ref TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  installed_at TIMESTAMPTZ,
  CONSTRAINT github_install_single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  origin_url TEXT NOT NULL,
  ref TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  source TEXT NOT NULL,
  github_repo_id TEXT,
  github_full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT repos_source_chk CHECK (source IN ('github','url'))
);

CREATE INDEX IF NOT EXISTS repos_sandbox_idx ON repos (sandbox_id);
CREATE UNIQUE INDEX IF NOT EXISTS repos_sandbox_slug_uniq ON repos (sandbox_id, slug);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sandbox_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT jobs_state_chk CHECK (state IN ('pending','running','succeeded','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs (state);
CREATE INDEX IF NOT EXISTS jobs_sandbox_idx ON jobs (sandbox_id);

CREATE TABLE IF NOT EXISTS github_token_cache (
  installation_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
