import type { HistoryEntry, TabRecord } from '../types';

export interface HistoryStore {
  append(entry: HistoryEntry): Promise<void>;
  query(q: {
    tabId?: string;
    limit?: number;
    since?: number;
    search?: string;
  }): Promise<HistoryEntry[]>;
  delete(ids: string[]): Promise<void>;
  deleteFor(tabId: string): Promise<void>;
}

export interface TabStore {
  put(tab: TabRecord): Promise<void>;
  get(id: string): Promise<TabRecord | undefined>;
  list(): Promise<TabRecord[]>;
  delete(id: string): Promise<void>;
}
