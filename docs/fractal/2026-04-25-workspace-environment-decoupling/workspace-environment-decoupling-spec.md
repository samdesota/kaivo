# Workspace Environment Decoupling Spec

## Seed

Redesign the app around durable Workspaces as the frontend shell and project context, with environments becoming per-agent-chat or per-shell execution targets. A Workspace should support local and remote agents/shells side by side while reusing the existing environment, proxy, filesystem, and session infrastructure where it still fits.

## Solution

- Workspace identity: first-class `workspaces` records; a workspace is a user-created container, not a folder or repo alias.
- Navigation: the primary app route is `/w/:workspaceId`; environment routes become implementation detail and admin/debug surface.
- Workspace switcher: a persistent bottom tab bar switches between many active workspaces and creates new ones.
- Workspace layout: each workspace reuses the current split view: full agent chat UI on the left, utility tabs on the right.
- Agent chats: chat/session tabs remain across the top of the left pane and are scoped to the active workspace.
- Environment targeting: each agent chat records its execution target: the single local environment or a remote environment.
- Shell targeting: shell tabs record their execution target; shells opened from an agent inherit that agent's environment.
- New chat flow: create chat by choosing an open folder or repo configuration; local execution is implicit in the first UI.
- Local environment: there is one local env per local computer; multiple local chats differ by workspace/chat/folder, not by env.
- Remote environments: use remote envs when work should continue independent of the local machine's availability.
- Workspace state: active chat, right-side tabs, split ratio, and workspace tab order persist per workspace.

## Spec

### Product Model

A Workspace is a durable user-created container for work-in-progress. It is not the same thing as a repo, folder, environment, agent session, or shell session. A workspace may mostly be used with one project folder, but the model must allow multiple folders, repo configs, local chats, remote chats, local shells, and remote shells inside the same workspace.

An Environment is an execution target. The local environment represents the user's local computer and is singular per local cc-env installation. Remote environments are created when work should run independently of local machine availability.

An Agent Chat is a workspace-scoped chat/session tab that points at one environment and one working directory. A Shell is a workspace-scoped utility tab that points at one environment and one cwd. A shell opened from an agent chat inherits the agent chat's environment and working directory unless the user explicitly chooses otherwise.

```text
App
  └─ Workspace
       ├─ agent chat tab -> env target + working directory
       ├─ agent chat tab -> env target + working directory
       ├─ utility tab    -> shell/file/preview/browser + env target when needed
       └─ persisted UI state
```

### Workspace Shell UX

The primary route renders a workspace shell, not an environment shell. The workspace shell keeps the existing two-pane app shape and should preserve the current environment page's detailed interactions and visual language.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Workspace: zoottle                       ⌘K  Shells  Previews  Settings   │
├──────────────────────────────────────┬───────────────────────────────────────┤
│ Agent Chats                          │ Workspace Tabs                        │
│ ┌────────────┐ ┌────────────┐ ┌───┐  │ ┌────────┐ ┌────────┐ ┌────────┐      │
│ │ chat-a     │ │ chat-b     │ │ + │  │ │ shell  │ │ file   │ │ web    │      │
│ └────────────┘ └────────────┘ └───┘  │ └────────┘ └────────┘ └────────┘      │
│                                      │                                       │
│ Active agent chat transcript         │ Active utility tab                    │
│ Composer / permissions / transcript  │ shell / file / preview / browser      │
├──────────────────────────────────────┴───────────────────────────────────────┤
│ Workspaces: [ zoottle ] [ app-2 ] [ infra ] [ + ]                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

The bottom workspace tab bar is global app chrome. It shows recently active/open workspaces, preserves user ordering, and includes a create button. Switching workspaces restores that workspace's active chat, utility tabs, split ratio, and command palette context. Double-clicking a workspace tab converts its title into an inline text input; submitting or blurring saves the new name.

The left pane remains a full agent chat view. It is not a chat list. The top of the left pane contains chat/session tabs like the current environment UI. The active chat owns the transcript, composer, approvals, questions, model controls, and agent status display.

The right pane currently displays workspace tabs. Workspace tabs may be file panes, shells, previews, browsers, or future workspace tools. Shell and preview tabs are environment-targeted. File tabs are workspace/session-aware because relative paths depend on the selected project context. The data model should call these workspace tabs, not right tabs, because their placement may change later.

The workspace shell should carry over current environment page affordances: draggable split resizing, double-click reset on the resize handle, top-right `⌘K`, `Shells`, `Previews`, and `Settings` actions, shell and preview dropdown counts, closable workspace tabs, shell termination controls, preview reload/open controls, and the existing command palette behavior. The top-level structure changes from environment-first to workspace-first; the UI details should feel like the existing environment page.

### Navigation

The canonical workspace route is:

```text
/w/:workspaceId
```

