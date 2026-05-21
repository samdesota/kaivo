ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE workspaces ADD COLUMN system_key TEXT;
ALTER TABLE workspaces ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_system_key_unique ON workspaces(system_key);
