# Contextual Universal Menu Plan

## Task 1: Baseline Modal Shell

Create the new detached overlay modal, route command-t/command-k style entry points into it, and build the overall shell design before any scope is fully implemented. This task is intentionally review-heavy: the goal is to agree on the modal shape, search input behavior, result list primitives, hierarchy-capable row variant, and scope-button layout.

**Steps**
- Add the universal menu overlay request/result plumbing.
- Build the modal shell, landing state, shared result primitives, and optional custom row rendering contract.
- Add placeholder scope buttons and baseline command search rows.
- Preserve existing behavior by routing real actions only where safe; use placeholders for unfinished scopes.

**Tests**
- E2E: Open the universal menu, verify the shell renders in the overlay layer, type a command query, navigate rows with keyboard, and close it.
- Manual: Review visual design, spacing, row hierarchy affordance, and scope-button layout.

**Depends on:** none

**Status:** done

## Task 2: Workspace Landing Context

Fill the default workspace-scoped landing page with contextual current-workspace content. This establishes the default experience before scoped search UIs are built out.

**Steps**
- Show folders used by open chats in the current workspace.
- Show current workspace shells.
- Show current workspace browser tabs when available.
- Keep unprefixed typing limited to scope entries and commands.

**Tests**
- E2E: In a workspace with a chat, shell, and browser tab, open the menu and verify those contextual rows appear and can be selected/focused where implemented.

**Depends on:** Task 1

**Status:** done

## Task 3: Open Folder Scope

Implement `/` and the `Open Folder` scope for starting a new chat from a filesystem folder. This should preserve the current new-chat path picker behavior.

**Steps**
- Enter the scope from the button and `/` quick key.
- Support path-like browsing, home/default/up affordances, drill-in, and folder selection.
- Start a new chat in the current workspace from the selected folder.

**Tests**
- E2E: Open the menu, enter `/`, browse/select a folder, and verify a chat starts in the current workspace with that working directory.

**Depends on:** Task 1

**Status:** done

## Task 4: Recent Folders Scope

Implement `:` and the `Recent Folders` scope for searching prior chat folders and starting chats from them.

**Steps**
- Enter the scope from the button and `:` quick key.
- Search recent folders by label/path.
- Start a new chat in the current workspace from the selected recent folder.

**Tests**
- E2E: Seed or create a recent folder, search it via `:`, select it, and verify a new chat starts from that folder.

**Depends on:** Task 1

**Status:** done

## Task 5: Work Trees Scope

Implement `#` and the `Work Trees` scope for searching known worktrees and starting chats from them.

**Steps**
- Enter the scope from the button and `#` quick key.
- Search worktrees by repo/worktree/path metadata.
- Start a new chat in the current workspace from the selected worktree.

**Tests**
- E2E: Search for an existing worktree via `#`, select it, and verify a new chat starts at that worktree path.

**Depends on:** Task 1

**Status:** done

## Task 6: Shells Scope

Implement `$` and the `Shells` scope for finding and focusing shells in the current workspace.

**Steps**
- Enter the scope from the button and `$` quick key.
- Search current workspace shells by title/cwd/id.
- Focus the selected shell.

**Tests**
- E2E: Create or use an existing workspace shell, search it via `$`, select it, and verify the shell tab/pane is focused.

**Depends on:** Task 1

**Status:** done

## Task 7: Web Scope

Implement `@` and the `Web` scope for current workspace browser tabs and bookmark-like destinations.

**Steps**
- Enter the scope from the button and `@` quick key.
- Search current workspace browser tabs first.
- Add bookmark support when the backing data source is available or introduced.
- Focus existing tabs or open selected bookmark destinations.

**Tests**
- E2E: Search an open browser tab via `@`, select it, and verify it is focused; add bookmark coverage when bookmark storage exists.

**Depends on:** Task 1

**Status:** done

## Task 8: Workspaces Scope

Implement `>` and the `Workspaces` scope for switching workspaces with hierarchy-capable results.

**Steps**
- Enter the scope from the button and `>` quick key.
- Search workspace names and tree paths.
- Render workspace hierarchy where useful.
- Switch to the selected workspace and close the modal.

**Tests**
- E2E: Search a workspace via `>`, select it, and verify the app switches to that workspace.

**Depends on:** Task 1

**Status:** done

## Task 9: Find Files Scope

Implement `.` and the `Find Files` scope for git-tracked files across folders that have open chats in the current workspace.

**Steps**
- Add or wire the needed multi-root git-tracked file search data source.
- Enter the scope from the button and `.` quick key.
- Search files across open-chat folders in the current workspace.
- Open or focus the selected file.

**Tests**
- E2E: Open a workspace with chats rooted in git folders, search a tracked file via `.`, select it, and verify the file opens.

**Depends on:** Task 1

**Status:** done

## Task 10: Command Polish And Replacement

Replace the old command palette/new-chat entry points with the universal menu and tighten command coverage, accessibility, and edge states.

**Steps**
- Remove or retire redundant old modal paths once covered.
- Finalize application/workspace commands: new shell, close current tab, collapse/expand agent pane, collapse/expand sidebar, settings.
- Cover empty/error states and quick-key edge cases.
- Ensure the modal works cleanly on desktop and mobile-sized layouts.

**Tests**
- E2E: Run the full universal menu flow suite covering open/close, every scope hotkey, every implemented command, and replacement entry points.

**Depends on:** Tasks 2-9
