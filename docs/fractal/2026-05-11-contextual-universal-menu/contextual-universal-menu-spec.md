# Contextual Universal Menu Spec

## Seed

Replace the current new chat modal with a global contextual menu, styled like the existing new chat flow, that combines new-chat creation with command-k-style search and navigation.

By default it should surface actions and resources relevant to the active workspace, while scope commands and shortcut buttons expose broader Recent Folders, Work Trees, and Browser Bookmarks search surfaces.

## Solution

- Surface: one detached overlay-layer modal replaces both the command palette entry point and the new chat modal entry point.
- Default scope: the landing view is scoped to the current workspace, not the whole app.
- Context rows: the default view shows folders previously used by chats in the workspace, open workspace shells, and open workspace browser tabs.
- Folder model: recent folders and worktrees are presented as the same selectable folder concept; worktree status is metadata, not a separate default category.
- Default search: typing in the landing view searches command-palette entries, including actions and scope entries, not content across folders, URLs, and resources.
- Scope entry: scope buttons and typed scope entries such as `Open Folder`, `Recent Folders`, `Work Trees`, `Find Files`, `Web`, `Shells`, and `Workspaces` enter content-specific search modes.
- Quick keys: every scope has a direct leading-symbol hotkey: `/` Open Folder, `:` Recent Folders, `#` Work Trees, `.` Find Files, `@` Web, `$` Shells, and `>` Workspaces.
- Scoped search: after selecting a scope entry, the input filters only that scope's results until the user clears or exits the scope.
- Open Folder: the `Open Folder` scope starts a new chat by choosing a folder, preserving the current new chat modal's automatic folder picker behavior.
- Find Files: the `Find Files` scope searches git-tracked files across every folder that has an open chat in the current workspace.
- Actions: selecting a folder starts a new chat there; selecting a shell or browser tab focuses it; selecting a workspace switches to it.
- Styling: reuse the new chat modal's visual language and the command palette's compact keyboard-driven interaction model.

## Spec

### Product Shape

The universal menu is a detached overlay-layer modal that replaces the current command palette surface and absorbs the current new chat folder selection flow. It is always opened in a workspace context for this version. There is no separate global landing page; switching workspace is handled by entering the `Workspaces` scope with `>` or by selecting the `Workspaces` scope command.

The landing page is a workspace-scoped command palette. Its empty-query state shows useful current-workspace resources, but its typed-query behavior searches commands and scope entries rather than all content. Content search begins only after entering a scope.

### Overlay Architecture

The modal must render through the detached overlay layer, following the existing `CommandPalette` and `NewAgentChatOverlay` pattern. App-facing callers invoke an overlay controller function, and the UI renders from `src/routes/internal/overlay-layer.tsx` so it cannot appear beneath Electron browser tabs.

The overlay needs both app and env data. App data provides workspace tree, workspace tabs/resources, and workspace switching. Env data provides shells, agent sessions, recent folders, worktrees, filesystem browsing, chat creation, and repo/file operations.

The implementation should consolidate behavior currently split across:

- `src/routes/env/shell/command-palette.tsx`
- `src/routes/env/agent/new-agent-chat-modal.tsx`
- `src/routes/internal/overlay-layer.tsx`
- `src/lib/overlay-layer-controller.tsx`

### State Model

The modal has two top-level interaction states.

`landing` is the default workspace-scoped command palette. It has a query string, active row index, and a result list made from actions, scope entries, and current workspace resources.

`scope` is a content-specific search mode. It has a scope id, query string, active row index, optional scope-local navigation state, and a result list owned by that scope.

Returning from a scope clears scope-local navigation but does not close the modal. Escape first exits the active scope, then closes the modal from the landing state.

### Default Workspace Landing

The landing page is scoped to the current workspace. It shows a contextual snapshot first, then lets the user type commands.

Empty state content:

- Primary scope buttons: `Open Folder`, `Recent Folders`, `Work Trees`, `Find Files`, `Web`, `Shells`, `Workspaces`.
- Current workspace folders: folders used by open chats in this workspace, including worktrees as folder rows with worktree metadata.
- Open shells: shells attached to the current workspace.
- Open browser tabs: browser tabs attached to the current workspace.
- Core commands: new shell, close current tab when available, collapse agent pane, collapse sidebar, open settings.

Typed query behavior:

- Normal text searches command-palette entries only.
- Command-palette entries include scope entries, application-level commands, and workspace-level commands.
- Normal text does not search folder paths, bookmark URLs, file names, all worktrees, or all workspaces.
- Leading quick keys enter or filter scope entries directly.

