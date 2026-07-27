CREATE TABLE orchestration_return_notification_outbox (
  return_id TEXT PRIMARY KEY NOT NULL REFERENCES orchestration_returns(id),
  workspace_id TEXT NOT NULL,
  subtask_id TEXT NOT NULL REFERENCES orchestration_subtasks(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX orchestration_return_notification_pending_idx
  ON orchestration_return_notification_outbox(delivered_at, created_at);
