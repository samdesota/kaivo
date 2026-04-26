import { pgTable, text, timestamp, integer, bigint, check, jsonb, bigserial } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export type SandboxStatus = 'active' | 'archived' | 'crashed'
export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RepoSource = 'github' | 'url'
export type AgentSessionStatus = 'active' | 'archived' | 'unavailable'
export type ShellOwnerKind = 'human' | 'agent'
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export type WorkspaceTab =
  | { id: string; type: 'shell'; envId: string; shellId: string; title: string }
  | { id: string; type: 'file'; envId: string; path: string; sessionId?: string; title: string }
  | { id: string; type: 'preview'; envId: string; port: number; title: string }
  | { id: string; type: 'browser'; url: string; browserTabId?: string; title: string }

export type WorkspaceUiState = {
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  workspaceTabs: WorkspaceTab[]
  splitRatio: number | null
  tabOrder: string[]
}

export const admin = pgTable(
  'admin',
  {
    id: integer('id').primaryKey().default(1),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    singleRow: check('admin_single_row', sql`${t.id} = 1`),
  }),
)

export const webSessions = pgTable('web_sessions', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const secrets = pgTable('secrets', {
  name: text('name').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
})

export const workspaceUiStates = pgTable('workspace_ui_states', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  state: jsonb('state').$type<WorkspaceUiState>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sandboxes = pgTable('sandboxes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  containerId: text('container_id'),
  status: text('status').$type<SandboxStatus>().notNull().default('active'),
  opencodePort: integer('opencode_port'),
  opencodePasswordSecret: text('opencode_password_secret'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
})

export const githubInstall = pgTable(
  'github_install',
  {
    id: integer('id').primaryKey().default(1),
    installationId: text('installation_id'),
    appId: text('app_id').notNull(),
    appSlug: text('app_slug'),
    orgLogin: text('org_login'),
    encryptedPrivateKeyRef: text('encrypted_private_key_ref').notNull(),
    encryptedWebhookSecretRef: text('encrypted_webhook_secret_ref'),
    clientId: text('client_id'),
    encryptedClientSecretRef: text('encrypted_client_secret_ref'),
    connectedAt: timestamp('connected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    installedAt: timestamp('installed_at', { withTimezone: true }),
  },
  (t) => ({
    singleRow: check('github_install_single_row', sql`${t.id} = 1`),
  }),
)

export const repoConfigs = pgTable('repo_configs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  source: text('source').$type<RepoSource>().notNull(),
  originUrl: text('origin_url').notNull(),
  ref: text('ref'),
  githubRepoId: text('github_repo_id'),
  githubFullName: text('github_full_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const repoConfigFiles = pgTable('repo_config_files', {
  id: text('id').primaryKey(),
  configId: text('config_id')
    .notNull()
    .references(() => repoConfigs.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const repos = pgTable('repos', {
  id: text('id').primaryKey(),
  sandboxId: text('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' }),
  configId: text('config_id').references(() => repoConfigs.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  originUrl: text('origin_url').notNull(),
  ref: text('ref').notNull(),
  workspacePath: text('workspace_path').notNull(),
  source: text('source').$type<RepoSource>().notNull(),
  githubRepoId: text('github_repo_id'),
  githubFullName: text('github_full_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  sandboxId: text('sandbox_id'),
  state: text('state').$type<JobState>().notNull().default('pending'),
  progressPct: integer('progress_pct').notNull().default(0),
  message: text('message'),
  error: text('error'),
  metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

export const githubTokenCache = pgTable('github_token_cache', {
  installationId: text('installation_id').primaryKey(),
  token: text('token').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const shellSessions = pgTable('shell_sessions', {
  id: text('id').primaryKey(),
  sandboxId: text('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' }),
  cwd: text('cwd').notNull(),
  cols: integer('cols').notNull(),
  rows: integer('rows').notNull(),
  ownerKind: text('owner_kind').$type<ShellOwnerKind>().notNull().default('human'),
  ownerSessionId: text('owner_session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const agentShellTokens = pgTable('agent_shell_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  sandboxId: text('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' }),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const agentSessions = pgTable('agent_sessions', {
  id: text('id').primaryKey(),
  sandboxId: text('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' }),
  opencodeSessionId: text('opencode_session_id').notNull(),
  title: text('title'),
  status: text('status').$type<AgentSessionStatus>().notNull().default('active'),
  selectedProviderId: text('selected_provider_id'),
  selectedModelId: text('selected_model_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
})

export const agentTranscripts = pgTable('agent_transcripts', {
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id, { onDelete: 'cascade' }),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  role: text('role').notNull(),
  contentJson: jsonb('content_json').$type<Record<string, unknown>>().notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
})

export type EnvAuthTokenSource = 'service' | 'device'
export type EnvAuthDeviceStatus = 'pending' | 'approved' | 'denied' | 'expired'

export const envAuthTokens = pgTable('env_auth_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  label: text('label').notNull(),
  source: text('source').$type<EnvAuthTokenSource>().notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const envAuthDeviceRequests = pgTable('env_auth_device_requests', {
  deviceCode: text('device_code').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  label: text('label').notNull(),
  status: text('status').$type<EnvAuthDeviceStatus>().notNull().default('pending'),
  grantedTokenHash: text('granted_token_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
})

export type EnvKind = 'container' | 'local'
export type EnvStatus = 'running' | 'archived' | 'crashed' | 'unreachable'

export const envs = pgTable('envs', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<EnvKind>().notNull(),
  label: text('label').notNull(),
  // For container envs: relative path like `/env/<id>` that the cc-control
  // reverse proxy will route to the container. For local envs: absolute
  // `http://localhost:47821`.
  url: text('url').notNull(),
  // Local env browser bearer token, stored server-side so any browser on the
  // same computer can connect without re-pairing. Null for container envs.
  envToken: text('env_token'),
  // Install-time local computer label (CC_LABEL). Used to avoid showing a
  // local env when the same user opens the app from another computer.
  localIdentityLabel: text('local_identity_label'),
  status: text('status').$type<EnvStatus>().notNull().default('running'),
  containerId: text('container_id'),
  // Reference into env_auth_tokens for revocation on delete.
  identityTokenHash: text('identity_token_hash').references(() => envAuthTokens.tokenHash, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
})

export const eventLogs = pgTable('event_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  // Captured at the source — survives batching/retries so the timeline is
  // correct even if a batch sat in the in-memory buffer for a second.
  eventTs: timestamp('event_ts', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source').notNull(),
  // Free-form principal: env id for env-server lines, "orchestrator" for
  // identity self-logs, web session id for browser, etc. Lets us scope
  // queries without joining auth tables.
  principal: text('principal'),
  level: text('level').$type<LogLevel>().notNull(),
  msg: text('msg').notNull(),
  ctx: jsonb('ctx').$type<Record<string, unknown> | null>(),
})
