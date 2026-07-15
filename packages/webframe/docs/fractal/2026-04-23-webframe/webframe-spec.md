# webframe

## Seed

An Electron-based **browser framework** you install as a library. Consumers write a `main.ts` that imports the framework and calls it to set up a window.

- The window and the main process both have access to a **tRPC API** exposing:
  - **Tab creation** — tabs are first-class logical objects (history, current URL, title, favicon), not just `BrowserView`s.
  - **Tab placement** — move a tab anywhere: to any window, or to any region within a window.
  - **Overlays** — create web content that stays *above* browser views (e.g. the main process can mount a UI overlay, the framework guarantees z-order).
- **Pluggable persistence**:
  - History store is configurable — ship a SQLite provider, allow custom implementations.
  - Other persistent tab state (favicons, session data, etc.) is also pluggable.

## Outline

- **Package shape**
  - Single npm package `webframe`, peer-deps Electron.
  - Exports: `createApp(config)` returning `{ window(opts), tabs, overlays, history, router }`.
  - Config passes in `historyStore`, `tabStore`, optional `session` partitions.
  - Consumer's `main.ts` imports it, creates app, opens windows.

- **Window model**
  - A `Window` wraps an Electron `BrowserWindow`.
  - The window's **root WebContents loads the consumer's "chrome" URL/HTML** (tab bar, URL bar, etc.) — consumer-owned UI.
  - Chrome talks to the framework via tRPC exposed on `window.webframe` in the preload.
  - Tabs and overlays are `WebContentsView` children stacked above the chrome's paint region (the chrome defines a content rect; framework positions children into it).

- **Tab model (key split)**
  - `Tab` = logical record: `{ id, url, title, favicon, history[], stateStoreKey }`. Persisted.
  - `TabView` = the live `WebContentsView` rendering the tab. Ephemeral, re-created on reopen.
  - A Tab exists independently of a window. Placing a tab *attaches* its view to a window; moving it *re-parents* the same `WebContentsView` (no reload, no state loss).
  - Inactive tabs: view detached from any window; logical Tab still exists.

- **Placement API**
  - Placement addressed as `{ windowId, rect: { x, y, w, h } }` in chrome-CSS pixels; framework handles DPR.
  - Chrome publishes *content regions* (named slots) via tRPC when its layout changes; tabs can be placed into a slot or a raw rect.
  - Decision to flag: **slots vs. raw rects vs. both** — default: both, with slots as sugar over rects.
  - Z-order within a window: chrome (bottom) → active tab view → inactive views (hidden) → overlays (top), enforced by framework maintaining the child-view list.

- **Overlay API**
  - `overlays.create({ windowId, rect | anchor, url, transparent, clickThrough })`.
  - Framework guarantees overlays stay above all tab views, even as tabs are added/moved.
  - Overlays are `WebContentsView`s themselves; get their own tRPC client on `window.webframe`.

- **tRPC API surface**
  - Router groups: `tabs`, `overlays`, `windows`, `history`, `navigation`.
  - Procedures: create/close/move tab, navigate, goBack/goForward, setActiveTab, createOverlay/closeOverlay, moveOverlay, queryHistory.
  - Subscriptions: tab title/url/favicon/loading changes, history appended, tab moved, overlay lifecycle.
  - Same router shape callable from **main process** (direct function call, no IPC) and **any renderer** (chrome or overlay, over IPC). Identity of caller attached to ctx for authorization.

- **tRPC transport**
  - Main ↔ renderer: `electron-trpc`-style bridge over `ipcRenderer.invoke` + `ipcMain.handle`; subscriptions over `webContents.send`.
  - Main ↔ main: bypass IPC, call the router's caller directly.
  - Decision to flag: **adopt `electron-trpc` as-is, or hand-roll the bridge** — hand-rolled is lighter and lets us unify main/renderer with one caller abstraction.

- **Persistence contracts**
  - `HistoryStore` interface: `append(entry)`, `query({ tabId?, limit?, since? })`, `deleteFor(tabId)`.
  - `TabStore` interface: `put(tab)`, `get(id)`, `list()`, `delete(id)`. Stores the logical `Tab` record.
  - Default provider: SQLite via `better-sqlite3`, one DB file in `app.getPath('userData')`.
  - Stores are injected at `createApp` time; no implicit global.

- **Session / WebContents config**
  - All tab `WebContentsView`s share a configurable Electron `session` partition (default: persistent).
  - Consumer can supply custom preload for tab contents separately from chrome preload.

