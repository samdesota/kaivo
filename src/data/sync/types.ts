export type SyncTableName =
  | 'workspaces'
  | 'workspace_folders'
  | 'workspace_tabs'
  | 'workspace_agent_tabs'
  | 'workspace_view_states'
  | 'agent_notifications'
  | 'workspace_resources'
  | 'bookmarks'

export type SyncChangeOp = 'insert' | 'update' | 'delete'

export type SyncChangeEvent<Row = Record<string, unknown>> = {
  seq: number
  table: SyncTableName | string
  op: SyncChangeOp
  key: string
  row: Row | null
  committedAt?: number
}

export type SyncSnapshot<Row = Record<string, unknown>> = {
  table: SyncTableName | string
  rows: Row[]
  seq: number
}

export type SyncCursor = {
  seq: number
}

export type ResumeSyncResult =
  | { type: 'changes'; events: SyncChangeEvent[] }
  | { type: 'stale' }

export type SyncClient = {
  resume(input: { afterSeq: number; tables: SyncTableName[] }): Promise<ResumeSyncResult>
  snapshot(table: SyncTableName): Promise<SyncSnapshot>
  snapshotMany(tables: SyncTableName[]): Promise<SyncSnapshot[]>
  subscribe(input: {
    afterSeq: number
    tables: SyncTableName[]
    onEvents: (events: SyncChangeEvent[]) => void
    onError?: (error: unknown) => void
  }): SyncSubscription
}

export type SyncSubscription = {
  unsubscribe(): void
  ready?: Promise<void>
}
