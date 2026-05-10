# Local-First Desktop Env

## Seed

Refactor Cloud Code around a local-first desktop runtime: remove the unused remote sandbox/orchestrator path from the repo for now, while keeping `cc-env` as the separate environment service that future remote environments can reuse.

The Electron app should run against a local identity/app server by default, auto-pair with its matching `cc-env`, and support multiple simultaneous worktrees/versions on one Mac without port, state, or pairing collisions.

## Solution

- Product shape: local-first desktop app backed by a local identity/app server and a separate local `cc-env` service.
- Persistence: identity/app server uses SQLite for local desktop state; `cc-env` keeps its own SQLite state.
- Runtime ownership: Electron launches or discovers its matching local identity/app server and `cc-env` before opening the UI.
- Pairing: desktop performs trusted local auto-pairing between the identity/app server and its matching `cc-env`; manual code pairing is retained for non-desktop/manual flows.
- Remote removal: remove Docker sandbox/container orchestration, remote env creation, reverse proxying, sandbox image/build paths, and remote-only UI routes from the active product.
- Future boundary: keep `cc-env` as the reusable environment service API so remote environments can be rebuilt later against the same contract.
- Multi-instance model: every desktop/worktree instance gets an explicit instance id, ports, state directories, app database, env database, and pairing credentials.
- Discovery: replace fixed local-port discovery with instance-scoped discovery handed to the renderer by Electron.

## Spec

### Target Architecture

Cloud Code becomes a local desktop product composed of three local processes:

```text
Electron main process
  starts/discovers local identity app server
  starts/discovers matching cc-env
  passes instance-scoped runtime config to renderer

Identity/app server
  serves the React app and identity APIs
  stores local app state in SQLite
  stores the paired cc-env URL/token for this instance

cc-env
  owns workspace shells, files, repos, agents, previews, and opencode integration
  stores environment state in its own SQLite database
```

The identity/app server no longer creates Docker containers or proxies remote env traffic. The only active environment target is the paired local `cc-env` for the desktop instance.

### Process Ownership

Electron owns the local runtime for the desktop app. On startup it resolves an instance config, ensures the identity/app server is reachable, ensures the matching `cc-env` is reachable, performs local auto-pairing when needed, then opens the web UI at the local identity/app URL.

Development can still run processes separately, but the product path is desktop-owned. Dev scripts must support both modes: explicit external URLs for debugging, and desktop-managed local processes for the normal desktop flow.

The renderer must not probe hardcoded ports. It receives the app URL, env URL, env label, and pairing state from the desktop-provided runtime config or from the local identity/app server that Electron bootstrapped.

### Instance Model

Every local desktop runtime has a stable `instanceId`. The instance id scopes:

- identity/app server port
- identity/app SQLite path
- identity/app data directory
- `cc-env` port
- `cc-env` state directory
- `cc-env` working directory
- `cc-env` label
- pairing token stored by the identity/app server
- logs and PID/lock files

Default instance ids should be derived from the worktree path during development and from the installed app identity in packaged builds. Explicit overrides are required for tests and operator debugging.

Two instances must be able to run concurrently from different worktrees on the same Mac without sharing SQLite databases, ports, pairing tokens, shell sessions, opencode state, or repo working directories.

Port allocation must be deterministic when possible and collision-safe when not. If the preferred port for an instance is occupied by the same instance, reuse it. If it is occupied by another process, allocate another loopback port and persist that choice in the instance state.

### Local Identity/App Server

The identity/app server keeps the existing app responsibilities that are still meaningful locally:

- admin/session auth or its local replacement
- encrypted secrets
- workspace metadata and UI state
- repo metadata needed by the app shell
- agent/session metadata that belongs to the app rather than `cc-env`
- event logs useful for local diagnosis
- local env registration for the paired `cc-env`

The identity/app server moves from Postgres to SQLite for the desktop/local runtime. SQLite must use a per-instance database file under the instance data directory. The app must run migrations on startup before serving traffic.

The app DB schema must drop active dependencies on remote-only entities: Docker sandboxes, container env lifecycle, remote env auth flows that only exist to authorize a container back to identity, and reverse-proxy bookkeeping. Historical migrations do not need to be preserved for unshipped local SQLite databases unless a concrete local upgrade path requires it.

Production Docker/Postgres deployment is no longer the default product path for this repo. Any remaining server mode must be explicitly marked as legacy or removed from active scripts and docs.

### cc-env Boundary

`cc-env` remains a separate service with its own HTTP/tRPC contract. It continues to own:

