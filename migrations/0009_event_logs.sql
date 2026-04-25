-- Centralized log sink. Every service (orchestrator, env-server,
-- sandboxes, browser) ingests its log lines here so we have one place
-- to grep when debugging. `event_ts` is captured at the source so it
-- survives batching/retries; `received_at` is when the row landed.

CREATE TABLE IF NOT EXISTS event_logs (
  id           BIGSERIAL PRIMARY KEY,
  event_ts     TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source       TEXT NOT NULL,
  -- Free-form principal: env-server uses its env id, orchestrator uses
  -- "orchestrator", browser uses the web session id, etc. Lets us scope
  -- queries without joining auth tables.
  principal    TEXT,
  level        TEXT NOT NULL
    CHECK (level IN ('trace','debug','info','warn','error','fatal')),
  msg          TEXT NOT NULL,
  ctx          JSONB
);

CREATE INDEX IF NOT EXISTS event_logs_ts_idx
  ON event_logs (event_ts DESC);
CREATE INDEX IF NOT EXISTS event_logs_source_ts_idx
  ON event_logs (source, event_ts DESC);
CREATE INDEX IF NOT EXISTS event_logs_principal_ts_idx
  ON event_logs (principal, event_ts DESC) WHERE principal IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_logs_level_ts_idx
  ON event_logs (level, event_ts DESC) WHERE level IN ('warn','error','fatal');
