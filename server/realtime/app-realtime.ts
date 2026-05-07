import { sqlite } from '../db/client.js'
import { SqliteRealtimeEngine } from '../sqlite-realtime/engine.js'

let appRealtime: SqliteRealtimeEngine | null = null

export function getAppRealtime(): SqliteRealtimeEngine {
  if (!appRealtime) appRealtime = new SqliteRealtimeEngine(sqlite, [
    {
      table: 'workspace_tabs',
      keyColumns: ['workspace_id', 'id'],
      columns: [
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'id' },
        { name: 'type' },
        { name: 'title' },
        { name: 'position' },
        { name: 'env_id', jsonName: 'envId' },
        { name: 'shell_id', jsonName: 'shellId' },
        { name: 'path' },
        { name: 'session_id', jsonName: 'sessionId' },
        { name: 'port' },
        { name: 'url' },
        { name: 'browser_tab_id', jsonName: 'browserTabId' },
        { name: 'updated_at', jsonName: 'updatedAt' },
      ],
    },
    {
      table: 'workspace_agent_tabs',
      keyColumns: ['workspace_id', 'session_id'],
      columns: [
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'session_id', jsonName: 'sessionId' },
        { name: 'position' },
        { name: 'updated_at', jsonName: 'updatedAt' },
      ],
    },
  ])
  return appRealtime
}

export function initializeAppRealtime(): void {
  getAppRealtime()
}
