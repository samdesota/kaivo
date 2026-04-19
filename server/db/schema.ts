import { pgTable, text, timestamp, integer, bigint, check, jsonb } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export type SandboxStatus = 'active' | 'archived' | 'crashed'
export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RepoSource = 'github' | 'url'
export type AgentSessionStatus = 'active' | 'archived' | 'unavailable'

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

export const repos = pgTable('repos', {
  id: text('id').primaryKey(),
  sandboxId: text('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' }),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const agentSessions = pgTable('agent_sessions', {
  id: text('id').primaryKey(),
  sandboxId: text('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' }),
  opencodeSessionId: text('opencode_session_id').notNull(),
  title: text('title'),
  status: text('status').$type<AgentSessionStatus>().notNull().default('active'),
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
