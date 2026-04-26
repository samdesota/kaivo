# Electron Browser Tabs Agent Pane Plan

## Task 1: Publish `webframe` Through GitHub Packages

Prepare `webframe` for scoped package publishing so `cloud-code-tools` can consume it as a normal dependency while keeping the source in its own repo.

**Steps**
- Rename or scope the `webframe` package for GitHub Packages, for example `@cloud-code/webframe`.
- Add GitHub Packages publish configuration and document required `.npmrc` authentication.
- Add a release/publish workflow or script that runs the `webframe` build before publishing.

**Tests**
- Unit: `webframe` package export smoke test imports `.`, `./renderer`, and `./sqlite` from built output.
- Integration: publish dry run or local pack install verifies package contents and peer dependency metadata.
- Manual: install the package into a clean temp project using GitHub Packages authentication.

**Depends on:** none

**Status:** done

## Task 2: Add Desktop Electron Test Harness

Create the test harness before feature work so every later Electron task can be verified by an agent without relying on manual observation.

**Steps**
- Add a Playwright Electron fixture for launching `cloud-code-desktop` with controlled environment variables and per-run temp state.
- Capture Electron main logs, chrome renderer console logs, browser-tab renderer console logs, unhandled rejections, uncaught exceptions, crashes, and `render-process-gone` events into a per-test log file.
- Expose test-only main-process inspection hooks for window ids, `webframe` app state, tab records, slot bounds, active tab ids, and log paths.
- Add helpers for renderer manipulation through Playwright `Page`, main-process inspection through Electron `app.evaluate`, and log dumping on failure.
- Add a minimal fixture Electron target or placeholder launch path so the harness can prove log capture and page control before the real desktop app is complete.

**Tests**
- Unit: harness log parser classifies main, chrome renderer, tab renderer, crash, and exception records.
- Integration: fixture Electron launch opens a page, evaluates renderer JavaScript, evaluates main-process state, writes logs, and fails the test when an unhandled error is emitted.
- Manual: intentionally trigger a renderer console error in the fixture and confirm the failing test output includes the log file path and recent log lines.

**Depends on:** Task 1

**Status:** done

## Task 3: Add `cloud-code-desktop` Package Skeleton

Create the desktop app package inside `cloud-code-tools` and wire it into the harness without changing browser pane behavior yet.

**Steps**
- Add `packages/cloud-code-desktop` with `src/main.ts`, `src/preload.ts`, package metadata, TypeScript config, and bundling config.
- Add Electron and `@samdesota/webframe` dependencies in the right package scope.
- Add root scripts for desktop build, typecheck, development startup, and desktop e2e tests.
- Point the Electron harness at the built desktop main process.

**Tests**
- Unit: TypeScript typecheck for `packages/cloud-code-desktop`.
- Integration: desktop package build emits main and preload bundles.
- Integration: desktop harness launches the skeleton app and captures main plus renderer logs.

**Depends on:** Task 2

**Status:** done

## Task 4: Boot Existing App Inside Electron

Wire the desktop app to launch the existing React chrome through `webframe` while preserving the normal web development flow.

**Steps**
- Initialize `webframe.createApp` from the desktop main process.
- Create a chrome window pointed at the Vite dev URL in development.
- Add production startup behavior for loading the built app/server URL.
- Ensure shutdown closes `webframe` and Electron cleanly.

**Tests**
- Unit: desktop config resolution covers development and production chrome URLs.
- Integration: desktop harness reaches the app shell, reads chrome renderer state, and dumps logs on failure.
- Manual: start server, client, and desktop app; verify the existing agent UI loads.

**Depends on:** Task 3

**Status:** done

## Task 5: Add Browser Pane State and Schemas

Teach the app and agent UI protocol about browser pane content without rendering native browser views yet.

**Steps**
- Extend env and sandbox right-pane `PaneContent` unions with `type: 'browser'`, `url`, and `browserTabId`.
- Update title, equality, restore, reducer, and right-pane rendering branches for browser panes.
- Extend env-server and orchestrator `agent-ui` schemas to accept browser panes.
- Extend `cloud_open_pane` tool input to accept `kind: 'browser'` and `url`.

