# 1Password Compatibility Probe

Task 4 is local-only because the 1Password extension package, desktop app, and native host manifest are machine state. Nothing from 1Password is vendored into this repository.

## Opt-In E2E

Set these variables before running the probe:

```bash
WEBFRAME_1PASSWORD_EXTENSION_PATH=/absolute/path/to/unpacked/1password-extension \
WEBFRAME_1PASSWORD_NATIVE_HOST_MANIFEST=/absolute/path/to/com.1password.1password.json \
npx playwright test e2e/onepassword.spec.ts
```

`WEBFRAME_1PASSWORD_NATIVE_HOST_MANIFEST` is optional. When absent, the native messaging test is skipped. `WEBFRAME_1PASSWORD_EXTENSION_ID` defaults to Chrome's public 1Password extension ID, `aeblfdkhhhdcdjpifhhbdiojplfjncoa`, and can be overridden for a locally repacked extension.

The tests print structured probe output containing:

- loaded extension metadata from `wf._debug.extensions`
- extension diagnostics from `wf._debug.extensionDiagnostics()`
- any currently open `chrome-extension://` web contents
- confirmation that the service-worker native messaging preload ran when the host manifest is configured

## Current Evidence

Automated default verification on 2026-05-25 proved the opt-in path is skipped safely when local 1Password state is absent: `npx playwright test e2e/onepassword.spec.ts` reported both tests skipped.

Local probe on 2026-05-25 used:

- extension: `/Users/sam/Library/Application Support/Vivaldi/Default/Extensions/aeblfdkhhhdcdjpifhhbdiojplfjncoa/8.12.21.1_0`
- native host manifest: `/Users/sam/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.1password.1password.json`
- extension ID: `aeblfdkhhhdcdjpifhhbdiojplfjncoa`

Results:

