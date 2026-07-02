# Kaivo 1Password Support Spec

## Seed

Bring 1Password browser extension support into Kaivo's Electron desktop browser panes by enabling WebFrame's Chrome extension runtime and native messaging bridge for the 1Password extension.

The WebFrame POC proves that an unpacked 1Password extension can load, open its popup, trigger its browser action, and attempt native messaging to the local 1Password app. Kaivo should turn that into a user-facing desktop capability without weakening extension isolation, leaking secrets, or hard-coding one developer's local paths.

## Solution

- Integration point: Kaivo desktop passes WebFrame extension options into its existing `createApp` call; 1Password support requires WebFrame 0.1.12 or newer.
- Scope: 1Password support is desktop-only; browser-only Kaivo does not emulate extension support.
- Extension source: install or load an unpacked local 1Password extension directory; Settings can download it from a pinned known URL, while manual path override remains available.
- Native messaging: register the local 1Password native host manifest for the loaded extension id, including the `com.1password.1password7` alias.
- Runtime API: expose a Kaivo desktop-side action that triggers the 1Password extension action for the active browser tab.
- UI surface: add a desktop settings surface showing detected 1Password status, install/download, manual path overrides, and a test/open action.
- Persistence: store user-selected extension and native-host paths in desktop-local instance config, not in cc-env or app secret records.
- Security boundary: Kaivo never reads vault secrets; it only hosts the extension and native messaging channel allowed by the native host manifest.
- Verification: keep automated WebFrame-style extension smoke tests opt-in, with a manual signed-app checklist for real 1Password native messaging.

## Spec

Kaivo desktop should treat 1Password as an optional local browser capability. The app loads the 1Password Chrome extension into the existing WebFrame browser-tab session, wires WebFrame's native messaging bridge to the local 1Password app, and exposes setup and diagnostics in Settings. Browser-only Kaivo should show that the feature is unavailable rather than attempting to mimic Electron extension support.

### User Experience

The Settings app gains a desktop-only 1Password section. It should make the current state obvious without requiring users to know about Chrome extension directories or native messaging manifests.

The section displays these states:

- `Unavailable`: Kaivo is running outside the desktop app, or the desktop preload API is absent.
- `Not installed`: no usable extension path is configured or discovered.
- `Extension installed`: the extension is present and loadable, but no valid native host manifest is detected.
- `Ready`: extension path, extension id, and native host manifest are valid and the desktop runtime has loaded WebFrame extension support.
- `Needs restart`: settings changed in a way that requires recreating the WebFrame app/session before the extension can load.
- `Error`: the latest install, validation, or runtime load failed with a user-readable message.

The primary setup path is `Install 1Password`. This downloads the extension from a pinned Chrome Web Store update URL for extension id `aeblfdkhhhdcdjpifhhbdiojplfjncoa`, verifies the downloaded package, extracts it into the current Kaivo instance directory, saves the resulting extension path, and reports whether restart is required. The UI should link to the first-party 1Password browser extension page for context, but downloads must not use third-party CRX mirror sites.

Manual setup remains available for users who already have an unpacked browser extension. The UI accepts an absolute extension directory path and an optional absolute native-host manifest path. Manual values are persisted only after validation. The UI should show the effective values, whether they came from install, discovery, manual override, or environment override, and offer a clear action to reset local overrides.

The section includes a `Test 1Password` or `Open 1Password` action. When the extension is loaded, this calls the desktop runtime action that triggers the 1Password browser action for the active Kaivo browser tab. If there is no active browser tab, the action reports that a browser pane must be focused first. If native messaging is missing, the action may still open the popup, but the UI should state that app integration may not work.

### Runtime Shape

Kaivo desktop owns a small 1Password runtime service. It resolves persisted config, validates local files, downloads and extracts the extension, translates state into WebFrame options, and exposes IPC methods to the renderer. The service should not depend on cc-env, tRPC app settings, agent provider secrets, or workspace data.

The service has three inputs:

- Instance runtime paths from `InstanceRuntimeConfig`, especially `rootDir`.
- Environment overrides for local development and debugging.
- A desktop-local JSON config file under the instance root.

The effective config is evaluated at app startup before `createApp(...)` is called. If 1Password is enabled and validation succeeds, Kaivo passes WebFrame these options:

