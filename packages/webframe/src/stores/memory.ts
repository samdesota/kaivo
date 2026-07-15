import type { HistoryEntry, TabRecord } from '../types';
import type { HistoryStore, TabStore } from './types';

export function createMemoryHistoryStore(): HistoryStore {
  const entries = new Map<string, HistoryEntry>();
  return {
    async append(entry) {
      entries.set(entry.id, entry);
    },
    async query(q) {
      let rows = Array.from(entries.values());
      if (q.tabId !== undefined) rows = rows.filter((r) => r.tabId === q.tabId);
      if (q.since !== undefined) rows = rows.filter((r) => r.visitedAt >= q.since!);
      if (q.search) {
        const needle = q.search.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.url.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle),
        );
      }
      rows.sort((a, b) => a.visitedAt - b.visitedAt);
      if (q.limit !== undefined) rows = rows.slice(0, q.limit);
      return rows;
    },
    async delete(ids) {
      for (const id of ids) entries.delete(id);
    },
    async deleteFor(tabId) {
      for (const [id, entry] of entries) {
        if (entry.tabId === tabId) entries.delete(id);
      }
    },
  };
}

export function createMemoryTabStore(): TabStore {
  const tabs = new Map<string, TabRecord>();
  return {
    async put(tab) {
      tabs.set(tab.id, { ...tab });
    },
    async get(id) {
      const t = tabs.get(id);
      return t ? { ...t } : undefined;
    },
    async list() {
      return Array.from(tabs.values()).map((t) => ({ ...t }));
    },
    async delete(id) {
      tabs.delete(id);
    },
  };
}
