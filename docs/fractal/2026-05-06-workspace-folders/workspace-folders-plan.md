# Workspace Folders Plan

## Task 1: Persist Workspace Folder Tree

Add app-database support for workspace folders and stable workspace placement. This establishes the durable sidebar hierarchy without changing the UI yet.

**Steps**
- Add a migration for `workspace_folders` with parent folder, name, position, collapse state, timestamps, and archive state.
- Add workspace placement fields: `folder_id`, `position`, `name_source`, `source_kind`, and `source_path`.
- Update app DB schema types for workspace folders and workspace name/source metadata.
- Backfill existing workspaces as top-level rows with deterministic positions and `name_source = explicit`.

**Tests**
- Unit: workspace schema/service test verifies existing workspaces receive stable positions and explicit name source.
- Integration: migration test or DB smoke verifies new columns/tables can be created on an existing DB.
- Manual: create/reload local app DB and confirm old workspaces still load.

**Depends on:** none

**Status:** done

## Task 2: Workspace Folder Service API

Expose server operations for reading and mutating the folder/workspace tree. This gives the UI a single stable source of truth for ordering.

**Steps**
- Add workspace service methods for listing the sidebar tree, creating folders, renaming folders, archiving folders, and toggling folder collapse.
- Update workspace create/rename/archive to respect folder placement, position, source metadata, and stable ordering.
- Add TRPC procedures for the new folder/tree operations.
- Remove reliance on client-local workspace order as the authoritative order.

**Tests**
- Unit: service returns folders/workspaces ordered by parent and position, with `created_at`/`id` tie-breaks.
- Unit: creating a workspace under a folder appends it to that folder.
- Unit: opening or renaming a workspace does not change position.

**Depends on:** Task 1

**Status:** done

## Task 3: New Agent Chat Workspace Mode State

Teach the new agent chat flow about creating a new workspace versus adding to an existing one. This is pure state and API wiring before visual sidebar changes.

**Steps**
- Extend new agent chat state with `workspaceMode = new | existing`.
- Add workspace-name derivation helpers for folder path, existing worktree, and clone worktree selections.
- Track whether the workspace name was user-edited versus generated.
- Add create flow that creates a workspace first in `new` mode, then starts the agent session with the new `workspace_id`.
- Keep existing workspace mode creating only an agent session with the existing `workspace_id`.

**Tests**
- Unit: name derivation returns folder basename, worktree name, and clone worktree name.
- Unit: clearing the workspace name restores generated preview instead of creating an empty name.
- Unit: start-input/create-flow state distinguishes new workspace creation from existing workspace chat creation.

**Depends on:** Task 2

**Status:** done

## Task 4: New Agent Chat Header Control

Update the existing New Agent Chat modal without redesigning its body. The only UI addition is the top-right workspace mode/name control plus bounded scrolling fixes.

**Steps**
- Add header control: `Workspace [New v] [editable generated name]` in new mode.
- Add header control: `Workspace [Existing v] existing-workspace-name` in existing mode.
- Implement dropdown switching between new and existing modes.
- Preserve current Folders/Worktrees/Clone body layout.
- Ensure recent folders, worktrees, and clone config lists are bounded scroll containers with fixed header/tab/footer areas.

**Tests**
- Unit/UI: modal renders editable workspace name in new mode and static workspace name in existing mode.
- Unit/UI: switching mode changes whether the workspace name input is editable/visible.
- Manual: populate many recent folders/worktrees/configs and verify only the list scrolls; footer remains visible.

**Depends on:** Task 3

**Status:** done

## Task 5: Sidebar Folder/Workspace Tree UI

Replace the flat workspace sidebar with the folder/workspace tree. Workspaces stay the visible project rows, with chat lists collapsed by default.

**Steps**
- Render top-level folders and workspaces from the tree API.
- Render nested workspace folders recursively.
- Add folder row actions for `+` and `+folder`.
- Render workspace rows with caret, name, chat count, rollup indicator slot, and workspace `+` action.
- Default workspace chat lists to collapsed and persist folder/workspace expansion state.
- Keep workspace row click navigation selecting remembered or most recent chat.

**Tests**
- Unit/UI: sidebar renders folders, nested folders, workspaces, and stable order from tree data.
- Unit/UI: folder `+` opens New Agent Chat in new-workspace mode with that folder context.
- Unit/UI: workspace `+` opens New Agent Chat in existing-workspace mode.
- Manual: reload app and confirm workspace/folder order and collapse state do not change.

**Depends on:** Task 4

**Status:** done

## Task 6: Workspace Rollup Chat State

Move chat activity signals up to the workspace row so collapsed workspaces still show useful state.

**Steps**
- Add or extend env summary data for per-workspace chat count, running state, pending attention, latest activity, and latest session.
- Track viewed/read state enough to identify `new_response` for inactive chats.
- Compute workspace row state with priority `attention > running > new_response > idle`.
- Show chat count only when a workspace has more than one chat.
- Keep expanded chat rows showing their existing per-chat state.

**Tests**
- Unit: rollup helper prioritizes attention over running over new response over idle.
- Unit: collapsed workspace state does not depend on mounted chat row components.
- Integration/UI: workspace row shows spinner when any chat is running and returns to idle when all are idle.
- Manual: start a chat, switch workspaces, let it finish, and confirm the workspace shows new-response state.

**Depends on:** Task 5

**Status:** done

## Task 7: Workspace And Chat Auto Naming

Implement the naming rules for new workspaces and chats. This prevents prompt-derived names from overwriting explicit or worktree-derived project names.

**Steps**
- Persist and update `WorkspaceNameSource` transitions: `folder_path`, `worktree`, `derived`, `explicit`.
- Set `folder_path` for generated names from local folder targets.
- Set `worktree` for existing or cloned worktree names.
- Set `explicit` when the user edits the workspace name or renames an existing workspace.
- On first prompt-derived chat title, rename the workspace only when the workspace source is still `folder_path`, it is the first active chat, and the chat had no explicit title.
- Ensure second/later chats can auto-name themselves but never rename the workspace.

**Tests**
- Unit: folder-path workspace auto-renames on first prompt under the allowed conditions.
- Unit: explicit, worktree, and derived workspaces do not auto-rename.
- Unit: second chat in an existing workspace never renames the workspace.
- Manual: create local-folder workspace with blank name edit, send first prompt, and observe workspace/chat names update together.

**Depends on:** Task 6

**Status:** done

## Task 8: Migration Polish And Regression Pass

Clean up old ordering assumptions and verify the full workflow end to end. This task makes the feature safe to ship after the main behavior is implemented.

**Steps**
- Remove or neutralize old localStorage workspace order as the source of truth.
- Audit workspace list callers for assumptions about recency ordering.
- Confirm `/w/$workspaceId?chat=...` route remains compatible.
- Add user-facing empty states for no folders, no workspaces in a folder, and workspace with no chats.
- Run focused tests, typecheck, and build.

**Tests**
- Unit: old workspace list consumers still receive compatible workspace summaries.
- Integration/UI: migrated workspace opens with existing chats and tabs intact.
- Manual: create folder, create workspace from folder `+`, create second chat from workspace `+`, reload, verify order/state/names persist.
- Command: `npx vitest run server/workspace/service.test.ts tests/unit/new-agent-chat-state.test.ts`.
- Command: `npm run typecheck`.
- Command: `npm run build`.

**Depends on:** Task 7

**Status:** done
