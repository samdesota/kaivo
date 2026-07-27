import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const envMeta = sqliteTable('env_meta', {
  id: integer('id').primaryKey(),
  envTokenHash: text('env_token_hash'),
  pairedAt: text('paired_at'),
  opencodePort: integer('opencode_port'),
  opencodePasswordHash: text('opencode_password_hash'),
  defaultProviderId: text('default_provider_id'),
  defaultModelId: text('default_model_id'),
})

export const pairSessions = sqliteTable('pair_sessions', {
  sessionId: text('session_id').primaryKey(),
  code: text('code').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
})

export const envTokens = sqliteTable('env_tokens', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
})

export type ShellOwnerKind = 'human' | 'agent'

export const shellSessions = sqliteTable('shell_sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id'),
  cwd: text('cwd').notNull(),
  cols: integer('cols').notNull(),
  rows: integer('rows').notNull(),
  ownerKind: text('owner_kind').$type<ShellOwnerKind>().notNull(),
  ownerAgentSessionId: text('owner_agent_session_id'),
  ownerSessionId: text('owner_session_id'),
  createdAt: text('created_at').notNull(),
  lastActivityAt: text('last_activity_at').notNull(),
})

export type RepoSource = 'github' | 'url'

export const repos = sqliteTable('repos', {
  id: text('id').primaryKey(),
  configId: text('config_id'),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  worktreeName: text('worktree_name'),
  worktreeSlug: text('worktree_slug'),
  originUrl: text('origin_url').notNull(),
  ref: text('ref').notNull(),
  workspacePath: text('workspace_path').notNull(),
  source: text('source').$type<RepoSource>().notNull(),
  githubRepoId: text('github_repo_id'),
  githubFullName: text('github_full_name'),
  createdAt: text('created_at').notNull(),
  workspaceId: text('workspace_id'),
})

export const recentFolders = sqliteTable('recent_folders', {
  path: text('path').primaryKey(),
  label: text('label'),
  lastOpenedAt: text('last_opened_at').notNull(),
})

export type AgentSessionStatus = 'active' | 'archived'
export type AgentSessionKind = 'chat' | 'dispatch' | 'subtask'

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id'),
  opencodeSessionId: text('opencode_session_id').notNull().unique(),
  title: text('title'),
  status: text('status').$type<AgentSessionStatus>().notNull(),
  kind: text('kind').$type<AgentSessionKind>().notNull().default('chat'),
  // Per-session working dir picked at create time. Shells opened from
  // a session inherit this so they land in the same place the agent's
  // tools run. Null means "use CC_WORKING_DIR" (e.g. older rows).
  workingDir: text('working_dir'),
  selectedProviderId: text('selected_provider_id'),
  selectedModelId: text('selected_model_id'),
  selectedModelVariant: text('selected_model_variant'),
  createdAt: text('created_at').notNull(),
  lastActivityAt: text('last_activity_at').notNull(),
})

export const agentSessionCredentials = sqliteTable('agent_session_credentials', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at'),
})

export type OrchestrationSubtaskState = 'provisioning' | 'active' | 'returned' | 'completed' | 'failed'
export type OrchestrationProvisioningStage = 'reserved' | 'worktree_created' | 'session_created' | 'prompt_accepted'
export type OrchestrationDeliveryMode = 'pull_request' | 'dispatcher_integration'

export const orchestrationSubtasks = sqliteTable('orchestration_subtasks', {
  id: text('id').primaryKey(),
  operationId: text('operation_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  dispatchSessionId: text('dispatch_session_id').notNull(),
  sessionId: text('session_id'),
  sourceRepositoryId: text('source_repository_id').notNull(),
  worktreeId: text('worktree_id'),
  worktreePath: text('worktree_path'),
  title: text('title').notNull(),
  instruction: text('instruction').notNull(),
  sourceRef: text('source_ref').notNull(),
  branchName: text('branch_name').notNull(),
  deliveryMode: text('delivery_mode').$type<OrchestrationDeliveryMode>().notNull(),
  state: text('state').$type<OrchestrationSubtaskState>().notNull(),
  provisioningStage: text('provisioning_stage').$type<OrchestrationProvisioningStage>(),
  deliveryPullRequestUrl: text('delivery_pull_request_url'),
  deliveryHeadCommit: text('delivery_head_commit'),
  deliverySummary: text('delivery_summary'),
  completedAt: text('completed_at'),
  failureStage: text('failure_stage'),
  failureMessage: text('failure_message'),
  failureRetryable: integer('failure_retryable', { mode: 'boolean' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export type OrchestrationArtifactKind = 'worktree_path' | 'repository_row' | 'agent_session' | 'opencode_session'
export type OrchestrationArtifactOwnership = 'operation' | 'external'
export type OrchestrationArtifactStatus = 'present' | 'compensated' | 'residual'

export const orchestrationProvisioningArtifacts = sqliteTable('orchestration_provisioning_artifacts', {
  id: text('id').primaryKey(),
  subtaskId: text('subtask_id').notNull(),
  kind: text('kind').$type<OrchestrationArtifactKind>().notNull(),
  identity: text('identity').notNull(),
  ownership: text('ownership').$type<OrchestrationArtifactOwnership>().notNull(),
  status: text('status').$type<OrchestrationArtifactStatus>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export type OrchestrationReturnKind = 'response' | 'error'

export const orchestrationReturns = sqliteTable('orchestration_returns', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  workspaceId: text('workspace_id').notNull(),
  subtaskId: text('subtask_id').notNull(),
  assistantMessageId: text('assistant_message_id').notNull(),
  kind: text('kind').$type<OrchestrationReturnKind>().notNull(),
  summary: text('summary').notNull(),
  createdAt: text('created_at').notNull(),
})

export const orchestrationReturnNotificationOutbox = sqliteTable('orchestration_return_notification_outbox', {
  returnId: text('return_id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  subtaskId: text('subtask_id').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  deliveredAt: text('delivered_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export type OrchestrationRepoConfigRequestStatus = 'pending' | 'claimed' | 'completed' | 'cancelled'

export const orchestrationRepoConfigRequests = sqliteTable('orchestration_repo_config_requests', {
  id: text('id').primaryKey(),
  operationId: text('operation_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  agentSessionId: text('agent_session_id').notNull(),
  workingDir: text('working_dir').notNull(),
  repositoryRoot: text('repository_root'),
  status: text('status').$type<OrchestrationRepoConfigRequestStatus>().notNull(),
  claimId: text('claim_id'),
  claimedAt: text('claimed_at'),
  configId: text('config_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const orchestrationRepoConfigBindings = sqliteTable('orchestration_repo_config_bindings', {
  repositoryRoot: text('repository_root').primaryKey(),
  configId: text('config_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const agentTranscripts = sqliteTable('agent_transcripts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  seq: integer('seq').notNull(),
  role: text('role').notNull(),
  contentJson: text('content_json').notNull(),
  createdAt: text('created_at').notNull(),
})

export type JobState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  state: text('state').$type<JobState>().notNull(),
  progressPct: integer('progress_pct').notNull(),
  message: text('message'),
  error: text('error'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  finishedAt: text('finished_at'),
})
