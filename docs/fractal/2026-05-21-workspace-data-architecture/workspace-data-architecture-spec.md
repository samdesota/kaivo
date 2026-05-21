# Workspace Data Architecture Spec

## Seed

Rework workspace data loading so workspace tab switches do not fetch broad workspace data. Shared workspace-level data should be loaded through TanStack DB stores with command files for optimistic writes and backend calls, while only the content inside an active workspace tab loads tab-specific data such as session details or terminal output.

## Solution

- Startup sync: app-level data loads once at app startup, hydrates TanStack DB collections, then stays current from realtime changes.
- Module boundary: every persisted table gets one data module with schema/types, collection, selectors, commands, and tests.
- React boundary: workspace React components read derived module state and call commands; they do not own tRPC queries, invalidation, snapshots, or optimistic mutation logic.
- First slice: migrate `workspaces`, `workspace_folders`, `workspace_tabs`, and `workspace_agent_tabs` into the new module pattern.
- Realtime contract: use snapshots only for initial hydration or stale-cursor recovery; normal startup resumes from local cursors and replays only missed changes.

## Spec

### Target File Tree

```text
src/data/
  app-data-provider.tsx
  startup-sync.ts
  sync/
    collection-factory.ts
    local-store.ts
    realtime-client.ts
    sync-registry.ts
    types.ts
  modules/
    workspaces/
      commands.ts
      collection.ts
      selectors.ts
      types.ts
      index.ts
    workspace-folders/
      commands.ts
      collection.ts
      selectors.ts
      tree.ts
      types.ts
      index.ts
    workspace-tabs/
      commands.ts
      collection.ts
      selectors.ts
      types.ts
      index.ts
    workspace-agent-tabs/
      commands.ts
      collection.ts
      selectors.ts
      types.ts
      index.ts
    workspace-view-state/
      commands.ts
      collection.ts
      selectors.ts
      types.ts
      index.ts
  views/
    workspace-shell-view.ts
    workspace-sidebar-view.ts
    workspace-tab-bar-view.ts
    agent-tabs-view.ts

server/realtime/
  app-realtime.ts

server/trpc/routers/
  sync.ts
```

Existing `src/routes/workspace/*-store.ts` files become migration sources only. Their collection setup, normalizers, optimistic writes, and backend calls move into `src/data/modules/*`.

### Shared Sync Abstraction

`src/data/sync/collection-factory.ts` defines the DRY collection pattern used by every module.

```ts
type SyncedCollectionConfig<Row, Key extends string> = {
  table: SyncTableName
  id: string
  getKey(row: Row): Key
  normalize(raw: unknown): Row
}

export function defineSyncedCollection<Row, Key extends string>(config: SyncedCollectionConfig<Row, Key>) {
  return {
    collection,
    useRows,
    getRows,
    applySnapshot,
    applyChanges,
    markHydrated,
  }
}
```

The factory owns TanStack DB setup, local hydration, snapshot application, realtime change application, and cursor updates. Modules provide only table-specific type conversion and selectors.

`src/data/sync/sync-registry.ts` registers the startup-loaded tables:

```ts
export const appSyncTables = [
  workspacesCollection,
  workspaceFoldersCollection,
  workspaceTabsCollection,
  workspaceAgentTabsCollection,
  workspaceViewStateCollection,
]
```

`src/data/startup-sync.ts` runs once under `AppDataProvider`:

```ts
export async function startAppDataSync() {
  await hydrateCollectionsFromLocalStore(appSyncTables)

  const cursor = await readLocalSyncCursor('app')
  const result = await syncClient.resume({ afterSeq: cursor.seq, tables: appSyncTables.map(t => t.table) })

  if (result.type === 'changes') {
    applyChangesToCollections(result.events)
  } else {
    const snapshot = await syncClient.snapshotMany(appSyncTables.map(t => t.table))
    applySnapshotsToCollections(snapshot)
  }

  subscribeToRealtimeChanges({ afterSeq: latestAppliedSeq() })
}
```

The first implementation may use existing `sync.snapshot(table)` and `sync.changes(afterSeq, tables)` endpoints internally, but React components must not call them directly.

### Backend Realtime Scope

`server/realtime/app-realtime.ts` must register the first-slice tables:

```ts
workspaces
workspace_folders
workspace_tabs
workspace_agent_tabs
workspace_view_states
```