**Tests**
- Unit: pane reducer opens, focuses, restores, and closes browser pane content.
- Unit: agent UI schemas accept valid browser content and reject invalid input.
- Integration: `cloud_open_pane` with `kind: 'browser'` emits an `open_pane` event to the frontend.

**Depends on:** Task 4

**Status:** done

## Task 6: Add Browser API Adapter

Expose a narrow browser API adapter that lets the React chrome create, attach, navigate, focus, and close `webframe` tabs without duplicating `webframe`'s shell API.

**Steps**
- Add a renderer-side browser API module with availability, tab control, slot updates, and tab-change subscription methods.
- Implement the Electron adapter by delegating to `window.webframe.trpc.windows`, `tabs`, and `navigation` methods; do not add custom main-process IPC for operations webframe already exposes.
- Add a non-Electron fallback adapter for the web app that reports browser support as unavailable.
- Add harness helpers for invoking the browser API from the chrome page and inspecting resulting `webframe` main-process state.

**Tests**
- Unit: browser API adapter reports unavailable outside Electron.
- Unit: Electron browser API maps pane ids, slot rects, tab creation, focus, close, and navigation calls to the expected `window.webframe.trpc` operations.
- Integration: desktop harness creates a `webframe` tab through the browser API, navigates it to a local test page, inspects tab state through `app.evaluate`, and captures tab renderer logs.

**Depends on:** Task 5

**Status:** done

## Task 7: Render Browser Panes With Native Slots

Connect the React right pane to Electron slots so browser panes display real `WebContentsView` tabs instead of iframes.

**Steps**
- Add a browser pane React component that measures its bounds and sends slot updates through the browser API adapter.
- Create or attach the `webframe` tab when the browser pane mounts or becomes active.
- Detach, hide, or close native tabs when panes unmount, close, or lose their visible slot.
- Subscribe to browser tab lifecycle updates for title and navigation state where needed.

**Tests**
- Unit: browser pane component calls browser API methods on mount, resize, activation, and cleanup.
- Integration: desktop harness opens two browser panes, switches active right-pane tabs, and verifies native `WebContentsView` bounds and z-order through main-process inspection.
- Integration: desktop harness resizes the app window and verifies the active tab follows the pane slot while inactive native content stays hidden.

**Depends on:** Task 6

**Status:** done

## Task 8: Integrate Agent-Driven Browser Opening

Complete the user-facing flow where an agent opens a full browser tab in the side pane.

**Steps**
- Route `open_pane` browser events from `session-view` into the right-pane reducer.
- Ensure `activate`, `title`, and initial `url` behavior matches existing pane-opening semantics.
- Add empty/unavailable states for browser panes outside Electron.
- Keep existing iframe preview tabs unchanged.

**Tests**
- Unit: session-view maps browser `open_pane` events to right-pane actions.
- Integration: desktop harness calls the agent UI path for `cloud_open_pane({ kind: 'browser', url })`, manipulates the chrome page, and verifies a real `webframe` tab is attached to the side pane.
- Integration: desktop harness captures logs from the opened browser tab and includes them in failure output.

**Depends on:** Task 7

**Status:** done

## Task 9: Package and Document Desktop Development

Make the new desktop workflow repeatable for local development and release candidates.

**Steps**
- Document GitHub Packages auth, published install, and linked `../webframe` development setup.
- Add a local dev command that runs app server, Vite client, `webframe` watch build, and `cloud-code-desktop` together.
- Document desktop test harness commands, log locations, failure output, and how to run a single Electron e2e test.
- Document production build expectations and failure modes for missing GitHub Packages auth or missing linked `webframe` build output.

**Tests**
- Unit: package scripts referenced by docs exist and run in dry-run form where possible.
- Integration: clean install with GitHub Packages auth builds `cloud-code-tools`, `cloud-code-desktop`, and runs the desktop harness smoke test.
- Manual: follow the documented linked `../webframe` workflow and verify a code change in `webframe` reaches the desktop app after rebuild/restart.

**Depends on:** Task 8
