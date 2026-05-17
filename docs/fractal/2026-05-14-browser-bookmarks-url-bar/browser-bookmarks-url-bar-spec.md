# Browser Bookmarks URL Bar Spec

## Seed

Make browser panes feel like real browser tabs: users can create bookmarks for the current page through a detached overlay-layer modal, reopen those bookmarks from the universal menu `@` Web scope, and use the pane URL bar for bookmark lookup, direct navigation, and plain-text web search.

The interaction should stay intentionally simple: no typeahead suggestions, but typed text should search open pages and bookmarks in both `@` mode and the URL bar, while URL bar submission should reliably choose between a bookmark match, a URL, or a search and navigate the active native browser tab.

## Solution

- Bookmark storage: add `bookmark` as a `workspace_resources` type, keyed by normalized URL with title, URL, optional favicon/origin, and created source in `data`, synced through the realtime SQLite engine.
- Bookmark frontend state: expose bookmarks through a dedicated TanStack collection hook backed by `sync.snapshot`/`sync.changes`, following the existing workspace resource collection pattern.
- Bookmark creation: browser pane exposes a right-side add-bookmark control and `Cmd+D`/`Ctrl+D` shortcut that open a typed detached overlay-layer modal seeded from the active page URL/title/favicon.
- Bookmark search: universal menu `@` mode and browser pane URL bar read the same workspace bookmark source, match typed text against title, URL, and origin, and rank exact matches before prefix/substring matches.
- URL bar behavior: typing filters local bookmark matches inline; submitting opens the selected/exact bookmark match, otherwise navigates a parsed URL, otherwise opens a configured web-search URL.
- `@` Web behavior: results combine direct URL/search action, open browser tabs, and saved bookmarks; selecting any result opens or focuses a browser pane through existing `PaneContent` routing.
- Navigation normalization: share one URL/search normalization utility between `BrowserPane` and universal menu Web scope.
- Overlay discipline: all bookmark-create UI renders in `routes/internal/overlay-layer.tsx`; workspace/browser components only launch it through `overlay-layer-controller.tsx`.

## Spec

### Product Shape

Browser panes become the app's browser workspace surface, not just a native tab embed. A user can save the current page, find saved pages from the URL bar or universal menu, and navigate with predictable browser-like input rules.

The feature has three visible surfaces:

- Browser pane chrome: back, forward, reload, devtools, bookmark action, URL/search input, bookmark match rows.
- Bookmark creation overlay: compact detached modal for naming and saving the current page.
- Universal menu `@` Web scope: keyboard-first list of direct navigation/search actions, open tabs, and bookmarks.

The UI should follow `docs/ux-principles.md`: compact rows, restrained borders, no cards for repeated bookmark rows, short labels, quiet empty/error states, and actions close to the affected page or row.

### Bookmark Data Model

Bookmarks are stored in the app SQLite DB via `workspace_resources` and synced to the frontend through the existing realtime engine.

Resource shape:

```ts
type WorkspaceResourceType = 'browser_tab' | 'worktree' | 'shell' | 'bookmark' | 'other'

type BookmarkResourceData = {
  title: string
  url: string
  normalizedUrl: string
  origin: string | null
  faviconDataUrl?: string | null
  faviconUrl?: string | null
  createdFrom?: 'browser-pane' | 'universal-menu' | 'migration'
}
```

Storage rules:

- `type` is `bookmark`.
- `workspaceId` is the current workspace id; bookmarks are workspace-scoped in this version.
- `resourceKey` is `bookmark:${normalizedUrl}` to make saving the same URL idempotent per workspace.
- `shared` is `true` because bookmark records describe workspace-level reusable destinations, not disposable native tabs.
- `data.title` is user-editable and required after trim.
- `data.url` is the navigable URL submitted to browser panes.
- `data.normalizedUrl` is the canonical comparison key.
- `data.origin` is used for compact display and favicon lookup.
- `data.faviconDataUrl` is the preferred persisted display icon for bookmark rows.
- `data.faviconUrl` is retained as source metadata or fallback when a safe data URL is unavailable.

