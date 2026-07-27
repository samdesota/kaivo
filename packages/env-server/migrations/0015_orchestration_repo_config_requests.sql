CREATE TABLE orchestration_repo_config_requests (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  working_dir TEXT NOT NULL,
  repository_root TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'cancelled')),
  claim_id TEXT,
  claimed_at TEXT,
  config_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_session_id, operation_id)
);

CREATE INDEX orchestration_repo_config_requests_workspace_status_idx
  ON orchestration_repo_config_requests(workspace_id, status, created_at);

CREATE TABLE orchestration_repo_config_bindings (
  repository_root TEXT PRIMARY KEY NOT NULL,
  config_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