ASCII overview:

```text
+------------------------------------------------------------+
| New Tab                                                     |
| [ Search commands or type @ # > ...                      ] |
+------------------------------------------------------------+
| Open Folder   Recent Folders   Work Trees   Find Files      |
| Web           Shells           Workspaces                   |
+------------------------------------------------------------+
| In this workspace                                           |
|  folder  cloud-code-tools        /Users/sam/d/...           |
|  folder  zootle worktree         repo: zootle · main        |
|                                                            |
| Open shells                                                 |
|  shell   dev server              /Users/sam/d/...           |
|  shell   tests                   /Users/sam/d/...           |
|                                                            |
| Browser tabs                                                |
|  web     Local app               http://127.0.0.1:...       |
|  web     GitHub PR               https://github.com/...     |
+------------------------------------------------------------+
| ↑↓ select   Enter open   Esc close                          |
+------------------------------------------------------------+
```

Typed command search example:

```text
+------------------------------------------------------------+
| [ wor                                                    ] |
+------------------------------------------------------------+
|  scope  Workspaces              Switch to another workspace |
|  scope  Work Trees              Search repo worktrees       |
|  cmd    New shell               Open terminal in workspace  |
|  cmd    Collapse sidebar        Toggle workspace sidebar    |
+------------------------------------------------------------+
```

### Scope Entry

Scopes can be entered in three ways.

- Click a scope button from the landing page.
- Type enough of the scope name and press Enter on the scope row.
- Type a quick-key prefix that maps to the scope family.

Quick-key routing:

- `/` enters `Open Folder`.
- `:` enters `Recent Folders`.
- `#` enters `Work Trees`.
- `.` enters `Find Files`.
- `@` enters `Web`.
- `$` enters `Shells`.
- `>` enters `Workspaces`.

The query text after a quick key becomes the initial scoped query. For example, `@git` opens Web scope with query `git`; `>client` opens Workspaces with query `client`; `.overlay` opens Find Files with query `overlay`.

`~` is reserved for home-directory navigation inside `Open Folder`, not for scope entry.

Scope chrome:

```text
+------------------------------------------------------------+
| < Work Trees                                               |
| [ Search work trees                                      ] |
+------------------------------------------------------------+
| results...                                                 |
+------------------------------------------------------------+
| Esc back   Enter select                                    |
+------------------------------------------------------------+
```

### Open Folder Scope

`Open Folder` starts a new chat by choosing a local folder. It preserves the useful behavior of the current new chat modal path picker, including automatic folder browsing when the query is path-like.

Behavior:

- Entering `Open Folder` starts in the default filesystem location from the current env, matching current `browseHome` behavior.
- Typing `/`, `~/`, or any path-like query enters filesystem browse mode.
- Directory rows support Enter to select and start a chat, and Right Arrow to drill into a highlighted directory when appropriate.
- The scope should expose home/default/up affordances if they exist in the current folder picker behavior.
- Selecting a folder starts a new chat in the current workspace using that folder as working directory.

ASCII overview:

```text
+------------------------------------------------------------+
| < Open Folder                                              |
| [ /Users/sam/d/repos                                     ] |
+------------------------------------------------------------+
|  dir    cloud-code-tools        /Users/sam/d/...           |
|  dir    zootle                  /Users/sam/d/repos/...     |
|  dir    experiments             /Users/sam/d/repos/...     |
+------------------------------------------------------------+
| Home   Default   Up        → drill   Enter start chat       |
+------------------------------------------------------------+
```

### Recent Folders Scope

`Recent Folders` searches folders previously opened in chats. It is broader than the landing page, which only shows folders relevant to the current workspace.

Behavior:

- Results come from recent folder history.
- Query filters folder label and path.
- Selecting a folder starts a new chat in the current workspace.
- Rows should indicate whether the folder is already used by an open chat in the current workspace.

ASCII overview:

```text
+------------------------------------------------------------+
| < Recent Folders                                           |
| [ cloud                                                  ] |
+------------------------------------------------------------+
|  folder cloud-code-tools       current workspace           |
|  folder cloud-code-old         opened yesterday            |
|  folder cloud-experiments      opened last week            |
+------------------------------------------------------------+
| Enter start chat   Esc back                                |
+------------------------------------------------------------+
```

### Work Trees Scope

`Work Trees` searches known repo worktrees. Worktrees remain a folder-like chat target, but this scope makes the worktree metadata primary.

Behavior:

