import { pgTable, text, timestamp, integer, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export type SandboxStatus = 'active' | 'archived' | 'crashed'

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
