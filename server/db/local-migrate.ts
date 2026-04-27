import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const nowMs = "(unixepoch() * 1000)"

const localSchemaSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  last_seen INTEGER NOT NULL DEFAULT ${nowMs},
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs},
  last_opened_at INTEGER,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS workspace_ui_states (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  container_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  opencode_port INTEGER,
  opencode_password_secret TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS github_install (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT,
  app_id TEXT NOT NULL,
  app_slug TEXT,
  org_login TEXT,
  encrypted_private_key_ref TEXT NOT NULL,
  encrypted_webhook_secret_ref TEXT,
  client_id TEXT,
  encrypted_client_secret_ref TEXT,
  connected_at INTEGER NOT NULL DEFAULT ${nowMs},
  installed_at INTEGER
);

CREATE TABLE IF NOT EXISTS repo_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  origin_url TEXT NOT NULL,
  ref TEXT,
  github_repo_id TEXT,
  github_full_name TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS repo_config_files (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES repo_configs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  config_id TEXT REFERENCES repo_configs(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  origin_url TEXT NOT NULL,
  ref TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  source TEXT NOT NULL,
  github_repo_id TEXT,
  github_full_name TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sandbox_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs},
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS github_token_cache (
  installation_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shell_sessions (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  owner_kind TEXT NOT NULL DEFAULT 'human',
  owner_session_id TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  last_activity_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS agent_shell_tokens (
  token_hash TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  issued_at INTEGER NOT NULL DEFAULT ${nowMs},
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  opencode_session_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  selected_provider_id TEXT,
  selected_model_id TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  last_activity_at INTEGER NOT NULL DEFAULT ${nowMs},
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_transcripts (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS env_auth_tokens (
  token_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  issued_at INTEGER NOT NULL DEFAULT ${nowMs},
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS env_auth_device_requests (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  granted_token_hash TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  approved_at INTEGER
);

CREATE TABLE IF NOT EXISTS envs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  env_token TEXT,
  local_identity_label TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  container_id TEXT,
  identity_token_hash TEXT REFERENCES env_auth_tokens(token_hash) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  archived_at INTEGER,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS event_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL DEFAULT ${nowMs},
  source TEXT NOT NULL,
  principal TEXT,
  level TEXT NOT NULL,
  msg TEXT NOT NULL,
  ctx TEXT
);
`

export type LocalAppMigrationResult = {
  sqlitePath: string
  applied: string[]
}

export function runLocalAppMigrations(sqlitePath: string): LocalAppMigrationResult {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })
  const sqlite = new Database(sqlitePath)
  try {
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const hasMigrations = Boolean(
      sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'schema_migrations'),
    )
    const migrationName = '0001_local_app_schema'
    const migrationAlreadyApplied =
      hasMigrations && sqlite.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migrationName)

    if (!migrationAlreadyApplied) {
      sqlite.transaction(() => {
        sqlite.exec(localSchemaSql)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(migrationName)
      })()
      return { sqlitePath, applied: [migrationName] }
    }

    return { sqlitePath, applied: [] }
  } finally {
    sqlite.close()
  }
}

export const localAppTables = [
  'admin',
  'web_sessions',
  'secrets',
  'workspaces',
  'workspace_ui_states',
  'sandboxes',
  'github_install',
  'github_token_cache',
  'repo_configs',
  'repo_config_files',
  'repos',
  'jobs',
  'shell_sessions',
  'agent_shell_tokens',
  'agent_sessions',
  'agent_transcripts',
  'env_auth_tokens',
  'env_auth_device_requests',
  'envs',
  'event_logs',
] as const
