# Electron Browser Tabs Agent Pane Spec

## Seed

Bring the `webframe` project into this codebase and use it as the foundation for an Electron shell around the existing app. The goal is to let the agent side pane run real browser tabs, not a simplified embedded preview, while preserving the app's current workflow.

## Solution

- Dependency model: keep `webframe` in its own repo, publish it through GitHub Packages, and use a linked `../webframe` checkout with `webframe` watch builds for local development.
- Shell boundary: Electron owns native windows, real browser tab `WebContentsView`s, and tab lifecycle.
- App boundary: the existing Vite/React app remains the chrome UI and continues rendering the agent workflow.
- Pane integration: extend the existing right-pane tab model from `shell | file | preview` to include `browser`.
- Browser rendering: browser tabs render through `webframe`/Electron views, not iframes or `<webview>`.
- Control channel: expose browser tab create/focus/navigate/close through the existing agent UI pane-opening path plus a thin browser API adapter over `window.webframe.trpc`.
- Runtime boot: Electron starts the existing app URL in development and the built app/server in production.
- Migration path: keep current preview tabs initially; add real browser tabs as a new pane type, then replace preview behavior where appropriate.

## Spec

The Electron shell is a local desktop runtime for `zoottle`. It does not replace the deployed web app or the env server model. It wraps the existing Vite/React UI as Electron chrome and delegates real browser-tab rendering to `webframe`.

### Repositories and Dependency Flow

`webframe` stays in its own repository and is consumed as a package by `zoottle`.

The `webframe` repo publishes to GitHub Packages under a scoped package name. The current package is `@samdesota/webframe`. Its package must keep public exports for the Electron main process and renderer browser API:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./renderer": "./dist/renderer.js",
    "./sqlite": "./sqlite/dist/index.js"
  },
  "peerDependencies": {
    "electron": ">=30"
  }
}
```

`zoottle` depends on the published package for normal installs and releases. Local development uses the sibling checkout at `../webframe` through `npm link` or an npm file override, with `webframe` running `npm run build:watch` so Electron restarts pick up package changes.

Authentication for GitHub Packages lives in developer or deploy environment configuration, not in source. The repo should document the required `.npmrc` scope mapping and `NODE_AUTH_TOKEN`/GitHub token requirements.

### Electron Package

Add a desktop app package inside `zoottle`, separate from the web client, env server, and opencode plugin. Name it `zoottle-desktop`:

```text
packages/zoottle-desktop/
  src/main.ts
  src/preload.ts
  package.json
  tsconfig.json
  tsup.config.ts
