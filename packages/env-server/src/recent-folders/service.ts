import path from 'node:path'
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
  list(): RecentFolderSummary[] {
    return db
      .select()
      .from(recentFolders)
      .orderBy(desc(recentFolders.lastOpenedAt))
      .all()
      .map(toSummary)
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

export const recentFolderService = new RecentFolderService()
