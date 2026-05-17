# Kaivo Rename Migration

This document is the working plan for renaming the product from Zoottle / Cloud Code to Kaivo.

The rename should happen in phases so we can keep the app runnable after each step. The two most disruptive changes are intentionally late:

- `cc-env` is renamed near the end because it requires restarting terminal shells and local env services.
- The desktop app is renamed last because it requires moving macOS Application Support data to a new app identity path.

## Naming Map

| Current | Target | Notes |
| --- | --- | --- |
| `Zoottle` | `Kaivo` | User-facing product name. |
| `zoottle` | `kaivo` | Lowercase package/path/tool slug. |
| `@zoottle/*` | `@kaivo/*` | Internal npm package scope. |
| `cloud-code` | `kaivo` | Runtime/storage slug. |
| `Cloud Code` | `Kaivo` | Old product name in docs/UI. |
| `cloudcode` | `kaivo` | Compact legacy slug. |
| `CLOUDCODE_*` | `KAIVO_*` | Plugin/app bridge env vars. |
| `CC_*` | `KAIVO_*` | Runtime env vars. Use compatibility only where needed. |
| `.cloud-code` | `.kaivo` | Local dev runtime state. |
| `cc-env` | `kaivo-env` | Environment service, renamed late. |
| `cc-terminal-daemon` | `kaivo-terminal-daemon` | Terminal daemon, renamed with env service. |
| `zoottle-desktop` | `kaivo-desktop` | Desktop app identity, renamed last. |
| `Zoottle.app` | `Kaivo.app` | macOS desktop app bundle, renamed last. |

## General Rules

- Keep each phase small enough to verify independently.
- Prefer direct renames over long-term aliases unless existing persisted state or active sessions require a temporary fallback.
- Do not rename the desktop app identity until the final phase.
- Do not rename `cc-env` until the late service phase.
- After each phase, run at least `npm run typecheck` and the relevant focused tests. Run the full suite before the final desktop rename.
- Update tests in the same phase as the code they assert.

## Phase 1: Product Copy, Active Docs, And Tests

Goal: make the visible product name Kaivo without touching runtime identities.

Rename:

- UI strings: `Zoottle` / `Cloud Code` -> `Kaivo`.
- Active docs: `README.md`, `AGENTS.md`, operator notes, current non-archival docs.
- Browser fixture copy and test labels.
- Test fixture names that only represent user-visible copy.

Do not rename yet:

- `cc-env`.
- `CC_*` env vars.
- `.cloud-code` runtime state.
- `packages/zoottle-desktop` folder.
- `Zoottle.app` or `zoottle-desktop` app identity.

Verification:

- `npm run typecheck`
- Focused UI/unit tests for changed strings.

## Phase 2: Package Scope And Non-Desktop Package Names

Goal: move package identity to Kaivo while leaving desktop app identity alone.

Rename:

- Root package name: `zoottle` -> `kaivo`.
- `@zoottle/opencode-plugin` -> `@kaivo/opencode-plugin`.
- `@zoottle/env-server` -> `@kaivo/env-server`.
- Package lock references.
- Script comments and package descriptions.

Defer:

- `packages/zoottle-desktop` directory and `zoottle-desktop` package name unless it can be changed without moving macOS app support. Prefer deferring to the final desktop phase.

Verification:

- `npm install --package-lock-only` if package-lock changes are needed.
- `npm run typecheck`
- `npm run build:plugin`
- `npm run build:env-server`

## Phase 3: Agent Tool Names And Plugin Slug

Goal: make the agent-facing tool API Kaivo-branded.

Rename:

- `zoottle_bash` -> `kaivo_bash`.
- `zoottle_pty` -> `kaivo_pty`.
- `zoottle_pty_list` -> `kaivo_pty_list`.
- `zoottle_pty_write` -> `kaivo_pty_write`.
- `zoottle_pty_read` -> `kaivo_pty_read`.
- `zoottle_pty_close` -> `kaivo_pty_close`.
- `zoottle_open_pane` -> `kaivo_open_pane`.
- `zoottle_browser_*` -> `kaivo_browser_*`.
- `zoottle-opencode-plugin` -> `kaivo-opencode-plugin` where it is not tied to the old desktop app identity.
- `/opt/zoottle-opencode-plugin` -> `/opt/kaivo-opencode-plugin`.

Compatibility decision:

- Prefer no aliases for completed agent sessions unless we need active session continuity.
- If aliases are required, keep them for one phase only and remove them before the final rename.

Verification:

- `npm run build:plugin`
- Agent service tests.
- Plugin bootstrap tests.
- Live smoke with a simple `kaivo_bash` command if practical.

## Phase 4: Runtime Storage Prefixes And IPC Channels

Goal: move local runtime names from Cloud Code to Kaivo while avoiding desktop app support migration.

Rename:

- `.cloud-code` -> `.kaivo` for local dev runtime state.
- `cloud-code-browser-*` socket names -> `kaivo-browser-*`.
- `cloud-code-overlay-layer` -> `kaivo-overlay-layer`.
- IPC channels `cloud-code/*` -> `kaivo/*`.
- localStorage keys `cloud-code.*` -> `kaivo.*`.
- Metadata keys like `cloudcode_shell_id` -> `kaivo_shell_id`.

