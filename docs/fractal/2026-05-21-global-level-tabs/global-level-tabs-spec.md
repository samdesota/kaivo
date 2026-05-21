# Global-Level Tabs Spec

## Seed

Kaivo needs global-level tabs that live outside any chat or workspace. Opening a web pane with `Cmd+Shift+T`, or submitting anything from the new-tab modal while holding `Shift` (bookmark, typed URL, or search), should create a tab above the workspace list in the sidebar with a favicon on the left and remain accessible across workspaces.

## Solution

- Scope: global tabs are browser panes owned by an auto-created system workspace, not by any user workspace or chat.
- Persistence: mark the system workspace as hidden/protected so it is excluded from workspace lists, landing defaults, pickers, rename/archive flows, and foldering.
- Creation: `Cmd+Shift+T` opens the new-tab modal in global mode; holding `Shift` while submitting a bookmark, typed URL, or search creates a global tab.
- Rendering: show global tabs in the sidebar above the workspace list, with favicon-first rows and active/close behavior matching existing tab affordances.
- Browser runtime: reuse the existing browser pane/native tab lifecycle, URL normalization, title updates, and favicon cache.
- Focus model: the sidebar has one active destination at a time; selecting a global tab makes that tab active and clears the active workspace highlight.

## Spec

### Concepts

Global tabs are normal browser pane tabs whose ownership is a reserved system workspace instead of a user workspace. The system workspace exists to reuse existing pane persistence, sync, browser resource tracking, and favicon behavior while keeping global tabs out of user workspace management.

The sidebar has one active destination at a time: either a user workspace/chat destination or a global tab. When a global tab is active, no user workspace row is highlighted as active.

### System Workspace

Kaivo must support a first-class system workspace record for global tabs.

Workspace records need enough metadata to distinguish ordinary user workspaces from internal workspaces:

```ts
type WorkspaceKind = "user" | "system";

type SystemWorkspaceKey = "global-tabs";
```

The global-tabs workspace has these properties:

- `kind: "system"`
- `systemKey: "global-tabs"`
- hidden from normal workspace list and tree queries
- protected from rename, archive, folder assignment, drag/drop ordering, cleanup, and user-facing pickers
- directly usable by internal tab/resource APIs that need a `workspaceId`

Creation is idempotent. Any code path that needs global tabs may request the global-tabs workspace and receive the existing row or create it if missing. User-facing workspace creation must never create or expose this workspace.

Default workspace selection and landing behavior must ignore hidden/system workspaces. If only the global-tabs workspace exists, landing still creates or selects a normal user workspace according to current behavior.

### Persistence And Resources

Global tabs use the existing workspace pane tab model with the global-tabs workspace id. A global browser tab is still a `browser` pane tab, with the same id, URL, title, active state, ordering, and resource linkage semantics used by workspace browser panes.

The app should not introduce a second browser-tab persistence model. Global-specific behavior is derived from the owning workspace being the global-tabs system workspace.

The existing favicon cache remains the source of truth for favicon display. Global tab rows use the same favicon lookup and fallback behavior as browser pane tab strips.

### Sidebar UI

The sidebar renders a global tabs section above the user workspace list. The section is visible only when at least one global tab exists.

Each global tab row shows:

- favicon on the left, using cached favicon when available and the browser/default fallback otherwise
- title from the tab title when available, otherwise a readable URL/search label
- close affordance consistent with existing tab close behavior
- active styling when it is the active sidebar destination

Global tab rows are not workspace rows. They do not participate in workspace multi-select, range selection, drag/drop, folder nesting, rename, archive, or workspace context actions.

Closing the active global tab selects another global tab if one exists. If no global tabs remain, Kaivo returns to the last active user workspace destination when known; otherwise it uses the normal landing/default workspace behavior.

### Main Content Behavior

Activating a global tab displays that browser pane in the main content area. The browser pane uses the same native webview slot lifecycle as workspace browser tabs, including attach, focus, create, URL changes, title updates, loading state, and favicon updates.

Activating a user workspace hides the active global tab content and restores the selected workspace route/content. The global tab remains open unless explicitly closed.

Global tab activation should not navigate to a visible `/w/:workspaceId` route for the system workspace. Routes may carry a global-tab selection state if needed, but the system workspace id should not appear as a normal workspace destination.

### Creation Paths

`Cmd+Shift+T` opens the new-tab modal in global mode. Submitting from that modal creates a global browser tab.

Holding `Shift` while submitting from the new-tab modal creates a global browser tab regardless of submission type:

- bookmark click
- bookmark Enter key activation
- typed URL submission
- search submission

Non-Shift submissions keep their current behavior. Existing `Cmd+T` behavior remains workspace-scoped unless the user explicitly chooses a global path.

The new-tab modal response must carry enough intent for the caller to distinguish workspace tab creation from global tab creation. Shift handling belongs at the submission boundary so bookmark clicks and keyboard submissions behave consistently.

### URL, Title, And Favicon Handling

Global tabs use the same URL normalization and search conversion rules as existing browser tab creation. Searches and typed URLs should produce identical destinations whether opened as workspace tabs or global tabs.

The sidebar label updates when the browser title changes. The favicon updates when the browser reports a favicon or the favicon cache resolves one. Missing or failed favicons fall back to the existing generic browser icon.

### Edge Cases

If the global-tabs system workspace is missing, the first global-tab creation path recreates it before creating the tab.

If the system workspace exists but is accidentally included in user-facing workspace queries, UI surfaces must still filter it out by hidden/system metadata.

If a protected system workspace is passed to rename, archive, move, folder, or cleanup APIs, those APIs reject the operation rather than silently mutating it.

If a global tab is opened while another workspace has unsaved UI state, activating the global tab must not discard that workspace state.

If the user closes the last global tab while no last user workspace can be resolved, Kaivo falls back to the existing workspace landing behavior.

### Dependencies

This feature depends on existing workspace pane persistence, the browser pane/native tab API, the detached overlay layer for the new-tab modal, the universal menu submission flow, and the favicon cache. No new external dependency is required.
