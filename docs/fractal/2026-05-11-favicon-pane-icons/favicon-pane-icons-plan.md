# Favicon Pane Icons Plan

## Task 1: Add Pane Icons To Tab Chrome

Add shared default icons for current pane types and render them in existing tab strips without changing tab behavior.

**Steps**
- Define pane icon metadata for `shell`, `file`, and `browser`.
- Add an optional icon field to `BorderedTabItem` and render it before the label.
- Pass icons from workspace tabs and env right-pane tabs.

**Tests**
- Unit: `BorderedTabStrip` renders an icon and preserves label/close behavior.
- Unit: pane type to icon mapping covers `shell`, `file`, and `browser`.
- Manual: open shell, file, and browser panes and verify each tab has the expected default icon.

**Depends on:** none

**Status:** done

## Task 2: Surface Webframe Favicons

Extend the existing `webframe` favicon event path so Kaivo receives selected favicon URLs consistently.

**Steps**
- Improve `webframe` favicon candidate selection for `page-favicon-updated`.
- Include `favicon?: string` in `webframe` tab list/get/create/change payloads.
- Forward favicon data through Kaivo browser API events and tab listings.

**Tests**
- Unit: favicon candidate selection prefers valid, same-origin, larger candidates and keeps prior favicon on empty events.
- Unit: browser API maps `favicon` from webframe list/change/create payloads.
- Manual: navigate to a site with a favicon and observe a favicon patch reaching the app.

**Depends on:** Task 1

**Status:** done

## Task 3: Persist Favicon Cache In App Service

Add app-service storage and APIs for restart-stable favicon data.

**Steps**
- Add a SQLite/Drizzle favicon cache table and migration.
- Add protected tRPC procedures to read by origin and upsert validated favicon records.
- Validate origin, media type, and size before accepting writes.

**Tests**
- Unit: origin normalization and cache-record validation reject invalid/oversized favicon data.
- Integration: favicon cache upsert then read returns the expected record after service reload/migration setup.
- Manual: inspect local app DB and verify favicon rows are persisted.

**Depends on:** Task 2

**Status:** done

## Task 4: Wire Browser Tabs To Cached Favicons

Connect browser tab favicon events to the app-service cache and hydrate visible tabs from cache on restore.

**Steps**
- Query favicon cache for visible browser tab origins.
- Resolve live favicon URLs to bounded data URLs and upsert valid records.
- Render cached/live favicons for browser tabs with default browser-icon fallback.

**Tests**
- Unit: browser tab icon state switches origin correctly and falls back for invalid/internal URLs.
- Integration: favicon event persists cache and restored browser tabs hydrate from that cache.
- Manual: verify default web icon before load, site favicon after navigation, and favicon persistence after app restart.

**Depends on:** Task 3

**Status:** done
