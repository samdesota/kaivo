# Workspace Folders

## Seed

Introduce workspace folders so domains can contain many project workspaces, while keeping each workspace as the unit that co-locates chats, tabs, shells, and project runtime state. The sidebar should feel chat-aware by default: new project creation starts from the new agent chat flow, workspace chat lists are collapsed unless expanded, and workspace rows roll up chat activity state.

## Solution

- Hierarchy: workspace folders contain workspace folders and workspaces; workspaces remain the project/runtime container.
- Creation: folder-level and top-level plus actions open the new agent chat flow, creating a workspace and first chat together.
- Existing projects: workspace-level plus actions create another chat in that workspace without creating a new workspace.
- Sidebar: workspace chat lists are collapsed by default, with a chat count shown when a workspace has multiple chats.
- Ordering: folders and workspaces use persisted stable positions, not recency or reload-dependent client order.
- Rollup state: each workspace row derives its visible activity state from its chats, prioritizing attention, running, new response, then idle.
- Naming: new workspaces derive initial names from explicit input, worktree name, or selected folder path; first-prompt renaming only applies to auto path-derived names.
- Persistence: workspace folders and workspace sidebar placement live in the app database; agent sessions remain in the env database linked by `workspace_id`.
- Migration: existing workspaces stay as workspaces, start outside folders, keep their current names, and default to collapsed chat lists.

## Spec

### Model

Workspaces stay one-per-project. A workspace folder is an organizational parent for project workspaces. A workspace remains the runtime container for chats, tabs, shells, previews, browser panes, and view state.

```text
Workspace Folder
  Workspace
    Chats
    Tabs / Shells / Previews / Browser panes
```

### Sidebar UX

Default:

```text
Zoottle                            +  +folder
  > zoottle                 4   *
  > opencode-plugin         1

Starch                             +  +folder
  > starch-web              2   !
  > starch-api              3

Unfiled                            +
  > scratch                 1
```

Expanded workspace:

```text
Zoottle
  v zoottle                 4   *
      Fix sidebar           *
      Add tests
      Release polish        .
      Investigate auth
```

Legend:

```text
!  attention: approval/question pending
*  running/loading/streaming
.  new response since last viewed
   idle/default
```

Top-level `+` and folder `+` open the New Agent Chat modal in new-workspace mode. Folder `+folder` creates a nested workspace folder. Workspace `+` opens the same modal in existing-workspace mode and creates another chat inside that workspace. The workspace caret expands or collapses the chat list without navigating.

### Stable Order

Sidebar order is database-backed, scoped by parent, and unaffected by reloads or `last_opened_at`. Opening, renaming, or receiving chat activity must not reorder workspaces.

```text
parent = null
  001 Zoottle folder
  002 Starch folder
  003 scratch workspace

parent = Zoottle
  001 zoottle workspace
  002 opencode-plugin workspace
  003 Packages folder
```

New folders and workspaces append to the end of their parent list. Migration assigns positions to existing workspaces using the current deterministic server order, with ties broken by `created_at` and then `id`.

### New Agent Chat Modal

New workspace mode:

```text
New Agent Chat                              Workspace [ New v ] [ zoottle ]

[Folders] [Worktrees] [Clone]

existing modal body stays the same:
  folder search / browse
  worktree list
  clone config form

                         [Cancel] [Create chat]
```

The existing modal body stays intact. The only layout change is the workspace control in the top-right corner of the header. It has a `New`/`Existing` dropdown and a workspace value. In `New` mode, the value is an editable workspace name that will be used in the sidebar.

Existing workspace mode:

```text
New Agent Chat                              Workspace [ Existing v ] zoottle

[Folders] [Worktrees] [Clone]

existing modal body stays the same

                         [Cancel] [Create chat]
```

Existing workspace mode does not show the workspace name field because the workspace already exists.
Its header still shows the target workspace so the user knows the chat will be added to an existing workspace.
Switching the dropdown to `New` means the modal will create a workspace and first chat. Switching to `Existing` means the modal will add a chat to the selected existing workspace.

Recent folders, worktrees, and clone config lists must each live inside bounded scroll containers. Long lists should scroll within the modal body, not grow the modal past the viewport or push the footer off-screen.

Creation from top-level or folder context creates a workspace, creates the first agent session with that `workspace_id`, and navigates to the workspace with the chat active. Creation from workspace context creates only an agent session with the existing `workspace_id` and selects that chat.

### Workspace Name Defaults

Workspace names have a source: `folder_path`, `worktree`, `derived`, or `explicit`. The source controls whether first-prompt auto naming may later replace the workspace name.

| Case | Default workspace name | Source |
| --- | --- | --- |
| Local folder | `basename(path)` | `folder_path` |
| Existing worktree | worktree name | `worktree` |
| Clone/create worktree | requested worktree name | `worktree` |
| User edits name field | typed value | `explicit` |
| Migrated workspace | current workspace name | `explicit` |

Empty name field does not mean empty name. It restores the generated preview.

### Workspace Auto Naming

```text
folder_path  --first prompt-->  derived
folder_path  --user rename--->  explicit
worktree     --user rename--->  explicit
derived      --user rename--->  explicit
explicit     ---------------->  explicit
```

First-prompt workspace auto naming only applies to a new workspace created from a local folder when the source is still `folder_path`, the first chat has no explicit title, the workspace still has exactly one active chat, and the user has not renamed the workspace.

Then:

```text
prompt: "Add workspace folders to the sidebar"
chat title:      "Add workspace folders"
workspace name:  "Add workspace folders"
source:          derived
```

Workspace auto naming never runs for `explicit`, `worktree`, or already `derived` workspaces. It also never runs when creating a second or later chat in an existing workspace.

### Chat Naming

Chat naming stays session-local. If a chat name is entered, use it. If an initial prompt is present, derive the chat title from the prompt. If the chat starts blank, show a temporary fallback until the first prompt derives the chat title. Additional chats can rename themselves from first prompt, but never rename the workspace.

### Workspace Rollup State

Workspace row state is computed from all non-archived chats, even while collapsed. The priority order is:

```text
if any chat has approval/question     -> ! attention
else if any chat is running/loading   -> * running
else if any inactive chat finished    -> . new_response
else                                  -> idle
```

This state must come from a shared status store or env summary query, not only mounted chat rows.

### Persistence Boundary

The app database owns workspace folders, workspace parent placement, stable positions, workspace name source, workspace source metadata, sidebar collapse state, and workspace tabs/view state.

The env database continues to own agent sessions, chat titles, transcripts, selected model, per-chat working directory, and shell session workspace links. Agent sessions remain linked to workspaces through `workspace_id`.

### Migration

Existing workspaces and chats are not split, duplicated, or converted. Existing workspaces become top-level rows with no folder, persisted positions, `name_source = explicit`, and collapsed chat lists. Existing client-side local order is replaced by database order after migration.

### Edge Cases

If an agent session fails to start after creating a new workspace, keep the workspace visible and show the error; do not silently delete it. Duplicate workspace names and duplicate source paths are allowed. If an active chat is archived, the workspace falls back to the most recent non-archived chat or no active chat.
