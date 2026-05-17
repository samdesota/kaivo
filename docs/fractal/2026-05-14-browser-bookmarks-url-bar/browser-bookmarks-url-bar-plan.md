# Browser Bookmarks URL Bar Plan

## Task 1: Bookmark Data And Realtime Collection

Create the bookmark data path end-to-end without changing visible UI: `workspace_resources` accepts `bookmark`, bookmark rows normalize into a typed frontend model, and realtime SQLite changes flow through a dedicated TanStack collection hook.

**Steps**
- Add `bookmark` to app/shared workspace resource type definitions and tRPC validation.
- Add bookmark mapping utilities for `WorkspaceResourceRecord` to `BookmarkRecord`, including URL/origin/favicon fields and invalid-row skipping.
- Add `useWorkspaceBookmarksStore(workspaceId?)` backed by `sync.snapshot` and `sync.changes` for `workspace_resources`.
- Add bookmark upsert/delete helpers or small mutation wrappers that preserve the existing `workspace.upsertResource`/`deleteResource` source-of-truth path.
- Update resource cleanup/type switches so bookmark records are retained as normal user data and not treated as orphaned disposable resources.

**Tests**
- Unit: bookmark resource mapping accepts valid rows and skips malformed `data` without throwing.
- Unit: bookmark resource key generation is stable and idempotent for equivalent normalized URLs.
- Unit: `workspace_resources` type validation accepts `bookmark` and still rejects unknown types.
- Unit: collection CDC handler applies insert/update/delete events with direct write utilities.
- E2E: not required for this task; the first user-visible E2E coverage lands when bookmarks are exposed through the overlay, URL bar, and universal menu.

**Maintainability**
- Keep bookmark normalization in a small utility module so `BrowserPane` and universal menu do not duplicate parsing.
- Do not widen resource type validation to arbitrary strings; add the explicit `bookmark` member everywhere needed.
- Keep the collection hook focused on data sync and filtering, not UI-specific ranking or rendering.
- Reuse the existing realtime collection pattern instead of creating a parallel subscription mechanism.

**Depends on:** none

**Status:** done

## Task 2: Shared Navigation And Bookmark Matching

Add the shared logic that decides whether typed text means bookmark, URL, or search, and rank bookmark matches consistently for the URL bar and universal menu.

**Steps**
- Move or replace `normalizeBrowserUrl` with a shared browser navigation utility.
- Implement URL parsing rules for schemes, localhost, IPv4, domain-like input, empty input, and search fallback.
- Implement bookmark matching against title, URL, normalized URL, and origin.
- Implement ranking so exact title/normalized URL matches beat prefix matches, prefix matches beat substring matches, and recency breaks ties.
- Add a search URL builder with the default Google search endpoint unless a product setting already exists.

**Tests**
- Unit: navigation utility handles domain, localhost, IPv4, existing schemes, whitespace query, and empty input.
- Unit: `foo` ranks bookmark title `foo` before `foozam`.
- Unit: exact normalized URL match ranks ahead of host/path substring matches.
- Unit: search URL builder correctly encodes spaces and punctuation.
- E2E: not required for this task; ranking is pure logic here and is exercised end-to-end in Tasks 4 and 5.

**Maintainability**
- Keep matching pure and framework-free so it can be unit tested without React.
- Avoid embedding search-provider assumptions outside the shared utility.
- Return structured decisions instead of booleans so UI code can render URL/search/bookmark rows cleanly.
- Do not make browser pane state responsible for ranking; it should consume ranked results.

**Depends on:** Task 1

**Status:** done

## Task 3: Bookmark Creation Overlay From Browser Pane

Ship the first visible bookmark workflow: a user can save the active browser page through a detached overlay-layer modal, including persisted favicon metadata.

**Steps**
- Add a typed `create-bookmark` request/response to `OverlayRequest` and `OverlayResponse`.
- Add `openCreateBookmarkOverlay(...)` to `overlay-layer-controller.tsx`.
- Render `CreateBookmarkOverlay` in `routes/internal/overlay-layer.tsx` with compact title and URL fields.
- Wire the overlay save action to upsert a `bookmark` `workspace_resources` row with title, URL, normalized URL, origin, `faviconDataUrl` when available, and `faviconUrl` fallback.
- Add a right-side star action to `BrowserPane`, seeded from current URL/title/favicon, disabled for unbookmarkable URLs.
- Bind `Cmd+D`/`Ctrl+D` to the same overlay when a browser pane is active.

**Tests**
- Unit: overlay-layer request guard recognizes `create-bookmark` and routes responses correctly.
- Unit: controller resolves bookmark id on save, resolves `null` on close, and throws on unexpected response.
- Component: bookmark overlay disables Save for invalid input and calls upsert with normalized bookmark data.
- Component: browser pane star button and `Cmd+D`/`Ctrl+D` launch bookmark creation when URL is bookmarkable.
- E2E: desktop Playwright (`tests/desktop`, `npm run test:e2e:desktop`) opens a browser pane, presses `Cmd+D`/`Ctrl+D`, verifies the detached bookmark overlay appears above the native browser slot, saves, and observes a persisted bookmark resource.
- Human: verify the overlay feels visually attached to the browser pane action and does not appear under the native browser tab on macOS.

**Maintainability**
- Keep modal UI in the overlay layer only; browser pane should only call the controller.
- Keep favicon selection in a small helper so save code does not mix cache lookup, URL normalization, and mutation construction.
- Do not add a general bookmark manager in this task; keep the slice to create/update from the active page.
- Use existing `Modal`, `Input`, and compact form conventions instead of introducing new modal chrome.

**Depends on:** Task 2

**Status:** done

## Task 4: URL Bar Bookmark Search And Navigation

