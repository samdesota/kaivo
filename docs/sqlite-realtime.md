# SQLite Realtime Tables

This project uses trigger-based SQLite CDC for TanStack DB collections that need backend-to-frontend realtime updates.

## Architecture

1. `SqliteRealtimeEngine` installs `AFTER INSERT`, `AFTER UPDATE`, and `AFTER DELETE` triggers for configured tables.
2. Triggers append durable rows to `cc_realtime_log` and call `cc_realtime_notify()`.
3. `cc_realtime_notify()` schedules an engine drain on the owning Node process.
4. The engine reads committed log rows in `seq` order and pushes batches to subscribers.
5. `sync.snapshot` returns current table rows plus the current log `seq`.
6. `sync.changes` streams missed and future events after a client-provided `afterSeq`.
7. Frontend collections hydrate from `sync.snapshot` and reconcile events through Query Collection direct write utilities.

Do not call normal collection `insert`, `update`, or `delete` for backend CDC events. Those methods create optimistic mutations and will call mutation handlers. Use `collection.utils.writeUpsert`, `collection.utils.writeDelete`, and `collection.utils.writeBatch` for remote sync events.

## Adding A Table

Register the table in the relevant realtime engine.

```ts
new SqliteRealtimeEngine(sqlite, [
  {
    table: 'workspace_tabs',
    keyColumns: ['workspace_id', 'id'],
    columns: [
      { name: 'workspace_id', jsonName: 'workspaceId' },
      { name: 'id' },
      { name: 'title' },
      { name: 'updated_at', jsonName: 'updatedAt' },
    ],
  },
])
```

Rules:

- `table`, `keyColumns`, and column `name` values are SQLite identifiers and must be trusted static strings.
- `keyColumns` must match the collection identity, not just a display id.
- `columns` should include every field the frontend needs to reconcile a full row update.
- Use `jsonName` to convert snake_case SQLite columns to frontend record names.
- The engine must be initialized before writes to watched tables on that SQLite connection.

## Frontend Collection Pattern

Hydrate from `sync.snapshot`:

```ts
queryFn: async () => {
  const snapshot = await appTrpcQuery('sync.snapshot', { table: 'workspace_tabs' })
  syncedSeqRef.current = Math.max(syncedSeqRef.current, snapshot.seq)
  return snapshot.rows.map(normalizeRow)
}
```

Subscribe and reconcile:

```ts
trpc.sync.changes.useSubscription(
  { afterSeq: syncedSeqRef.current, tables: ['workspace_tabs'] },
  {
    onData(events) {
      collection.utils.writeBatch(() => {
        for (const event of events) {
          if (event.seq <= syncedSeqRef.current) continue
          if (event.op === 'delete') collection.utils.writeDelete(event.key)
          else if (event.row) collection.utils.writeUpsert(normalizeRow(event.row))
          syncedSeqRef.current = event.seq
        }
      })
    },
  },
)
```

## Idempotency

CDC events are expected to be replayable.

- Track the highest applied `seq` per collection subscription.
- Ignore events with `seq <= appliedSeq`.
- Apply inserts and updates with `writeUpsert`.
- Apply deletes with `writeDelete` only if the collection key is present or safely no-op.
- It is correct for a client to receive its own optimistic mutation back from the backend. The returned CDC row is the source-of-truth confirmation and overwrites the optimistic row by key.

## Primary Key Caveats

Stable keys are mandatory.

- Prefer client-generated stable IDs such as ULIDs for user-created rows.
- For composite primary keys, use all primary key columns in `keyColumns`.
- Do not use array position, row order, or mutable names as collection keys.
- If the server assigns the final key, the optimistic client row needs a temporary-id mapping strategy before this pattern is safe.
- If a primary key changes, SQLite CDC represents it as an update with a new key. Avoid mutable primary keys; model key changes as delete plus insert if needed.

## Conflict Semantics

The default policy is last committed SQLite event wins.

- Optimistic local writes are immediate.
- Backend CDC events are applied in global `seq` order.
- Later committed updates overwrite earlier local state.
- Deletes from the backend win over pending local updates for the same key.

Collection-specific merge logic can be added later, but the default should stay simple and idempotent.

## Operational Caveats

- Triggers call `cc_realtime_notify()`, so the owning SQLite connection must register the realtime engine before writes.
- External writers that do not register this function will fail when touching watched tables. If we need external writers, add a no-notify trigger mode plus polling drain.
- `cc_realtime_log` is append-only. Add retention/checkpointing after clients persist resume cursors.
- The engine captures database table changes, not derived query shapes. Frontend stores should filter rows locally or define domain-specific views on top.
