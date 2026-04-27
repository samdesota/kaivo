# Local-First Desktop Env Plan

## Task 1: Define Instance Runtime Config

Create the shared instance model that gives each desktop/worktree runtime distinct ids, ports, state directories, database paths, labels, and process metadata. This establishes the isolation contract every later task uses.

**Steps**
- Add an instance config resolver for desktop-managed runtimes with `CC_INSTANCE_ID`, app host/port/data dir, env host/port/state dir/working dir, labels, log paths, and override handling.
- Make development defaults derive from the worktree path and packaged defaults derive from the installed app identity.
- Add collision-safe persisted port selection semantics to the config contract, without launching services yet.

**Tests**
- Unit: instance config resolver produces stable values for one worktree and distinct values for two worktrees.
- Unit: explicit env vars override derived ids, ports, and directories.
- Manual: run the resolver from two repo checkouts and confirm no shared state paths or ports.

**Depends on:** none

**Status:** done

## Task 2: Add cc-env Instance Identity

Teach `cc-env` to identify which local desktop instance it belongs to. This lets Electron distinguish a matching service from an unrelated process on the same machine.

**Steps**
- Add `CC_INSTANCE_ID` or equivalent instance label to `packages/env-server` config.
- Include the instance id in `/healthz` alongside `kind`, `label`, `paired`, `identityReady`, and `opencodeReady`.
- Keep existing manual pairing behavior unchanged.

**Tests**
- Unit: env-server config reads and defaults the instance id correctly.
- Integration: `/healthz` returns the expected instance id and label.
- Manual: start two `cc-env` instances on different ports and verify distinct health payloads.

**Depends on:** Task 1

**Status:** done

## Task 3: Introduce Local App SQLite Storage

Move the identity/app server local runtime off Postgres and onto per-instance SQLite. This makes the desktop stack independent of Docker Compose and local Postgres.

**Steps**
- Add a SQLite database client and migration runner for the identity/app server local mode.
- Define the local app schema for identity-owned data: admin/session state, secrets, workspaces, workspace UI state, repo config metadata, local env registrations, and event logs.
- Update local app boot so migrations run against the instance SQLite path before serving traffic.

**Tests**
- Unit: SQLite migrations create the expected local app tables in a temp directory.
- Integration: app server boots with SQLite and no `DATABASE_URL`.
- Manual: inspect the generated app SQLite file under the instance data directory.

**Depends on:** Task 1

**Status:** done

## Task 4: Remove Docker Boot Coupling

Make the app server start without Docker, sandbox images, Docker networks, or container reconciliation. This separates the local identity/app server from the removed remote orchestration path.

**Steps**
- Remove or disable Docker ping, Docker network setup, sandbox reconciliation, container env reconciliation, and periodic remote reconcile timers from the local app boot path.
- Remove Docker socket and sandbox image requirements from local/default scripts and docs.
- Keep any temporary legacy mode explicit rather than default.

**Tests**
- Integration: app server `/healthz` succeeds with no Docker socket available.
- Unit: local app env validation does not require sandbox image, Docker network, or Postgres values.
- Manual: run the local app server on a machine with Docker stopped and confirm it starts.

**Depends on:** Task 3

**Status:** done

## Task 5: Prune Remote Sandbox Product Surfaces

Remove active routes and APIs that create or operate remote Docker sandboxes/container envs. This keeps the product aligned with the local-only runtime.

**Steps**
- Remove sandbox/container creation procedures from the active tRPC router.
- Remove `/sandbox/$id`, sandbox-specific tab shells, and remote/container env creation from active navigation.
- Remove the container env reverse proxy from local app routing.

**Tests**
- Unit: active router no longer exposes sandbox/container creation procedures.
- Integration: workspace routes load without sandbox APIs registered.
- Manual: start the app and confirm no UI path offers remote sandbox/container creation.

**Depends on:** Task 4

**Status:** done

## Task 6: Build Desktop Service Supervisor

Make Electron responsible for ensuring the local app server and matching `cc-env` are running before the UI opens. This creates the desktop-owned product path.

**Steps**
- Add Electron main-process service discovery for the instance app server and `cc-env` health endpoints.
- Add child-process launch for missing services using the resolved instance config.
- Reject services whose health payload does not match the expected instance id.
- Surface startup failures with log paths and retry instead of opening a broken UI.

**Tests**
- Unit: supervisor reuses matching running services and rejects mismatched services.
- Integration: supervisor launches both services into temp instance directories and observes healthy endpoints.
- Manual: run desktop with no services running and confirm it opens the local UI after startup.

**Depends on:** Tasks 2, 3, 4

**Status:** done

## Task 7: Add Trusted Desktop Auto-Pairing

Add a local auto-pairing path that produces the same token end state as manual pairing without requiring the user to read a code from logs. This makes first-run desktop startup automatic.