Compatibility:

- localStorage should read old keys once and write new keys so users keep UI state.
- Runtime state migration from `.cloud-code` to `.kaivo` can be manual for dev worktrees unless we decide otherwise.
- IPC does not need old-channel compatibility if preload and main process ship together.

Verification:

- `npm run typecheck`
- Workspace/sidebar/tab state tests.
- Desktop preload/main IPC tests.
- Local `npm run dev:web` smoke.

## Phase 5: Environment Variable Rename

Goal: rename process configuration to `KAIVO_*` while preserving temporary compatibility for developer machines and scripts.

Rename:

- `CC_*` -> `KAIVO_*`.
- `CLOUDCODE_AGENT_TOKEN` -> `KAIVO_AGENT_TOKEN`.
- `CLOUDCODE_APP_URL` -> `KAIVO_APP_URL`.
- Script arguments, env docs, test setup, Vite config, server config, desktop supervisor env.

Compatibility:

- New `KAIVO_*` values take precedence.
- Old `CC_*` / `CLOUDCODE_*` values can be fallback aliases during this migration.
- Remove fallback aliases after the desktop rename is stable unless there is a concrete external integration using them.

Verification:

- `npm run typecheck`
- Config/env unit tests.
- Local launcher tests.
- Desktop supervisor tests.

## Phase 6: Docker, Legacy Sandbox, And Hosted Names

Goal: rename legacy infrastructure references after core local runtime is Kaivo-branded.

Rename:

- Compose project `cloud-code` -> `kaivo`.
- Docker image `cloud-code-sandbox:dev` -> `kaivo-sandbox:dev`.
- Docker network `cloud-code-net` -> `kaivo-net`.
- Docker label `cloud-code.env` -> `kaivo.env`.
- Postgres defaults `cloudcode` -> `kaivo` where they are only dev/legacy defaults.
- Caddy/domain docs once target domains are known.

Needs decision:

- Replacement domains for `code.438d.xyz`, `llm.438d.xyz`, and `*.preview.438d.xyz`.

Verification:

- Env config tests.
- Legacy Docker tests if still maintained.
- No default local desktop path should depend on Docker.

## Phase 7: Rename `cc-env` To `kaivo-env`

Goal: rename the environment service immediately before the final desktop app rename.

This is disruptive because terminal shells and env services must restart.

Preparation:

- Stop active dev servers and terminal shells that depend on `cc-env`.
- Confirm no long-running agent session depends on the old tool/service names.
- Capture current launch manifest paths before changing names.

Rename:

- Binary `cc-env` -> `kaivo-env`.
- Binary `cc-terminal-daemon` -> `kaivo-terminal-daemon`.
- User state path `~/.local/share/cc-env` -> `~/.local/share/kaivo-env`.
- Container/runtime path `/var/lib/cc-env` -> `/var/lib/kaivo-env`.
- Logs `cc-env.log` -> `kaivo-env.log`.
- LaunchAgent `com.cloudcode.env` -> `com.kaivo.env`.
- systemd user service `cc-env.service` -> `kaivo-env.service`.
- UI and docs references to the env service.
- Package scripts and install scripts.

Manual migration checkpoint:

- Move or copy existing env service state only after stopping old services.
- Restart terminal daemon and env services after the rename.

Verification:

- `npm run build:env-server`
- Env server tests.
- Local launcher can start app plus `kaivo-env`.
- New terminal shell opens and survives normal app reloads.

## Phase 8: Desktop App Rename Last

Goal: rename the macOS desktop app identity and bundle after all other names are Kaivo.

Preparation:

- Quit the old desktop app.
- Stop desktop-managed services.
- Move/copy app support data from the old app identity to the new one.

Rename:

- `Zoottle.app` -> `Kaivo.app`.
- `zoottle-desktop` -> `kaivo-desktop`.
- `packages/zoottle-desktop` -> `packages/kaivo-desktop`.
- `~/Library/Application Support/zoottle-desktop` -> `~/Library/Application Support/kaivo-desktop`.
- `/Applications/Zoottle.app` -> `/Applications/Kaivo.app`.
- Release dir `Zoottle-darwin-arm64` -> `Kaivo-darwin-arm64`.
- Packager scripts, desktop tests, backup paths, docs.

Manual migration checkpoint:

- Copy/move macOS Application Support data before launching the renamed desktop app.
- Keep a backup of the old support directory until the new app has launched and paired successfully.

Verification:

- `npm run typecheck`
- `npm run build`
- `npm run build:desktop`
- `npm run test:e2e:desktop:app`
- Launch `Kaivo.app` and verify it finds the migrated app DB, env DB, logs, and workspaces.

## Final Cleanup

After all phases are stable:

- Remove temporary compatibility aliases for old env vars and tool names.
- Remove old migration-only docs or mark them as historical.
- Search for leftover `Zoottle`, `zoottle`, `Cloud Code`, `cloud-code`, `cloudcode`, `CLOUDCODE`, `CC_`, and `cc-env` references.
- Keep references only where they describe historical migration behavior or archived plans.

Final verification:

```bash
npm run typecheck
npm test
npm run build
npm run build:desktop
npm run test:e2e:desktop:app
```
