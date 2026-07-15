# WebFrame

Electron browser framework for logical tabs, placement, overlays, and the tRPC bridge used by Kaivo desktop shells.

WebFrame is an internal package at `packages/webframe`. The desktop package depends on it through the monorepo path and does not fetch it from a package registry.

## Development

```sh
npm install --prefix packages/webframe
npm test --prefix packages/webframe
npm run test:e2e --prefix packages/webframe
```

`kaivo-desktop` builds WebFrame before compiling the Electron main process, so local WebFrame changes are picked up by normal desktop builds.

## Verification

```bash
npm test
npm run test:exports
npm run test:pack
npm pack --dry-run
```

`test:exports` imports the built package entrypoints: `.`, `./renderer`, and `./sqlite`. `test:pack` creates the local tarball, installs it into a temp project, verifies package contents, and checks peer dependency metadata.

## Automation Access

Main-process consumers that need to drive or inspect pages can call `wf.tabs.getWebContents(tabId)` to retrieve the live Electron `WebContents` for a mounted logical tab. The accessor is intentionally read-only from WebFrame's perspective: it returns `undefined` for missing, detached, or destroyed tabs, and consumers should wrap any automation in their own domain service rather than coupling application code to WebFrame internals. CDP attachment is optional and should be handled by the consumer when `WebContents` evaluation is insufficient.
