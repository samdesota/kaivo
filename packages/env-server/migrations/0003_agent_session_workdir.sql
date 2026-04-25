-- Per-session working dir. Set at session create time from the picker
-- (or null = "use the env's CC_WORKING_DIR"). Shells opened from a
-- session inherit this so they land in the same place the agent's
-- tools run.

ALTER TABLE agent_sessions ADD COLUMN working_dir TEXT;