The existing app realtime registration already includes `workspace_resources`; implementation must ensure `bookmark` is accepted by TypeScript, zod router validation, and any cleanup/type switch statements without weakening validation to arbitrary strings.

### Bookmark Collection

Create a bookmark-specific TanStack collection hook on top of `workspace_resources`, following `useWorkspaceResourcesStore` and `docs/sqlite-realtime.md`.

Expected API shape:

```ts
type BookmarkRecord = {
  id: string
  workspaceId: string
  title: string
  url: string
  normalizedUrl: string
  origin: string | null
  faviconDataUrl?: string | null
  faviconUrl?: string | null
  createdAt: Date
  updatedAt: Date
}

function useWorkspaceBookmarksStore(workspaceId?: string): {
  bookmarks: BookmarkRecord[]
  isLoading: boolean
  error: unknown
  collection: Collection<WorkspaceResourceRecord, string>
}
```

Collection rules:

- Hydrate with `sync.snapshot` for `workspace_resources`.
- Subscribe with `sync.changes` for `workspace_resources`.
- Use `collection.utils.writeUpsert`, `writeDelete`, and `writeBatch` for backend CDC events.
- Filter to `type === 'bookmark'` and optional `workspaceId` after hydration.
- Normalize malformed bookmark data defensively; invalid rows should be skipped, not rendered as broken UI.
- Mutations still go through `workspace.upsertResource` and `workspace.deleteResource` so the backend remains source of truth.

### URL And Search Normalization

Move browser navigation parsing into a shared utility used by `BrowserPane` and universal menu Web scope.

Expected decisions:

- Empty input navigates to `about:blank` only when explicitly submitted from the URL bar.
- Existing schemes such as `https:`, `http:`, `about:`, `file:`, and custom valid schemes pass through unchanged.
- `localhost`, `localhost:PORT`, and IPv4 host input become `http://...`.
- Domain-like input with no spaces becomes `https://...`.
- Anything else becomes a web search URL.

Default search URL:

```text
https://www.google.com/search?q=<encoded query>
```

If the product already has a search provider setting by implementation time, use that setting; otherwise keep the default local to the navigation utility.

Bookmark matching uses the same trimmed query text but does not transform it into a URL. It compares lowercased title, URL, normalized URL, and origin.

Ranking rules:

- Exact title or exact normalized URL match comes first.
- Prefix title or prefix host/origin match comes next.
- Substring title/URL/origin matches come after prefix matches.
- Recency breaks ties, using `updatedAt` descending.
- The query `foo` must rank bookmark title `foo` ahead of `foozam`.

### Browser Pane Chrome

`BrowserPane` remains responsible for native browser tab lifecycle and calls `browserApi.navigate` on the active native tab. It gains workspace bookmark data and right-side browser actions.

Required props or wiring:

- `workspaceId` or enough context to create workspace-scoped bookmark resources.
- `bookmarks` or a hook inside the pane that reads workspace bookmarks.
- Current `url`, current `title`, current favicon/origin when available.
- A way to persist the current favicon as bookmark display metadata. Prefer the app favicon cache data URL for the page origin when available; fall back to the live browser favicon URL only if safe display handling already exists.

The URL input is not typeahead. It is a text field with an inline results popover shown only when focused and the typed value has non-empty text that differs from the current page URL enough to be treated as a query.

Browser pane wireframe:

```text
+------------------------------------------------------------------+
| <-  ->  reload  [ Search bookmarks or enter URL     ]  </>  star |
+------------------------------------------------------------------+
|                                                                  |
|                    native browser slot                           |
|                                                                  |
+------------------------------------------------------------------+
```

URL bar with bookmark matches:

