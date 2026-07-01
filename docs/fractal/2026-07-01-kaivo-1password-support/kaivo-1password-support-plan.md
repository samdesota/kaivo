# Kaivo 1Password Support Plan

## Task 1: Show Desktop 1Password Status

Add the desktop-only 1Password settings surface and runtime status API. This creates the user-visible home for setup without loading extensions yet.

**Steps**
- Add a small desktop 1Password runtime module that reads instance-local config, applies environment overrides, validates only basic path presence, and returns `OnePasswordStatus`.
- Add Electron IPC handlers and preload methods for `getOnePasswordStatus()` and `resetOnePasswordConfig()`.
- Add a 1Password page or section in Settings using the existing `SettingsPanel` pattern, gated by `window.cloudCodeDesktop` like Terminal settings.
- Show `Unavailable`, `Not installed`, `Needs restart`, and `Error` states with effective extension id, configured paths, and reset controls.
- Keep persistence under the desktop instance root and out of cc-env, tRPC settings, and encrypted provider secrets.

**Tests**
- Unit: desktop runtime returns default `not-installed` status when no config or env overrides exist.
- Unit: desktop runtime reports env-sourced values without writing them into persisted config.
- Unit: reset removes persisted 1Password config and returns default status.
- Unit: Settings renders unavailable messaging when `window.cloudCodeDesktop` has no 1Password methods.
- E2E: desktop Settings page shows the 1Password section and a non-crashing status in a normal desktop test run.

**Maintainability**
- Keep config parsing, validation, and status formatting in a desktop module rather than embedding it in `main.ts`.
- Keep the Settings component thin; it should call desktop APIs and render state, not duplicate validation rules.
- Use shared TypeScript types for preload, IPC handlers, and renderer usage to avoid drift.
- Make the config file path a function of `InstanceRuntimeConfig.rootDir` so multi-worktree instances remain isolated.

**Depends on:** none

**Status:** done

## Task 2: Load A Manual Extension And Trigger It

Allow users and developers to point Kaivo at an unpacked local 1Password extension, restart the desktop app, and open the extension action for the active browser tab. This is the smallest useful end-to-end browser-extension slice.

**Steps**
- Add `saveOnePasswordConfig(input)` validation for absolute extension directory paths and manifest presence.
- At desktop startup, translate a valid enabled config into WebFrame `extensions` and `chromeExtensions` options in the existing `createApp(...)` call.
- Preserve WebFrame diagnostics from extension load failures and expose the latest load error in `OnePasswordStatus`.
- Add `triggerOnePassword(input?)` IPC/preload support that calls `webframeApp.extensions.triggerAction(...)` against the focused or supplied browser tab.
- Add Settings controls for manual extension path save, current status refresh, reset, and `Open/Test 1Password`.

**Tests**
- Unit: extension path validation rejects relative paths, missing directories, and directories without `manifest.json`.
- Unit: desktop startup option builder emits WebFrame `extensions` and `chromeExtensions` only for valid enabled config.
- Unit: trigger action returns a clear error when no browser tab is focused or supplied.
- E2E: with a fixture unpacked extension path supplied by env, desktop startup loads extension support and the Settings test action calls the trigger IPC without crashing.
- Human: point Kaivo at the known local 1Password extension directory and verify the 1Password popup opens for a focused browser pane.

**Maintainability**
- Do not make `main.ts` own extension validation; it should consume an already-resolved runtime result.
- Keep trigger-tab lookup aligned with existing browser focus tracking instead of introducing parallel focus state.
- Keep manual path handling generic enough for tests but pinned to the expected 1Password extension id and manifest checks.
- Avoid live WebFrame reconfiguration unless WebFrame exposes a safe API; report `Needs restart` for config changes that cannot apply safely.

**Depends on:** Task 1

**Status:** done

## Task 3: Wire Native Messaging Detection

Detect and validate the local 1Password native host manifest, then pass WebFrame native messaging options when available. This upgrades the extension from popup-only to local 1Password app integration.

**Steps**
- Add macOS native host manifest discovery for the Chrome native messaging host path.
- Validate manifest JSON, `stdio` type, absolute host executable path, and `allowed_origins` for `chrome-extension://<extensionId>/`.
- Allow manual native host manifest override through Settings and persisted config.
- Add WebFrame `nativeMessaging.hosts` startup options for both `com.1password.1password` and `com.1password.1password7` when validation succeeds.
- Show native host state and validation messages in Settings without disabling extension popup support when the native host is missing.

