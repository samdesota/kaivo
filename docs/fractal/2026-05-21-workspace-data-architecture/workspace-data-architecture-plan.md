# Workspace Data Architecture Plan

## Task 1: Startup Sync Foundation

Create the app-level data sync infrastructure and wire it into app startup without migrating workspace UI behavior yet. This establishes the shared abstraction every data module will use.

**Steps**
- Add `src/data/sync/collection-factory.ts`, `local-store.ts`, `realtime-client.ts`, `sync-registry.ts`, and `types.ts` with a DRY `defineSyncedCollection(...)` API.
- Add `src/data/startup-sync.ts` and `src/data/app-data-provider.tsx` so startup sync runs once above route rendering.
- Implement local hydration/cursor interfaces behind `local-store.ts`; the first pass may use browser storage or IndexedDB behind the abstraction, but callers must not depend on storage details.
- Implement realtime resume through existing `sync.changes` and table snapshot fallback through existing `sync.snapshot` until backend `snapshotMany`/stale-cursor support is added.
- Keep existing route/component queries untouched in this task except for adding the provider.

**Tests**
- E2E: Launch the app and verify the workspace route still renders with the startup sync provider mounted.
- Unit: `defineSyncedCollection` applies insert/update/delete events in sequence order and ignores duplicate/old events.
- Unit: startup sync hydrates local rows first, applies missed changes, and records the latest cursor.
- Unit: startup sync falls back to snapshots when the resume client reports stale local state.

**Maintainability**
- Avoid per-table sync copy-paste; table-specific modules should only provide config, normalizers, selectors, and commands.
- Keep storage details behind `local-store.ts` so switching persistence backends does not touch modules.
- Do not let React hooks call tRPC sync endpoints directly; all sync transport goes through `realtime-client.ts`.
- Keep this task behavior-preserving; do not mix foundational sync work with workspace UI migration.

**Depends on:** none

**Status:** done

## Task 2: Workspace And Folder Modules

Move workspaces and workspace folders into startup-synced data modules, then derive the sidebar tree locally instead of querying `workspace.listTree` from workspace components.

**Steps**
- Register `workspaces`, `workspace_folders`, and `workspace_view_states` in `server/realtime/app-realtime.ts`.
- Add `src/data/modules/workspaces/*` with collection, types, selectors, and commands for create, rename, archive, and mark-opened.
- Add `src/data/modules/workspace-folders/*` with collection, tree derivation, selectors, and commands for create, rename, archive, collapse, and move.
- Replace `WorkspaceSidebar` usage of `trpc.workspace.list`, `trpc.workspace.listTree`, folder mutations, workspace rename/archive mutations, and manual invalidation with module selectors and commands.
- Replace `WorkspaceTabBar` usage of `trpc.workspace.list` and workspace create/rename/archive mutations with module selectors and commands.
- Keep `workspace.listTree` available for non-migrated surfaces until they are migrated, but workspace route/sidebar/tab bar must not depend on it.

**Tests**
- E2E: Switching between two existing workspaces does not issue `workspace.list`, `workspace.listTree`, or `workspace.get` network calls from workspace route/sidebar/tab bar after startup sync is ready.
- E2E: Create a workspace from the tab bar, rename it inline, switch away/back, and verify the name persists without a full workspace list refetch.
- E2E: Create a folder in the sidebar, move a workspace into it, collapse/expand it, reload the app, and verify the derived tree matches persisted state.
- Unit: `buildWorkspaceSidebarTree` handles root folders, nested folders, archived rows, hidden/system workspaces, and deterministic ordering.
- Unit: workspace/folder commands optimistically update collections and reconcile/revert on backend failure.

**Maintainability**
- Keep tree building pure in `workspace-folders/tree.ts`; React components should not rebuild tree logic inline.
- Commands should express product actions, not tRPC procedure names, so component code remains stable if backend APIs change.
- Avoid duplicating optimistic update code between workspaces and folders; extract tiny shared helpers only when they are actually reused.
- Preserve existing DnD projection code, but route final persistence through `moveWorkspaceSidebarNode`.

**Depends on:** Task 1

**Status:** done

## Task 3: Workspace View State And Pane Tabs

Move workspace view state and workspace pane tabs into modules so workspace route switching is a local read and workspace pane mutations are command calls.

