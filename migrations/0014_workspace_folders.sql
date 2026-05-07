CREATE TABLE IF NOT EXISTS workspace_folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES workspace_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  collapsed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

ALTER TABLE workspaces ADD COLUMN folder_id TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN name_source TEXT NOT NULL DEFAULT 'explicit';
ALTER TABLE workspaces ADD COLUMN source_kind TEXT;
ALTER TABLE workspaces ADD COLUMN source_path TEXT;

WITH ordered_workspaces AS (
  SELECT
    id,
    row_number() OVER (ORDER BY last_opened_at DESC NULLS LAST, created_at DESC, id ASC) - 1 AS next_position
  FROM workspaces
  WHERE archived_at IS NULL
)
UPDATE workspaces
SET
  folder_id = NULL,
  position = ordered_workspaces.next_position,
  name_source = 'explicit'
FROM ordered_workspaces
WHERE workspaces.id = ordered_workspaces.id;
