CREATE TABLE walkthroughs (
  id TEXT PRIMARY KEY NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'thinking', 'streaming', 'checking', 'repairing', 'completed', 'failed', 'cancelled')),
  cwd TEXT NOT NULL,
  repository_root TEXT NOT NULL,
  repository_git_dir TEXT NOT NULL,
  repository_head_oid TEXT,
  repository_branch TEXT,
  comparison_json TEXT NOT NULL,
  base_ref TEXT,
  merge_base_oid TEXT,
  files_json TEXT NOT NULL,
  patch TEXT NOT NULL,
  patch_digest TEXT NOT NULL,
  patch_byte_count INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  markdown TEXT NOT NULL,
  covered_units INTEGER NOT NULL,
  total_units INTEGER NOT NULL,
  warnings_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE walkthrough_events (
  walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id),
  sequence INTEGER NOT NULL,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('started', 'status.changed', 'markdown.appended', 'coverage.changed', 'warning', 'completed', 'failed', 'cancelled')),
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (walkthrough_id, sequence)
);

CREATE INDEX walkthrough_events_walkthrough_sequence_idx
  ON walkthrough_events(walkthrough_id, sequence);