- **Lifecycle**
  - App shutdown: flush stores, close windows, detach views cleanly.
  - Window close: detach tabs (logical tabs survive); consumer chooses whether to re-place them elsewhere or leave unplaced.
  - Crash: tab WebContents crash → framework emits event; logical Tab keeps `url` so chrome can offer "reload".

- **Out of scope (v1)**
  - Extension system, devtools UI, built-in chrome UI, download manager, PDF viewer.
  - Multi-process tab pooling / background throttling heuristics.
  - Cross-process drag-and-drop of tabs between separate `webframe` apps.

## Spec

### Package layout

```
webframe/
  src/
    index.ts              # createApp, public types
    router.ts             # tRPC AppRouter definition
    bridge.ts             # main↔renderer tRPC transport
    window.ts             # Window + chrome loading
    tab.ts                # Tab (logical) + TabView (WebContentsView)
    overlay.ts            # Overlay (WebContentsView)
    layout.ts             # slot resolution, rect math, DPR
    preload/chrome.ts     # preload exposed to consumer chrome renderer
    preload/overlay.ts    # preload exposed to overlay renderers
    preload/tab.ts        # optional preload for tab contents
    stores/types.ts       # HistoryStore, TabStore interfaces
    stores/memory.ts      # in-memory reference impls (for tests)
  sqlite/
    index.ts              # createSqliteHistoryStore, createSqliteTabStore
```

Public entry points: `webframe` (main), `webframe/renderer` (type-only exports for chrome/overlay code), `webframe/sqlite` (opt-in SQLite providers).

### Entry API

```ts
// main.ts (consumer)
import { app as electronApp } from 'electron';
import { createApp } from 'webframe';
import { createSqliteHistoryStore, createSqliteTabStore } from 'webframe/sqlite';

electronApp.whenReady().then(async () => {
  const wf = await createApp({
    historyStore: createSqliteHistoryStore({ dbPath: '...' }),
    tabStore:     createSqliteTabStore({ dbPath: '...' }),
    session:      'persist:webframe',       // string partition OR Electron Session
    tabPreload?:  '/abs/path/tab-preload.js',
  });

  const win = await wf.windows.create({
    chromeUrl:     'file:///.../chrome/index.html',
    chromePreload: '/abs/path/chrome-preload.js',
    electronWindow: { width: 1280, height: 800 },   // passthrough to BrowserWindow
  });

  // Direct main-process tRPC call (no IPC):
  await wf.caller.tabs.create({ windowId: win.id, url: 'https://example.com', slot: 'content', active: true });
});
```

`createApp` returns:

```ts
type WebframeApp = {
  router:  AppRouter;                 // tRPC router (type-only export for clients)
  caller:  ReturnType<AppRouter['createCaller']>;   // server-side caller, kind:'main' ctx
  windows: {
    create(opts: WindowOptions): Promise<WindowHandle>;
    get(id: string): WindowHandle | undefined;
    list(): WindowHandle[];
  };
  stop():  Promise<void>;
};

type AppRouter = /* exported for renderer typing via `import type` */;
```

### Window

```ts
type WindowOptions = {
  chromeUrl: string;                                // loaded into BrowserWindow's root WebContents
  chromePreload?: string;                           // chained after webframe's chrome preload
  electronWindow?: Electron.BrowserWindowConstructorOptions;
  initialSlots?: Slot[];                            // chrome can also publish later via tRPC
};

type WindowHandle = {
  id: string;
  electronWindow: Electron.BrowserWindow;           // escape hatch
  close(): Promise<void>;
};
```

The window's root `webContents` is the *chrome*. Tabs + overlays are `WebContentsView` children whose bounds are recomputed from slot/rect + window size. Framework maintains the child-view list in this order: tabs (active on top of hidden) → overlays. Inactive tabs have `visible = false`.

### tRPC router shape

