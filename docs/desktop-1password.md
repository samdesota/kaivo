# Desktop 1Password Support

Kaivo desktop can host the 1Password Chrome extension in WebFrame browser panes. Kaivo does not read vault data; it only loads the extension and, when configured, registers the native messaging host manifest for the local 1Password app.

## Developer Overrides

- `KAIVO_1PASSWORD_EXTENSION_PATH`: absolute path to an unpacked 1Password extension directory.
- `KAIVO_1PASSWORD_NATIVE_HOST_MANIFEST`: absolute path to `com.1password.1password.json`.
- `KAIVO_1PASSWORD_EXTENSION_ID`: defaults to `aeblfdkhhhdcdjpifhhbdiojplfjncoa`.
- `KAIVO_1PASSWORD_DOWNLOAD_URL`: test/debug-only package URL override for Settings install.

On macOS, Kaivo auto-detects the native host manifest at:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.1password.1password.json
```

## Opt-In Smoke Test

Run after building desktop:

```bash
KAIVO_1PASSWORD_EXTENSION_PATH="/absolute/path/to/unpacked/extension" \
KAIVO_1PASSWORD_NATIVE_HOST_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.1password.1password.json" \
npx playwright test -c playwright.desktop.config.ts tests/desktop/onepassword-live.spec.ts
```

The smoke test is skipped unless `KAIVO_1PASSWORD_EXTENSION_PATH` is set.

## Manual Signed-App Checklist

- Build or install a signed Kaivo desktop app.
- Open Settings -> 1Password.
- Install 1Password or save the unpacked extension path.
- Confirm status is `ready` when the native host manifest is present, or `extension-installed` when only the extension is configured.
- Open a browser pane, focus it, and use `Open/Test 1Password`.
- Confirm the 1Password popup opens and the extension attempts to connect to the local 1Password app.
- Check desktop logs for extension load errors, without expecting native messaging payloads or vault data to be logged.
