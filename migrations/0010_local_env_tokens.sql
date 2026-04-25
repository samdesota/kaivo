ALTER TABLE envs ADD COLUMN IF NOT EXISTS env_token TEXT;
ALTER TABLE envs ADD COLUMN IF NOT EXISTS local_identity_label TEXT;

CREATE INDEX IF NOT EXISTS envs_local_identity_label_idx ON envs (local_identity_label);
