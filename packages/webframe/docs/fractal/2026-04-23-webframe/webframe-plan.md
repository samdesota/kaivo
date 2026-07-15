# webframe — Execution Plan

Thin plan. Implementer decides how to build each step; this doc defines the **order of attack** and **how we know it works**.

## Test harness (prerequisite for everything)

A minimal consumer app under `test-app/` that the framework points Electron at. Playwright drives it via `_electron`.

```
test-app/
  main.ts          # imports webframe, createApp, opens one window
  chrome.html      # tab-bar stub, calls window.webframe.trpc
  preload-chrome.ts
```

- Stores default to in-memory impls; test can opt into SQLite by env var.
- Test app stashes `{ wf, stores }` on `globalThis` so Playwright's `electronApp.evaluate` can introspect.
- Helper fixture returns `{ electronApp, window, stores, mainCall }` where `mainCall` proxies `wf.caller` via `evaluate`.

**Acceptance:** `npm run test:e2e` launches real Electron, opens `test-app`, exits cleanly.

---

## Execution order

Each step must land with its tests green before the next begins.

### 1. Scaffolding

- TS monorepo-free package, `tsup` or `tsc` build.
- Exports map: `webframe` (main), `webframe/renderer` (types), `webframe/sqlite` (opt-in).
- Electron + Playwright devDeps wired, CI target for e2e.

**Acceptance:** bare `createApp({ historyStore: inMem, tabStore: inMem })` runs, returns an object with `router`, `caller`, `windows`, `stop`. Unit-level.

### 2. Stores & types

- `HistoryStore` / `TabStore` interfaces + in-memory impls.
- Public types (`Rect`, `Anchor`, `Slot`, `TabRecord`, `HistoryEntry`, `WindowInfo`, `OverlayInfo`).

**Tests (unit):**
- In-memory stores round-trip every interface method.
- `deleteFor(tabId)` removes only that tab's history.

### 3. Router (stubs) + main caller

- Full `appRouter` with every procedure, Zod inputs, but resolvers stubbed (throw `not-implemented`).
- `app.caller = appRouter.createCaller({ caller: { kind:'main' } })`.
- Export `AppRouter` type.

**Tests (unit):**
- Type-check: client proxy type includes every documented procedure.
- Zod rejects malformed inputs.

### 4. Window + chrome preload + renderer bridge

- `windows.create` opens `BrowserWindow`, loads `chromeUrl`, attaches chrome preload.
- Preload exposes `window.webframe.trpc` (typed client) and `window.webframe.caller`.
- Hand-rolled tRPC link over `ipcRenderer.invoke('webframe/rpc', op)`.
- Framework maintains `WebContents.id → Caller` map; chrome preload registers on `DOMContentLoaded`.

**E2E tests:**
- Launch test-app → window appears, chrome URL loads (`electronApp.firstWindow()`).
- From chrome: `await window.webframe.trpc.windows.list.query()` returns `[{ id, bounds, slots:[], tabIds:[], overlayIds:[] }]`.
- From main: `wf.caller.windows.list()` returns the same rows.
- Caller identity: add a debug `_whoami` procedure (temp) — chrome call → `kind:'chrome'`, main call → `kind:'main'`. Remove before ship or leave as `_debug`.

### 5. Tab create / close / navigate (single window)

- Logical `Tab` + `TabView` (WebContentsView).
- `tabs.create` with `windowId` + `placement` → rect-resolves, mounts view, loads URL, persists `TabRecord`.
- `navigation.goto/back/forward/reload/stop` wire to WebContents.
- Per-tab event wiring: title, favicon, `did-navigate` → append history + update TabRecord.
- `tabs.close` destroys view, deletes TabRecord.

**E2E tests:**
- Create tab via main caller → view mounts, `did-finish-load` fires, TabRecord has `url`, `title`.
- `tabStore` shows exactly one record with that id.
- `navigation.goto` to a second URL → `historyStore.query({ tabId })` returns 2 entries in order.
- `navigation.back` rewinds; TabRecord.url matches first URL.
- `tabs.close` → view gone from `BrowserWindow.contentView.children`, tabStore empty.
- Detached create (no windowId) → TabRecord persists, `contentView.children` unchanged.

