import { sqliteRaw } from '../db/client.js'
import { SqliteRealtimeEngine } from '../sqlite-realtime/engine.js'

let envRealtime: SqliteRealtimeEngine | null = null

export function getEnvRealtime(): SqliteRealtimeEngine {
  if (!envRealtime) envRealtime = new SqliteRealtimeEngine(sqliteRaw, [
    {
      table: 'repos',
      keyColumns: ['id'],
      columns: [
        { name: 'id' },
        { name: 'config_id', jsonName: 'configId' },
        { name: 'name' },
        { name: 'slug' },
        { name: 'worktree_name', jsonName: 'worktreeName' },
        { name: 'worktree_slug', jsonName: 'worktreeSlug' },
        { name: 'origin_url', jsonName: 'originUrl' },
        { name: 'ref' },
        { name: 'workspace_path', jsonName: 'workspacePath' },
        { name: 'source' },
        { name: 'github_repo_id', jsonName: 'githubRepoId' },
        { name: 'github_full_name', jsonName: 'githubFullName' },
        { name: 'created_at', jsonName: 'createdAt' },
      ],
    },
    {
      table: 'recent_folders',
      keyColumns: ['path'],
      columns: [
        { name: 'path' },
        { name: 'label' },
        { name: 'last_opened_at', jsonName: 'lastOpenedAt' },
      ],
    },
  ])
  return envRealtime
}

export function initializeEnvRealtime(): void {
  getEnvRealtime()
}
