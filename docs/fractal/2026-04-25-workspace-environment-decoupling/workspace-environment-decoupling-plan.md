# Workspace Environment Decoupling Plan

## Task 1: Workspace Persistence And API

Add durable workspace records and workspace UI state to the identity service. This creates the top-level object the new route and bottom tab bar depend on.

**Steps**
- Add `workspaces` and workspace UI state storage in `server/db/schema.ts` plus a migration under `migrations/`.
- Add a workspace service and tRPC router for list, get, create, rename, archive, mark-opened, read UI state, and save UI state.
- Mount the workspace router in `server/trpc/router.ts`.
- Store workspace UI state fields for active agent session, active workspace tab, workspace tabs, split ratio, and tab ordering.

**Tests**
- Unit: workspace service creates, renames, archives, and orders workspaces by recent activity.
- Integration: workspace tRPC router persists and reloads UI state for a workspace.
- Manual: create a workspace through a temporary API call and verify it appears in the DB with empty UI state.

**Depends on:** none

**Status:** done

## Task 2: Env-Server Workspace-Scoped Agent Sessions

Make agent sessions carry `workspaceId` and keep `envId` explicit at the workspace boundary. This lets the workspace left pane show only chats for the active workspace while still targeting the local env initially.

**Steps**
- Add nullable `workspace_id` to env-server `agent_sessions` schema and migration.
- Update agent session start to accept `workspaceId` and persist it with `workingDir`.
- Update session list/search summaries to include `workspaceId`, `workingDir`, status, title, and timestamps.
- Filter workspace route session lists by `workspaceId`; preserve compatibility for old env/debug surfaces.

**Tests**
- Unit: session creation persists `workspaceId` and `workingDir`.
- Integration: `sessionList({ workspaceId })` returns only that workspace's sessions.
- Manual: start two sessions in different workspace IDs against the local env and confirm they do not appear together.

**Depends on:** Task 1

**Status:** done

## Task 3: Env-Server Workspace-Scoped Shell Sessions

Make shell sessions workspace-aware and agent-aware. This supports workspace tabs whose shell target is still an env-server shell.

**Steps**
- Add `workspace_id` and `owner_agent_session_id` shell metadata in env-server schema/service code.
- Update shell create/list summaries to accept and return `workspaceId`, `cwd`, `envId` at the client boundary, and `ownerAgentSessionId`.
- Default shells opened from an agent to that agent's `workingDir` and environment.
- Ensure shell IDs are always paired with `envId` in workspace-level state.

**Tests**
- Unit: shell create records workspace, cwd, and owner agent session.
- Integration: shell list filters by workspace and does not mix shell sessions across workspaces.
- Manual: open a shell from an agent chat and verify it starts in the chat working directory.

**Depends on:** Task 2

**Status:** done

## Task 4: Recent Folders And Repo Config Clone Flow

Add the project-source backend needed by the new agent chat modal. The first UI supports recent/open folder and repo config full clone, with local env implicit.

**Steps**
- Add recent folder persistence and API for listing/upserting local folder history.
- Update folder-based agent session start to upsert the selected folder after successful session creation.
- Add or adapt a repo-config clone endpoint that creates a fresh full clone, not a git worktree.
- Return the clone path so the new agent session can use it as `workingDir`.

**Tests**
- Unit: recent folder upsert refreshes `lastOpenedAt` and de-duplicates by path.
- Integration: repo config clone returns a fresh directory and applies config files.
- Manual: create a chat from a folder, then reopen the modal and see the folder in recent folders.

**Depends on:** Task 2

**Status:** done

## Task 5: Workspace Route And Target Resolver

Add `/w/:workspaceId` as the primary app route and provide workspace context plus env-client resolution by `envId`. This separates app navigation from environment navigation.

**Steps**
- Add the `/w/$workspaceId` route in `src/router.tsx`.
- Build `WorkspaceRoute` to load workspace record, workspace UI state, visible env targets, and the single local env target.
- Add a workspace context that exposes workspace data, UI state updates, and `getEnvClient(envId)`.
- Keep existing `/env/$id` route functional for admin/debug or transition use.

**Tests**
- Unit: target resolver distinguishes local and remote env URL/token shapes.
- Integration: `/w/:workspaceId` bootstraps workspace data without requiring one route-level env.
- Manual: open `/w/:workspaceId` and confirm an unavailable env target does not crash the whole route.

**Depends on:** Task 1

**Status:** done

## Task 6: Extract Environment Shell UI For Workspace Reuse

Refactor the current environment shell without changing its behavior. This prepares the workspace page to preserve the existing UI details instead of rebuilding them.

**Steps**
- Extract reusable shell chrome from `src/routes/env/tab-shell.tsx` for header actions, split layout, command palette wiring, and tab area.
- Preserve `Shells`, `Previews`, `Settings`, `⌘K`, split resize, double-click reset, closable tabs, shell controls, and preview controls on the env page.
- Keep current environment page localStorage keys unchanged until the workspace route uses workspace-scoped keys.

**Tests**
- Unit: split ratio persistence and reset behavior remain unchanged for env route.
- Integration: env page renders shell/preview/settings actions after extraction.
- Manual: use the existing env page and verify resize, Shells, Previews, Settings, command palette, shell terminate, and preview reload/open still work.

**Depends on:** none

