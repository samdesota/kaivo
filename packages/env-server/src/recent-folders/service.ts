import path from 'node:path'
import fs from 'node:fs/promises'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { recentFolders } from '../db/schema.js'

export interface RecentFolderSummary {
  path: string
  label: string | null
  lastOpenedAt: Date
}

function toSummary(row: typeof recentFolders.$inferSelect): RecentFolderSummary {
  return {
    path: row.path,
    label: row.label,
    lastOpenedAt: new Date(row.lastOpenedAt),
  }
}

function labelFor(folderPath: string): string {
  return path.basename(folderPath) || folderPath
}

class RecentFolderService {
  async list(): Promise<RecentFolderSummary[]> {
    const rows = db
      .select()
      .from(recentFolders)
      .orderBy(desc(recentFolders.lastOpenedAt))
      .all()
    const existing: RecentFolderSummary[] = []
    for (const row of rows) {
      if (await isExistingDirectory(row.path)) existing.push(toSummary(row))
      else this.remove(row.path)
    }
    return existing
  }

  upsert(folderPath: string, label?: string | null): RecentFolderSummary {
    const normalized = path.resolve(folderPath)
    const now = new Date()
    const row = {
      path: normalized,
      label: label ?? labelFor(normalized),
      lastOpenedAt: now.toISOString(),
    }
    db.insert(recentFolders)
      .values(row)
      .onConflictDoUpdate({
        target: recentFolders.path,
        set: { label: row.label, lastOpenedAt: row.lastOpenedAt },
      })
      .run()
    return toSummary(row)
  }

  remove(folderPath: string): void {
    db.delete(recentFolders).where(eq(recentFolders.path, path.resolve(folderPath))).run()
  }
}

async function isExistingDirectory(folderPath: string): Promise<boolean> {
  try {
    return (await fs.stat(folderPath)).isDirectory()
  } catch {
    return false
  }
}

export const recentFolderService = new RecentFolderService()