```

The Electron main process owns startup, shutdown, and native browser surfaces. It imports `createApp` from `@samdesota/webframe`, creates a `webframe` app, and opens one chrome window whose `chromeUrl` is the existing `zoottle` UI.

In development, the chrome URL points at the Vite dev server. The normal dev loop runs the app server, Vite client, `webframe` watch build, and Electron main process together. In production, Electron starts or connects to the built `zoottle` server and loads the served client URL.

The desktop app should preserve the default `webframe` chrome preload so the React chrome can call `window.webframe.trpc`. Do not duplicate `webframe`'s tab/window/navigation API in custom main-process IPC unless a concrete missing operation is discovered.

### Browser Pane Model

Extend the right-pane content union with a browser pane type:

```ts
type BrowserPaneContent = {
  type: 'browser'
  url?: string
  browserTabId?: string
}
```

`browserTabId` is the identity of the underlying `webframe` tab after creation. `url` is the initial navigation target when a browser pane is opened without an existing tab.

The existing pane state remains the source of truth for the React chrome layout and selected pane. `webframe` remains the source of truth for the native browser tab lifecycle, navigation state, title, favicon, and history.

The browser pane is rendered by a React component that does not iframe content. It reserves a DOM slot in the right pane, observes that slot's bounds, and sends slot updates through the browser API adapter. The adapter delegates to `window.webframe.trpc.windows.setSlots`; `webframe` maps the named slot to native `WebContentsView` placement.

When a browser pane becomes active, the app focuses or creates the matching `webframe` tab and marks it active. When the pane is hidden, closed, or replaced, the shell detaches or closes the native tab according to the pane action.

### Layout Contract

The React chrome reports browser pane geometry to Electron as a named slot:

```ts
type BrowserSlotUpdate = {
  paneId: string
  rect: { x: number; y: number; width: number; height: number }
}
```

Electron converts each update into a `webframe` slot and calls `windows.setSlots`. Browser tabs are attached using an anchor that references the pane's slot name.

The slot is updated when the right pane resizes, the tab strip changes active tab, the window resizes, or the browser pane mounts/unmounts. A zero-size or unmounted slot hides or detaches the tab instead of leaving stale native content visible.

### Browser API Adapter

The React app communicates with native browser tabs through a narrow browser API adapter. In Electron, this adapter is implemented in renderer code on top of `window.webframe.trpc`; outside Electron, the adapter reports unavailable. The adapter should cover browser pane behavior only:

```ts
type BrowserApi = {
  isAvailable(): boolean
  createTab(input: { paneId: string; url?: string }): Promise<{ browserTabId: string }>
  attachTab(input: { paneId: string; browserTabId: string }): Promise<void>
  focusTab(input: { browserTabId: string }): Promise<void>
  navigate(input: { browserTabId: string; url: string }): Promise<void>
  closeTab(input: { browserTabId: string }): Promise<void>
  setSlot(input: BrowserSlotUpdate): Promise<void>
  onTabChange(handler: (event: BrowserTabChange) => void): () => void
}
```

The implementation delegates to `window.webframe.trpc` for `windows.setSlots`, `tabs.create`, `tabs.move`, `tabs.setActive`, `tabs.close`, `navigation.goto`, and `tabs.onChange`. The app should not call Electron globals or custom main-process IPC for these operations.

The adapter maps app pane ids to deterministic webframe slot names, converts DOM rects from `{ width, height }` to webframe `{ w, h }`, and resolves the current webframe chrome window id through `window.webframe.identity()` or `window.webframe.trpc.windows.list` as needed.

In a non-Electron browser, `isAvailable()` is false. Browser pane UI should show an explanatory empty state or fall back to the existing preview behavior where that is intentionally supported.

### Agent Pane Opening

The agent-side pane-opening path must accept browser content.

The schema in the env server and orchestrator agent UI routers expands from `file | shell | preview` to include `browser`. The opencode plugin tool schema expands `cloud_open_pane.kind` the same way, with `url` accepted for browser panes.

An agent request like this opens or focuses a browser pane:

```json
{
  "kind": "browser",
  "url": "https://example.com",
  "title": "Example",
  "activate": true
}
```

The frontend subscription path remains the same: `agentUi.events` emits `open_pane`, `session-view` receives it, and the right-pane reducer opens a `PaneContent` object. Browser-specific work starts after the pane is rendered in the Electron chrome.

### Current Preview Tabs

Existing preview tabs remain supported during the transition. They still render local env ports through the current iframe-based `PreviewTabContent` path.

Browser tabs are the target for full-page browsing, external sites, authenticated sessions, and agent-driven browser use. Preview tabs can later be reimplemented as browser panes when parity is proven.

### State and Persistence

The right-pane reducer continues to persist pane layout and tab selection as it does today. Persisted browser panes may store `url` and `browserTabId`, but startup must tolerate stale `browserTabId` values because Electron/webframe tab state may not survive the same way as React pane state.

On restore, if `browserTabId` does not resolve, the browser pane creates a new `webframe` tab from its saved `url`. If neither value is present, it renders an empty browser pane with an address/navigation affordance or waits for agent navigation.

### Edge Cases

If the app is opened outside Electron, browser panes must not crash the React app.

If GitHub Packages authentication is missing, install should fail with a clear setup instruction rather than silently falling back to an untracked local copy.

If `webframe` is linked locally but not built, `zoottle-desktop` should fail fast with the missing package output rather than masking the error.

If a pane is closed while a navigation is in flight, the close wins and later lifecycle events for that `browserTabId` are ignored.

If a layout update references a missing `webframe` slot or tab, the shell reconciles by recreating the slot or detaching the stale tab.

If multiple browser panes exist, each pane owns one named slot and one active `webframe` tab attachment; focusing a pane must not move another pane's tab unless explicitly requested.

### Tests and Verification Scope

`webframe` owns tests for native tab creation, navigation, lifecycle events, slot attachment, and Electron view behavior.

`zoottle` owns tests for pane state, schema validation, tool input handling, the browser API adapter, and the React-to-webframe integration boundary.

End-to-end verification should cover launching the Electron shell, opening an agent session, calling `cloud_open_pane` with `kind: "browser"`, and observing a real browser tab in the agent side pane.