**Steps**
- Add `src/data/modules/workspace-view-state/*` with selectors and commands for active agent session, active workspace tab, split ratio, and agent collapsed state.
- Add `src/data/modules/workspace-tabs/*` with collection, selectors, tab conversion helpers, and commands for open, close, reorder, browser id, URL, and title changes.
- Replace `useWorkspaceViewStateStore` and `useWorkspaceTabsStore` usage in `WorkspaceRoutePage`, `WorkspaceShell`, and `WorkspaceTabPane` with the new modules.
- Remove route-level loading gates for workspace get, workspace tabs, and workspace view state; missing local data should render a lightweight not-found or empty state, not trigger per-switch fetches.
- Keep active tab content loading scoped to `WorkspaceTabContent`; do not migrate terminal output, file content, browser content, bookmarks, resources, shells, or favicons in this task.
- Move URL search synchronization into a thin adapter that only calls `workspace-view-state` commands.

**Tests**
- E2E: Open shell/browser/file workspace tabs, switch to another workspace and back, and verify tab strip and active tab restore without route-level data fetches.
- E2E: Reorder and close workspace pane tabs, reload the app, and verify order/active fallback persist.
- E2E: Change split ratio and collapse/expand the agent pane, switch workspaces, and verify each workspace keeps its own view state.
- Unit: workspace tab commands calculate positions, avoid duplicate tabs by `workspaceTabKey`, and choose active fallback correctly on close.
- Unit: URL sync adapter applies `chat`/`tab` search params once per workspace and does not loop when state changes update the URL.

**Maintainability**
- Keep tab normalization/conversion in the module; components should render `WorkspaceTab` objects, not database records.
- Do not preserve old `useWorkspaceTabsStore`/`useWorkspaceViewStateStore` wrappers as compatibility layers unless needed temporarily inside the migration task.
- Keep workspace-route code declarative: derive a view, provide context, render shell.
- Avoid moving active tab content data into startup sync; that would violate the desired loading boundary.

**Depends on:** Task 2

**Status:** done

## Task 4: Agent Tab Ordering Module

Move persisted agent tab ordering into the new module pattern while leaving agent session summaries and transcript content outside startup sync.

**Steps**
- Add `src/data/modules/workspace-agent-tabs/*` with collection, selectors, ordering helper, and commands for ensure, delete, and reorder.
- Replace `useWorkspaceAgentTabsStore` usage in `SessionTabs` with module selectors and commands.
- Keep `agent.sessionList` ownership outside this module; `SessionTabs` receives or reads session summaries from the agent data layer and uses this module only for ordering/persistence.
- Ensure agent tab commands optimistically persist order without query invalidation.
- Audit workspace components to remove remaining imports from old first-slice store files.

**Tests**
- E2E: Open multiple agent sessions, reorder tabs, switch workspaces and back, and verify ordering persists without fetching workspace-agent-tab snapshots per switch.
- E2E: Close an agent tab and verify the next active session selection is correct after workspace switch and reload.
- Unit: `orderAgentSessionsByTabs` preserves stored order, appends sessions missing tab records deterministically, and ignores tab records for missing/archived sessions.
- Unit: agent tab commands create missing records once and update positions without duplicate records.

**Maintainability**
- Keep session lifecycle separate from tab ordering; this module must not fetch transcripts or session summaries.
- Keep ordering helper pure and reusable by tests and React.
- Do not add component-level invalidation after command calls; realtime/local reconciliation owns consistency.
- Remove dead old store code only after all imports are gone.

**Depends on:** Task 3

## Task 5: Workspace Switch No-Fetch Guardrails

Add verification and cleanup so workspace switching remains local-data-only for the migrated slice.

**Steps**
- Add a test helper that records app/env tRPC operations during workspace switching.
- Add an E2E scenario dedicated to switching workspaces after startup sync is ready.
- Fail the scenario if migrated app-side procedures run during a workspace switch: `workspace.list`, `workspace.listTree`, `workspace.get`, `workspace.getViewState`, `workspace.listTabs`, or `workspace.listAgentTabs`.
- Allow tab-content-specific calls only when active tab content mounts, such as shell list, terminal attach, file read, browser setup, or agent session content.
- Remove obsolete first-slice query invalidations and old store files that are no longer imported.

**Tests**
- E2E: After startup sync readiness, switch workspaces via sidebar and top tab bar; assert no migrated-slice app data procedures run during the switch.
- E2E: Switch to a workspace with an active shell tab; assert shell/tab-content loading may occur but workspace/sidebar/tab metadata procedures do not.
- Unit: module exports remain the only import path for first-slice data access; legacy store files are not imported by workspace route code.

**Maintainability**
- Encode the no-fetch policy in tests so future component changes cannot quietly reintroduce tRPC hooks.
- Keep the procedure allow/deny list explicit and documented near the E2E helper.
- Delete migrated compatibility code instead of leaving parallel data paths.
- Keep guardrail tests focused on the first slice; do not block known non-migrated data modules yet.

**Depends on:** Task 4