The current app realtime engine already supports `workspace_tabs` and `workspace_agent_tabs`. `workspaces`, `workspace_folders`, and `workspace_view_states` need table registrations so they can use the same startup sync path.

### Data Modules

#### `workspaces`

Owns workspace rows and workspace-level commands.

```ts
// selectors.ts
export function useWorkspace(workspaceId: string): WorkspaceRecord | null
export function useWorkspaces(): WorkspaceRecord[]
export function useVisibleWorkspaces(): WorkspaceRecord[]
export function getWorkspace(workspaceId: string): WorkspaceRecord | null

// commands.ts
export async function createWorkspace(input?: CreateWorkspaceInput): Promise<WorkspaceRecord>
export async function renameWorkspace(input: { id: string; name: string }): Promise<void>
export async function archiveWorkspace(id: string): Promise<void>
export async function markWorkspaceOpened(id: string): Promise<void>
```

Commands optimistically update the `workspaces` collection, call the backend, then reconcile from realtime. Components never invalidate `workspace.list` or `workspace.listTree`.

#### `workspace-folders`

Owns folder rows and tree derivation.

```ts
// selectors.ts
export function useWorkspaceFolders(): WorkspaceFolderRecord[]
export function useWorkspaceSidebarTree(): WorkspaceSidebarNode[]

// tree.ts
export function buildWorkspaceSidebarTree(input: {
  workspaces: WorkspaceRecord[]
  folders: WorkspaceFolderRecord[]
}): WorkspaceSidebarNode[]

// commands.ts
export async function createWorkspaceFolder(input: { name: string; parentId?: string | null }): Promise<WorkspaceFolderRecord>
export async function renameWorkspaceFolder(input: { id: string; name: string }): Promise<void>
export async function archiveWorkspaceFolder(id: string): Promise<void>
export async function setWorkspaceFolderCollapsed(input: { id: string; collapsed: boolean }): Promise<void>
export async function moveWorkspaceSidebarNode(input: MoveSidebarNodeInput): Promise<void>
```

`workspace.listTree` stops being a component query. The tree is derived locally from synced `workspaces` and `workspace_folders` rows.

#### `workspace-tabs`

Owns non-agent workspace pane tabs.

```ts
// selectors.ts
export function useWorkspaceTabs(workspaceId: string): WorkspaceTab[]
export function getWorkspaceTabs(workspaceId: string): WorkspaceTab[]
export function useActiveWorkspaceTab(workspaceId: string): WorkspaceTab | null

// commands.ts
export function openWorkspaceTab(input: { workspaceId: string; tab: WorkspaceTab; activate?: boolean }): WorkspaceTab
export function closeWorkspaceTab(input: { workspaceId: string; tabId: string }): void
export function reorderWorkspaceTabs(input: { workspaceId: string; tabIds: string[] }): void
export function setWorkspaceTabBrowserId(input: { workspaceId: string; tabId: string; browserTabId: string }): void
export function setWorkspaceTabUrl(input: { workspaceId: string; tabId: string; url: string }): void
export function setWorkspaceTabTitle(input: { workspaceId: string; tabId: string; title: string; source?: 'auto' | 'explicit' }): void
```

Commands write the collection optimistically and call `workspace.upsertTab` or `workspace.deleteTab`. Position calculation stays in the module.

#### `workspace-agent-tabs`

Owns persisted ordering of agent chat tabs, not session data.

```ts
// selectors.ts
export function useWorkspaceAgentTabRecords(workspaceId: string): WorkspaceAgentTabRecord[]
export function orderAgentSessionsByTabs(input: {
  sessions: AgentSessionSummary[]
  tabs: WorkspaceAgentTabRecord[]
}): AgentSessionSummary[]

// commands.ts
export function ensureWorkspaceAgentTab(input: { workspaceId: string; sessionId: string }): void
export function deleteWorkspaceAgentTab(input: { workspaceId: string; sessionId: string }): void
export function reorderWorkspaceAgentTabs(input: { workspaceId: string; sessionIds: string[] }): void
```

This module does not fetch `agent.sessionList`; it only orders whatever session summaries the agent data layer supplies.

#### `workspace-view-state`

Owns active workspace tab, active agent session, split ratio, and agent collapse state.

```ts
// selectors.ts
export function useWorkspaceViewState(workspaceId: string): WorkspaceViewStateRecord

// commands.ts
export function setActiveWorkspaceTab(input: { workspaceId: string; tabId: string | null }): void
export function setActiveAgentSession(input: { workspaceId: string; sessionId: string | null }): void
export function setWorkspaceSplitRatio(input: { workspaceId: string; splitRatio: number | null }): void
export function setAgentCollapsed(input: { workspaceId: string; collapsed: boolean }): void
```

