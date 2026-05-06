# Backend Pane Opening Plan

## Task 1: Share Pane-To-Tab Semantics

Move the logical tab key, tab id, and pane-content-to-workspace-tab mapping into code that both backend and frontend can use. This keeps duplicate detection and titles identical across frontend clicks and agent tool calls.

**Steps**
- Create or relocate a shared workspace pane helper for `PaneContent` to `WorkspaceTab` conversion.
- Replace frontend-only `workspaceTabFromPaneContent` and `workspaceTabKey` call sites with the shared helper.
- Use deterministic logical keys for duplicate detection while preserving stable persisted tab ids.

**Tests**
- Unit: shared pane helper converts shell, file, preview, and browser content with expected keys and titles.
- Unit: duplicate logical keys match existing workspace UI behavior.
- Manual: open the same file from the workspace UI twice and observe one focused tab.

**Depends on:** none

**Status:** done

## Task 2: Add Backend Workspace Open-Pane Service

Add a workspace service method that atomically opens or focuses a tab in `workspace_tabs` and optionally updates `workspace_view_states`. This is the backend source of truth for pane opening.

**Steps**
- Add `workspaceService.openPane` with inputs for `workspaceId`, `envId`, `content`, `title`, and `activate`.
- Reuse existing tab rows when the logical tab key already exists.
- Insert new tabs at the next position and set `activeWorkspaceTabId` unless `activate === false`.

**Tests**
- Unit: new pane inserts one `workspace_tabs` row and activates it.
- Unit: duplicate pane focuses existing row without adding another row.
- Unit: `activate:false` inserts or finds the tab without changing active tab.

**Depends on:** Task 1

**Status:** done

## Task 3: Expose Env-To-Identity Open-Pane API

Add an identity-authenticated env API mutation so `cc-env` can persist pane state in the app backend. This keeps the write available when no browser frontend is mounted.

**Steps**
- Add `envApi.openPane` on the app server, authenticated by `identityProcedure`.
- Validate workspace id, env id, and pane content before calling `workspaceService.openPane`.
- Add a mutation helper to `packages/env-server/src/identity/client.ts`.

**Tests**
- Integration: `envApi.openPane` accepts an identity token and persists a file tab.
- Integration: invalid or missing workspace returns a typed tRPC error.
- Unit: env identity client encodes mutation requests with bearer auth.

**Depends on:** Task 2

**Status:** done

## Task 4: Persist `agentUi.openPane`

Change the current `cloud_open_pane` backend handler from transient event publication to durable workspace state writes. Existing live events remain only as refresh hints.

**Steps**
- Resolve `opencodeSessionId` to env `agentSessions.workspaceId` and working directory.
- Resolve relative file paths before sending content to identity.
- Compute the local env id from the configured instance identity and call the new identity mutation.
- Publish an event after persistence for already-mounted frontends.

**Tests**
- Integration: `agentUi.openPane` persists a tab when no frontend has subscribed.
- Integration: relative file paths resolve against the agent working directory.
- Unit: missing workspace on the agent session returns a clear error.

**Depends on:** Task 3

**Status:** done

## Task 5: Refresh Mounted Workspace UI

Update frontend subscription handling so mounted workspaces refresh backend-backed tab/view-state stores after a backend pane write. The frontend no longer owns the open operation.

**Steps**
- Replace direct `onOpenPane` handling for agent UI events with invalidation or collection refresh of workspace tabs and view state.
- Keep legacy env shell behavior unchanged if it still uses local pane state outside workspaces.
- Ensure activation follows the backend `activeWorkspaceTabId` after refresh.

**Tests**
- Integration: subscribed workspace refreshes and shows a backend-opened tab.
- Unit: `open_pane` event handler triggers refresh without constructing a tab locally.
- Manual: call `cloud_open_pane` while the workspace is open and observe the tab appear/focus.

**Depends on:** Task 4

**Status:** done

## Task 6: End-To-End Regression Coverage

Add coverage that proves pane opening is backend-owned across plugin, env-server, app backend, and frontend refresh boundaries.

**Steps**
- Extend plugin tests only if the `agentUi.openPane` wire contract changes.
- Add a no-frontend regression that invokes the backend mutation path and then reads `workspace.listTabs` and `workspace.getViewState`.
- Add a mounted-frontend regression that receives a refresh hint and hydrates the persisted tab.

**Tests**
- Integration: `cloud_open_pane` file flow persists and activates a workspace tab with no frontend subscriber.
- Integration: shell, preview, and browser pane types persist with correct identity fields.
- Manual: start `npm run dev:web`, run `cloud_open_pane`, reload the browser, and confirm the pane remains open.

**Depends on:** Task 5

**Status:** done
