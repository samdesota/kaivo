# Agent Browser Tools Spec

## Seed

Provide agent-accessible browser tools for Zoottle browser panes, using Starch's `browser-run` tool suite as the reference for browser inspection and interaction.

## Solution

- Tool surface: expose direct OpenCode browser tools for list tabs, connect tab, open and connect tab, disconnect tab, snapshot, interact, screenshot, and execute JavaScript.
- Connection model: tools operate on a `cdpId` returned by explicit tab connection, not implicit active-tab state.
- Browser target: connect only to Zoottle browser panes backed by Electron/webframe tabs.
- Browser primitives: implement snapshot, interact, screenshot, and JavaScript execution through the desktop CDP/webframe boundary.
- UI state: show an agent-connected banner under the URL bar with a disconnect button for connected tabs.
- Orchestration: let the OpenCode agent decide whether to call tools inline or delegate through its own sub-task mechanisms.
- Results: return concise observations, screenshot metadata, and structured action outcomes suitable for the main agent transcript.
- Safety: enforce local URL/action/JavaScript policy at the app boundary before desktop browser operations.

## Spec

### Scope

Zoottle will add browser automation tools to the OpenCode plugin. These tools control browser panes already owned by the Zoottle desktop app. They do not create a browser subagent, use Browserbase, or mirror Starch's LRT child-run orchestration.

The first version supports desktop browser panes only. In browser-only mode the tools return a clear unavailable error because there is no native webframe tab or Electron CDP target to operate on.

### Tool Surface

The OpenCode plugin registers these tools alongside `cloud_open_pane`:

```ts
cloud_browser_list_tabs(): BrowserTabSummary[]
cloud_browser_connect_tab(input: { browserTabId: string }): BrowserConnection
cloud_browser_open_and_connect(input: { url: string; title?: string; activate?: boolean }): BrowserConnection
cloud_browser_disconnect(input: { cdpId: string }): { ok: true }
cloud_browser_snapshot(input: SnapshotInput & { cdpId: string }): SnapshotOutput
cloud_browser_interact(input: InteractInput & { cdpId: string }): InteractOutput
cloud_browser_screenshot(input: ScreenshotInput & { cdpId: string }): ScreenshotOutput
cloud_browser_execute_js(input: ExecuteJsInput & { cdpId: string }): ExecuteJsOutput
```

`cloud_open_pane` remains display-only. It may still open a browser pane, but it does not connect the agent to that pane.

### Connection Model

`browserTabId` is the webframe tab id already used by `BrowserPane`. `cdpId` is a short-lived app-issued handle that binds one OpenCode session to one `browserTabId`.

```ts
type BrowserConnection = {
  cdpId: string
  browserTabId: string
  url: string
  title: string
  connectedAt: string
}

type BrowserTabSummary = {
  browserTabId: string
  url: string
  title: string
  active: boolean
  connected: boolean
  connectedByCurrentAgent: boolean
}
```

Connections are scoped to the authenticated agent token and `opencodeSessionId`. A `cdpId` cannot be used by another sandbox or another OpenCode session. Disconnect detaches the CDP session and clears UI state; closing the tab or ending the agent session also invalidates the connection.

`cloud_browser_open_and_connect` creates or focuses a Zoottle browser pane for the requested URL, waits until the backing `browserTabId` exists, then returns a connection. This is the fast path for agents that need a fresh page instead of selecting from existing tabs.

### App And Desktop Architecture

The plugin calls a new `agentBrowser` tRPC router through `AgentShellClient`. The router uses the same bearer-token auth path as `agentShell` and `agentUi`.

Both server surfaces need the same public procedures:

```ts
agentBrowser.listTabs({ sandboxId?, opencodeSessionId })
agentBrowser.connectTab({ sandboxId?, opencodeSessionId, browserTabId })
agentBrowser.openAndConnect({ sandboxId?, opencodeSessionId, url, title?, activate? })
agentBrowser.disconnect({ sandboxId?, opencodeSessionId, cdpId })
agentBrowser.snapshot({ sandboxId?, opencodeSessionId, cdpId, ...snapshot })
agentBrowser.interact({ sandboxId?, opencodeSessionId, cdpId, ...interact })
agentBrowser.screenshot({ sandboxId?, opencodeSessionId, cdpId, ...screenshot })
agentBrowser.executeJs({ sandboxId?, opencodeSessionId, cdpId, ...executeJs })
```

The local app server and `packages/env-server` mirror this router because the plugin can talk to either environment. Shared browser command code should live outside the routers so both surfaces validate inputs identically.

