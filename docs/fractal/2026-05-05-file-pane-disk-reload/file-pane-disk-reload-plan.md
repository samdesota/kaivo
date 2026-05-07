# File Pane Disk Reload Plan

## Task 1: Tab-Scoped File Draft State

Move file editor draft metadata out of the mounted `FileViewer` so local edits survive workspace-tab switches and remounts.

**Steps**
- Add a tab-scoped file editor state shape for `draft`, `draftBaseMtime`, and any deleted/stale marker needed by the viewer.
- Thread the state and updater from file tab content into `FileViewer` without changing non-file tab behavior.
- Keep write errors local to the mounted viewer unless a test proves they must persist.

**Tests**
- Unit: file tab state update preserves draft metadata for the target tab only.
- Unit: switching away from and back to a file tab restores the draft passed to `FileViewer`.
- Manual: edit a file, switch to another workspace tab, return, and observe the edit remains.

**Depends on:** none

**Status:** done

## Task 2: Render-Time Freshness Reconciliation

Make `fs.read` on mount/remount the correctness path for detecting newer disk contents, including changes missed while the pane was unmounted.

**Steps**
- Track the latest readable disk snapshot from `fs.read`, including content and `mtime`.
- Capture `draftBaseMtime` when the first local edit starts.
- On every successful `fs.read`, compare the snapshot `mtime` against `draftBaseMtime` when a draft exists.
- Preserve the draft when disk is newer; adopt disk content automatically when clean.

**Tests**
- Unit: clean viewer renders newer `fs.read` content on mount.
- Unit: dirty viewer shows stale state on mount when `fs.read.mtime` is newer than `draftBaseMtime`.
- Unit: dirty viewer does not replace draft when a newer snapshot arrives.

**Depends on:** Task 1

**Status:** done

## Task 3: Live Watch Refresh For Mounted Panes

Use the existing `fs.watch` subscription to reduce latency for visible panes while preserving `fs.read` as the source of truth.

**Steps**
- Subscribe mounted file viewers to `fs.watch`.
- Match file events to the viewer path for workspace-relative panes and absolute panes under the workspace.
- Refetch or invalidate `fs.read` only for matching `add`, `change`, and `unlink` events.
- Ignore duplicate events and directory events.

**Tests**
- Unit: matching change event refetches the current file query.
- Unit: unrelated and directory events do not refetch the viewer.
- Manual: edit an open file externally and observe a clean pane update without tab switching.

**Depends on:** Task 2

**Status:** done

## Task 4: Stale Banner And Conflict Actions

Add the visible conflict workflow for dirty panes whose disk snapshot moved ahead of the draft base.

**Steps**
- Render the stale banner between the file header and editor only when the dirty draft is based on an older disk snapshot.
- Add `Discard changes` to clear the draft and render the latest disk content or current read error.
- Reuse the existing save mutation for both header Save and banner Save.
- Keep the stale banner visible after write failure when disk is still newer than the draft base.

**Tests**
- Unit: stale banner appears only for dirty stale state.
- Unit: `Discard changes` clears draft and renders latest disk content.
- Unit: `Save` writes the draft, clears draft after success, and refreshes `fs.read`.
- Unit: failed save keeps draft and stale banner.

**Depends on:** Task 3

**Status:** done

## Task 5: Deleted File Handling

Handle `unlink` and read-not-found cases without losing local edits.

**Steps**
- For clean panes, let a deleted file fall through to the existing read error/not-found state.
- For dirty panes, keep the draft visible when refresh reports not found.
- Show delete-specific stale banner copy for dirty deleted files.
- Let `Save` recreate the file through the existing `fs.write` behavior.

**Tests**
- Unit: clean viewer shows read error after deleted-file refresh.
- Unit: dirty viewer keeps draft and shows deleted-file banner after deleted-file refresh.
- Unit: saving a dirty deleted file calls `fs.write` with the draft and clears stale state after refetch.

**Depends on:** Task 4

**Status:** done

## Task 6: End-to-End Verification

Verify the behavior through the product path and lock in the expected user flows.

**Steps**
- Add or update a higher-level React test covering remount after missed disk change.
- Run the relevant unit test suite for file viewer, tab state, and path matching.
- Run the app locally and manually exercise clean refresh, dirty stale banner, discard, save overwrite, and deleted-file recovery.

**Tests**
- Unit: full remount flow detects stale disk snapshot without any watch event.
- Manual: open a file, externally edit it while clean, observe auto-refresh.
- Manual: open a file, type local edits, externally edit/delete it, observe banner actions behave as specified.

**Depends on:** Task 5

**Status:** done