```ts
{
  extensions: [
    { path: effective.extensionPath, allowFileAccess: true },
  ],
  chromeExtensions: {
    enabled: true,
    license: 'GPL-3.0',
  },
  nativeMessaging: effective.nativeHostManifestPath
    ? {
        hosts: [
          {
            manifestPath: effective.nativeHostManifestPath,
            extensionId: effective.extensionId,
            hostName: 'com.1password.1password',
          },
          {
            manifestPath: effective.nativeHostManifestPath,
            extensionId: effective.extensionId,
            hostName: 'com.1password.1password7',
          },
        ],
      }
    : undefined,
}
```

The implementation may adapt this object to WebFrame's exact exported types, but the behavior is fixed: enable the Chrome extension runtime only when a validated 1Password extension should be loaded, load exactly the configured extension directory, and register both current and legacy 1Password native host names against the same extension id.

### Desktop Config Contract

Persisted desktop-local config should be explicit and boring. It should live under the instance root, for example `<instance.rootDir>/desktop-1password.json`, with permissions appropriate for local app config. It does not contain secrets.

```ts
type OnePasswordInstallSource = 'downloaded' | 'manual'

type OnePasswordDesktopConfig = {
  enabled: boolean
  extensionId: string
  extensionPath?: string
  extensionSource?: OnePasswordInstallSource
  nativeHostManifestPath?: string
  updatedAt: string
}
```

Default values:

- `enabled`: `false` until the user installs or saves a manual extension path.
- `extensionId`: `aeblfdkhhhdcdjpifhhbdiojplfjncoa`.
- `extensionPath`: omitted unless downloaded, discovered, manually configured, or supplied by env.
- `nativeHostManifestPath`: omitted unless discovered, manually configured, or supplied by env.

Environment overrides are allowed for development and test automation. They should be reflected in status as overrides and should not silently overwrite the JSON config:

- `KAIVO_1PASSWORD_EXTENSION_PATH`
- `KAIVO_1PASSWORD_NATIVE_HOST_MANIFEST`
- `KAIVO_1PASSWORD_EXTENSION_ID`
- `KAIVO_1PASSWORD_DOWNLOAD_URL`

The download URL override is for local testing only. Normal builds use the pinned Chrome Web Store update endpoint for the pinned extension id.

### Download And Install Contract

The installer downloads the Chrome extension package from a pinned, first-party/Chrome Web Store infrastructure URL derived from the extension id. The expected source is the Chrome extension update service, using a redirect response for extension id `aeblfdkhhhdcdjpifhhbdiojplfjncoa`. The installer must not depend on a developer's browser profile path or a third-party CRX index.

After download, Kaivo validates before persisting:

- The response is a Chrome extension package, not an HTML error page.
- The package can be unpacked into a temporary directory under the instance root.
- The unpacked manifest exists and has the expected extension identity/name for 1Password.
- The manifest version is recorded for display.
- The final installed directory is instance-scoped, for example `<instance.rootDir>/extensions/1password/<version>/`.
- Failed installs leave the previous working config untouched and remove temporary files.

The installer should keep one active installed version and may keep the previous version only long enough to support rollback after a failed extraction or validation. Future update automation is out of scope; Settings can expose reinstall/update by running the same install flow again.

### Native Messaging Detection

Kaivo should automatically detect the local 1Password native host manifest when possible, then allow manual override when detection fails. On macOS, the first expected path is the Chrome native messaging host location used by the WebFrame POC:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.1password.1password.json
```

Validation requires:

- The manifest path is absolute.
- The manifest JSON parses.
- `type` is `stdio`.
- `path` points to an absolute native host executable.
- `allowed_origins` contains the effective extension origin, `chrome-extension://<extensionId>/`.

If the manifest is valid but only names the current host, Kaivo still registers the WebFrame alias `com.1password.1password7` against the same manifest so extension code that uses the legacy name can connect. If the manifest is absent or invalid, the extension can still load, but status must make clear that native app integration is not ready.

### IPC And Renderer API

The renderer communicates with 1Password support through `window.cloudCodeDesktop`. These methods are desktop-only and return structured values rather than throwing raw Electron errors across the UI boundary.