Desktop owns the native operation layer. It already finds tab `WebContents` by `browserTabId` for DevTools; the browser tool layer extends that path to attach an Electron debugger/CDP session, evaluate DOM snapshot code, dispatch input events, capture screenshots, and run user JavaScript.

### UI State

Connected state is keyed by `browserTabId` and surfaced to React via the browser API or an agent UI event stream. `BrowserPane` renders a banner directly under the URL bar when its tab is connected:

```text
Agent connected to this tab        Disconnect
```

The banner appears for any connected tab. The disconnect button calls the app-side disconnect path for that tab and clears the connection. If multiple agent sessions connect to the same tab, the banner remains until the final connection is gone; the first version should avoid multiple simultaneous CDP attachments unless Electron requires explicit sharing support.

### Snapshot

Snapshot follows Starch's semantic-tree model. It returns compact text optimized for an agent transcript, not raw HTML.

```ts
type SnapshotInput = {
  filter?: string
  filterFlags?: string
  viewportOnly?: boolean
}

type SnapshotOutput = {
  url: string
  title: string
  interactiveCount: number
  durationMs: number
  text: string
}
```

The text includes a JSON header and a tree of visible or filtered elements. Interactive elements receive stable element ids for the current snapshot. Later `interact` calls may use those ids; ids are not guaranteed after navigation, reload, or a new snapshot that changes the DOM.

### Interact

Interact mirrors Starch's action vocabulary where it applies to a local desktop tab.

```ts
type InteractInput = {
  action:
    | { type: 'click'; elementId: string }
    | { type: 'type'; elementId: string; text: string; clear?: boolean }
    | { type: 'fill'; fields: Array<{ elementId: string; text: string; clear?: boolean }> }
    | { type: 'scroll'; x?: number; y?: number }
    | { type: 'goto'; url: string }
    | { type: 'back' }
    | { type: 'forward' }
    | { type: 'wait'; ms?: number; until?: 'load' | 'settle' }
  postSnapshot?: false | { wait?: 'none' | 'load' | 'settle'; waitMs?: number; filter?: string }
}

type InteractOutput = {
  ok: boolean
  action: InteractInput['action']
  url: string
  title: string
  error?: string
  snapshot?: SnapshotOutput
}
```

DOM-targeted actions use the element ids from the most recent snapshot for that `cdpId`. Navigation actions do not require an element id. `postSnapshot` defaults to `false` for concise results.

### Screenshot

Screenshot captures the connected tab viewport through CDP.

```ts
type ScreenshotInput = {
  format?: 'jpeg' | 'png'
  quality?: number
  fullPage?: boolean
}

type ScreenshotOutput = {
  format: 'jpeg' | 'png'
  width: number
  height: number
  base64: string
  byteLength: number
}
```

The default is a JPEG viewport screenshot with bounded quality and dimensions. Full-page capture is optional and must enforce size limits. If an image would exceed the tool response limit, the tool returns a clear error instead of truncating the base64.

### Execute JavaScript

JavaScript execution is an explicit power tool for cases where semantic snapshot and interact are insufficient.

```ts
type ExecuteJsInput = {
  expression: string
  awaitPromise?: boolean
  timeoutMs?: number
}

type ExecuteJsOutput = {
  type: string
  value?: unknown
  unserializableValue?: string
  exception?: string
}
```

Execution runs in the main frame of the connected tab. Results must be JSON-serializable or summarized by type. The app enforces a timeout and rejects expressions that exceed configured size limits. The tool description must tell the agent to prefer snapshot/interact before JavaScript.

### Safety And Validation

The app validates URL schemes before opening or navigating. The allowed defaults are `http:`, `https:`, `about:blank`, and local development URLs. Dangerous schemes such as `file:`, `javascript:`, and custom external app protocols are rejected unless a future explicit policy allows them.

Browser commands are scoped to tabs known to the current Zoottle desktop window. The router rejects unknown `browserTabId`, stale `cdpId`, closed tabs, and commands from the wrong sandbox/session. JavaScript and screenshots use conservative payload limits to avoid leaking excessive data into the agent transcript.

### Error Handling

Unavailable desktop browser support returns `browser tools unavailable in this environment`. Closed tabs return `browser tab closed`. Stale or cross-session `cdpId` returns `browser connection not found`. Failed DOM element lookup returns `element id not found; refresh snapshot`.

Tool failures return structured metadata with `status: 'error'` and a short `stderr`, matching the existing plugin tools.

### Dependencies

No external browser service is required. The implementation depends on Electron `WebContents.debugger` or an equivalent webframe-supported CDP path, existing webframe tab ids, the current tRPC auth middleware, and React browser pane state.
