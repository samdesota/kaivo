CREATE TABLE IF NOT EXISTS workspace_view_states (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  active_agent_session_id TEXT,
  active_workspace_tab_id TEXT,
  split_ratio DOUBLE PRECISION,
  agent_collapsed BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_tabs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  env_id TEXT,
  shell_id TEXT,
  path TEXT,
  session_id TEXT,
  port INTEGER,
  url TEXT,
  browser_tab_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

INSERT INTO workspace_view_states (
  workspace_id,
  active_agent_session_id,
  active_workspace_tab_id,
  split_ratio,
  agent_collapsed,
  updated_at
)
SELECT
  workspace_id,
  NULLIF(state->>'activeAgentSessionId', ''),
  NULLIF(state->>'activeWorkspaceTabId', ''),
  CASE
    WHEN jsonb_typeof(state->'splitRatio') = 'number' THEN (state->>'splitRatio')::double precision
    ELSE NULL
  END,
  COALESCE((state->>'agentCollapsed')::boolean, false),
  updated_at
FROM workspace_ui_states
ON CONFLICT (workspace_id) DO UPDATE SET
  active_agent_session_id = excluded.active_agent_session_id,
  active_workspace_tab_id = excluded.active_workspace_tab_id,
  split_ratio = excluded.split_ratio,
  agent_collapsed = excluded.agent_collapsed,
  updated_at = excluded.updated_at;

INSERT INTO workspace_tabs (
  workspace_id,
  id,
  type,
  title,
  position,
  env_id,
  shell_id,
  path,
  session_id,
  port,
  url,
  browser_tab_id,
  updated_at
)
SELECT
  s.workspace_id,
  tab.value->>'id',
  tab.value->>'type',
  COALESCE(tab.value->>'title', tab.value->>'id'),
  (tab.ordinality - 1)::integer,
  NULLIF(tab.value->>'envId', ''),
  NULLIF(tab.value->>'shellId', ''),
  NULLIF(tab.value->>'path', ''),
  NULLIF(tab.value->>'sessionId', ''),
  CASE
    WHEN jsonb_typeof(tab.value->'port') = 'number' THEN (tab.value->>'port')::integer
    ELSE NULL
  END,
  NULLIF(tab.value->>'url', ''),
  NULLIF(tab.value->>'browserTabId', ''),
  s.updated_at
FROM workspace_ui_states s
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.state->'workspaceTabs', '[]'::jsonb)) WITH ORDINALITY AS tab(value, ordinality)
WHERE tab.value ? 'id'
  AND tab.value ? 'type'
ON CONFLICT (workspace_id, id) DO UPDATE SET
  type = excluded.type,
  title = excluded.title,
  position = excluded.position,
  env_id = excluded.env_id,
  shell_id = excluded.shell_id,
  path = excluded.path,
  session_id = excluded.session_id,
  port = excluded.port,
  url = excluded.url,
  browser_tab_id = excluded.browser_tab_id,
  updated_at = excluded.updated_at;