```ts
import { initTRPC } from '@trpc/server';
import { z } from 'zod';

type Caller =
  | { kind: 'main' }
  | { kind: 'chrome'; windowId: string }
  | { kind: 'overlay'; overlayId: string; windowId: string }
  | { kind: 'tab'; tabId: string };

type Ctx = { caller: Caller };
const t = initTRPC.context<Ctx>().create();

const rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const anchor = z.union([
  z.object({ slot: z.string() }),
  z.object({ edge: z.enum(['top','bottom','left','right']), size: z.number() }),
  rect,
]);

export const appRouter = t.router({
  windows: t.router({
    list:      t.procedure.query(...),                                              // WindowInfo[]
    get:       t.procedure.input(z.object({ windowId: z.string() })).query(...),    // WindowInfo
    setSlots:  t.procedure.input(z.object({ windowId: z.string(), slots: z.array(slot) })).mutation(...),
    onResize:  t.procedure.input(z.object({ windowId: z.string().optional() })).subscription(...), // { windowId, w, h }
  }),

  tabs: t.router({
    create:    t.procedure.input(z.object({
                 url: z.string(),
                 windowId: z.string().optional(),            // omit → detached logical tab
                 placement: anchor.optional(),               // required if windowId present
                 active: z.boolean().default(false),
                 stateStoreKey: z.string().optional(),
               })).mutation(...),                            // → TabRecord
    close:     t.procedure.input(z.object({ tabId: z.string() })).mutation(...),
    move:      t.procedure.input(z.object({
                 tabId: z.string(),
                 windowId: z.string(),
                 placement: anchor,
               })).mutation(...),                            // re-parents same WebContentsView
    detach:    t.procedure.input(z.object({ tabId: z.string() })).mutation(...),   // view removed, Tab survives
    setActive: t.procedure.input(z.object({ tabId: z.string(), windowId: z.string() })).mutation(...),
    list:      t.procedure.input(z.object({ windowId: z.string().optional() })).query(...),  // TabRecord[]
    get:       t.procedure.input(z.object({ tabId: z.string() })).query(...),       // TabRecord
    onChange:  t.procedure.input(z.object({ tabId: z.string().optional() })).subscription(...),
               // emits: { tabId, patch: Partial<TabRecord> }
    onMoved:   t.procedure.subscription(...),                                       // { tabId, from, to }
  }),

  navigation: t.router({
    goto:         t.procedure.input(z.object({ tabId: z.string(), url: z.string() })).mutation(...),
    back:         t.procedure.input(z.object({ tabId: z.string() })).mutation(...),
    forward:      t.procedure.input(z.object({ tabId: z.string() })).mutation(...),
    reload:       t.procedure.input(z.object({ tabId: z.string(), ignoreCache: z.boolean().default(false) })).mutation(...),
    stop:         t.procedure.input(z.object({ tabId: z.string() })).mutation(...),
    onLifecycle:  t.procedure.input(z.object({ tabId: z.string().optional() })).subscription(...),
                  // { tabId, phase: 'loading'|'loaded'|'failed'|'crashed', url?, error? }
  }),

  overlays: t.router({
    create:   t.procedure.input(z.object({
                windowId: z.string(),
                placement: anchor,
                url: z.string(),
                transparent: z.boolean().default(false),
                clickThrough: z.boolean().default(false),
                preload: z.string().optional(),
              })).mutation(...),                             // → OverlayInfo
    close:    t.procedure.input(z.object({ overlayId: z.string() })).mutation(...),
    move:     t.procedure.input(z.object({ overlayId: z.string(), placement: anchor })).mutation(...),
    setZ:     t.procedure.input(z.object({ overlayId: z.string(), index: z.number() })).mutation(...),
                  // reorders within the overlay stack only; overlays always stay above tabs
    list:     t.procedure.input(z.object({ windowId: z.string().optional() })).query(...),
  }),

  history: t.router({
    query:    t.procedure.input(z.object({
                tabId: z.string().optional(),
                limit: z.number().optional(),
                since: z.number().optional(),
                search: z.string().optional(),
              })).query(...),                                 // HistoryEntry[]
    delete:   t.procedure.input(z.object({ entryIds: z.array(z.string()) })).mutation(...),
    clear:    t.procedure.input(z.object({ tabId: z.string().optional() })).mutation(...),
  }),
});

export type AppRouter = typeof appRouter;
```

### Data types (public)

```ts
type Rect  = { x: number; y: number; w: number; h: number };                        // CSS px, window-content coords
type Slot  = { name: string; rect: Rect };
type Anchor = { slot: string } | { edge: 'top'|'bottom'|'left'|'right'; size: number } | Rect;

type TabRecord = {
  id: string;                // stable, stored
  url: string;
  title: string;
  favicon?: string;
  createdAt: number;
  lastVisitedAt: number;
  stateStoreKey?: string;    // opaque consumer-owned key into tabStore extras
};

type HistoryEntry = {
  id: string;
  tabId: string;
  url: string;
  title: string;
  visitedAt: number;
};

type WindowInfo  = { id: string; bounds: Rect; slots: Slot[]; tabIds: string[]; overlayIds: string[] };
type OverlayInfo = { id: string; windowId: string; url: string; placement: Anchor; zIndex: number };
```

