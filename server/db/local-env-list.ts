import Database from 'better-sqlite3'
import { env } from '../env.js'

export type LocalEnvSummary = {
  id: string
  kind: 'local'
  label: string
  url: string
  envToken: string | null
  localIdentityLabel: string | null
  status: 'running' | 'archived' | 'crashed' | 'unreachable'
  containerId: null
  createdAt: Date
  archivedAt: Date | null
  lastSeenAt: Date | null
}

export function listLocalEnvRegistrations(): LocalEnvSummary[] {
  const sqlite = new Database(env.APP_SQLITE_PATH)
  try {
    const rows = sqlite.prepare(`
      SELECT id, label, url, env_token, local_identity_label, status, created_at, archived_at, last_seen_at
      FROM envs
      WHERE kind = 'local'
      ORDER BY created_at DESC
    `).all() as Array<{
      id: string
      label: string
      url: string
      env_token: string | null
      local_identity_label: string | null
      status: 'running' | 'archived' | 'crashed' | 'unreachable'
      created_at: string
      archived_at: string | null
      last_seen_at: string | null
    }>
    return rows.map((row) => ({
      id: row.id,
      kind: 'local' as const,
      label: row.label,
      url: row.url,
      envToken: row.env_token,
      localIdentityLabel: row.local_identity_label,
      status: row.status,
      containerId: null,
      createdAt: new Date(row.created_at),
      archivedAt: row.archived_at ? new Date(row.archived_at) : null,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    }))
  } finally {
    sqlite.close()
  }
}
