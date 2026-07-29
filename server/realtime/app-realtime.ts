import { sqlite } from '../db/client.js'
import { SqliteRealtimeEngine } from '../sqlite-realtime/engine.js'

let appRealtime: SqliteRealtimeEngine | null = null

export function getAppRealtime(): SqliteRealtimeEngine {
  if (!appRealtime) appRealtime = new SqliteRealtimeEngine(sqlite, [
    {
      table: 'workspaces',
      keyColumns: ['id'],
      columns: [
        { name: 'id' },
        { name: 'name' },
        { name: 'folder_id', jsonName: 'folderId' },
        { name: 'position' },
        { name: 'name_source', jsonName: 'nameSource' },
        { name: 'source_kind', jsonName: 'sourceKind' },
        { name: 'source_path', jsonName: 'sourcePath' },
        { name: 'kind' },
        { name: 'system_key', jsonName: 'systemKey' },
        { name: 'hidden' },
        { name: 'protected' },
        { name: 'created_at', jsonName: 'createdAt' },
        { name: 'updated_at', jsonName: 'updatedAt' },
        { name: 'last_opened_at', jsonName: 'lastOpenedAt' },
        { name: 'archived_at', jsonName: 'archivedAt' },
      ],
    },
    {
      table: 'workspace_folders',
      keyColumns: ['id'],
      columns: [
        { name: 'id' },
        { name: 'parent_id', jsonName: 'parentId' },
        { name: 'name' },
        { name: 'position' },
        { name: 'collapsed' },
        { name: 'created_at', jsonName: 'createdAt' },
        { name: 'updated_at', jsonName: 'updatedAt' },
        { name: 'archived_at', jsonName: 'archivedAt' },
      ],
    },
    {
      table: 'workspace_view_states',
      keyColumns: ['workspace_id'],
      columns: [
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'active_agent_session_id', jsonName: 'activeAgentSessionId' },
        { name: 'active_workspace_tab_id', jsonName: 'activeWorkspaceTabId' },
        { name: 'split_ratio', jsonName: 'splitRatio' },
        { name: 'agent_collapsed', jsonName: 'agentCollapsed' },
        { name: 'updated_at', jsonName: 'updatedAt' },
      ],
    },
    {
      table: 'workspace_tabs',
      keyColumns: ['workspace_id', 'id'],
      columns: [
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'id' },
        { name: 'type' },
        { name: 'title' },
        { name: 'title_source', jsonName: 'titleSource' },
        { name: 'position' },
        { name: 'env_id', jsonName: 'envId' },
        { name: 'shell_id', jsonName: 'shellId' },
        { name: 'path' },
        { name: 'repo_root', jsonName: 'repoRoot' },
        { name: 'walkthrough_id', jsonName: 'walkthroughId' },
        { name: 'session_id', jsonName: 'sessionId' },
        { name: 'port' },
        { name: 'url' },
        { name: 'browser_tab_id', jsonName: 'browserTabId' },
        { name: 'favicon_url', jsonName: 'faviconUrl' },
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
    {
      table: 'agent_notifications',
      keyColumns: ['id'],
      columns: [
        { name: 'id' },
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'session_id', jsonName: 'sessionId' },
        { name: 'kind' },
        { name: 'title' },
        { name: 'summary' },
        { name: 'created_at', jsonName: 'createdAt' },
      ],
    },
    {
      table: 'workspace_resources',
      keyColumns: ['id'],
      columns: [
        { name: 'id' },
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'type' },
        { name: 'resource_key', jsonName: 'resourceKey' },
        { name: 'shared' },
        { name: 'data' },
        { name: 'created_at', jsonName: 'createdAt' },
        { name: 'updated_at', jsonName: 'updatedAt' },
      ],
    },
    {
      table: 'bookmarks',
      keyColumns: ['id'],
      columns: [
        { name: 'id' },
        { name: 'title' },
        { name: 'url' },
        { name: 'normalized_url', jsonName: 'normalizedUrl' },
        { name: 'origin' },
        { name: 'favicon_data_url', jsonName: 'faviconDataUrl' },
        { name: 'favicon_url', jsonName: 'faviconUrl' },
        { name: 'created_at', jsonName: 'createdAt' },
        { name: 'updated_at', jsonName: 'updatedAt' },
      ],
    },
  ])
  return appRealtime
}

export function initializeAppRealtime(): void {
  getAppRealtime()
}
