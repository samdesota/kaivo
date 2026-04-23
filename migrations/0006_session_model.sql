-- Persist the per-session model override so it survives server restarts
-- (previously kept in-memory only, which made the picker show stale state
-- after a deploy or process restart).

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS selected_provider_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS selected_model_id TEXT;
