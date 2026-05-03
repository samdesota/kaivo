# Worktree-Ready Browser Dev Spec

## Seed

Make this repo worktree-ready for local development: multiple checkouts should run their app, identity, and env services on the same machine without colliding.

Browser-based development should work well enough to open a worktree, launch its local server in the app's browser pane, and test against seeded LLM credentials, while desktop-only browser-pane features remain unavailable in plain browser mode.

## Solution

- Isolation: every worktree gets a deterministic local instance id, root, SQLite app DB, env DB, logs, and workspaces directory.
- Ports: a local launch script finds free ports for every service and retries until the full service set has non-conflicting ports.
- Runtime manifest: launch writes a gitignored config file listing every local server, URL, port, health endpoint, and log file.
- Services: desktop-managed app/identity server and cc-env remain the default; browser-only development uses the app server and pairs to an externally running local cc-env.
- Pairing: app and cc-env must verify the same instance id before exchanging or accepting local service credentials.
- Browser mode: the app must load in a normal browser with explicit degraded behavior for desktop-only browser panes and native webframe features.
- Launch flow: worktree servers are started from the app shell/agent path, then opened by URL in a browser pane when native panes are available.
- Seed data: local launch seeds only the app-side identity/admin state and encrypted LLM provider credentials needed for agent runs.
- Credential flow: cc-env never stores provider secrets; it resolves provider environment variables from the app/identity server at agent runtime.

## Spec

### Scope

Worktree readiness covers local development from multiple checkouts on one machine. The app/identity server, cc-env, client dev server, SQLite data, logs, and workspace files for one checkout must not collide with another checkout.

The identity server is the existing app server process. The env server is the existing `cc-env` process.

### Local Runtime Model

Each worktree has a local instance derived from the worktree path unless explicitly overridden.

Required per-instance values:

- `CC_INSTANCE_ID`: stable id for the worktree, defaulting to the existing `dev-<hash(cwd)>` form.
- `CC_INSTANCE_ROOT`: `.cloud-code/instances/<CC_INSTANCE_ID>` under the worktree by default.
- App DB: `<CC_INSTANCE_ROOT>/app/app.db`.
- Env DB/state: `<CC_INSTANCE_ROOT>/env-state/env.db`.
- Logs: `<CC_INSTANCE_ROOT>/logs/app.log`, `<CC_INSTANCE_ROOT>/logs/cc-env.log`, plus client/dev-launch logs when captured.
- Env workspaces: `<CC_INSTANCE_ROOT>/workspaces` for dev-managed local runs.

The runtime must keep supporting explicit overrides for instance id, root, app port, env port, app URL, env URL, app data dir, app SQLite path, env state dir, env working dir, and log paths.

### Launch Script

A local launch script owns worktree-ready dev startup. It must be the common entry point behind browser-mode development and may also be used by desktop-managed development.

The script launches these services as one local set:

- App/identity server.
- cc-env.
- Client dev server for browser access.

The script must allocate free ports for every network service before launch:

- App/identity API port, exported as `CC_APP_PORT` and reflected in `CC_APP_URL`.
- cc-env API port, exported as `CC_ENV_PORT` and reflected in `CC_ENV_URL`.
- Client dev server port, exported to Vite and reflected in the URL opened by the user or desktop shell.

Port allocation must not depend on fixed ports such as `3000`, `47821`, or `5180`. Preferred deterministic ranges are acceptable only as starting points. The script must retry until it has a complete set of non-conflicting ports.

Because port probing can race, successful probing is not sufficient. After starting children, the script must verify each service by health check or startup success. If any service fails to bind, reports `EADDRINUSE`, or returns a mismatched instance id, the script must stop the whole local set, choose a fresh full port set, update the manifest, and retry. A retry limit may exist, but the failure must name the exhausted service and attempted ports.

The script must emit the resolved runtime values in a machine-readable form for child processes and debugging. The data must include instance id, instance root, app URL, env URL, client URL, DB paths, state paths, and log paths.

### Runtime Manifest

Each launch writes a gitignored runtime manifest under the instance root, for example `<CC_INSTANCE_ROOT>/launch.json`. The manifest is the source of truth for humans, agents, and tools that need to know the current local environment.

The manifest must be written atomically after port allocation and updated after successful service start. During retries, stale attempted ports must not be presented as healthy. The manifest must never include raw tokens, provider API keys, admin passwords, or decrypted secrets.

Required manifest fields:

- Instance: id, root, worktree path, launch mode, and generated timestamp.
- Servers: one entry per local server, including app/identity, cc-env, and client dev server.
- Server entry: name, role, host, port, base URL, health URL when available, process id when known, status, and log file path.
- Storage: app DB path, env DB/state path, env workspace path, and secrets key path without secret contents.
- Commands: the launch command and relevant npm script name.

