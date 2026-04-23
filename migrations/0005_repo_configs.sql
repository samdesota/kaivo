-- Global repo configurations: a reusable template for cloning a repo,
-- including auxiliary files (typically .env) that should be placed into
-- the workspace after the clone completes. Configs are NOT scoped to a
-- sandbox; the existing per-sandbox `repos` row references the config
-- that produced it.

CREATE TABLE IF NOT EXISTS repo_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  origin_url TEXT NOT NULL,
  ref TEXT,
  github_repo_id TEXT,
  github_full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT repo_configs_source_chk CHECK (source IN ('github','url'))
);

CREATE UNIQUE INDEX IF NOT EXISTS repo_configs_name_uniq ON repo_configs (name);

CREATE TABLE IF NOT EXISTS repo_config_files (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES repo_configs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS repo_config_files_config_idx ON repo_config_files (config_id);
CREATE UNIQUE INDEX IF NOT EXISTS repo_config_files_path_uniq ON repo_config_files (config_id, path);

ALTER TABLE repos ADD COLUMN IF NOT EXISTS config_id TEXT REFERENCES repo_configs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS repos_config_idx ON repos (config_id);