**Steps**
- Add a trusted local pairing mechanism scoped to the expected instance id.
- Store the raw env token in the local app SQLite env registration and only token hashes in `cc-env` validation state.
- Make startup pairing idempotent: reuse valid tokens, mint a replacement when missing or invalid.
- Preserve manual code pairing for browser-only or externally managed flows.

**Tests**
- Unit: auto-pairing refuses a mismatched instance id.
- Integration: desktop startup pairs a fresh `cc-env`, stores the token, and can call an authenticated env procedure.
- Integration: invalid stored token triggers re-pair and updates the local app env registration.

**Depends on:** Task 6

**Status:** done

## Task 8: Replace Fixed-Port Renderer Discovery

Move renderer env discovery from hardcoded `127.0.0.1:47821` probing to instance-scoped runtime data. This enables multiple desktop instances on one machine.

**Steps**
- Pass app/env runtime metadata from Electron or the local app server to the renderer.
- Update env client creation to use the paired local env URL/token from local app state.
- Remove fixed local-port discovery from the desktop path while keeping explicit/manual configuration available for browser-only development.

**Tests**
- Unit: env client uses provided runtime/env registration instead of the hardcoded default port.
- Integration: workspace selects the instance-paired env target.
- Desktop e2e: two desktop instances load distinct env labels and do not cross-call each other's env server.

**Depends on:** Task 7

**Status:** done

## Task 9: Align Workspace UI With Local Env Target

Finish the UI transition so the workspace operates through the paired local `cc-env` abstraction only. This removes remaining remote/sandbox assumptions from normal use.

**Steps**
- Update dashboard first-run behavior to show local runtime status instead of manual pairing by default.
- Ensure workspace tabs, shells, files, agents, previews, and repo flows use the paired local env target.
- Keep manual pairing reachable only for explicit manual/external modes.

**Tests**
- Unit: workspace env target selection returns the paired local env and handles missing env state.
- Integration: dashboard and workspace render with an auto-paired local env.
- Manual: first-run desktop opens to a usable local workspace without reading a pairing code.

**Depends on:** Task 8

**Status:** done

## Task 10: Update Scripts, Packaging, And Docs

Make local-first desktop the default operator and developer workflow. This removes stale Docker Compose assumptions from the primary path.

**Steps**
- Update root and package scripts so desktop-managed local runtime is the normal desktop command.
- Keep explicit scripts for browser-only development and externally managed app/env debugging.
- Update README/operator docs to describe local SQLite state, instance overrides, multi-worktree runs, and the removed remote sandbox path.
- Remove or clearly mark obsolete sandbox image and Compose workflows as legacy if they still exist temporarily.

**Tests**
- Unit: config tests cover documented env var overrides.
- Integration: documented local desktop command starts the app without Postgres or Docker.
- Manual: follow the README from a clean checkout and open the desktop app.

**Depends on:** Task 9

**Status:** done

## Task 11: Run Full Local Verification

Verify the completed local-first stack end to end before migrating production data. This is the release gate for the new runtime.

**Steps**
- Run unit, web e2e, desktop e2e, and any local live env tests that apply after the refactor.
- Run a two-instance concurrency smoke test from separate worktrees.
- Confirm no default path requires Docker, Postgres, sandbox image builds, or fixed `cc-env` port `47821`.

**Tests**
- Unit: `npm test`.
- Integration: `npm run test:e2e` and applicable env-server integration tests.
- Manual: two desktop/worktree instances run concurrently with separate app DBs, env DBs, logs, ports, and tokens.

**Depends on:** Task 10

**Status:** done

## Task 12: Migrate Relevant Production Data To Local SQLite

After the new local system is complete, pull identity-owned data from the production box and import it into the new local app SQLite database. This is intentionally last so migration targets the final schema.

**Steps**
- Create an export script that connects to production Postgres on the box and exports only identity-owned data: `admin`, `secrets`, `github_install`, useful `github_token_cache`, `repo_configs`, `repo_config_files`, `workspaces`, `workspace_ui_states`, local-only `envs`, and optional recent `event_logs`.
- Exclude removed or execution-owned data: `sandboxes`, container env rows, sandbox repos, sandbox shell sessions, agent shell tokens, sandbox/container agent transcripts, jobs, device auth requests, and remote orchestration history.
- Create an import script that loads the export into the finalized local app SQLite schema and validates row counts and foreign-key integrity.
- Document the exact final command sequence for pulling from `root@161.35.136.150` and importing into the chosen local instance.

**Tests**
- Unit: import mapper handles representative exported rows and skips excluded tables.
- Integration: export fixture imports into a fresh SQLite app DB with foreign keys enabled.
- Manual: run the production export/import once after Task 11 passes, then open the desktop app and verify workspaces, repo configs, secrets-backed integrations, and local env registration state.

**Depends on:** Task 11

**Status:** cancelled
