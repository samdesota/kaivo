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
  originUrl: text('origin_url').notNull(),
  ref: text('ref').notNull(),
  workspacePath: text('workspace_path').notNull(),
  source: text('source').$type<RepoSource>().notNull(),
  githubRepoId: text('github_repo_id'),
  githubFullName: text('github_full_name'),
  createdAt: text('created_at').notNull(),
})

export const recentFolders = sqliteTable('recent_folders', {
  path: text('path').primaryKey(),
  label: text('label'),
  lastOpenedAt: text('last_opened_at').notNull(),
})

export type AgentSessionStatus = 'active' | 'archived'

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id'),
  opencodeSessionId: text('opencode_session_id').notNull().unique(),
  title: text('title'),
  status: text('status').$type<AgentSessionStatus>().notNull(),
  // Per-session working dir picked at create time. Shells opened from
  // a session inherit this so they land in the same place the agent's
  // tools run. Null means "use CC_WORKING_DIR" (e.g. older rows).
  workingDir: text('working_dir'),
  selectedProviderId: text('selected_provider_id'),
  selectedModelId: text('selected_model_id'),
  createdAt: text('created_at').notNull(),
  lastActivityAt: text('last_activity_at').notNull(),
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
