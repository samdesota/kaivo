import { sql } from 'drizzle-orm'
import { check, integer, primaryKey, real, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { WorkspaceTab } from '../../shared/workspace-pane'

export type { WorkspaceTab }

export type SandboxStatus = 'active' | 'archived' | 'crashed'
export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RepoSource = 'github' | 'url'
export type AgentSessionStatus = 'active' | 'archived' | 'unavailable'
export type ShellOwnerKind = 'human' | 'agent'
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type WorkspaceNameSource = 'explicit' | 'folder_path' | 'worktree' | 'derived'
export type WorkspaceSourceKind = 'folder' | 'worktree' | 'repo_config'
export type WorkspaceKind = 'user' | 'system'
export type WorkspaceSystemKey = 'global-tabs'
export type WorkspaceResourceType = 'browser_tab' | 'worktree' | 'shell' | 'other'

export type WorkspaceUiState = {
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  workspaceTabs: WorkspaceTab[]
  splitRatio: number | null
  agentCollapsed: boolean
  tabOrder: string[]
}

export type WorkspaceViewState = {
  workspaceId: string
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  splitRatio: number | null
  agentCollapsed: boolean
  updatedAt: Date
}

export type WorkspaceTabRow = {
  workspaceId: string
  id: string
  type: WorkspaceTab['type']
  title: string
  titleSource: 'auto' | 'explicit' | null
  position: number
  envId: string | null
  shellId: string | null
  path: string | null
  repoRoot: string | null
  sessionId: string | null
  port: number | null
  url: string | null
  browserTabId: string | null
  faviconUrl: string | null
  updatedAt: Date
}

export type WorkspaceAgentTabRow = {
  workspaceId: string
  sessionId: string
  position: number
  updatedAt: Date
}

export type WorkspaceResourceRow = {
  id: string
  workspaceId: string
  type: WorkspaceResourceType
  resourceKey: string
  shared: boolean
  data: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export type BookmarkRow = {
  id: string
  title: string
  url: string
  normalizedUrl: string
  origin: string | null
  faviconDataUrl: string | null
  faviconUrl: string | null
  createdAt: Date
  updatedAt: Date
}

export type FaviconCacheRow = {
  pageOrigin: string
  iconUrl: string
  dataUrl: string
  mediaType: string
  sizeBytes: number
  updatedAt: Date
  lastSeenAt: Date
}

export type AgentNotificationRow = {
  id: string
  workspaceId: string
  sessionId: string
  kind: 'finished' | 'question' | 'permission' | 'error'
  title: string
  summary: string
  createdAt: Date
}

const nowMs = sql`(unixepoch() * 1000)`
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })
const jsonText = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()

export const admin = sqliteTable(
  'admin',
  {
    id: integer('id').primaryKey().default(1),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at').notNull().default(nowMs),
  },
  (t) => ({ singleRow: check('admin_single_row', sql`${t.id} = 1`) }),
)

export const webSessions = sqliteTable('web_sessions', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  lastSeen: timestamp('last_seen').notNull().default(nowMs),
  expiresAt: timestamp('expires_at').notNull(),
})

export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: timestamp('created_at').notNull().default(nowMs),
})

export const workspaceFolders = sqliteTable('workspace_folders', {
  id: text('id').primaryKey(),
  parentId: text('parent_id').references((): AnySQLiteColumn => workspaceFolders.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  updatedAt: timestamp('updated_at').notNull().default(nowMs),
  archivedAt: timestamp('archived_at'),
})

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    folderId: text('folder_id').references(() => workspaceFolders.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
    nameSource: text('name_source').$type<WorkspaceNameSource>().notNull().default('explicit'),
    sourceKind: text('source_kind').$type<WorkspaceSourceKind>(),
    sourcePath: text('source_path'),
    kind: text('kind').$type<WorkspaceKind>().notNull().default('user'),
    systemKey: text('system_key').$type<WorkspaceSystemKey>(),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    protected: integer('protected', { mode: 'boolean' }).notNull().default(false),
    createdAt: timestamp('created_at').notNull().default(nowMs),
    updatedAt: timestamp('updated_at').notNull().default(nowMs),
    lastOpenedAt: timestamp('last_opened_at'),
    archivedAt: timestamp('archived_at'),
  },
  (t) => ({ systemKeyUnique: uniqueIndex('workspaces_system_key_unique').on(t.systemKey) }),
)

