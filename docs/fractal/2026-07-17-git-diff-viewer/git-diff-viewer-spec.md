# Git Diff Viewer

## Seed

Add an **Open Git Diff** action to Kaivo's Command-T menu that opens a dedicated right-side pane tab for reviewing the current repository's changes. The pane defaults to the current branch versus the repository's main branch, and also supports viewing working-tree-only changes or comparing against another remote branch.

## Solution

- Pane integration: add a persistent `git-diff` workspace tab, opened from Command-T for the active working directory and rendered in the right-side pane system.
- Git boundary: run typed, argument-safe Git operations in the paired env server, with repository-root validation and bounded command output.
- Default comparison: show PR-style changes from the merge base of the current branch and `origin`'s default branch through the full local state, including committed and uncommitted changes; fall back to `origin/main` then `origin/master`.
- Comparison controls: switch the base to another `origin/*` branch, disable **Include uncommitted** for a committed-only PR diff, or select **Working tree** for staged, unstaged, and untracked changes relative to `HEAD` only.
- Branch data: use locally available remote refs without an implicit network fetch; expose an explicit refresh action for rereading repository state.
- Diff UI: reuse Kaivo's unified diff rendering and syntax highlighting, with file navigation, aggregate change counts, loading, empty, and actionable error states.
- State model: persist the repository identity with the tab while keeping comparison selection and refreshed diff data live to the pane instance.

## Spec

### User Flow

1. The user presses Command-T in a workspace and selects **Open Git Diff**.
2. Kaivo resolves the active session's working directory and opens or activates one Git Diff tab for that environment and repository root.
3. The pane discovers the repository, its current branch, local `origin/*` refs, and `origin`'s default branch.
4. The initial view shows changes from the merge base of `HEAD` and the default origin branch through the full local state: committed, staged, unstaged, and untracked changes.
5. The user can turn off **Include uncommitted** to end the branch comparison at `HEAD`, choose **Working tree** to isolate staged, unstaged, and untracked changes relative to `HEAD`, or select another `origin/*` branch as the comparison base.
6. The user can navigate changed files, expand or collapse file diffs, and explicitly refresh the snapshot.

Opening Git Diff outside a Git repository still opens the pane and shows a repository-not-found state. If there is no active session or working directory, the Command-T action is disabled with an explanation.

### Pane Contract

Git Diff is a first-class workspace pane alongside shell, file, and browser panes.

```ts
type GitDiffPaneContent = {
  type: "git-diff"
  cwd: string
}

type GitDiffWorkspaceTab = {
  id: string
  type: "git-diff"
  envId: string
  repoRoot: string
  title: string
}
```

The menu passes the active `cwd`; repository discovery canonicalizes it to `repoRoot` before the durable tab record is settled. A Git Diff tab is uniquely keyed by environment and canonical repository root. Reopening the action for the same repository activates the existing tab; separate repositories or environments receive separate tabs.

The durable tab stores only repository identity and title. Comparison mode, selected origin branch, file expansion, and current results are transient state keyed to the tab ID. They survive switching between tabs during the app session but reset to defaults after an application reload. On reload, the restored tab performs fresh repository discovery and diff queries.

The pane uses the existing workspace environment provider and paired environment token. It does not route Git operations through the app server or legacy sandbox APIs.

### Environment API

The paired env server exposes authenticated, read-only Git queries:

```ts
type GitRepository = {
  root: string
  gitDir: string
  headOid: string | null
  branch: string | null
}

type OriginBranch = {
  name: string                 // e.g. "main"
  ref: string                  // e.g. "refs/remotes/origin/main"
  oid: string
  isDefault: boolean
}

type GitDiffInput =
  | { cwd: string; kind: "branch"; originBranch: string; includeUncommitted: boolean }
  | { cwd: string; kind: "working-tree" }

type GitDiffFile = {
  oldPath: string | null
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
  binary: boolean
  additions: number | null
  deletions: number | null
}

type GitDiffResult = {
  repository: GitRepository
  kind: "branch" | "working-tree"
  baseRef: string | null
  mergeBaseOid: string | null
  patch: string
  files: GitDiffFile[]
  additions: number
  deletions: number
  byteCount: number
  truncated: boolean
  warnings: string[]
}
```