- Results come from the existing repo worktree list.
- Query filters worktree name, repo name, slug, GitHub full name, and working directory.
- Selecting an existing worktree starts a new chat in the current workspace at that worktree path.
- Rows should show repo/worktree identity and path.
- If repo config clone flows are preserved here, cloneable repo configs should be separate command rows from existing worktree rows.

ASCII overview:

```text
+------------------------------------------------------------+
| < Work Trees                                               |
| [ universal                                             ] |
+------------------------------------------------------------+
|  wt  zootle/universal-menu     /Users/sam/d/...            |
|  wt  cloud-tools/main          /Users/sam/d/...            |
|  wt  app/local-first           /Users/sam/d/...            |
+------------------------------------------------------------+
| Enter start chat   Esc back                                |
+------------------------------------------------------------+
```

### Find Files Scope

`Find Files` searches git-tracked files across every folder that has an open chat in the current workspace.

Scope source set:

- Collect open chat sessions in the current workspace.
- Extract each session working directory.
- Deduplicate directories by resolved path.
- Treat those directories as the searchable roots.

Behavior:

- Results are files, grouped implicitly by root folder when paths would otherwise be ambiguous.
- Query filters file path and basename.
- Only git-tracked files are included.
- Selecting a file opens that file in the workspace, or focuses it if already open.
- If a root cannot provide git-tracked files, skip it and show a non-blocking empty/error row only when all roots fail.

This likely needs a new env endpoint because the current codebase has generic filesystem search and repo config file APIs, but no clear git-tracked multi-root search endpoint.

ASCII overview:

```text
+------------------------------------------------------------+
| < Find Files                                               |
| [ overlay                                               ] |
+------------------------------------------------------------+
|  file  src/routes/internal/overlay-layer.tsx               |
|        cloud-code-tools                                    |
|  file  src/lib/overlay-layer-controller.tsx                |
|        cloud-code-tools                                    |
|  file  packages/env-server/src/...                         |
|        zootle worktree                                     |
+------------------------------------------------------------+
| Enter open file   Esc back                                 |
+------------------------------------------------------------+
```

### Web Scope

`Web` searches browser destinations. For this version it should include open browser tabs in the current workspace and bookmark-like saved destinations if a bookmark source exists or is added.

Behavior:

- `@` enters this scope.
- Query filters title, URL, and bookmark label.
- Selecting an open tab focuses it.
- Selecting a bookmark opens it in a new browser tab in the current workspace.
- If bookmarks are not yet available as app data, the scope should initially support current workspace browser tabs and leave bookmark storage as an explicit dependency for implementation.

ASCII overview:

```text
+------------------------------------------------------------+
| < Web                                                      |
| [ github                                                ] |
+------------------------------------------------------------+
|  tab       GitHub PR              open in workspace         |
|            https://github.com/...                          |
|  bookmark  GitHub Issues          saved bookmark            |
|            https://github.com/issues                       |
+------------------------------------------------------------+
| Enter focus/open   Esc back                                |
+------------------------------------------------------------+
```

### Shells Scope

`Shells` searches open shells in the current workspace. It is the scoped content-search version of shell-related command rows on the landing page.

Behavior:

- `$` enters this scope.
- Query filters shell title, id, cwd, and owner metadata.
- Selecting a shell focuses it in the workspace.
- A `New shell` command remains available from landing search; the Shells scope is primarily for finding existing shells.

ASCII overview:

```text
+------------------------------------------------------------+
| < Shells                                                   |
| [ dev                                                   ] |
+------------------------------------------------------------+
|  shell  dev server              /Users/sam/d/...           |
|  shell  env logs                /Users/sam/d/...           |
|  shell  tests                   /Users/sam/d/...           |
+------------------------------------------------------------+
| Enter focus shell   Esc back                              |
+------------------------------------------------------------+
```

### Workspaces Scope

`Workspaces` switches the active workspace. There is no unscoped global landing page in this version. To open something in another workspace, the user enters `>` scope, switches workspace, then opens the menu again in that workspace.

Behavior:

- `>` enters this scope.
- Query filters workspace name and tree path.
- Selecting a workspace closes the modal and switches the app to that workspace.
- Creating a new workspace remains available as a command-palette action from the landing page, but workspace search itself is for switching.

ASCII overview:

```text
+------------------------------------------------------------+
| < Workspaces                                               |
| [ client                                                ] |
+------------------------------------------------------------+
|  workspace  Client App             /Active Projects        |
|  workspace  Client Backend         /Active Projects        |
|  workspace  Client Experiments     /Archive                |
+------------------------------------------------------------+
| Enter switch workspace   Esc back                          |
+------------------------------------------------------------+
```