```text
+------------------------------------------------------------------+
| <-  ->  reload  [ git                                  ]  </>  * |
+----------------------------+-------------------------------------+
                             | [icon]  GitHub Issues               |
                             |         github.com/issues            |
                             | [icon]  GitHub PR                   |
                             |         github.com/sam/repo/pull/1   |
                             | [🔍]    Search web for "git"        |
                             +-------------------------------------+
```

Interaction rules:

- Typing filters bookmark matches locally.
- Exact bookmark matches rank above prefix and substring matches.
- Up/Down moves through visible bookmark/search rows when the popover is open.
- Enter on a selected bookmark navigates to that bookmark URL.
- Enter with no selected bookmark first checks for an exact bookmark title or URL match, then parses as URL, then falls back to web search.
- Escape closes the popover without closing the browser pane.
- Blur closes the popover unless the blur is caused by clicking a result.
- The popover is compact, row-based, and never a modal.
- Bookmark rows use the persisted favicon image on the left when available, then favicon URL fallback, then the default browser icon; they do not show a literal `bookmark` text label in the URL bar popover.
- Search rows use a search icon on the left and no favicon.

Bookmark action rules:

- An unbookmarked page shows an outline star-style action with accessible label `Bookmark page`.
- A bookmarked current URL shows a filled/starred state with accessible label `Edit bookmark` or `Bookmarked`.
- Clicking the action opens the detached bookmark overlay seeded with current URL/title.
- `Cmd+D` on macOS and `Ctrl+D` elsewhere opens the same bookmark overlay when a browser pane is active and the current URL is bookmarkable.
- If there is no navigable current URL, disable the action.

### Bookmark Creation Overlay

Bookmark creation must render through the overlay layer, not inside `BrowserPane` or `workspace.tsx`.

Typed overlay additions:

```ts
type CreateBookmarkOverlayRequest = {
  requestId: string
  type: 'create-bookmark'
  workspaceId: string
  initialTitle: string
  initialUrl: string
  initialFaviconDataUrl?: string | null
  initialFaviconUrl?: string | null
}

type CreateBookmarkOverlayResponse =
  | { requestId: string; type: 'bookmark-saved'; bookmarkId: string }
  | { requestId: string; type: 'closed' }
```

Controller API:

```ts
openCreateBookmarkOverlay(input: {
  workspaceId: string
  initialTitle?: string
  initialUrl: string
  initialFaviconDataUrl?: string | null
  initialFaviconUrl?: string | null
}): Promise<string | null>
```

Overlay wireframe:

```text
+------------------------------------------+
| Save bookmark                            |
+------------------------------------------+
| Title                                    |
| [ GitHub Pull Request                  ] |
|                                          |
| URL                                      |
| [ https://github.com/sam/repo/pull/1   ] |
|                                          |
| github.com                               |
|                                          |
|                         Cancel  Save     |
+------------------------------------------+
```

Overlay behavior:

- Autofocus the title field.
- Save is disabled until title and URL are both valid after trim.
- URL edits use the shared URL normalization utility; invalid non-search-like values show inline validation.
- Saving upserts `workspace_resources` with `type: 'bookmark'`, including the best available favicon display value.
- Saving an existing `resourceKey` updates title/favicon metadata rather than creating a duplicate.
- Close on Escape or Cancel without saving.
- On mutation error, show one quiet inline error above actions; do not close.

### Universal Menu Web Scope

The `@` Web scope reads open browser tabs from `contextItems` and bookmarks from `useWorkspaceBookmarksStore(workspaceId)`.

Result order:

- If query parses as a URL, show `Open <url>` first.
- If query is non-empty and not URL-like, show `Search web for "query"` first.
- Then open browser tabs matching query.
- Then bookmark rows matching query.
- With an empty query, show open browser tabs first and recent/updated bookmarks second, capped to keep the list compact.

Wireframe:

