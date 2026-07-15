# WebFrame Extension Loading Spike Spec

## Seed

Spike WebFrame extension loading by first proving a basic browser extension can load and run, then testing whether the 1Password extension can load with enough native-messaging support to understand the required runtime surface.

## Solution

- Extension loading: add a session-level extension manager behind `createApp({ extensions })`, using Electron `Session.extensions.loadExtension` before tabs/windows are created.
- Test target: prove support with an unpacked MV3 fixture extension that exercises content scripts, runtime messaging, storage, and extension resource URLs.
- Session model: require persistent Electron sessions for extension-enabled runs; reject memory/custom sessions that cannot support `loadExtension` deterministically.
- Observability: surface loaded extension metadata and load/runtime diagnostics through logs and test-only debug hooks.
- Native messaging: implement an experimental WebFrame-owned bridge for `chrome.runtime.connectNative`/`sendNativeMessage` semantics instead of assuming Electron supports them.
- Native host policy: launch stdio hosts only from explicit host manifests and allowlists keyed by extension ID and native host name.
- 1Password spike: load the unpacked 1Password extension as a compatibility probe, then test native messaging against `com.1password.1password` only when the local host manifest and browser trust prerequisites are present.
