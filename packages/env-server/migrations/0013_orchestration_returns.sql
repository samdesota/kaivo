CREATE TABLE orchestration_returns (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  subtask_id TEXT NOT NULL REFERENCES orchestration_subtasks(id),
  assistant_message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('response', 'error')),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (subtask_id, assistant_message_id)
);

CREATE INDEX orchestration_returns_subtask_sequence_idx
  ON orchestration_returns (subtask_id, sequence DESC);
CREATE INDEX orchestration_returns_workspace_sequence_idx
  ON orchestration_returns (workspace_id, sequence);