```text
+------------------------------------------------------------+
| < Web                                                      |
| [ github                                                ] |
+------------------------------------------------------------+
| search    Search web for "github"                         |
| tab       GitHub PR              open in workspace         |
|           https://github.com/sam/repo/pull/1              |
| [icon]    GitHub Issues          saved bookmark            |
|           https://github.com/issues                       |
+------------------------------------------------------------+
| Enter open   Esc back                                      |
+------------------------------------------------------------+
```

Selection behavior:

- Direct URL result opens `{ type: 'browser', url }`.
- Search result opens `{ type: 'browser', url: searchUrl }`.
- Open tab result preserves existing `{ type: 'browser', url, browserTabId }` behavior so workspace can focus or attach the native tab.
- Bookmark result opens `{ type: 'browser', url: bookmark.url }`.

The scope should not render disabled placeholder bookmark rows once real bookmark data exists.

### Edge Cases

- Duplicate save: saving the same normalized URL in the same workspace updates the existing bookmark.
- Favicon persistence: saving a bookmark stores the current best favicon display source so bookmark rows still show icons after restart.
- Current page title missing: default title to origin, hostname, or URL.
- Current page URL is `about:blank` or unsupported internal URL: disable bookmark creation unless the URL can be normalized into a navigable URL.
- Bookmark deleted from another window: realtime CDC removes it from URL bar and `@` results without manual refresh.
- Bookmark updated from another window: title/URL changes update existing rows by collection key.
- Browser unavailable fallback: external-open fallback should still display normalized URL/search output, but bookmark creation can be hidden or disabled if no workspace context is available.
- Slow snapshot: URL bar remains usable for URL/search navigation before bookmarks hydrate; bookmark rows appear when collection data arrives.
- Malformed persisted bookmark data: skip in UI and avoid throwing during menu/pane render.

### Testing Scope

Unit coverage should include:

- URL/search normalization for domains, localhost, schemes, whitespace searches, and empty input.
- Bookmark resource mapping from `workspace_resources` rows to `BookmarkRecord`.
- Bookmark filtering and result ordering for URL bar and `@` Web scope.
- Exact-match ranking ahead of prefix/substring bookmark matches.
- Overlay request/response plumbing for `create-bookmark`.
- Browser pane submit behavior: selected bookmark, exact bookmark match, direct URL, and search fallback.
- Browser pane keyboard behavior for `Cmd+D`/`Ctrl+D`.

Integration or component coverage should include:

- Creating a bookmark through the overlay writes a `bookmark` resource and the TanStack collection surfaces it.
- Universal menu `@` mode opens a bookmark as browser pane content.
- URL bar typing shows bookmark rows and Enter navigates the active native browser tab to the bookmark URL.

Playwright E2E coverage should include:

- Web E2E (`tests/e2e`, `npm run test:e2e`): seed or create a workspace bookmark, open the universal menu, enter `@` Web scope, type a matching query, and verify selecting the bookmark opens browser pane content for the bookmark URL.
- Web E2E (`tests/e2e`, `npm run test:e2e`): verify exact-match ordering by seeding bookmarks named `foo` and `foozam`, typing `@foo`, and asserting `foo` is the first bookmark result.
- Desktop E2E (`tests/desktop`, `npm run test:e2e:desktop`): in a real browser pane, press `Cmd+D`/`Ctrl+D`, verify the detached bookmark overlay is visible above the native browser slot, save, then verify the URL bar can find and navigate to that bookmark.
- Desktop E2E (`tests/desktop`, `npm run test:e2e:desktop`): save a bookmark with favicon metadata, restart/remount through the desktop harness if practical, and verify the URL bar bookmark row renders an image/icon rather than the text label `bookmark`.
- Desktop E2E should own behavior that depends on Electron native browser slots or overlay z-order; web E2E should cover app routing, universal menu behavior, ranking, and persistence paths that do not need native tabs.

Manual verification should cover:

- Desktop overlay appears above native browser tabs.
- Bookmark creation from a real browser page uses the current title and URL.
- Bookmark creation from a real browser page persists a favicon that appears in URL bar results after reload.
- Realtime update appears in another open workspace view without reload.
