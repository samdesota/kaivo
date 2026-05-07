# File Pane Disk Reload Spec

## Seed

Open file panes should track the current file contents on disk. When the file changes externally, panes with no local edits should refresh automatically; panes with unsaved edits should keep those edits and show a banner that the disk version is newer, with actions to discard local edits or save them.

## Solution

- Watch source: reuse the existing `fs.watch` tRPC subscription from the env server.
- Freshness signal: use `fs.read.mtime` as the editor's disk-version marker.
- Render-time correctness: every mounted file pane reconciles against a fresh `fs.read` snapshot, even if it missed prior watch events.
- Watch behavior: matching file events invalidate `fs.read` for mounted panes so visible files update promptly.
- Conflict UI: show an inline top banner only when the disk version is newer than the draft base.
- Conflict actions: `Discard changes` replaces the draft with the latest disk content; `Save` overwrites disk with the current draft.

## Spec

### Scope

This feature applies to open file panes rendered by the env file viewer. It covers text files that `fs.read` can display. Binary files, oversized files, missing files, and read errors continue to use the existing non-editor states.

### Existing Interfaces

The env server already exposes the needed file APIs:

```ts
fs.read({ path: string, absolute?: boolean }) => {
  path: string
  size: number
  mtime: Date
  encoding: 'utf8' | 'binary'
  content: string | null
  binary: boolean
  tooLarge: boolean
}

fs.write({ path: string, content: string, absolute?: boolean }) => { ok: true }

fs.watch => FsEvent
type FsEvent = {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
}
```

`fs.watch` emits workspace-relative paths. Absolute file panes must match events by comparing the watched event path to the pane path after resolving both to the same file identity.

### File Viewer State

Each file tab owns enough editor state to survive unmount/remount while switching workspace tabs. The state has three concepts:

```ts
type DiskSnapshot = {
  content: string
  mtime: string | Date
}

type EditorState = {
  draft: string | null
  draftBaseMtime: string | Date | null
  latestDisk: DiskSnapshot
}
```

`latestDisk` comes from the current `fs.read` result. `draft === null` means the editor is clean and should render `latestDisk.content`. When the user edits, the pane captures `draftBaseMtime` from the current `latestDisk.mtime` and renders `draft`.

The pane is dirty when `draft !== null` and `draft !== latestDisk.content`. It is stale when it is dirty and `latestDisk.mtime` is newer than `draftBaseMtime`.

### Watch Handling

Each mounted file viewer subscribes to `fs.watch`. A viewer responds only to events for its own file. Directory events are ignored by the viewer.

For matching `add` or `change` events, the viewer refreshes its `fs.read` query. If the editor is clean, the refreshed query updates the CodeMirror value. If the editor is dirty, the refreshed query updates `latestDisk` but keeps the draft in CodeMirror.

For matching `unlink` events, a clean editor moves to the existing read-error or not-found state after refresh. A dirty editor keeps the draft visible and shows the same stale banner, with copy indicating the file was deleted on disk.

Watch events are hints and only improve latency for mounted panes. The source of truth remains `fs.read`, so missed or duplicate events must not corrupt editor state.

### Render-Time Freshness

Inactive workspace tabs are not rendered, so their file viewers are not subscribed to `fs.watch`. A file pane must therefore check freshness whenever it mounts or remounts.

On mount, the viewer runs `fs.read` for its path. If the tab has no draft, the viewer renders the returned snapshot. If the tab has a draft, the viewer compares the returned `mtime` with `draftBaseMtime`. A newer `mtime` marks the draft stale and shows the banner immediately, even if no watch event was observed while the pane was inactive.

Dirty editor state must live at the file-tab level or another tab-scoped store, not only inside the mounted CodeMirror component. This prevents local edits from disappearing when the user switches workspace tabs and later returns.

### End-to-End Lifecycle

The backend owns disk observation. The env server's shared chokidar watcher observes changes under the workspace root and emits debounced `FsEvent` objects through the existing `fs.watch` tRPC subscription. Those events contain only the event type and workspace-relative path, so they tell the client that something changed but do not carry file contents.

The frontend owns pane-specific reconciliation. When a file pane is rendered, it fetches `fs.read` and compares that backend snapshot against any tab-scoped draft state. While the pane remains mounted, it also compares incoming watch events against its pane path. When an event matches, the viewer refetches `fs.read`. The refetch returns the authoritative file snapshot: content, size, binary flags, and `mtime`.

Clean panes render the backend snapshot immediately. Dirty panes keep the local CodeMirror draft, update their cached disk snapshot from the mount fetch or watch-triggered refetch, and compare the snapshot `mtime` against the draft's base `mtime`. If disk moved ahead, the pane shows the stale banner.

User actions complete the loop back to the backend. `Discard changes` is local state reconciliation: clear the draft and render the latest backend snapshot or read error. `Save` sends the draft through the existing `fs.write` mutation; the env server writes UTF-8 content to disk, the frontend refetches `fs.read`, and the pane becomes clean against the new backend snapshot.

### Conflict Banner

The stale banner appears between the file header and CodeMirror. It appears only when local edits exist and the disk snapshot changed after the draft began.

Required banner content:

```text
The file on disk is newer than your local edits.
```

For deletes, use:

```text
The file was deleted on disk while you have local edits.
```

Required actions:

```text
Discard changes
Save
```

`Discard changes` clears the draft and renders the latest readable disk content. If the file was deleted or no latest content is available, it clears the draft and lets the pane show the read-error/not-found state.

`Save` writes the current draft to disk using the existing write mutation. This intentionally overwrites the newer disk version. After a successful save, the pane clears the draft and refreshes `fs.read` so `latestDisk` represents the saved file.

### Save Semantics

The existing Save button remains available whenever the editor is dirty. The banner's Save action and the header Save action share the same behavior.

Save does not need an optimistic concurrency check in this iteration. The user-visible stale banner is the conflict warning, and pressing Save is an explicit overwrite.

### Path Matching

Workspace-relative panes match `FsEvent.path` directly after normalizing leading slashes. Absolute panes match events that resolve to the same absolute file under the current workspace. If an absolute pane is outside the watched workspace, it cannot receive watch events and keeps current manual-refresh behavior.

### Error Handling

If a refresh after a watch event fails while the editor is clean, show the existing read error. If it fails while dirty, keep the draft and show the banner when the failure means the disk copy is no longer the draft base.

Write failures keep the draft and display the existing write error. The stale banner remains if the disk version is still newer than the draft base.

### Dependencies

No new server dependency is required. The client uses the existing env tRPC hooks, React Query invalidation/refetch, and current inline Tailwind banner patterns.

### Test Surface

Unit tests should cover the file viewer state transitions with a mocked env tRPC layer and a mocked CodeMirror component: clean auto-refresh, dirty stale banner, render-time stale detection after remount, draft survival across unmount/remount, discard, overwrite save, delete while clean, and delete while dirty.

Server tests are not required for the existing watcher API unless path matching needs a new helper. If a helper is added for path normalization, it should have direct unit coverage.

Manual verification should open a file pane, edit the same file from disk, and confirm clean panes refresh while dirty panes retain local edits and show the banner.