`CLAUDE.md` must document the manifest path and instruct coding agents to read it before assuming ports, URLs, DB paths, or log file locations. The instructions should prefer the manifest over hardcoded defaults and note that `.cloud-code/` is gitignored.

### App And Env Pairing

The app/identity server and cc-env must only pair when they agree on `CC_INSTANCE_ID`.

Pairing behavior:

- Desktop-managed startup mints an app-side identity token, calls cc-env `/pair/desktop`, and registers the returned env token with the app.
- Browser-only startup runs the same app/identity and cc-env services without native desktop webframe support.
- Existing env-token reuse is allowed only after `/auth/check` succeeds against the same env URL and instance.
- `/healthz` for app and env must expose enough instance data for the launcher/supervisor to reject cross-worktree pairing.

Provider credentials must not be copied into cc-env storage during pairing.

### Browser-Mode App Behavior

The app must load from the client dev server in a normal browser.

In browser mode:

- Core workspace, shell, agent session, settings, and identity-backed API flows must keep working against the local app/identity server.
- Native browser panes backed by `window.webframe` are unavailable and must degrade explicitly.
- Browser-tab content must not silently fail. If a URL cannot be opened in a native pane, the UI must show the URL and an external-open action.
- Preview/open-pane events must not be dropped. If native preview/browser panes are unavailable, URL previews should use the browser-compatible preview tab behavior or show an explicit fallback.
- Desktop-only controls should be hidden or disabled with clear copy rather than throwing runtime errors.

In desktop mode:

- Native browser panes continue to use `@samdesota/webframe`.
- Launching a local server from a shell or agent can open its URL in a native browser pane.

### Local Server Launch Flow From The App

The app does not need a separate bespoke server-launch service for this work. A worktree server is started through the existing shell or agent execution path.

Expected flow:

1. User opens a worktree in the app.
2. User or agent starts that worktree's local server from a shell command.
3. The app receives or is given the server URL.
4. Desktop mode opens the URL in a native browser pane.
5. Browser mode opens the URL through a preview/fallback tab or external-open action.

This flow must preserve workspace tab state and must not require Docker, Postgres, remote orchestrator services, or the legacy fixed cc-env port.

### Seed Data

Local launch must seed only app-side state needed for development:

- Admin identity/password state.
- Encrypted provider secret `provider.openai.api_key`.
- Encrypted provider base URL `provider.openai.base_url`.
- Encrypted default model setting `agent.default_model`.

Seed inputs remain environment-driven:

- `CC_SEED_ADMIN_PASSWORD`.
- `CC_SEED_OPENAI_API_KEY` or `CC_SEED_OPENAI_API_KEY_OP_REF`.
- `CC_SEED_OPENAI_BASE_URL`.
- `CC_SEED_MODEL_PROVIDER` and `CC_SEED_MODEL_ID`.

The seed operation must target the current instance's app DB and secrets key. It must remain safe for local development: production seeding still requires an explicit force flag.

Seeding should be idempotent. Re-running local launch may update seeded values from current inputs, but must not create duplicate identity or secret records.

### Credential Resolution

Provider secrets live only in the app SQLite secrets table, encrypted with the app secrets key.

Runtime credential flow:

- Agent execution in cc-env asks the app/identity server for provider environment variables.
- The app resolves encrypted provider secrets and returns only the env map needed for the run.
- cc-env injects provider env vars into the spawned agent process.
- cc-env must not persist long-lived provider API keys in env DB, state files, pairing records, or logs.

Missing credentials should fail as an agent-provider configuration error, not as a service startup failure. Placeholder local credentials are acceptable only when explicitly produced by the dev seed path.

### Configuration Compatibility

Existing commands may remain, but their worktree-ready behavior must route through the launch contract where needed:

- `npm run dev` remains the default desktop-managed local path.
- `npm run dev:web` remains the browser-only path and must use allocated app/client ports instead of fixed Vite and proxy ports.
- `npm run db:seed:dev` remains usable directly and by the launcher.

The implementation must avoid adding any new default dependency on Docker, Postgres, sandbox image builds, production services, or fixed `cc-env` port `47821`.

### Edge Cases

- Two worktrees launched at the same time must converge on different ports and different instance roots.
- A stale service on a previously selected port must cause a retry or same-instance reuse only after instance verification.
- A service that starts on the wrong instance id must be treated as a collision.
- A browser-only user opening a native browser tab must see a usable fallback, not a blank pane.
- A preview open request in workspace context must be rendered or surfaced explicitly, not ignored.
- Seeded credentials must follow the selected app DB path, including explicit `CC_APP_SQLITE_PATH` overrides.
- Logs must not include raw provider API keys or raw env tokens.

### Dependencies

No new external infrastructure is required. Port probing can use Node's standard networking APIs or an existing project dependency. Browser fallback should reuse existing preview/tab components where possible.