Volatile selection state may live in search params:

```text
/w/:workspaceId?chat=:agentSessionId&tab=:workspaceTabId
```

The URL should not serialize the full workspace tab list or split state. Those belong in persisted workspace UI state. Environment routes may remain for admin/debug pages, but normal app navigation should enter through `/w/:workspaceId`.

If an old `/env/:id` route is opened, it may redirect to the most recent workspace using that environment or show an environment administration/debug surface. It should not become the main product route for chat work.

### New Workspace Flow

Creating a workspace is immediate. Clicking the workspace `+` button creates a new empty workspace record, navigates to `/w/:workspaceId`, opens the empty workspace chat view, and focuses the new workspace tab title as an inline text input in the bottom bar. The default name may be temporary; the user can type any title and save by pressing Enter or blurring the input.

```text
+ workspace
   │
   ▼
create Workspace(id, defaultName)
   │
   ▼
navigate /w/:workspaceId
   │
   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Empty workspace                                                              │
│                                                                              │
│                         Start a new agent chat                               │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ Workspaces: [ zoottle ] [ Untitled workspace▌ ] [ + ]                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Workspace rename uses the same inline editor whether started by creating a workspace or double-clicking an existing workspace tab. Escape cancels the edit and restores the prior persisted name. If the newly created workspace is still using its default name and the user cancels, the workspace remains; creation is not rolled back.

### New Agent Chat Flow

Creating an agent chat starts from the active workspace and produces a workspace-scoped chat tab. The first UI does not ask the user to choose local vs remote execution; it targets the single local environment implicitly. The data model still records `envId` so remote chat support can be added later without changing the core workspace/session shape.

```text
+ chat tab
   │
   ▼
┌────────────────────────────────────────────────────────────┐
│ New agent chat                                             │
├────────────────────────────────────────────────────────────┤
│ Start from                                                 │
│  ( ) Open folder                                           │
│      Recent folders                                        │
│      ┌──────────────────────────────────────────────────┐  │
│      │ /Users/sam/d/zoottle                             │  │
│      │ /Users/sam/d/notes-app                           │  │
│      └──────────────────────────────────────────────────┘  │
│      [ Choose any folder... ]                              │
│                                                            │
│  ( ) Repo config                                           │
│      ┌──────────────────────────────────────────────────┐  │
│      │ zoottle                                          │  │
│      │ notes-app                                        │  │
│      └──────────────────────────────────────────────────┘  │
│                                                            │
│                    [ Cancel ] [ Create chat ]              │
└────────────────────────────────────────────────────────────┘
```

Open folder starts a chat in an existing local folder. The modal should default to showing recently opened folders and still allow choosing any folder, including whatever folder the user considers the workspace default/current folder. Creating a chat from a folder records that folder as the chat `workingDir` and updates the recent folder list.

Repo config starts a chat by making a full clone of the configured repository, not a git worktree. The clone location becomes the chat `workingDir`. Repo configs are reusable project templates and may include setup files, checked-in configuration, and later model/setup metadata.

Local execution always targets the single registered local environment in this first UI. Remote execution remains supported by the underlying `envId` field and target-aware client model, but remote target selection is not exposed in the initial new-chat modal.

### Data Model

Identity service storage owns workspace identity and workspace-level UI state. Env-server storage owns execution-local session state. Records that cross this boundary must carry IDs explicitly.

Minimum identity-side workspace record:

```ts
type Workspace = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
  archivedAt: string | null
}
```

Recent folders are local-user history, not workspace identity. They should be queryable by the new-chat modal and updated when a chat is created from an arbitrary folder.

```ts
type RecentFolder = {
  path: string
  label: string | null
  lastOpenedAt: string
}
```

Repo configs are reusable clone templates. Creating a chat from a repo config performs a full clone and records the resulting clone path as the chat working directory.

```ts
type RepoConfig = {
  id: string
  name: string
  repoUrl: string
  defaultBranch: string | null
  files: RepoConfigFile[]
}
```

Workspace UI state may be stored as structured JSON or normalized tables, but it must represent:

```ts
type WorkspaceUiState = {
  workspaceId: string
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  workspaceTabs: WorkspaceTab[]
  splitRatio: number | null
  tabOrder: string[]
}
```

Workspace tabs must include enough target data to reconnect after reload:

```ts
type WorkspaceTab =
  | { id: string; type: 'shell'; envId: string; shellId: string; title: string }
  | { id: string; type: 'file'; envId: string; path: string; sessionId?: string; title: string }
  | { id: string; type: 'preview'; envId: string; port: number; title: string }
  | { id: string; type: 'browser'; url: string; title: string }