**Tests**
- Unit: native host validation accepts a valid fixture manifest with the pinned extension origin.
- Unit: native host validation rejects relative manifest paths, non-`stdio` manifests, relative executable paths, and missing allowed origin.
- Unit: WebFrame option builder registers both current and legacy host names for a valid manifest.
- E2E: with fixture extension and native host manifest env values, desktop startup exposes `ready` status in Settings.
- Human: in a signed or locally suitable desktop build, open 1Password and confirm the extension attempts app integration rather than only displaying a disconnected popup.

**Maintainability**
- Keep native host detection platform-specific behind a detector function so Windows/Linux paths can be added later without touching Settings.
- Keep validation messages actionable but avoid logging native messaging payloads or sensitive app data.
- Do not fail the whole extension load when native messaging is absent; model extension and native host status separately.
- Use fixture manifests in tests rather than depending on the developer's installed 1Password app.

**Depends on:** Task 2

**Status:** done

## Task 4: Install 1Password From A Pinned URL

Add the primary setup path: Settings downloads the pinned 1Password extension package, validates it, extracts it into the instance directory, and enables it. This removes the need for users to find browser profile extension folders.

**Steps**
- Implement `installOnePassword()` in the desktop runtime with a pinned Chrome Web Store update-service URL for extension id `aeblfdkhhhdcdjpifhhbdiojplfjncoa`.
- Support `KAIVO_1PASSWORD_DOWNLOAD_URL` only for tests and local debugging, and show when an override is active.
- Download into an instance-scoped temp directory, reject obvious HTML/error responses, unpack the CRX/package, and validate the extracted `manifest.json`.
- Move the validated extension to `<instance.rootDir>/extensions/1password/<version>/`, persist downloaded config, and clean failed temp installs without touching the previous working config.
- Add Settings `Install 1Password` / `Reinstall or update` controls with pending, success, retryable error, and restart-required states.

**Tests**
- Unit: installer uses the pinned extension id and rejects third-party or malformed download responses in fixture tests.
- Unit: failed download, failed unpack, and failed manifest validation preserve the previous persisted config.
- Unit: successful install writes downloaded config with extension version and instance-scoped path.
- E2E: using a local fixture download URL override, Settings install completes and status changes to installed or needs restart.
- Human: run install against the real pinned URL on macOS and confirm the extension is installed into the current Kaivo instance directory.

**Maintainability**
- Keep download, unpack, validation, and persistence as separate functions to make failure rollback testable.
- Do not introduce background auto-update yet; the same install path can serve manual reinstall/update.
- Keep all installed assets under the instance root to avoid cross-instance contamination.
- Avoid depending on browser profile directories or one developer's local paths in production code.

**Depends on:** Task 3

**Status:** done

## Task 5: Add Opt-In 1Password Smoke Verification

Add focused verification for extension loading and a manual checklist for real native messaging. This gives future implementers confidence without making normal CI depend on 1Password accounts or local app state.

**Steps**
- Add an opt-in desktop e2e spec that runs only when 1Password extension fixture/env variables are present.
- Exercise Settings status, browser pane focus, and `triggerOnePassword()` using fixture extension inputs.
- Capture useful WebFrame extension diagnostics in test failure output without logging native messaging payloads.
- Document the signed-app manual checklist for real 1Password native messaging and app integration.
- Add developer notes for supported env overrides and expected macOS native host manifest path.

**Tests**
- E2E: opt-in desktop smoke opens Settings, verifies ready or extension-installed status, focuses a browser pane, and triggers the extension action.
- E2E: opt-in native messaging fixture verifies both host aliases are registered in the desktop startup options or runtime diagnostics.
- Unit: diagnostics redaction omits native messaging payloads and user-specific secret values.
- Human: signed-app checklist confirms native messaging against the real local 1Password app.

**Maintainability**
- Keep opt-in tests skipped by default unless explicit env vars are set, so normal CI remains deterministic.
- Keep fixtures minimal and non-secret; never commit real 1Password extension packages or account data.
- Put docs beside the desktop test or in the existing desktop documentation location so setup instructions stay discoverable.
- Make failure output diagnostic enough for extension load issues without exposing local filesystem secrets beyond configured paths already visible in Settings.

**Depends on:** Task 4

**Status:** done
