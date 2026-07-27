ALTER TABLE agent_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'
  CHECK (kind IN ('chat','dispatch','subtask'));

ALTER TABLE repos ADD COLUMN workspace_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_workspace_path
  ON repos (workspace_path);

CREATE TABLE orchestration_subtasks (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  dispatch_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  session_id TEXT REFERENCES agent_sessions(id),
  source_repository_id TEXT NOT NULL,
  worktree_id TEXT REFERENCES repos(id),
  worktree_path TEXT,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  delivery_mode TEXT NOT NULL
    CHECK (delivery_mode IN ('pull_request','dispatcher_integration')),
  state TEXT NOT NULL
    CHECK (state IN ('provisioning','active','returned','completed','failed')),
  provisioning_stage TEXT
    CHECK (provisioning_stage IN ('reserved','worktree_created','session_created','prompt_accepted')),
  delivery_pull_request_url TEXT,
  delivery_head_commit TEXT,
  delivery_summary TEXT,
  completed_at TEXT,
  failure_stage TEXT,
  failure_message TEXT,
  failure_retryable INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dispatch_session_id, operation_id),
  UNIQUE (session_id),
  UNIQUE (worktree_id)
);

CREATE INDEX idx_orchestration_subtasks_workspace
  ON orchestration_subtasks (workspace_id, created_at);
CREATE INDEX idx_orchestration_subtasks_dispatch
  ON orchestration_subtasks (dispatch_session_id, created_at);

CREATE TABLE orchestration_provisioning_artifacts (
  id TEXT PRIMARY KEY,
  subtask_id TEXT NOT NULL REFERENCES orchestration_subtasks(id),
  kind TEXT NOT NULL
    CHECK (kind IN ('worktree_path','repository_row','agent_session','opencode_session')),
  identity TEXT NOT NULL,
  ownership TEXT NOT NULL
    CHECK (ownership IN ('operation','external')),
  status TEXT NOT NULL
    CHECK (status IN ('present','compensated','residual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subtask_id, kind, identity)
);

CREATE INDEX idx_orchestration_artifacts_subtask
  ON orchestration_provisioning_artifacts (subtask_id);

CREATE TABLE agent_session_credentials (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX idx_agent_session_credentials_session
  ON agent_session_credentials (session_id);
