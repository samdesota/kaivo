CREATE INDEX IF NOT EXISTS agent_sessions_workspace_kind_created_idx
  ON agent_sessions (workspace_id, kind, created_at);