The query surface consists of:

- `discoverGit({ cwd })` returning a canonical repository or `null` when `cwd` is not inside one.
- `originBranches({ cwd })` returning branches, the detected default branch, and detection source (`symbolic-ref`, `heuristic`, or `none`).
- `diff(input)` returning one internally consistent diff snapshot and structured file metadata.

All inputs have length limits. Repository discovery canonicalizes paths and every later operation verifies that the requested directory resolves to the discovered repository. Origin branch input is matched against enumerated `refs/remotes/origin/*` refs rather than interpolated into a shell command. Git runs with argument arrays, never shell strings, with color, external diff drivers, and text conversion disabled.

Git subprocesses have a 15-second timeout and a 5 MiB combined patch-output limit. Exceeding the limit returns the captured prefix with `truncated: true`; timeout and invalid-ref failures are structured errors, not partial successes. No query fetches, checks out, modifies, stages, or cleans repository state.

### Git Semantics

Repository discovery uses Git's own top-level and Git-directory resolution, so nested working directories and worktrees resolve correctly. `branch` is `null` for detached `HEAD`; `headOid` is `null` for an unborn repository.

Origin branches come only from locally available `refs/remotes/origin/*`; symbolic `origin/HEAD` is excluded from the selectable list. The default branch is resolved in this order:

1. Target of `refs/remotes/origin/HEAD`.
2. Existing `origin/main`.
3. Existing `origin/master`.
4. No default.

Branch comparisons validate the chosen ref and calculate its merge base with `HEAD`. With **Include uncommitted** on, the diff runs from that merge base through the current index and working tree, then appends untracked files as additions. With it off, the diff ends at `HEAD`. Both variants avoid unrelated changes added to the base branch after divergence.

Working-tree comparison produces all tracked changes relative to `HEAD`, combining staged and unstaged changes into each file's net current state. Untracked, non-ignored files are appended as additions from `/dev/null`. Ignored files are excluded. In an unborn repository, all non-ignored files are treated as untracked additions and branch comparison is unavailable.

Renames and copies retain old and new paths. Binary files appear in navigation and counts with a binary marker but no fabricated line counts or body. Deleted files, filenames requiring Git quoting, submodules, and files outside the selected subdirectory are represented using repository-relative paths.

### Interface

```text
Wide pane
┌──────────────────────────────────────────────────────────────────────────────┐
│ Git Diff  feature/login → origin/main               ↻ Refresh       ×       │
├──────────────────────────────────────────────────────────────────────────────┤
│ [ Branch changes ▾ ] [ origin/main ▾ ] [✓ Include uncommitted]  +142  -37    │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ CHANGED FILES         │ src/auth/login.tsx                         −  ×      │
│ 6 files  +142  -37    │ @@ -18,7 +18,12 @@                                  │
│                       │  const submit = async () => {                        │
│ M src/auth/login.tsx  │ -  await login(email)                               │
│ A src/auth/token.ts   │ +  await login({ email, remember })                  │
│ R src/old.ts → new.ts │ +  navigate("/home")                                │
│ M src/styles.css      │  }                                                   │
│ B assets/logo.png     │                                                      │
│                       ├──────────────────────────────────────────────────────┤
│                       │ src/auth/token.ts                           −  ×      │
│                       │ New file                                              │
│                       │ +export function readToken() { ... }                 │
└───────────────────────┴──────────────────────────────────────────────────────┘

Narrow pane
┌──────────────────────────────────────────┐
│ Git Diff                         ↻   ×    │
│ feature/login → origin/main              │
├──────────────────────────────────────────┤
│ [ Branch changes ▾ ] [ origin/main ▾ ]   │
│ [✓ Include uncommitted]                   │
│ [ 6 changed files ▾ ]       +142  -37    │
├──────────────────────────────────────────┤
│ src/auth/login.tsx              −  ×     │
│ @@ -18,7 +18,12 @@                       │
│ -  await login(email)                    │
│ +  await login({ email, remember })       │
└──────────────────────────────────────────┘
```