- filesystem and repo operations
- shell sessions and shell WebSockets
- agent sessions, opencode integration, and agent UI proxying
- previews and jobs
- environment-local secrets and token validation

`cc-env` keeps SQLite at `CC_STATE_DIR/env.db` and keeps using `CC_WORKING_DIR` for repos/workspaces. Both paths must be instance-scoped.

The `cc-env` health response remains the basic readiness contract, but desktop needs enough local metadata to verify it found the matching instance. At minimum, health must expose `kind`, `label`, `paired`, and a stable instance label or id that Electron can compare against its expected instance config.

### Pairing

Manual pairing remains for non-desktop/manual operation: start a pair session, read the code from `cc-env` logs, confirm the code, receive an env token, and register the env with identity.

Desktop auto-pairing is a trusted local flow between Electron-managed processes. It must not require the user to read a six-digit code from logs. Auto-pairing must produce the same end state as manual pairing: `cc-env` has a valid token hash, and identity stores the raw token with the env URL/label for API calls.

Auto-pairing must be scoped to the expected instance. A desktop app must not silently pair with an unrelated `cc-env` already listening on another port.

Re-pairing should be idempotent. If identity already has a valid token for its matching `cc-env`, startup should reuse it. If the token is missing or invalid, startup should mint a new token and update identity state.

### Frontend Behavior

The dashboard and workspace screens should assume a local paired env in the desktop path. Manual local pairing UI is still available for explicit manual mode, but it is not the first-run desktop experience.

Workspace env selection should resolve to the instance-paired local env. The app should no longer offer remote/container env creation in the active UI.

The legacy sandbox route and sandbox-specific shell UI are removed from active navigation. Workspace tabs, shells, files, agents, previews, and repo flows should use the `cc-env` target abstraction only.

Browser-side fixed discovery of `http://127.0.0.1:47821` is removed from the desktop path. The renderer uses instance-scoped runtime data, so multiple desktop instances can point at different local identity/app and `cc-env` ports.

### Remote Removal

Remove active runtime dependencies on Docker orchestration from the identity/app server:

- no Docker socket mount required for the app server
- no sandbox image required for normal development or desktop use
- no Docker network reconciliation on app boot
- no container `cc-env` creation from identity
- no `/env/:id` reverse proxy for container envs
- no periodic container/sandbox reconciliation timers

Remote-environment concepts may remain only as neutral API boundaries around `cc-env` if they do not require Docker, Postgres, or remote orchestration to run the local desktop product.

### Configuration

Required desktop-managed config values:

- `CC_INSTANCE_ID`
- identity/app host, port, data directory, SQLite path, and public local URL
- `cc-env` host, port, state directory, working directory, label, and allowed origins
- path to the `cc-env` executable or built server entrypoint
- path to the opencode plugin used by `cc-env`

Required override behavior:

- explicit app URL override for debugging against an externally managed server
- explicit env URL/token override for debugging against an externally managed `cc-env`
- explicit instance id and port overrides for tests
- safe defaults that never share state across worktrees unless explicitly configured to do so

### Data And Migration Policy

Local SQLite app state is the source of truth for the desktop identity/app server. Since the remote sandbox/orchestrator path is being killed for now, migration effort should target the local desktop schema rather than preserving every historical Postgres migration shape.

Data that belongs to environment execution stays in `cc-env` SQLite. Data that belongs to the app shell, identity, settings, workspaces, and UI state stays in identity/app SQLite. Tokens crossing the boundary are stored raw only where needed to call the other service and hashed where used for validation.

### Edge Cases

If the identity/app server starts but `cc-env` fails, Electron should open a recoverable local error screen or app route that shows the failed process, log path, and retry action.

If ports collide, startup should choose new available loopback ports for this instance and persist them.

If Electron finds a running service on the expected port with a different instance id, it must treat that as a collision, not as a match.

If identity has a paired env record but health/token validation fails, Electron should re-pair the matching `cc-env` and update identity state.

If multiple renderers/windows are opened for the same desktop instance, they share the same identity/app server and `cc-env` processes.

If the app is run in browser-only development mode, manual pairing and explicit env URL configuration remain available.

### Verification Expectations

Automated coverage must prove that two instances can run concurrently with distinct ports, state directories, app DBs, env DBs, labels, and tokens.

Automated coverage must prove that the desktop startup path can create or discover both services, auto-pair them, and load the workspace UI without fixed-port discovery.

Automated coverage must prove that the app server starts without Docker or Postgres in the local desktop path.