**Status:** done

## Task 7: Workspace Shell, Tabs, And Persistence

Implement the workspace shell using the extracted environment UI pieces. Workspace tabs replace env-scoped right-pane state while the current visual placement stays on the right.

**Steps**
- Render `WorkspaceShell` with agent chat pane, workspace tab pane, top-right actions, draggable split, and bottom workspace tab bar.
- Store workspace tabs as `WorkspaceTab[]` with `envId` on shell/file/preview tabs.
- Persist active agent session, active workspace tab, workspace tabs, and split ratio via workspace UI state.
- Mirror optional `chat` and `tab` search params without serializing full tab state in the URL.

**Tests**
- Unit: workspace tab reducer treats same preview port in different envs as distinct because `envId` differs.
- Integration: reload `/w/:workspaceId` restores active chat, active workspace tab, and split ratio.
- Manual: open/close workspace tabs, resize the split, reload, and confirm state restores for that workspace only.

**Depends on:** Task 5, Task 6

**Status:** done

## Task 8: Bottom Workspace Tab Bar And Inline Rename

Build the global bottom workspace switcher. Creating a workspace should be immediate and rename should happen inline in the tab bar.

**Steps**
- Render recently active/open workspaces in a persistent bottom tab bar with preserved ordering.
- Implement `+` to create an empty workspace, navigate to `/w/:workspaceId`, and focus the new tab title as a text input.
- Implement double-click rename for any workspace tab.
- Save on Enter or blur; Escape cancels the edit without deleting a newly created workspace.

**Tests**
- Unit: rename editor save/cancel state transitions, including new workspace cancel preserving the workspace.
- Integration: clicking `+` creates a workspace, navigates to it, and focuses the inline title input.
- Manual: create, rename, switch, double-click rename, press Escape, and confirm workspace records remain consistent.

**Depends on:** Task 5

**Status:** done

## Task 9: Workspace Agent Chat Pane

Move the full agent chat UI into workspace scope. The left pane remains the current chat view with session tabs, not a sidebar.

**Steps**
- Adapt agent session tabs to list only sessions for the active workspace.
- Control active session from workspace UI state instead of component-local state.
- Keep transcript, composer, approvals, questions, model controls, restart, and context usage behavior recognizable from the current env page.
- Show an empty workspace state with a call to start a new agent chat when no chats exist.

**Tests**
- Unit: active session selection chooses the persisted workspace session when present and falls back safely when missing.
- Integration: two workspaces with sessions against the same local env show separate chat tab sets.
- Manual: create/open chats, reload, switch workspaces, and confirm the left pane restores the correct active chat.

**Depends on:** Task 2, Task 7

**Status:** done

## Task 10: New Agent Chat Modal

Replace the workspace route's new-chat entry with the local-first modal. The modal starts chats from recent/open folder or repo config full clone.

**Steps**
- Implement the new agent chat modal with `Open folder` and `Repo config` sections only.
- Show recent folders by default under `Open folder` and provide `Choose any folder...`.
- List repo configs and create a fresh full clone before starting the agent session.
- Start the agent session with `workspaceId`, implicit local `envId`, and selected `workingDir`.
- Do not expose local/remote environment selection in this first UI.

**Tests**
- Unit: modal state validates folder vs repo config selection and hides remote target selection.
- Integration: folder start creates a workspace-scoped agent session and updates recent folders.
- Integration: repo config start clones to a fresh directory and starts the chat with that directory.
- Manual: open empty workspace, create a chat from recent folder, create another from repo config, and confirm both tabs appear in the left pane.

**Depends on:** Task 4, Task 9

**Status:** done

## Task 11: Workspace-Aware Files, Previews, And Failure States

Finish the target-aware behavior for workspace utility tabs and degraded env availability. This closes edge cases before shipping the workspace-first route.

**Steps**
- Make file tabs carry enough `envId`, path, and optional session context to resolve relative paths correctly.
- Make preview tabs include `envId` so identical ports in different envs do not collide.
- Show disconnected/unavailable states for chats or tabs whose target env is unavailable without failing the entire workspace.
- Keep environment deletion/archive from deleting workspaces; mark dependent tabs/chats unavailable.

**Tests**
- Unit: workspace tab identity keys include `envId` for shell, file, and preview tabs.
- Integration: unavailable env target renders a per-tab/per-chat error state while the workspace stays mounted.
- Manual: simulate a missing env target and confirm local tabs/chats in the same workspace remain usable.

**Depends on:** Task 7, Task 10

**Status:** done

## Task 12: Migration And Cutover

Make the workspace route the normal product entry while keeping environment pages available for transition/debug. This task intentionally avoids over-migrating old env-scoped UI state.

**Steps**
- Add navigation from the existing app entry to the most recent workspace, or create an initial empty workspace if none exists.
- Decide and implement `/env/:id` behavior as debug/admin or redirect to a recent related workspace.
- Drop or ignore old env-scoped right-pane localStorage state for workspace routes.
- Add operator notes for deploying identity and local env-server changes.

**Tests**
- Integration: app landing opens the most recent workspace or creates an initial one.
- Integration: old env route remains reachable or redirects according to the chosen behavior.
- Manual: fresh profile opens into an empty workspace; existing profile does not leak old env tabs into workspace tabs.

**Depends on:** Task 11

**Status:** done