- Electron loaded the unpacked extension as `1Password – Password Manager`.
- Electron emitted `extension-loaded` and `extension-ready` diagnostics for the 1Password extension.
- Opening `chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup/index.html` succeeded enough to report title `1Password`, but body text was empty.
- After opening the popup, diagnostics showed the MV3 service worker running with scope `chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/`.
- Service worker console output included startup logs and then `Uncaught TypeError: Cannot read properties of undefined (reading 'onClicked')` in `background/background.js`, indicating Electron is missing at least one Chrome extension API shape that 1Password expects.
- After implementing the service-worker preload native messaging API, the native messaging probe showed `[webframe] extension service worker preload starting` and `[webframe] extension service worker native messaging API installed` before 1Password background startup logs.
- The previous page-preload synthetic native messaging probe has been removed; native messaging is now exposed as `chrome.runtime.sendNativeMessage` and `chrome.runtime.connectNative` in extension service workers.
- WebFrame now exposes `wf.extensions.triggerAction(extensionId, { tabId })`, backed by `chrome.action.onClicked`/`browser.action.onClicked` dispatch in the extension service worker.
- 1Password moved past the previous `onClicked` failure after adding action and notification event support.
- WebFrame now has opt-in `electron-chrome-extensions` integration via `chromeExtensions: { enabled: true, license: 'GPL-3.0' }` / `WEBFRAME_CHROME_EXTENSIONS`. It is enabled for the 1Password probe and left disabled for the baseline fixture tests because the package's frame preload conflicts with Electron's built-in content-script runtime messaging path.
- The package moved 1Password past the previous `webNavigation.onDOMContentLoaded` failure.
- Additional compatibility shims fill Chrome constants/events not covered by the package in this path: `chrome.windows.WINDOW_ID_NONE`, `chrome.windows.WINDOW_ID_CURRENT`, and no-op `chrome.commands.onCommand`/`chrome.commands.getAll`.
- The latest local probe showed 1Password background initialization progressing through storage, context menu setup, WASM initialization, database upgrade, and `OPDatabaseInitialized` without a captured uncaught TypeError. The popup still opened with title `1Password` and empty body text.
- The native messaging bridge now reaches the 1Password helper through `chrome.runtime.connectNative('com.1password.1password')`. WebFrame passes the extension origin argv and aliases `com.1password.1password7` to the same local manifest because no separate `1password7` manifest exists on this machine.
- The latest BrowserSupport log shows the helper rejecting Electron before any app pairing: it verifies `/Users/sam/d/webframe/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, fails to read a code signature, reports `parent browser was not valid`, and exits with `UnsupportedBrowser` / `Browser process validation failed`.

Conclusion: WebFrame can load the unpacked 1Password extension, run service-worker preloads before its background code, install real-shaped native messaging methods into `chrome.runtime`/`browser.runtime`, dispatch extension action clicks through WebFrame, and use `electron-chrome-extensions` to supply the broader browser API surface needed past `webNavigation`. The current blocker is 1Password's macOS BrowserSupport verification rejecting the unsigned Electron runtime as an unsupported browser; this is outside the native messaging framing/allowlist path.

Expected blockers to record during a local run:

- Electron may load the extension but still omit Chrome runtime APIs that 1Password expects.
- Electron and `electron-chrome-extensions` may still omit Chrome extension APIs that 1Password expects after background initialization.
- The 1Password desktop app may reject WebFrame until browser trust, signing, or installation-location requirements are satisfied.
- The native host manifest must include the loaded extension origin in `allowed_origins`, or WebFrame's deny-by-default shim will reject the host before spawning it.

## Human Check

After a local run that loads the extension, inspect any opened 1Password extension UI and record whether it opens, requests browser trust, prompts for desktop-app pairing, or fails before UI appears.

## Interactive Harness

Run:

```bash
npm run test:1password:interactive
```

The harness builds WebFrame and the test app, launches Electron visibly, loads the local unpacked 1Password extension, enables `electron-chrome-extensions`, configures the 1Password native host manifest, opens a normal test page, triggers the 1Password action handler, and opens `chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup/index.html` in a WebFrame tab.

Defaults can be overridden with:

- `WEBFRAME_1PASSWORD_EXTENSION_PATH`
- `WEBFRAME_1PASSWORD_NATIVE_HOST_MANIFEST`
- `WEBFRAME_1PASSWORD_EXTENSION_ID`
- `WEBFRAME_ELECTRON_APP=/Applications/Kaivo.app` to launch the harness through a candidate Electron `.app` executable instead of `node_modules/.bin/electron`
- `WEBFRAME_INTERACTIVE_START_URL`
- `WEBFRAME_OPEN_1PASSWORD_POPUP=0`
- `WEBFRAME_TRIGGER_1PASSWORD_ACTION=0`
- `WEBFRAME_LOG`

Default log path: `/tmp/webframe-1password-interactive.log`.

## macOS Signing Harness

Build a throwaway signed browser app for 1Password allow-list testing:

```bash
npm run test:1password:build-signed-browser
```

Default output:

```text
/Applications/WebFrame 1Password Test.app
```

The builder copies Electron's app bundle, rewrites the main bundle ID to `dev.webframe.onepassword-test-browser`, gives each Electron helper a distinct bundle ID, signs the full bundle, and installs it under `/Applications`. It automatically prefers a `Developer ID Application` identity when available; otherwise it falls back to `Apple Development`. Override with `WEBFRAME_SIGN_IDENTITY`, `WEBFRAME_TEST_BROWSER_BUNDLE_ID`, `WEBFRAME_TEST_BROWSER_NAME`, or `WEBFRAME_TEST_BROWSER_INSTALL_PATH`.

Run:

```bash
npm run test:1password:signing -- /Applications/Kaivo.app
```

The harness checks the app bundle shape that 1Password's BrowserSupport validation depends on: `/Applications` location, `Info.plist` identity, `codesign --verify --deep --strict`, `spctl --assess`, app signature authority, TeamIdentifier, and Electron helper app bundle identifiers/signatures.

Current `/Applications/Kaivo.app` result:

- `Signature=adhoc`
- `TeamIdentifier=not set`
- `spctl --assess --type execute` rejects the app
- all Electron helper apps are also ad-hoc signed
- all helper apps reuse `com.electron.kaivo.helper`, instead of distinct helper IDs like `.helper`, `.helper.Renderer`, `.helper.GPU`, and `.helper.Plugin`

This matches the 1Password BrowserSupport failure: the native host reaches browser verification, then rejects the parent browser with `UnsupportedBrowser` / `Browser process validation failed`. A candidate build should use a stable non-placeholder app bundle ID, distinct helper bundle IDs, a Developer ID Application signature with a TeamIdentifier, and pass Gatekeeper assessment before expecting 1Password to accept it as an additional browser.

Current `/Applications/WebFrame 1Password Test.app` result:

- signed by `Developer ID Application: Samuel DeSota (U33G93KH8Y)`
- `TeamIdentifier=U33G93KH8Y`
- stable app bundle ID: `dev.webframe.onepassword-test-browser`
- distinct helper bundle IDs: `.helper`, `.helper.Renderer`, `.helper.GPU`, `.helper.Plugin`
- `codesign --verify --deep --strict` passes
- `spctl --assess --type execute` reports `Unnotarized Developer ID`, but 1Password accepts the app in the additional-browser allow list after adding it manually

Use this app path in 1Password Settings > Browser > Add Browser. The app must keep the same bundle ID, app path, signing team, user data directory, and session partition across runs, otherwise 1Password treats it as a different/unstable browser.

The interactive harness now sets stable browser identity state:

- app name: `WebFrame 1Password Test`
- user data directory: `~/Library/Application Support/WebFrame 1Password Test`
- session partition: `persist:webframe-1password-interactive`
- launch path: macOS LaunchServices via `open -n -W /Applications/WebFrame 1Password Test.app ...`

Run the opt-in 1Password E2E through the signed test app:

```bash
WEBFRAME_ELECTRON_APP="/Applications/WebFrame 1Password Test.app" \
WEBFRAME_1PASSWORD_EXTENSION_PATH="/Users/sam/Library/Application Support/Vivaldi/Default/Extensions/aeblfdkhhhdcdjpifhhbdiojplfjncoa/8.12.21.1_0" \
WEBFRAME_1PASSWORD_NATIVE_HOST_MANIFEST="/Users/sam/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.1password.1password.json" \
npx playwright test e2e/onepassword.spec.ts
```

Current signed-app E2E result after adding the test app to 1Password's additional-browser allow list:

- Playwright launches the test app executable from `/Applications/WebFrame 1Password Test.app` via `WEBFRAME_ELECTRON_APP`.
- 1Password BrowserSupport verifies `/Applications/WebFrame 1Password Test.app/Contents/MacOS/WebFrame 1Password Test`; the previous unsigned-Electron `UnsupportedBrowser` log is gone.
- The extension initializes, attempts desktop integration, sends `NmRequestAccounts`, then receives `BrowserVerificationFailed` from native core and leaves the popup at `Loading...`.
- BrowserSupport currently logs `waiting for potential partner browser authorization from B5X`, so the remaining failure is past process signature/path validation and inside the 1Password native-core/browser authorization handshake.

Current signed interactive result after rebuilding with Developer ID and stable profile identity:

- BrowserSupport verifies `/Applications/WebFrame 1Password Test.app/Contents/MacOS/WebFrame 1Password Test`.
- BrowserSupport starts SLS communication with the desktop app.
- BrowserSupport logs `Code signature team id of client == ourselves: true`.
- BrowserSupport connects to `2BUA8C4S2C.com.1password.browser-helper` and logs `Connected to BrowserHelper`.
- User confirmed the interactive 1Password integration is working.
