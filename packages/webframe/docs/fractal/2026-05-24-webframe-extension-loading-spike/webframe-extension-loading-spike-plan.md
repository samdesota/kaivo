# WebFrame Extension Loading Spike Plan

## Task 1: Load a Fixture Extension

Add the smallest WebFrame extension-loading path and prove an unpacked MV3 fixture can affect a tab.

**Steps**
- Add `createApp({ extensions })` support that loads unpacked extension paths against the shared Electron `Session` before creating windows or tabs.
- Reject extension loading when the selected session cannot support Electron extension loading deterministically.
- Add a tiny unpacked MV3 fixture extension under the e2e/test fixtures that injects a content script and exposes a known resource.
- Wire the test app and Playwright fixture so e2e tests can launch with the fixture extension enabled.

**Tests**
- E2E: launch the test app with the fixture extension, open a tab, and assert the content script marked the page.
- E2E: navigate to a `chrome-extension://...` fixture resource and assert it loads.
- Unit: validate extension option handling rejects invalid paths or unsupported sessions without creating tabs.

**Maintainability**
- Keep extension loading in a small module called by `createApp`; do not spread Electron extension calls through tab/window managers.
- Keep fixture extension code intentionally tiny so test failures point at WebFrame, not fixture complexity.
- Avoid adding generalized extension-management UI or APIs before the spike proves the runtime path.

**Depends on:** none

**Status:** done

## Task 2: Observe Runtime Behavior

Add enough diagnostics to understand what Electron actually supports for loaded extensions during the spike.

**Steps**
- Record extension load results, IDs, names, and warnings through the existing logger.
- Add test-only debug access to loaded extension metadata and relevant service worker state when Electron exposes it.
- Add fixture extension coverage for `chrome.runtime.sendMessage`, `chrome.storage.local`, and a simple MV3 background service worker response.

**Tests**
- E2E: assert a tab can round-trip a message from content script to extension background code.
- E2E: assert extension storage can write and read a value during the app session.
- Unit: assert diagnostics include failed-load errors without swallowing the original Electron error.

**Maintainability**
- Keep debug hooks explicitly internal and unstable; do not commit to a public extension API from spike diagnostics.
- Prefer structured diagnostic records over parsing log strings in tests.
- Do not special-case the fixture extension by ID in production code.

**Depends on:** Task 1

**Status:** done

## Task 3: Prototype Native Messaging Shim

Prototype WebFrame-owned native messaging semantics with a local fake native host before touching 1Password.

**Steps**
- Define a minimal host manifest reader for Chrome native messaging manifests: `name`, absolute `path`, `type: "stdio"`, and `allowed_origins`.
- Add an extension-side bridge path for `sendNativeMessage`/`connectNative`-style calls that reaches Electron main and speaks the Chrome length-prefixed JSON stdio protocol.
- Enforce explicit allowlists by loaded extension ID and native host name before spawning any host process.
- Add a fake native host script for tests that echoes messages and emits a multi-message stream.

**Tests**
- E2E: fixture extension sends one native message to the fake host and receives the echoed response.
- E2E: fixture extension opens a native port, receives multiple responses, and disconnects cleanly.
- Unit: reject host manifests with relative paths, non-stdio type, missing allowed origin, or disallowed extension IDs.
- Unit: verify length-prefixed JSON framing handles partial reads and malformed frames.

**Maintainability**
- Keep process spawning and protocol framing isolated from extension option parsing.
- Make host allowlisting deny-by-default and test the denial paths first.
- Do not call the bridge production-ready; name and document it as experimental until tested with real extensions.
- Avoid hardcoding 1Password behavior into the generic native messaging shim.

**Depends on:** Task 2

**Status:** done

## Task 4: Probe 1Password Compatibility

Try to load the unpacked 1Password extension and, when local prerequisites exist, test whether the native messaging shim can reach the desktop host.

**Steps**
- Add a local-only configuration path for an unpacked 1Password extension directory; do not vendor the extension into the repo.
- Add a local-only configuration path for the `com.1password.1password` native host manifest; skip native messaging checks when absent.
- Launch WebFrame with the 1Password extension enabled and capture load warnings, service worker state, extension pages, and native messaging attempts.
- Document what works, what fails, and which unsupported Electron APIs or 1Password browser-trust checks block progress.

**Tests**
- E2E: local opt-in test loads the unpacked 1Password extension and records whether Electron reports it as loaded.
- E2E: local opt-in test attempts a native messaging call to `com.1password.1password` only when the host manifest exists.
- Human: verify any 1Password UI that appears can be opened and whether it requests browser/app trust.

**Maintainability**
- Keep 1Password tests opt-in and skipped by default so CI and normal development do not depend on local desktop state.
- Keep paths supplied through environment variables, not committed machine-specific config.
- Document compatibility findings in the spike folder instead of encoding assumptions as permanent code.
- Stop at evidence collection if 1Password requires browser signing/trust that WebFrame cannot satisfy during the spike.

**Depends on:** Task 3

**Status:** done