export const workspaceUiStates = sqliteTable('workspace_ui_states', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  state: jsonText<WorkspaceUiState>('state').notNull(),
  updatedAt: timestamp('updated_at').notNull().default(nowMs),
})

export const workspaceViewStates = sqliteTable('workspace_view_states', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  activeAgentSessionId: text('active_agent_session_id'),
  activeWorkspaceTabId: text('active_workspace_tab_id'),
  splitRatio: real('split_ratio'),
  agentCollapsed: integer('agent_collapsed', { mode: 'boolean' }).notNull().default(false),
  updatedAt: timestamp('updated_at').notNull().default(nowMs),
})

export const workspaceTabs = sqliteTable(
  'workspace_tabs',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    type: text('type').$type<WorkspaceTab['type']>().notNull(),
    title: text('title').notNull(),
    titleSource: text('title_source').$type<'auto' | 'explicit'>(),
    position: integer('position').notNull(),
    envId: text('env_id'),
    shellId: text('shell_id'),
    path: text('path'),
    repoRoot: text('repo_root'),
    sessionId: text('session_id'),
    port: integer('port'),
    url: text('url'),
    browserTabId: text('browser_tab_id'),
    faviconUrl: text('favicon_url'),
    updatedAt: timestamp('updated_at').notNull().default(nowMs),
  },
  (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.id] }) }),
)

export const workspaceAgentTabs = sqliteTable(
  'workspace_agent_tabs',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    position: integer('position').notNull(),
    updatedAt: timestamp('updated_at').notNull().default(nowMs),
  },
  (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.sessionId] }) }),
)

export const workspaceResources = sqliteTable('workspace_resources', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  type: text('type').$type<WorkspaceResourceType>().notNull(),
  resourceKey: text('resource_key').notNull(),
  shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
  data: jsonText<Record<string, unknown>>('data').notNull(),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  updatedAt: timestamp('updated_at').notNull().default(nowMs),
})

export const bookmarks = sqliteTable('bookmarks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  normalizedUrl: text('normalized_url').notNull().unique(),
  origin: text('origin'),
  faviconDataUrl: text('favicon_data_url'),
  faviconUrl: text('favicon_url'),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  updatedAt: timestamp('updated_at').notNull().default(nowMs),
})

export const faviconCache = sqliteTable('favicon_cache', {
  pageOrigin: text('page_origin').notNull(),
  iconUrl: text('icon_url').notNull(),
  dataUrl: text('data_url').notNull(),
  mediaType: text('media_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  updatedAt: timestamp('updated_at').notNull().default(nowMs),
  lastSeenAt: timestamp('last_seen_at').notNull().default(nowMs),
}, (t) => ({ pk: primaryKey({ columns: [t.pageOrigin, t.iconUrl] }) }))

export const agentNotifications = sqliteTable('agent_notifications', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  kind: text('kind').$type<AgentNotificationRow['kind']>().notNull().default('finished'),
  title: text('title').notNull().default('Chat finished'),
  summary: text('summary').notNull(),
  createdAt: timestamp('created_at').notNull().default(nowMs),
})

export const sandboxes = sqliteTable('sandboxes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  containerId: text('container_id'),
  status: text('status').$type<SandboxStatus>().notNull().default('active'),
  opencodePort: integer('opencode_port'),
  opencodePasswordSecret: text('opencode_password_secret'),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  archivedAt: timestamp('archived_at'),
})

export const githubInstall = sqliteTable(
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
    connectedAt: timestamp('connected_at').notNull().default(nowMs),
    installedAt: timestamp('installed_at'),
  },
  (t) => ({ singleRow: check('github_install_single_row', sql`${t.id} = 1`) }),
)

export const repoConfigs = sqliteTable('repo_configs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  source: text('source').$type<RepoSource>().notNull(),
  originUrl: text('origin_url').notNull(),
  ref: text('ref'),
  githubRepoId: text('github_repo_id'),
  githubFullName: text('github_full_name'),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  updatedAt: timestamp('updated_at').notNull().default(nowMs),
})