```ts
type OnePasswordStatus = {
  available: boolean
  state: 'unavailable' | 'not-installed' | 'extension-installed' | 'ready' | 'needs-restart' | 'error'
  enabled: boolean
  extensionId: string
  extensionPath?: string
  extensionVersion?: string
  extensionSource?: 'downloaded' | 'manual' | 'env' | 'discovered'
  nativeHostManifestPath?: string
  nativeHostState: 'missing' | 'valid' | 'invalid'
  nativeHostMessage?: string
  requiresRestart: boolean
  error?: string
}

type OnePasswordManualConfigInput = {
  extensionPath: string
  nativeHostManifestPath?: string
}

type OnePasswordInstallResult = {
  status: OnePasswordStatus
}

type OnePasswordTriggerInput = {
  browserTabId?: string
}
```

Required desktop API surface:

- `getOnePasswordStatus(): Promise<OnePasswordStatus>`
- `installOnePassword(): Promise<OnePasswordInstallResult>`
- `saveOnePasswordConfig(input: OnePasswordManualConfigInput): Promise<OnePasswordStatus>`
- `resetOnePasswordConfig(): Promise<OnePasswordStatus>`
- `triggerOnePassword(input?: OnePasswordTriggerInput): Promise<{ ok: true }>`

The settings UI may call these methods directly as the existing terminal settings section does. If this API grows beyond the settings page, shared typing should move into the existing browser/desktop API typing layer rather than duplicating ad hoc window types.

### Browser Action Behavior

The trigger action must target the active WebFrame tab when possible. Kaivo already tracks browser tab focus owners and tab webContents for desktop browser features; 1Password should use the same active-tab source instead of inventing a separate notion of focus.

Expected outcomes:

- With a focused browser pane and loaded extension, 1Password popup opens for that tab.
- With no focused browser pane, the call returns a clear error for the UI.
- With extension support disabled or failed to load, the call returns a clear error and does not create a fake popup.
- With native messaging missing, the popup may open, but the extension may show its own app-connection error.

### Security Boundaries

Kaivo's responsibility is hosting the extension runtime, not brokering or reading secrets.

- Do not read, parse, log, or store 1Password vault items.
- Do not store 1Password account identifiers, vault metadata, auth tokens, or native messaging payloads.
- Do not log full native messaging payloads, downloaded package contents, or user-entered secret-like values.
- Do not allow arbitrary extension installation through this UI; the download path is pinned to the 1Password extension id, and manual paths are local absolute directories only.
- Do not add extension support to cc-env or browser-only mode.
- Do not render setup dialogs as in-app modals under browser panes; any blocking picker/confirmation must use the detached overlay layer.

### Failure Cases

The user should always be able to recover from a broken setup from Settings.

- Download offline or blocked: keep current config, show retryable error.
- Download returns an unexpected file: delete temp files, show validation error.
- Unpack succeeds but manifest validation fails: delete temp files, do not enable.
- Config path no longer exists: show `Not installed` or `Error` with reset/manual options.
- Native host manifest disappears: keep extension enabled, mark native host missing.
- Native host manifest does not allow the extension id: mark native host invalid and show the expected origin.
- WebFrame extension load fails at startup: Settings shows runtime load error and keeps reset/reinstall available.
- Settings changed after WebFrame startup: report `Needs restart` when live reload is not safe.

### Dependencies And Constraints

Kaivo already uses `@samdesota/webframe` `^0.1.11`, which contains the needed extension, Chrome runtime, trigger action, and native messaging hooks. No new default workflow should require Docker, Postgres, fixed cc-env ports, or remote orchestrator infrastructure.

The feature depends on Electron desktop behavior and a persistent WebFrame session. It is expected to work first on macOS, matching the local 1Password app and native host manifest paths from the POC. The design should not hard-code one developer's username or browser profile. Windows/Linux detection can be added later by extending the detector without changing the user-facing contract.

Real native messaging may be sensitive to app signing and bundle identity. Automated tests should prove Kaivo passes the right WebFrame options and can load/open the extension in opt-in environments; a signed-app manual checklist remains required for end-to-end 1Password app integration.

### Flow

```text
Settings UI
  -> window.cloudCodeDesktop.installOnePassword()
  -> desktop 1Password runtime
  -> Chrome Web Store update URL
  -> instance temp dir
  -> validate and extract manifest
  -> instance extensions dir + desktop config
  -> status: needs restart or ready

Desktop startup
  -> resolve desktop config + env overrides
  -> validate extension dir and native host manifest
  -> create WebFrame app with extensions/chromeExtensions/nativeMessaging
  -> browser action API can trigger 1Password for the active tab
```