```

Agent session summaries exposed to the workspace UI must include:

```ts
type WorkspaceAgentSession = {
  id: string
  workspaceId: string
  envId: string
  title: string
  workingDir: string
  status: 'idle' | 'running' | 'waiting' | 'closed' | string
  createdAt: string
  updatedAt: string
}
```

Shell session summaries exposed to the workspace UI must include:

```ts
type WorkspaceShellSession = {
  id: string
  workspaceId: string
  envId: string
  cwd: string
  ownerAgentSessionId: string | null
  title: string
  createdAt: string
  updatedAt: string
}
```

Existing env-server session IDs must not be assumed globally unique across environments. Workspace-level references that point at env-server resources must pair `envId` with the resource ID.

### API Boundaries

The identity app needs workspace APIs for listing, creating, renaming, archiving, opening, and persisting workspace UI state. These APIs should be used by the bottom workspace switcher and by `/w/:workspaceId` route bootstrap.

The workspace page needs a target-aware env client factory. Given an `envId`, it must resolve the correct env-server transport and token, whether the target is local or remote. Workspace UI components should not assume the whole page is bound to one env.

Agent APIs remain env-server APIs, but workspace callers must pass or receive `workspaceId`, `envId`, and `workingDir` for session list/start/rename/close/reopen/status/messages/transcript/send/approval/question flows.

Repo config APIs should support listing configs for the new-chat modal and cloning a config into a fresh full clone directory. The resulting directory is passed to agent session start as `workingDir`.

Shell APIs remain env-server APIs, but workspace callers must pass or receive `workspaceId`, `envId`, `cwd`, and `ownerAgentSessionId` for create/list/resize/dispose/attach flows.

Filesystem APIs remain env-targeted. File operations opened from a chat should resolve relative paths against that chat's `workingDir`. File operations opened from a workspace utility tab must include either an env target and absolute path, or an env target plus session context.

Preview APIs remain env-targeted. Preview tab identity must include `envId` because different environments may expose the same port number.

### Frontend Component Shape

The current environment detail page should be split so the reusable work area is no longer hard-bound to a single route-level env. The workspace route owns workspace bootstrap, workspace UI state, and target resolution. Existing environment UI components should be reused or extracted where possible instead of redesigning equivalent controls.

Expected component boundaries:

```text
WorkspaceRoute
  ├─ loads workspace record + workspace UI state
  ├─ provides workspace context
  ├─ provides env client resolver by envId
  └─ renders WorkspaceShell

WorkspaceShell
  ├─ WorkspaceHeader
  ├─ AgentChatPane
  ├─ WorkspaceTabPane
  └─ WorkspaceTabBar

AgentChatPane
  ├─ Workspace-scoped session tabs
  └─ Active agent session view

WorkspaceTabPane
  ├─ Workspace-scoped tab state
  └─ Env-targeted tab content
```

The active agent session is controlled by workspace state and optionally mirrored into the URL. It should not be local React state that resets on route reload. Workspace tabs and split ratio are persisted per workspace, not per env.

Current environment components to preserve or adapt include the split pane resize behavior, shell and preview dropdowns, command palette, shell tab header/actions, preview tab header/actions, and settings entry point. Their data inputs must become workspace-aware, but their user-facing behavior should remain recognizable.

### Environment Semantics

The local environment is the user's local computer. There is one local env per cc-env installation. Multiple local chats use the same env target with different `workspaceId` and `workingDir` values.

Remote environments are independent execution targets. Future UI may allow a remote agent chat to use a remote env whose filesystem and state are separate from the local machine. Remote environments can be reused by multiple chats when explicitly selected, but remote selection is not shown in the first new-chat UI.

Local and remote chats may eventually appear side by side in the same workspace. When remote chat creation is exposed, UI labels should expose target identity enough to prevent accidental local-vs-remote confusion.

### Persistence And Migration

Workspace records are new durable data. Existing environments remain valid execution targets. Existing localStorage keys scoped as `env.${envId}.*` should not leak tabs or split state across workspaces.

The workspace UI may drop old env-scoped utility tabs rather than migrate them if that keeps the model clean. Existing agent sessions can be shown only if they can be assigned to a workspace; otherwise they may remain accessible from environment debug/admin surfaces.

### Edge Cases

Opening `/w/:workspaceId` when its active chat targets an unavailable remote env should render the workspace and mark that chat as disconnected, not fail the whole page.

Deleting or archiving a workspace should not automatically delete environments. Remote environment cleanup remains explicit unless a future policy says otherwise.

Archiving or deleting an environment should mark dependent chats/shell tabs as unavailable and offer retargeting or closure.

If the local environment is unavailable, local chats should show a reconnect/unavailable state while remote chats in the same workspace continue to work.

If two environments expose the same preview port, preview tabs remain distinct because each tab includes `envId`.

If an agent chat changes working directory, existing file panes opened from its prior directory keep their explicit path/session context rather than silently retargeting.