### 6. Placement + move + slot layout

- `Anchor` resolver: `{slot}` / `{edge,size}` / raw `Rect` → `Rect`.
- `windows.setSlots` from chrome updates layout; on resize, all anchored views rebind.
- `tabs.move` reparents the **same** `WebContentsView` to another window's `contentView`.
- `tabs.setActive` toggles visibility within a window.

**E2E tests:**
- Chrome publishes slot `content`; tab placed with `{slot:'content'}`; resize window → view bounds track slot.
- Raw rect placement → bounds match input after DPR round-trip.
- Edge anchor `{edge:'top', size:40}` → view occupies top strip.
- **Move preserves state:** in tab, set `window.__probe = 42` via `executeJavaScript`; move tab to second window; read `window.__probe` → still 42.
- **Move mid-load:** navigate tab to slow URL (throttled route), call `move` before `loaded`; `onLifecycle` still emits `loaded` post-move.
- Unknown slot name → `trpc.tabs.create` rejects with typed error `SLOT_NOT_FOUND`.

### 7. Overlays + z-order

- `overlays.create` mounts `WebContentsView` above all tabs.
- Framework re-asserts child order whenever tabs are added/moved or overlays change.
- `overlays.setZ` reorders within overlay stack only.

**E2E tests:**
- Create tab, then overlay → `contentView.children` order: `[tab, overlay]`.
- Create another tab → order becomes `[tab, newTab, overlay]` (overlay still last).
- Two overlays, `setZ` swaps them → both still after all tabs.
- `overlays.close` removes just that overlay.
- Close window → overlays destroyed before tab detach.

### 8. Subscriptions

- `tabs.onChange`, `tabs.onMoved`, `navigation.onLifecycle`, `windows.onResize`.
- Transport: `webContents.send('webframe/sub', { subId, data })`; framework tracks active subs by WebContents id; cleans up on `destroyed`.

**E2E tests:**
- Chrome subscribes to `tabs.onChange`; main creates tab and navigates → chrome receives ≥ `{patch:{url}}`, `{patch:{title}}` events.
- `navigation.onLifecycle` emits `loading` then `loaded` for a normal nav.
- Simulate crash (tab calls `process.crash()`) → `phase:'crashed'` emitted; TabRecord retains last url/title.
- Close chrome window → internal sub registry for that WebContents id is empty (expose `wf._debug.subCount(wcId)` for the assertion).

### 9. SQLite providers

- `webframe/sqlite` entry: `createSqliteHistoryStore`, `createSqliteTabStore`, schema + migrations inline.
- Both wrap `better-sqlite3` sync calls in resolved promises.

**Tests:**
- Unit: same interface-conformance suite as in-memory stores, run against a tmpdir DB.
- E2E: re-run a subset of the tab/history e2e suite with `USE_SQLITE=1`, asserting identical behavior.
- Restart: create tab, exit Electron, relaunch pointing at same DB → `tabStore.list()` contains the tab; its view is **not** auto-recreated (consumer decides).

### 10. Lifecycle & cleanup

- `wf.stop()` closes windows, awaits store flush, destroys views.
- Window close detaches tabs (logical survive), cascade-closes overlays, fires `tabs.onMoved { to: null }`.

**E2E tests:**
- Close window while 2 tabs attached → `tabStore.list()` still has both; 2 `onMoved` events with `to:null` observed.
- `wf.stop()` → `electronApp.close()` resolves; no dangling renderers.

---

## Cross-cutting invariants (assert in multiple tests)

- Child-view order at **every** assertion point: `[hiddenTabs..., activeTab, ...overlays]`.
- `historyStore.append` never throws into navigation path — inject a failing store, ensure nav still completes; error surfaces via logger only.
- `Caller` identity set correctly on every procedure call (spot-check at least one query per router group).

## Definition of done

- All e2e suites green against in-memory stores.
- Tab/history subset green against SQLite stores.
- Type-check passes for a consumer `main.ts` + chrome renderer importing `webframe` + `webframe/renderer`.
- `npm pack` output contains only `dist/`, `sqlite/dist/`, and the documented entry points.