export const repoConfigFiles = sqliteTable('repo_config_files', {
  id: text('id').primaryKey(),
  configId: text('config_id')
    .notNull()
    .references(() => repoConfigs.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  updatedAt: timestamp('updated_at').notNull().default(nowMs),
})

export const repos = sqliteTable('repos', {
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
  createdAt: timestamp('created_at').notNull().default(nowMs),
})

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  sandboxId: text('sandbox_id'),
  state: text('state').$type<JobState>().notNull().default('pending'),
  progressPct: integer('progress_pct').notNull().default(0),
  message: text('message'),
  error: text('error'),
  metadataJson: jsonText<Record<string, unknown>>('metadata_json'),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  updatedAt: timestamp('updated_at').notNull().default(nowMs),
  finishedAt: timestamp('finished_at'),
})

export const githubTokenCache = sqliteTable('github_token_cache', {
  installationId: text('installation_id').primaryKey(),
  token: text('token').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
})

export const shellSessions = sqliteTable('shell_sessions', {
  id: text('id').primaryKey(),
  sandboxId: text('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' }),
  cwd: text('cwd').notNull(),
  cols: integer('cols').notNull(),
  rows: integer('rows').notNull(),
  ownerKind: text('owner_kind').$type<ShellOwnerKind>().notNull().default('human'),
  ownerSessionId: text('owner_session_id'),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  lastActivityAt: timestamp('last_activity_at').notNull().default(nowMs),
})

export const agentShellTokens = sqliteTable('agent_shell_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  sandboxId: text('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' }),
  issuedAt: timestamp('issued_at').notNull().default(nowMs),
  revokedAt: timestamp('revoked_at'),
})

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  sandboxId: text('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' }),
  opencodeSessionId: text('opencode_session_id').notNull(),
  title: text('title'),
  status: text('status').$type<AgentSessionStatus>().notNull().default('active'),
  selectedProviderId: text('selected_provider_id'),
  selectedModelId: text('selected_model_id'),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  lastActivityAt: timestamp('last_activity_at').notNull().default(nowMs),
  archivedAt: timestamp('archived_at'),
})

export const agentTranscripts = sqliteTable('agent_transcripts', {
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  role: text('role').notNull(),
  contentJson: jsonText<Record<string, unknown>>('content_json').notNull(),
  ts: timestamp('ts').notNull().default(nowMs),
})

export type EnvAuthTokenSource = 'service' | 'device'
export type EnvAuthDeviceStatus = 'pending' | 'approved' | 'denied' | 'expired'

export const envAuthTokens = sqliteTable('env_auth_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  label: text('label').notNull(),
  source: text('source').$type<EnvAuthTokenSource>().notNull(),
  issuedAt: timestamp('issued_at').notNull().default(nowMs),
  revokedAt: timestamp('revoked_at'),
})

export const envAuthDeviceRequests = sqliteTable('env_auth_device_requests', {
  deviceCode: text('device_code').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  label: text('label').notNull(),
  status: text('status').$type<EnvAuthDeviceStatus>().notNull().default('pending'),
  grantedTokenHash: text('granted_token_hash'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  approvedAt: timestamp('approved_at'),
})

export type EnvKind = 'container' | 'local'
export type EnvStatus = 'running' | 'archived' | 'crashed' | 'unreachable'

export const envs = sqliteTable('envs', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<EnvKind>().notNull(),
  label: text('label').notNull(),
  url: text('url').notNull(),
  envToken: text('env_token'),
  localIdentityLabel: text('local_identity_label'),
  status: text('status').$type<EnvStatus>().notNull().default('running'),
  containerId: text('container_id'),
  identityTokenHash: text('identity_token_hash').references(() => envAuthTokens.tokenHash, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at').notNull().default(nowMs),
  archivedAt: timestamp('archived_at'),
  lastSeenAt: timestamp('last_seen_at'),
})

export const eventLogs = sqliteTable('event_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventTs: timestamp('event_ts').notNull(),
  receivedAt: timestamp('received_at').notNull().default(nowMs),
  source: text('source').notNull(),
  principal: text('principal'),
  level: text('level').$type<LogLevel>().notNull(),
  msg: text('msg').notNull(),
  ctx: jsonText<Record<string, unknown> | null>('ctx'),
})