The standard workspace tab chrome owns the close control; it is shown in the wireframe only to establish the header boundary. The pane content starts with a sticky comparison toolbar. **Branch changes** reveals the base-branch selector and a default-on **Include uncommitted** checkbox; **Working tree** hides both because its scope is inherently uncommitted changes. Branch options display as `origin/<name>`, are searchable when the list is long, and mark the detected default.

At wide widths, a resizable file navigator remains visible beside the unified diff. At narrow widths, it becomes a changed-files selector above the diff. Selecting a file scrolls to and expands its section. File rows show status, repository-relative path, binary state, and additions/deletions when available. Renames show both paths.

The existing unified diff visual language and syntax highlighting are reused. File sections can be collapsed independently. Hunk and file headers remain sticky within the scrolling diff where space permits. Rendering and highlighting are lazy by expanded file so a large valid response does not block the entire pane.

Toolbar controls and changed-file rows are keyboard reachable. Selectors expose labels, selected state, and standard listbox keyboard behavior. Additions and deletions use text/symbol cues as well as color. Focus moves into an error action only when the user invokes it, never merely because a background refresh completed.

### Loading And Errors

Initial loading shows the pane skeleton without an empty-state flash. Changing mode or base keeps the prior diff visible at reduced emphasis with a loading indicator until the new snapshot succeeds; stale responses cannot replace a newer selection.

Refresh rereads repository identity, branches, and the active comparison without contacting the remote. A changed default branch updates the default selection only when the user has not explicitly chosen another base during the tab session. The **Include uncommitted** preference survives tab switching during the session and resets to on after an application reload.

Defined empty and error states are:

- **No changes:** successful query with a zero-file explanation specific to branch or working-tree mode.
- **Not a Git repository:** show the attempted working directory and a retry action.
- **No origin branches:** keep Working tree available and explain that branch comparison requires local `origin/*` refs.
- **Detached HEAD:** allow both modes when a merge base exists; label the head by short commit SHA.
- **Base has no merge base:** preserve the selected branch and explain that the histories are unrelated.
- **Repository disappeared or changed:** rerun discovery; if its canonical root changes, update tab identity without merging it into an unrelated existing tab.
- **Truncated diff:** render captured files, show a persistent limit warning, and do not claim complete aggregate counts unless metadata completed independently.
- **Timed out or Git failed:** retain the previous successful snapshot if present and show retry plus concise stderr details.

### Dependencies And Compatibility

The feature uses the Git executable already required by repository workflows, the existing paired env tRPC transport, workspace-tab persistence, and Kaivo's current diff renderer and Shiki setup. It adds no network service and no automatic GitHub or pull-request API dependency. Private repositories work from existing local refs without requiring fresh credentials.

Existing shell, file, and browser tab records remain valid. The workspace-tab schema change is additive and older clients must reject or ignore an unknown Git Diff tab safely rather than corrupting persisted tab state.

### Verification Scope

Service coverage uses temporary real Git repositories for default-branch detection, merge-base behavior, alternate bases, branch comparisons with uncommitted changes included and excluded, working-tree-only changes, unborn and detached states, renames, binary files, unusual filenames, output limits, timeouts, and ref-injection attempts. Contract coverage validates authenticated inputs and structured errors.

Workspace coverage verifies menu enablement, open-pane transport, tab deduplication, persistence round trips, restore behavior, environment targeting, transient selection state, stale-request protection, responsive file navigation, empty/error states, and keyboard operation. Existing pane types and workspace restoration receive regression coverage.
