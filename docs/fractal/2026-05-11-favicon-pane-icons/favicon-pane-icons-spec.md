# Favicon Pane Icons Spec

## Seed

Improve pane iconography so every pane type has a clear default icon, browser tabs use a default web icon until a site favicon is resolved, and favicons are resolved like a browser through the existing `webframe` path. Favicon data should be cached in the app service so resolved icons survive app restarts, with `../webframe` improved where its current favicon support is insufficient.

## Solution

- Pane icons: define shared default icon metadata for current pane types, consumed by all tab strips.
- Tab rendering: add an icon slot to `BorderedTabStrip`; labels remain text and truncation behavior stays unchanged.
- Favicon resolution: use `webframe`/Electron `page-favicon-updated` as the browser-quality signal; no app-side favicon scraping.
- Webframe API: expose favicon on tab list/create/change payloads and improve candidate selection when multiple favicon URLs are reported.
- App persistence: store Zoottle favicon cache records in the app service SQLite layer, not in webframe’s tab store.
- Browser fallback: show the default web icon until a cached or newly resolved favicon is available; blank/system/error cases keep the default.
- Cache flow: browser tab favicon events update app-service cache, and restored tabs hydrate icons from that cache before live browser events arrive.

## Spec

### Scope

Workspace pane tabs have three current types: `shell`, `file`, and `browser`. This work adds consistent icons for those pane types and favicon-backed browser tab icons. It does not reintroduce preview panes or replace the browser address bar UI.

### Icon Model

Add a small shared pane-icon model for tab chrome:

```ts
type PaneIconKind = 'shell' | 'file' | 'browser'

type TabIcon =
  | { kind: 'pane'; pane: PaneIconKind }
  | { kind: 'favicon'; url: string; fallback: { kind: 'pane'; pane: 'browser' } }
```

The default pane icons are visual-only metadata consumed by React tab chrome. They should not be persisted in workspace tab records. Browser tabs use `{ kind: 'pane', pane: 'browser' }` until a valid cached or live favicon is available.

### Tab Chrome

`BorderedTabStrip` gets an optional icon field on `BorderedTabItem`. The component renders the icon before the existing label inside the tab button, keeps the label as the accessible/title text source, and preserves existing truncation and close-button behavior.

All current tab producers pass icons:

- Workspace tabs in `src/routes/workspace.tsx` map `WorkspaceTab.type` to the shared pane icon model.
- Env right-pane tabs in `src/routes/env/shell/right-pane.tsx` map `PaneContent.type` to the same model.
- Agent/session tab strips may omit icons unless they represent pane tabs.

Icons should use the existing `lucide-react` dependency for default pane icons. Favicons render as `img` with fixed square dimensions, rounded corners only if needed for visual alignment, and `alt=""` because the label names the tab.

### Webframe Favicon Signal

`../webframe` already listens to Electron `page-favicon-updated` and stores `TabRecord.favicon`. Improve it so the tab record uses a selected favicon URL rather than blindly `favicons[0]`.

Selection rules:

- Ignore empty, invalid, `about:`, `data:` over a reasonable size, and non-http(s) candidates unless Electron only reports a small data URL.
- Prefer same-origin http(s) candidates when the page URL has an http(s) origin.
- Prefer larger explicit image filenames when distinguishable by URL (`32`, `48`, `64`, `96`, `128`, `180`, `192`, `256`) over `16` or unknown size.
- Keep the previous favicon if Electron emits an empty candidate list during navigation.

`webframe` tab list/get/create/change payloads must expose `favicon?: string` consistently. Zoottle’s browser bridge and browser API then surface `favicon?: string` on `BrowserTabChange`, `BrowserTabCreated`, and `listTabs()` results.

### App-Service Cache

Favicons are persisted in the app service SQLite database, not only in `webframe` memory or its tab store. Add a dedicated cache table because favicons are browser/site metadata, not workspace resources.

Logical record:

```ts
type FaviconCacheRecord = {
  pageOrigin: string
  iconUrl: string
  dataUrl: string
  mediaType: string
  sizeBytes: number
  updatedAt: Date
  lastSeenAt: Date
}
```

`pageOrigin` is the normalized origin of the browser tab URL. `dataUrl` is the display source used by React. The app service accepts only bounded image data: png, jpeg, gif, webp, svg+xml, or x-icon; records above the configured size limit are ignored.

Add protected tRPC procedures for the UI:

```ts
favicon.getByOrigins({ origins: string[] }) -> Record<string, FaviconCacheRecord>
favicon.upsert(record: FaviconCacheRecord) -> { ok: true }
```

The UI batches reads by origins visible in open tabs. Writes happen when a browser tab emits a valid favicon URL and the UI has resolved it to a bounded data URL.

### Favicon Resolution Flow

On startup or workspace restore:

1. Workspace tab state supplies browser tab URLs.
2. The UI computes normalized origins for open browser tabs.
3. The UI queries app-service favicon cache for those origins.
4. Browser tab icons render cached favicons immediately when present, otherwise the default browser icon.

During browsing:

1. `webframe` receives Electron favicon candidates.
2. `webframe` selects a candidate and emits `patch.favicon`.
3. Zoottle’s browser API forwards the favicon patch.
4. The browser pane/workspace tab layer fetches the image as a bounded data URL using browser fetch semantics where possible.
5. The app service persists the data URL by page origin.
6. Visible browser tab icons update from the new cache entry.

If fetching the favicon data fails, the UI may still show the live favicon URL for the current session if the browser can load it, but it must not write an invalid cache record.

### Edge Cases

Blank tabs, internal URLs, invalid URLs, and browser tabs without an origin use the default browser icon and do not query or write the favicon cache.

Navigation between origins changes the cache key. A tab must not keep showing the previous origin’s favicon after its URL changes unless the new origin resolves to the same cached icon.

Failed favicon fetches, oversized images, unsupported media types, and broken image loads fall back to the default browser icon.

Multiple browser tabs for the same origin share the same cached favicon. The most recent valid favicon for that origin wins.

Cache writes must be debounced or deduplicated so repeated `page-favicon-updated` events for the same origin and icon URL do not spam tRPC writes.

### Verification Requirements

Unit coverage should include pane-icon mapping, favicon candidate selection, origin normalization, cache validation, and `BorderedTabStrip` icon rendering. Integration coverage should exercise a browser tab receiving a favicon patch, persisting it through the app service, and hydrating it after UI reload. Manual verification should cover shell, file, and browser tab icons; default browser icon before favicon resolution; favicon update after navigation; and persistence after app restart.
