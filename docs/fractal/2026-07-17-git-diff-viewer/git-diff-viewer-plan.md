# Git Diff Viewer Execution Plan

## Task 1: Open The Default Repository Diff

Ship the smallest useful end-to-end path: **Open Git Diff** creates a persistent right-side tab and displays the current branch's changes against the detected default origin branch, including uncommitted changes.

**Steps**
- Add a focused env-server Git service and authenticated router for repository discovery, local origin-branch enumeration/default detection, and the default merge-base-to-local-state diff. Use argument-array Git execution, canonical repository roots, bounded output, timeout handling, structured metadata, and untracked-file inclusion.
- Extend the shared pane and workspace-tab contracts with `git-diff`, including Zod validation, durable SQLite storage for the repository root, row/record conversions, additive local migration, restore behavior, and the environment-plus-root deduplication key.
- Add **Open Git Diff** to the active universal-menu command list. Disable it without an active environment working directory; otherwise return the existing detached overlay's `open-pane` response and activate an existing matching tab when present.
- Add the workspace renderer and a focused Git Diff tab component inside the workspace environment provider. Discover the repository, load the default comparison, and render its summary and unified patch with the existing diff visual language.
- Represent initial loading, no changes, no repository, no local origin/default branch, detached or unborn `HEAD`, command failure, timeout, and truncated-output states without modifying repository or remote state.

**Tests**
- E2E: From a workspace backed by a temporary repository, open Command-T, choose **Open Git Diff**, verify a right-side tab shows committed and uncommitted changes against `origin/main`, close it, reopen it, and verify tab persistence/deduplication.
- Unit: Exercise the Git service against real temporary repositories for canonical discovery, symbolic and fallback default branches, merge-base semantics, staged/unstaged/untracked content, detached and unborn states, binary/rename metadata, limits, timeout, and malicious ref/path inputs.
- Unit: Validate authenticated router inputs, error mapping, and the returned structured snapshot contract.
- Unit: Cover pane schema parsing, migration of an existing database, tab row/record round trips, restored tabs, tab keys, universal-menu enablement/response, and workspace renderer environment targeting.
- Unit: Render the tab through loading, successful, empty, and primary error states while verifying uncommitted content is requested by default.

**Maintainability**
- Keep Git process execution and Git-domain interpretation separate so command safety, timeout, and output-limit logic are not duplicated across queries.
- Define the `git-diff` pane contract once in shared code and derive client/server handling from it where possible; explicitly test unavoidable conversion boundaries to prevent schema drift.
- Keep the tab component responsible for orchestration, not Git parsing or persistence conversion; isolate query-state and presentation concerns before the component grows.
- Extend the existing diff renderer rather than creating a second unified-diff visual implementation.
- Make the workspace-tab migration additive and preserve all existing shell, file, and browser records unchanged.

**Depends on:** none

**Status:** done

## Task 2: Choose The Comparison Scope

Let the user move between the default combined diff, a committed-only PR diff, another local origin base, and working-tree-only changes without leaving the tab.

**Steps**
- Complete the env Git diff contract for `includeUncommitted: false`, alternate validated `origin/*` bases, and `working-tree` comparisons that combine staged, unstaged, and untracked changes relative to `HEAD`.
- Add the sticky comparison toolbar with **Branch changes** and **Working tree** modes, a searchable local origin-branch selector, the default-on **Include uncommitted** control, comparison labels, aggregate counts, and explicit refresh.
- Keep mode, explicit base choice, include-uncommitted preference, and file expansion state in transient state keyed by tab ID so they survive tab switches but not application reloads.
- Refresh repository identity, available branches, and the active diff from local state only. Preserve an explicit base choice, adopt a changed detected default only when appropriate, and prevent stale requests from replacing newer selections.
- Preserve the previous successful diff while a changed comparison loads or fails, and expose mode-specific empty states and retry actions.

**Tests**
- E2E: Switch a populated tab from the default combined comparison to committed-only, another origin base, and Working tree; verify each file/count set and verify Refresh picks up a newly edited file without fetching the remote.
- Unit: Verify branch comparisons include or exclude index, working-tree, and untracked content according to `includeUncommitted`, while Working tree excludes committed branch changes.
- Unit: Verify alternate-ref validation, unrelated histories, missing refs, no-origin behavior, and default-branch changes during refresh.
- Unit: Verify control visibility and keyboard behavior, default-on uncommitted state, transient state across tab switches, reset after restore, retained snapshots, and stale-response suppression.

**Maintainability**
- Model comparison selection as one discriminated state rather than independent booleans that can form invalid combinations.
- Reuse one diff query/result contract for all modes and keep mode-specific Git arguments inside the service.
- Centralize refresh and request-order handling instead of adding separate effects for each toolbar control.
- Keep transient comparison state out of durable workspace-tab rows so persistence does not become a cache of stale repository data.

**Depends on:** Task 1

**Status:** done

## Task 3: Navigate Large And Complex Diffs

Complete the review experience with responsive file navigation, efficient rendering, clear edge-case treatment, and keyboard-accessible interaction.

**Steps**
- Add the wide-pane resizable changed-file navigator and narrow-pane changed-files selector, with status, paths, rename presentation, binary marker, per-file counts, aggregate counts, and selection-to-section scrolling.
- Refine the reusable diff renderer around structured file metadata and robust hunk parsing. Support independently collapsible sections, repository-relative unusual filenames, deleted and renamed files, binary placeholders, and sticky headers.
- Make parsing, expansion, syntax highlighting, and rendering incremental so valid responses near the output limit do not block the pane. Clearly mark a truncated patch and avoid presenting incomplete totals as complete.
- Finish responsive behavior, focus order, labeled selectors/listboxes, non-color addition/deletion cues, keyboard file navigation, and reduced-motion-safe scrolling.
- Add concise retained-snapshot errors for repository disappearance/change and Git failures, including retry behavior and canonical-root identity reconciliation.

**Tests**
- E2E: Review a multi-file diff on wide and narrow viewports, navigate files by pointer and keyboard, collapse sections, inspect rename and binary rows, and verify truncation/error warnings remain actionable.
- Unit: Cover diff parsing for multiple hunks, quoted/unusual paths, additions, deletions, renames, binary files, and truncated final sections.
- Unit: Cover responsive navigator switching, file selection/scroll targeting, lazy highlighting, aggregate-count completeness, accessible names, focus order, and keyboard listbox behavior.
- Regression: Run the full workspace pane suite to verify shell, file, and browser tabs still open, restore, activate, and close normally.
- Human: Confirm the diff remains readable and responsive with a repository near the 5 MiB patch limit on both desktop and a narrow right-side pane.

**Maintainability**
- Keep parsed diff data independent from rendered React elements so navigation, counting, and tests do not depend on syntax-highlighted markup.
- Share file identity and status formatting between the navigator and diff sections rather than reparsing patch headers in each component.
- Isolate responsive layout from data fetching so viewport changes never refetch or reset comparison state.
- Avoid rendering every highlighted line eagerly; expansion and visibility should bound expensive work.
- Keep generic improvements in the shared diff renderer and Git-viewer-specific controls in the Git Diff tab.

**Depends on:** Task 2

**Status:** done

## Plan Verification

Run focused tests after each Task, then finish with:

```bash
npm test
npm run typecheck
npm run lint
npm run test:e2e -- tests/e2e/git-diff-viewer.spec.ts
npm run build
```