This keeps active-tab writes out of `WorkspaceRoutePage` and makes URL sync a thin adapter over commands.

### Workspace Component Pseudocode

`WorkspaceRoutePage` becomes route binding plus view selection. It should not fetch.

```tsx
function WorkspaceRoutePage({ workspaceId, search }) {
  const view = useWorkspaceShellView(workspaceId)

  useWorkspaceSearchSync({ workspaceId, search })

  if (!view.workspace) return <WorkspaceError message="Workspace not found" />

  return (
    <WorkspaceContextProvider value={view.context}>
      <WorkspaceShell />
    </WorkspaceContextProvider>
  )
}
```

`WorkspaceShell` receives already-derived state and dispatches commands.

```tsx
function WorkspaceShell() {
  const view = useWorkspaceShellViewContext()

  return (
    <ShellChrome
      title={view.workspace.name}
      left={<WorkspaceAgentPane />}
      right={view.workspaceTabs.length ? <WorkspaceTabPane /> : <WorkspaceEmptyPaneCta />}
      leftCollapsed={view.agentCollapsed}
      onSplitRatioChange={(splitRatio) => setWorkspaceSplitRatio({ workspaceId: view.workspace.id, splitRatio })}
    />
  )
}
```

`WorkspaceSidebar` reads one derived tree and calls commands.

```tsx
function WorkspaceSidebar() {
  const tree = useWorkspaceSidebarTree()
  const activeWorkspaceId = useActiveWorkspaceId()

  return <SidebarTree
    nodes={tree}
    activeWorkspaceId={activeWorkspaceId}
    onCreateFolder={(parentId) => createWorkspaceFolder({ name: 'New folder', parentId })}
    onRenameWorkspace={(id, name) => renameWorkspace({ id, name })}
    onRenameFolder={(id, name) => renameWorkspaceFolder({ id, name })}
    onToggleFolder={(id, collapsed) => setWorkspaceFolderCollapsed({ id, collapsed })}
    onMoveNode={(input) => moveWorkspaceSidebarNode(input)}
    onArchiveWorkspace={(id) => archiveWorkspace(id)}
  />
}
```

`WorkspaceTabPane` reads tab rows and active view state. It only renders active tab content.

```tsx
function WorkspaceTabPane() {
  const { workspaceId } = useWorkspaceShellViewContext()
  const tabs = useWorkspaceTabs(workspaceId)
  const activeTab = useActiveWorkspaceTab(workspaceId)

  return <TabsLayout
    tabs={tabs}
    activeTabId={activeTab?.id ?? null}
    onSelect={(tabId) => setActiveWorkspaceTab({ workspaceId, tabId })}
    onClose={(tabId) => closeWorkspaceTab({ workspaceId, tabId })}
    onReorder={(tabIds) => reorderWorkspaceTabs({ workspaceId, tabIds })}
  >
    {activeTab ? <WorkspaceTabContent tab={activeTab} /> : <EmptyPane />}
  </TabsLayout>
}
```

`SessionTabs` keeps session loading separate from agent-tab ordering.

```tsx
function SessionTabs({ workspaceId, sessions }) {
  const tabRecords = useWorkspaceAgentTabRecords(workspaceId)
  const ordered = orderAgentSessionsByTabs({ sessions, tabs: tabRecords })

  useEffect(() => {
    for (const session of sessions) ensureWorkspaceAgentTab({ workspaceId, sessionId: session.id })
  }, [workspaceId, sessions])

  return <BorderedTabStrip
    items={ordered.map(sessionToTabItem)}
    onSelect={(sessionId) => setActiveAgentSession({ workspaceId, sessionId })}
    onClose={(sessionId) => deleteWorkspaceAgentTab({ workspaceId, sessionId })}
    onReorder={(sessionIds) => reorderWorkspaceAgentTabs({ workspaceId, sessionIds })}
  />
}
```

### Non-Goals For This Slice

- Do not migrate terminal content, transcript content, file contents, resources, bookmarks, notifications, or favicon cache yet.
- Do not make workspace switching wait on agent sessions, shell lists, terminal output, transcript hydration, or file/browser tab content.
- Do not keep compatibility queries in components after their module exists; the module owns backend access.
