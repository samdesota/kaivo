import Database from 'better-sqlite3'
import { env } from '../env.js'

export type LocalEnvRegistration = {
  id: string
  label: string
  url: string
  envToken: string
  localIdentityLabel: string
}

export function getLocalEnvRegistration(id: string): LocalEnvRegistration | null {
  const sqlite = new Database(env.APP_SQLITE_PATH)
  try {
    const row = sqlite.prepare('SELECT id, label, url, env_token, local_identity_label FROM envs WHERE id = ?').get(id) as
      | { id: string; label: string; url: string; env_token: string | null; local_identity_label: string | null }
      | undefined
    if (!row?.env_token) return null
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      envToken: row.env_token,
      localIdentityLabel: row.local_identity_label ?? row.label,
    }
  } finally {
    sqlite.close()
  }
}

export function upsertLocalEnvRegistration(input: LocalEnvRegistration): LocalEnvRegistration {
  const sqlite = new Database(env.APP_SQLITE_PATH)
  try {
    sqlite.prepare(`
      INSERT INTO envs (id, kind, label, url, env_token, local_identity_label, status, last_seen_at)
      VALUES (?, 'local', ?, ?, ?, ?, 'running', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        url = excluded.url,
        env_token = excluded.env_token,
        local_identity_label = excluded.local_identity_label,
        status = 'running',
        archived_at = NULL,
        last_seen_at = datetime('now')
    `).run(input.id, input.label, input.url, input.envToken, input.localIdentityLabel)
    return input
  } finally {
    sqlite.close()
  }
}
