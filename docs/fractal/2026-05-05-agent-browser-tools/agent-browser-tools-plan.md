# Agent Browser Tools Plan

## Task 1: Define Browser Tool Contracts

Add the shared contract layer for browser tool inputs, outputs, connection records, and errors. This stands alone because every router, plugin tool, and UI state path should consume the same types.

**Steps**
- Add shared `agentBrowser` schemas for list, connect, open-and-connect, disconnect, snapshot, interact, screenshot, and execute JavaScript.
- Define the `cdpId` connection record shape and scoped error codes.
- Add URL/action/JavaScript validation helpers with conservative defaults.

**Tests**
- Unit: schema validation accepts valid tool inputs and rejects stale, unsafe, or oversized inputs.
- Unit: URL policy rejects `file:`, `javascript:`, and external app protocols.

**Depends on:** none

**Status:** done

## Task 2: Add Agent Browser Routers

Expose the browser contracts through authenticated tRPC procedures in both app-server and env-server. This creates the app boundary without requiring the desktop CDP implementation yet.

**Steps**
- Add `agentBrowser` router to `server/trpc/routers/` and wire it into `server/trpc/router.ts`.
- Add the mirrored `agentBrowser` router to `packages/env-server/src/trpc/routers/` and its root router.
- Scope every procedure by `sandboxId` and `opencodeSessionId` using the existing agent token middleware.
- Return explicit unavailable or unimplemented responses behind a browser service interface until desktop primitives exist.

**Tests**
- Unit: app-server router rejects unauthenticated and cross-sandbox calls.
- Unit: env-server router exposes the same procedure names and input validation.

**Depends on:** Task 1

**Status:** done

## Task 3: Implement CDP Connection Management

Create the desktop-side connection registry that maps a session-scoped `cdpId` to an Electron/webframe tab. This stands alone because all browser actions depend on reliable attach, detach, and tab lifecycle handling.

**Steps**
- Extend the desktop main process path that already finds tab `WebContents` by `browserTabId`.
- Attach and detach Electron debugger sessions per connected tab.
- Track connections by `cdpId`, `browserTabId`, sandbox/session scope, and lifecycle timestamps.
- Invalidate connections when the tab closes, the debugger detaches, or disconnect is called.
- Implement `listTabs`, `connectTab`, `openAndConnect`, and `disconnect` through the router service.

**Tests**
- Unit: connection registry prevents cross-session `cdpId` reuse and cleans up stale tabs.
- Integration: connecting to an existing desktop browser pane returns a usable `cdpId`.
- Integration: open-and-connect creates a browser pane for a URL and returns the backing `browserTabId` and `cdpId`.

**Depends on:** Task 2

**Status:** done

## Task 4: Port Starch Snapshot Precisely

Port Starch's current semantic snapshot implementation rather than reimplementing it. This task is isolated so behavior and tests can be reviewed against the upstream source before interaction tools depend on it.

**Steps**
- Port `/Users/sam/d/starch/Starch-app/supabase/functions/_shared/agent-tree-snapshot.ts` into the Zoottle browser tool layer with minimal semantic changes.
- Port the CDP wrapper behavior from `/Users/sam/d/starch/Starch-app/supabase/functions/_shared/browser/snapshot.ts` to Electron debugger CDP calls.
- Preserve semantic tree output, viewport filtering, shadow DOM traversal, ARIA role/name handling, element id assignment, filtering, pruning, and compact text formatting.
- Adapt Deno/Supabase imports and Starch tool wrappers to this repo's TypeScript and test environment.
- Add direct snapshot unit tests for behavior not covered upstream.

**Tests**
- Unit: ported serializer renders the same text shape for representative DOM fixtures.
- Unit: filtering, viewport-only behavior, interactive element ids, shadow DOM, ARIA names, and decorative pruning match Starch expectations.
- Integration: `cloud_browser_snapshot` returns a semantic tree for a connected desktop tab.

**Depends on:** Task 3

**Status:** done

