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
    {
      table: 'agent_sessions',
      keyColumns: ['id'],
      columns: [
        { name: 'id' },
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'title' },
        { name: 'status' },
        { name: 'kind' },
        { name: 'working_dir', jsonName: 'workingDir' },
        { name: 'created_at', jsonName: 'createdAt' },
        { name: 'last_activity_at', jsonName: 'lastActivityAt' },
      ],
    },
    {
      table: 'orchestration_subtasks',
      keyColumns: ['id'],
      columns: [
        { name: 'id' },
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'dispatch_session_id', jsonName: 'dispatchSessionId' },
        { name: 'session_id', jsonName: 'sessionId' },
        { name: 'title' },
        { name: 'state' },
        { name: 'provisioning_stage', jsonName: 'provisioningStage' },
        { name: 'source_ref', jsonName: 'sourceRef' },
        { name: 'branch_name', jsonName: 'branchName' },
        { name: 'delivery_mode', jsonName: 'deliveryMode' },
        { name: 'delivery_pull_request_url', jsonName: 'deliveryPullRequestUrl' },
        { name: 'delivery_head_commit', jsonName: 'deliveryHeadCommit' },
        { name: 'delivery_summary', jsonName: 'deliverySummary' },
        { name: 'completed_at', jsonName: 'completedAt' },
        { name: 'worktree_path', jsonName: 'worktreePath' },
        { name: 'failure_stage', jsonName: 'failureStage' },
        { name: 'failure_message', jsonName: 'failureMessage' },
        { name: 'failure_retryable', jsonName: 'failureRetryable' },
        { name: 'created_at', jsonName: 'createdAt' },
        { name: 'updated_at', jsonName: 'updatedAt' },
      ],
    },
    {
      table: 'orchestration_returns',
      keyColumns: ['sequence'],
      columns: [
        { name: 'sequence' },
        { name: 'id' },
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'subtask_id', jsonName: 'subtaskId' },
        { name: 'assistant_message_id', jsonName: 'assistantMessageId' },
        { name: 'kind' },
        { name: 'summary' },
        { name: 'created_at', jsonName: 'createdAt' },
      ],
    },
  ])
  return envRealtime
}

export function initializeEnvRealtime(): void {
  getEnvRealtime()
}