### Transport

- **Main caller**: `app.caller` is `appRouter.createCaller({ caller: { kind: 'main' } })`. Zero IPC.
- **Renderer → main**: custom tRPC link built on `ipcRenderer.invoke('webframe/rpc', op)` for queries/mutations and `ipcRenderer.on('webframe/sub', …)` for subscription events. The framework-side handler attaches a `Caller` to the ctx based on `sender.id` (which it tracks per chrome/overlay/tab WebContents).
- **Subscription fan-out**: renderers subscribe via `webContents.send` addressed by subscription id. Framework tracks active subs per WebContents and cleans up on `destroyed`.
- **Renderer bridge** (in all three preloads):

```ts
// window.webframe
declare global {
  interface Window {
    webframe: {
      trpc: import('@trpc/client').CreateTRPCProxyClient<AppRouter>;
      caller: Exclude<Caller, { kind: 'main' }>;   // self-identity
    };
  }
}
```

### Persistence contracts

```ts
interface HistoryStore {
  append(entry: HistoryEntry): Promise<void>;
  query(q: { tabId?: string; limit?: number; since?: number; search?: string }): Promise<HistoryEntry[]>;
  delete(ids: string[]): Promise<void>;
  deleteFor(tabId: string): Promise<void>;
}

interface TabStore {
  put(tab: TabRecord): Promise<void>;
  get(id: string): Promise<TabRecord | undefined>;
  list(): Promise<TabRecord[]>;
  delete(id: string): Promise<void>;
}
```

Shipped providers (`webframe/sqlite`):

```ts
createSqliteHistoryStore({ dbPath: string }): HistoryStore
createSqliteTabStore({ dbPath: string }): TabStore
```

Both use `better-sqlite3` (sync, wrapped in `Promise.resolve`). In-memory impls ship in core for tests.

### Layout & z-order invariants

- Child-view order in a window: `[tabViewsHidden..., activeTabView, overlayViews...]`. The framework is the sole writer; no consumer code touches `contentView.addChildView` directly.
- Rect resolution: `Anchor` → `Rect` happens every time the window resizes or the chrome republishes slots. `edge` anchors consume a strip; remaining space implicitly belongs to any `slot: 'content'` if defined, else unused.
- DPR: all rects are CSS pixels; framework converts to device pixels for `setBounds`.

### Events & identity

- Per-tab `WebContents` events (`page-title-updated`, `did-navigate`, `page-favicon-updated`, `did-start-loading`, `did-fail-load`, `render-process-gone`) fan out to `tabs.onChange` / `navigation.onLifecycle`.
- On every `did-navigate`, framework appends a `HistoryEntry` via `historyStore.append` *and* updates `TabRecord` via `tabStore.put`.
- `Caller` identity: framework maintains `WebContents.id → Caller` map; chrome preload registers on load (`kind:'chrome', windowId`), overlay preload similarly, tab preload optionally.

### Edge cases

- **Tab created detached** (no `windowId`): logical Tab persists, no WebContents yet. Placing it later spins up the `WebContentsView` and loads `url`.
- **Tab moved mid-load**: `WebContentsView` re-parented; load continues uninterrupted.
- **Window closes while tabs attached**: tabs detach (logical Tabs survive). `onMoved` fires with `to: null`.
- **Overlay on closing window**: cascade-closed before tabs detach.
- **Slot referenced but undefined**: tab/overlay creation rejects with a typed error.
- **Render process crash**: `navigation.onLifecycle` emits `phase:'crashed'`; Tab keeps last `url`/`title` for reload UX.
- **Store error on append**: logged, navigation not blocked; consumer stores decide durability.
- **Duplicate `tabId` across restarts**: IDs are authoritative in `tabStore`; restarted app rehydrates logical Tabs but does not auto-recreate their views (consumer decides what to place).

### Dependencies

- `electron` (peer)
- `@trpc/server` ^11, `@trpc/client` ^11
- `zod` ^3
- `better-sqlite3` (only pulled in via `webframe/sqlite`)