## Task 5: Add Interact, Screenshot, And JavaScript Execution

Implement the remaining connected-tab operations using the CDP connection created by earlier tasks. This stands alone because each operation can be verified against a connected tab without changing UI chrome.

**Steps**
- Port/adapt Starch's interact action vocabulary from `browser-run/tools/interact.ts` and `_shared/browser/interact.ts`.
- Resolve snapshot element ids to DOM targets for click, type, fill, scroll, navigation, and wait actions.
- Add optional post-action snapshot using the ported snapshot implementation.
- Implement viewport screenshot capture with format, quality, full-page, and payload-size limits.
- Implement explicit JavaScript execution with timeout and serializable result handling.

**Tests**
- Unit: interact input validation covers every action type and post-snapshot options.
- Integration: click/type/fill/goto/wait actions mutate a connected test page as expected.
- Integration: screenshot returns bounded image metadata and base64 for a connected tab.
- Integration: execute JavaScript returns values, exceptions, and timeout errors correctly.

**Depends on:** Task 4

**Status:** done

## Task 6: Register OpenCode Browser Tools

Expose the app-side browser operations as OpenCode plugin tools with concise descriptions and transcript-friendly outputs. This can ship separately once router procedures exist.

**Steps**
- Add `cloud_browser_list_tabs`, `cloud_browser_connect_tab`, `cloud_browser_open_and_connect`, `cloud_browser_disconnect`, `cloud_browser_snapshot`, `cloud_browser_interact`, `cloud_browser_screenshot`, and `cloud_browser_execute_js` to `packages/opencode-plugin/src/index.ts`.
- Include `opencodeSessionId` from the tool context on every app call.
- Return existing plugin-style `{ output, metadata }` results with `status`, ids, errors, and concise observations.
- Update plugin logging to include the browser tool names when registered.

**Tests**
- Unit: plugin registers every browser tool when Zoottle credentials exist.
- Unit: each tool calls the expected tRPC procedure with `opencodeSessionId` and normalized inputs.
- Unit: app-unreachable and router errors map to structured plugin error metadata.

**Depends on:** Task 5

**Status:** done

## Task 7: Add Connected-Tab UI State

Show the user when an agent is connected to a browser pane and let them disconnect it from the UI. This stands alone because it changes visible behavior but not core CDP operation semantics.

**Steps**
- Add connected-tab state to the browser API or agent UI event flow keyed by `browserTabId`.
- Render an agent-connected banner under the URL bar in `BrowserPane`.
- Add a disconnect button that calls the app disconnect path for that tab.
- Keep banner state correct across tab attach, tab close, disconnect, and multiple workspace/right-pane render paths.

**Tests**
- Unit: `BrowserPane` renders the banner only for connected tabs and calls disconnect on click.
- Unit: browser API connected-state events update the correct `browserTabId`.
- Integration: connecting through the agent tool shows the banner in the desktop browser pane, and clicking disconnect invalidates the `cdpId`.

**Depends on:** Task 3

**Status:** done

## Task 8: End-To-End Tool Flow

Verify the complete agent-facing workflow in the desktop app. This task ties together plugin registration, router auth, desktop CDP control, and UI state.

**Steps**
- Add a desktop test page fixture with stable controls, forms, navigation, and scriptable state.
- Exercise open-and-connect, snapshot, interact, screenshot, execute JavaScript, and disconnect through the same tRPC/plugin path used by OpenCode.
- Confirm browser-only mode returns the documented unavailable error.
- Run full typecheck, unit tests, desktop build, and desktop e2e tests.

**Tests**
- Integration: full desktop flow opens a tab, connects, snapshots, interacts, screenshots, executes JavaScript, then disconnects.
- Integration: browser-only flow returns `browser tools unavailable in this environment`.
- Manual: start `npm run dev`, open a browser pane, connect through an OpenCode browser tool, observe the banner, interact with the page, then disconnect.

**Depends on:** Tasks 6 and 7

**Status:** done
