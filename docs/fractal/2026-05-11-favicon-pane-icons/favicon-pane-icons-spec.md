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