### Keyboard And Pointer Interaction

The modal should preserve the command palette's fast keyboard model.

- Up/Down changes active row.
- Enter selects the active row.
- Escape exits scope or closes from landing.
- Click selects buttons and rows.
- Right Arrow drills into directories in `Open Folder` when the highlighted row is a directory.
- The input is focused after open and after scope transitions.

### Result Types

The menu needs a shared result shape so landing commands and scoped content can render consistently, but rendering must not be baked into the architecture.

Common fields:

- `id`: stable row id.
- `kind`: action, scope, folder, worktree, shell, browser-tab, bookmark, workspace, file.
- `label`: primary display text.
- `detail`: secondary display text.
- `badge`: optional short metadata such as current workspace, worktree, open, bookmark.
- `parentId`: optional parent row id for hierarchical result sets.
- `depth`: optional visual nesting depth for hierarchical result sets.
- `haystack`: searchable text for the active search mode.
- `run`: action to perform on selection.

### Result Rendering

Build shared result components as the default presentation layer, not as the only rendering path.

The menu shell owns selection, keyboard movement, active row state, and invoking a result. Scopes own result production and may optionally own result rendering.

Default rendering primitives:

- `UniversalMenuResultList`: keyboard-aware list container.
- `UniversalMenuResultRow`: default row layout for icon/kind, label, detail, badge, and active state.
- `UniversalMenuHierarchyRow`: default row variant for tree/group results with indentation, disclosure affordance, and inherited active state behavior.
- `UniversalMenuScopeButton`: default landing-page scope shortcut button.
- `UniversalMenuEmptyRow`: default empty/error row.

Scope rendering contract:

- A scope can return plain result objects and use the default row component.
- A scope can provide `renderResult(result, state)` when it needs a custom row.
- Custom row rendering must still receive active/disabled state and invoke the same selection callback.
- The shell must not assume every result is visually represented by `UniversalMenuResultRow`.

This keeps the common command-palette shape cheap to build while preserving freedom for `Open Folder`, `Find Files`, or `Web` to use richer custom rows later.

Hierarchical result sets are optional. A scope can provide flattened results with `parentId` and `depth`, plus scope-local expanded/collapsed state if needed. The shell still treats the visible flattened rows as the keyboard list. This is expected for `Workspaces`, where workspace folders and workspaces form a tree, and for `Web`, where bookmarks may be grouped by folder.

### Data Dependencies

Existing data sources:

- Recent folders: `envTrpc.repo.listRecentFolders`.
- Worktrees: `envTrpc.repo.listWorktrees`.
- Filesystem browse: `envTrpc.fs.browseHome`.
- Chat creation: `envTrpc.agent.sessionStart` plus workspace resource updates.
- Shells: `envTrpc.shell.list` and `envTrpc.shell.create`.
- Agent sessions: `envTrpc.agent.sessionList`.
- Workspaces: `trpc.workspace.listTree` and existing workspace navigation plumbing.
- Browser tabs: current workspace browser tab state and browser open/focus plumbing.

New or clarified data sources:

- Workspace chat folders: a reliable way to derive open chat sessions for the current workspace and their working directories.
- Workspace browser tabs: a reliable row source for open browser tabs in the current workspace.
- Bookmarks: saved browser destinations if this does not already exist.
- Git file search: env endpoint for git-tracked file search across multiple roots from current workspace chats.

### Command Set

Landing search includes scope entries plus commands that act at the application or current-workspace level.

Initial command rows:

- New shell.
- Close current tab when a tab is active.
- Collapse or expand agent pane.
- Collapse or expand sidebar.
- Open settings.
- Reopen or focus current workspace resources when represented as command-like rows.

Commands should be easy to extend without changing scoped result implementations.

Do not include separate `New chat`, `New workspace`, or `New browser tab` command rows in the default command set. Those intents are covered by scoped flows: folder/worktree/recent-folder selection starts chats, workspace search switches context, and web/bookmark selection opens browser destinations.

### Empty And Error States

Landing with no workspace resources still shows scope buttons and core commands.

Scopes with no results show one empty row explaining what is being searched. Data errors should not close the overlay; they should appear as non-blocking rows with retry if practical.

If the user tries `Find Files` with no open-chat folders in the workspace, show an empty state explaining that files are searched from folders used by open chats.

If bookmarks are unavailable, `Web` should still search open browser tabs and can show a disabled or empty bookmarks section only if useful.