Make the browser pane URL bar usable as a bookmark finder, direct URL bar, and search box while preserving native tab navigation.

**Steps**
- Pass workspace context/bookmarks into `BrowserPane` or have it read `useWorkspaceBookmarksStore` with the active workspace id.
- Move `</>` and star actions to the right side of the URL bar.
- Add a compact detached overlay popover under the URL input while focused with ranked bookmark rows and a search row.
- Render bookmark rows with persisted favicon data URL, favicon URL fallback, then default browser icon; render search rows with a search icon.
- Implement keyboard behavior: Up/Down selects rows, Enter opens selected bookmark/search, Escape closes popover, blur closes after result click handling.
- Submit with no selected row by exact bookmark match, then URL decision, then search fallback.
- Navigate the active native browser tab through `browserApi.navigate` and update local address state optimistically.

**Tests**
- Component: URL bar filters bookmarks and renders favicon-backed rows without `bookmark` text labels.
- Component: search fallback row renders with a search icon and navigates to encoded search URL.
- Component: Enter on selected bookmark navigates to bookmark URL.
- Component: Enter on exact bookmark match navigates to bookmark URL before treating input as search or URL.
- Component: `</>` and star controls render on the right side of the URL input.
- E2E: desktop Playwright (`tests/desktop`, `npm run test:e2e:desktop`) creates or seeds a bookmark, types into the browser pane URL bar, verifies bookmark rows appear with an icon, presses Enter, and verifies the native tab navigates to the bookmark URL.
- E2E: desktop Playwright verifies typing a non-URL query in the URL bar shows a search-icon row and navigates to the encoded web search URL on Enter.
- Human: URL bar remains compact and usable on narrow pane widths.

**Maintainability**
- Keep the popover UI in the detached overlay layer so it renders above native browser tabs.
- Avoid duplicating universal menu result components unless their assumptions fit; URL bar rows have different density and icon rules.
- Keep browser API calls isolated to submit/result activation handlers.
- Make row rendering tolerant of missing favicon values and malformed bookmark records.

**Depends on:** Task 3

**Status:** done

## Task 5: Universal Menu Web Scope Bookmarks

Complete `@` mode by searching saved bookmarks alongside open browser tabs and direct URL/search actions.

**Steps**
- Read workspace bookmarks in `UniversalMenu` when Web scope is active.
- Replace placeholder bookmark behavior with real bookmark results.
- Use shared navigation/search utility for direct URL and search rows.
- Use shared bookmark matching/ranking for bookmark rows.
- Render bookmark rows with favicon when available while preserving existing compact universal menu row style.
- Selecting a bookmark opens `{ type: 'browser', url: bookmark.url }`; selecting search/direct URL opens browser pane content with the resolved URL.

**Tests**
- Component: typing `@foo` shows exact bookmark matches before prefix/substring matches.
- Component: Web scope shows direct search action for non-URL text.
- Component: selecting a bookmark calls `onOpenContent` with browser pane content for the bookmark URL.
- Component: open browser tab results still preserve `browserTabId` so focus/attach behavior is not regressed.
- Unit: Web scope result ordering combines direct action, open tabs, then bookmarks as specified.
- E2E: web Playwright (`tests/e2e`, `npm run test:e2e`) seeds bookmarks named `foo` and `foozam`, opens universal menu `@` Web scope, types `foo`, and asserts the exact `foo` bookmark appears before `foozam`.
- E2E: web Playwright seeds a bookmark, opens `@` Web scope, selects it, and verifies browser pane content opens for the bookmark URL.

**Maintainability**
- Keep Web scope result production separate from rendering so future bookmark folders do not require rewriting menu shell logic.
- Reuse favicon icon helpers instead of adding one-off image handling in universal menu.
- Do not make universal menu own bookmark mutations in this task; it only reads and opens bookmarks.
- Preserve existing scope keyboard behavior and avoid special-case event handling for Web unless necessary.

**Depends on:** Task 4

**Status:** done

## Task 6: Polish, Realtime Verification, And Regression Coverage

Harden the full workflow across reloads, multiple open views, and browser fallback states.

**Steps**
- Verify favicon persistence across app reload by saving and rehydrating `faviconDataUrl` or safe fallback metadata.
- Verify realtime updates by creating/updating/deleting a bookmark in one mounted collection and observing URL bar/Web scope updates in another.
- Add quiet loading/error behavior for bookmark collection failures in URL bar and Web scope.
- Ensure browser-unavailable fallback does not throw when bookmark context or native APIs are missing.
- Run focused unit/component tests and the relevant typecheck/test command for the touched packages.

**Tests**
- Integration: creating a bookmark writes a realtime `workspace_resources` event and another collection instance receives it without reload.
- Integration: saved bookmark with favicon metadata reappears with icon after remount or reload.
- Unit: malformed bookmark rows do not break URL bar or Web scope rendering.
- E2E: desktop Playwright saves a bookmark with favicon metadata, remounts/restarts through the desktop harness if practical, and verifies the URL bar bookmark row renders an image/icon rather than a literal `bookmark` label.
- E2E: web or desktop Playwright verifies a bookmark created in one visible app context appears in another subscribed context without full reload when the harness can support two pages/windows.
- Human: `Cmd+D`, star click, URL bar bookmark open, URL bar search, and `@` bookmark open all work in desktop browser panes.

**Maintainability**
- Prefer focused regression tests near existing unit suites over broad brittle end-to-end tests for every keyboard branch.
- Keep error states inline and quiet; do not add global toasts for routine bookmark sync failures.
- Avoid adding cleanup code that deletes user bookmarks as if they were disposable browser resources.
- Document any remaining manual-only browser/Electron behavior in test notes if automation cannot cover it reliably.

**Depends on:** Task 5

**Status:** done
