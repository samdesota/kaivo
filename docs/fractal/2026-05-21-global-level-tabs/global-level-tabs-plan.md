# Global-Level Tabs Plan

## Task 1: Protected System Workspace

Add first-class system workspace support and create the hidden/protected `global-tabs` workspace contract. This stands alone because it makes the storage model safe before any UI begins using it.

**Steps**
- Extend workspace persistence with user/system metadata, including a unique system key for reserved workspaces.
- Add an idempotent service/API path to get or create the `global-tabs` system workspace.
- Exclude hidden/system workspaces from normal list, tree, landing, picker, and sidebar data by default.
- Reject rename, archive, move, folder assignment, and cleanup operations for protected system workspaces.

**Tests**
- Unit: workspace service creates the `global-tabs` system workspace once and returns the same record on repeated calls.
- Unit: workspace `list` and `listTree` exclude the hidden system workspace while internal lookup can still retrieve it.
- Unit: rename, archive, move, and folder operations reject protected system workspaces.
- Unit: landing/default workspace selection ignores the system workspace when no user workspace is selected.

**Maintainability**
- Avoid scattering string literals by centralizing the `global-tabs` system key and workspace kind values.
- Keep hidden/protected filtering in workspace service/query boundaries, not repeated across every UI caller.
- Do not overload `archivedAt` to mean hidden; hidden/system/protected semantics should be explicit.
- Preserve existing user workspace behavior by making default APIs exclude system workspaces unless explicitly requested.

**Depends on:** none

**Status:** done

## Task 2: Global Tab Activation And Sidebar Rendering

Make an existing browser pane tab owned by the global-tabs workspace visible and usable as a global sidebar destination. This creates the first end-to-end user-visible global tab path through an internal/debug or direct creation call before shortcut wiring is added.

**Steps**
- Add a global-tabs store/query that reads browser pane tabs from the `global-tabs` workspace.
- Render a global tabs section above the workspace list when global tabs exist.
- Render each global tab row with favicon, title fallback, active state, and close affordance.
- Add active destination state so selecting a global tab clears workspace-row active styling and displays the global browser pane in the main content area.
- Preserve the last user workspace destination for return after closing or leaving global tabs.

**Tests**
- Unit: sidebar rendering shows global tabs above workspaces and does not include them in workspace selection/range-selection behavior.
- Unit: selecting a global tab marks only that tab active and leaves workspace rows inactive.
- Unit: closing the active global tab selects the next global tab or returns to the last user workspace fallback.
- E2E: with a seeded global browser tab, clicking it shows the browser pane and removes the active workspace highlight.

**Maintainability**
- Keep global tab rows separate from workspace row components so workspace drag/drop and multi-select logic does not leak in.
- Reuse existing tab icon/favicon components instead of duplicating favicon fallback logic.
- Keep active-destination logic small and typed rather than encoding global tabs as fake route workspaces.
- Avoid mounting a second browser runtime; global tabs should use the same browser pane/native slot component path.

**Depends on:** Task 1

**Status:** done

## Task 3: Global Tab Creation From `Cmd+Shift+T`

Wire the keyboard shortcut to create user-facing global browser tabs through the new-tab modal. This ships the primary requested creation path end to end.

**Steps**
- Change `Cmd+Shift+T` handling to open the new-tab modal in global-tab mode instead of the current alternate intent.
- Extend the modal request/response contract with an explicit target of workspace tab versus global tab.
- On global response, create the browser pane tab in the `global-tabs` system workspace and activate it as the sidebar destination.
- Use the existing URL/search normalization, browser tab creation, title updates, and favicon cache paths.

**Tests**
- Unit: shortcut handling opens the new-tab modal with global-tab target metadata.
- Unit: global modal response creates a browser pane tab under the `global-tabs` workspace, not the active user workspace.
- E2E: pressing `Cmd+Shift+T`, entering a URL, and submitting opens a global tab above workspaces with favicon/title fallback and active styling.
- E2E: normal `Cmd+T` still opens the existing workspace-scoped flow.

**Maintainability**
- Do not encode global creation as a special URL route; keep it as an explicit creation target in the modal result.
- Reuse existing workspace tab creation helpers where possible, parameterized by owner workspace id.
- Keep shortcut intent names accurate so `Cmd+Shift+T` no longer reads like workspace creation internally.
- Avoid duplicating URL normalization between workspace and global tab creation.

**Depends on:** Task 2

**Status:** done

## Task 4: Shift-Submission Global Creation

Make holding `Shift` while submitting anything from the new-tab modal open a global tab. This completes the alternate requested creation path for bookmarks, typed URLs, and searches.

**Steps**
- Capture shift state at every modal submission boundary: bookmark click, bookmark Enter activation, typed URL submit, and search submit.
- Return global-tab target metadata when submission occurs with `Shift` held.
- Ensure non-Shift bookmark, URL, and search submissions keep their existing behavior.
- Normalize click and keyboard bookmark activation through the same submission contract.

**Tests**
- Unit: Shift-clicking a bookmark returns a global-tab target response.
- Unit: pressing `Shift+Enter` on a focused bookmark returns a global-tab target response.
- Unit: pressing `Shift+Enter` after typing a URL or search returns a global-tab target response.
- E2E: Shift-opening a bookmark creates and activates a global sidebar tab while a normal bookmark open remains workspace-scoped.

**Maintainability**
- Centralize submission target selection so click and keyboard paths cannot drift.
- Keep modifier-key handling at the modal boundary, not inside low-level tab persistence code.
- Avoid adding bookmark-specific global creation code; bookmarks, typed URLs, and searches should share the same response shape.
- Preserve accessibility by ensuring keyboard activation uses the same semantic controls as non-Shift activation.

**Depends on:** Task 3

## Task 5: Edge Cases And Regression Hardening

Harden global tabs around lifecycle, route state, and protected workspace leakage. This task makes the feature robust after the main creation and activation paths work.

**Steps**
- Ensure global tab creation recreates the system workspace if it is missing.
- Ensure the system workspace never appears in workspace switchers, command palette workspace scopes, folders, landing defaults, or cleanup flows.
- Ensure closing the last global tab returns to the last user workspace when available and otherwise uses normal landing behavior.
- Ensure global tab title/favicon updates continue after switching between global tabs and user workspaces.
- Add any needed route/search-state handling without exposing the system workspace as a visible workspace route.

**Tests**
- Unit: deleting or missing the global-tabs workspace before creation causes it to be recreated idempotently.
- Unit: workspace picker/search scopes exclude the global-tabs system workspace.
- Unit: last-global-tab close falls back to last user workspace, then landing behavior when no last workspace exists.
- E2E: open two global tabs, switch to a user workspace, return to a global tab, close all global tabs, and verify active sidebar state remains correct.
- Human: verify favicon/title visual polish in the sidebar for pages with favicon, pages without favicon, and search-result pages.

**Maintainability**
- Keep defensive filtering at data source boundaries and add UI assertions only where needed for safety.
- Avoid special-casing one global tab count path; use the same active-destination reducer for one, many, and zero tabs.
- Keep route state optional and minimal so the system workspace cannot become a normal shareable workspace URL by accident.
- Prefer focused regression tests over broad snapshots that would make sidebar changes brittle.

**Depends on:** Task 4
