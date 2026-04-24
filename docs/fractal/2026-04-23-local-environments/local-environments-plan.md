# Local Environments — Execution Plan

A thin checklist of **what to test** at each phase. The implementation agent picks the exact files/abstractions. Acceptance criteria are the bar.

---

## Phase ordering (quick map)

```
1. Identity (envAuth + env-facing)      ─┐
2. Orchestrator env router               ├─ parallelizable
3. Env server core (no opencode)         ─┘
                 │
                 ▼
4. Env server opencode + identity client
                 │
                 ▼
5. Container image + orchestrator integration
                 │
                 ├──► 6. install.sh
                 │
                 └──► 7. Webapp
```

Phases 1, 2, 3 can run in parallel. 4 depends on 1 + 3. 5 depends on 2 + 4. 6 and 7 depend on 5 (6 can start earlier against a locally-run env server).

---

## Phase 1 — Identity: envAuth + env-facing endpoints

### Build
- New tables: `envAuthTokens`, `envAuthDeviceRequests`, `serviceCredentials`.
- New routers on `cc-control`: `envAuth.*` (issueFromService, deviceStart, deviceConfirm, devicePoll) and `env.*` (resolveProviderKeys, getRepoConfig).
- Seed `serviceCredentials` from an env var at boot.

### Acceptance
- [ ] `envAuth.issueFromService` with a valid service token returns a token; without service header → 401.
- [ ] Device flow: `deviceStart` → show userCode → `deviceConfirm` with a logged-in session → `devicePoll` returns `{ status: 'approved', identityToken }`.
- [ ] `devicePoll` before confirm returns `{ status: 'pending' }`; after expiry returns `{ status: 'expired' }`.
- [ ] `env.resolveProviderKeys` with a valid `identityToken` returns only the owning user's keys.
- [ ] `env.resolveProviderKeys` with a revoked token → 401.
- [ ] Cross-user leakage test: user A's token cannot read user B's keys or repo configs.
- [ ] `deviceStart` is rate-limited; sending 100 requests does not exhaust the DB.

---

## Phase 2 — Orchestrator env router

### Build
- Drop old `sandbox` router + `sandboxes` table (v1 migration strategy: wipe).
- New `envs` table + `env.*` orchestrator router: `list`, `get`, `createContainer`, `archive`, `delete`, `restart`, `registerLocal`, `unregister`, `health`.
- `createContainer` mints `envToken` + calls identity `envAuth.issueFromService` to get `identityToken`; injects both into the (currently stub) container.

### Acceptance
- [ ] `env.createContainer` returns `{ id, url, envToken }` exactly once; second call to same endpoint yields a different envToken (no reuse).
- [ ] Created container has `CC_ENV_TOKEN`, `CC_IDENTITY_TOKEN`, `CC_IDENTITY_URL`, `CC_WORKING_DIR`, `CC_KIND=container`, `CC_PORT` in its env (inspect via `docker inspect`).
- [ ] `env.list` scopes to the caller's userId (second user doesn't see first user's envs).
- [ ] `env.registerLocal` calls `GET url/healthz` with bearer envToken before inserting; failure → reject; success → row inserted with `kind='local'`, no token stored.
- [ ] `env.archive` / `delete` / `restart` operate only on `kind='container'` envs; return error for local.
- [ ] `env.health` pings `/healthz` without credentials and updates `lastSeenAt`.

---

## Phase 3 — Env server core (pairing, shell, fs — no opencode)

### Build
- New `packages/env-server/` with bundled binary build.
- Fastify server, SQLite schema + migrations (`envMeta`, plus migrated per-env tables).
- Routers: `meta.info`, `pair.*`, `shell.*`, `fs.*`, `job.*`, `repo.*`.
- `/healthz` (no auth), `/ws/shell/:id` (envToken-authed).
- Auth middleware: envToken for non-pair routers; 412 for all non-pair routers when unpaired.

### Acceptance
- [ ] `cc-env` binary starts given only `CC_WORKING_DIR`, `CC_PORT`, `CC_STATE_DIR` set; `/healthz` returns 200 with `identityReady: false`, `opencodeReady: false`.
- [ ] `pair.start` on an unpaired env returns `{ sessionId, code }` and writes `pair code: <code>` to stdout.
- [ ] `pair.confirm` with correct `sessionId` + `code` returns `{ envToken }`; subsequent `pair.start` → 409 (already paired).
- [ ] Calling `shell.create` without `envToken` → 401; with wrong token → 401; with valid token → returns shell id.
- [ ] WebSocket `/ws/shell/:id` with valid envToken streams a working PTY (type `echo hi`, receive `hi\n`).
- [ ] `fs.read` inside `CC_WORKING_DIR` works; `fs.read` with `../../../etc/passwd` returns error (after realpath resolution).
- [ ] SQLite migrations are idempotent — stop/start twice preserves envToken + shell session rows.
- [ ] All non-pair routers return 412 while unpaired.

---

## Phase 4 — Env server: opencode + identity client

### Build
- Identity client (tRPC against `CC_IDENTITY_URL` with bearer `identityToken` read from the 0600 secrets file).
- Opencode child process supervisor: per-env `XDG_CONFIG_HOME` / `XDG_DATA_HOME`, unique `opencodePort`, plugin path resolved locally.
- Routers: `agent.*` (including new `agent.restart`), `agentShell.*`, `preview.*`.
- `/agent/*` HTTP + WS proxy to `127.0.0.1:<opencodePort>` with opencode basic auth injected upstream.

### Acceptance
- [ ] With `identityToken` provided (via secrets file), starting `cc-env` boots opencode within 45s; `/healthz` reports `opencodeReady: true`.
- [ ] `agent.sessionStart` creates a session; `agent.sessionSend` streams chunks; `agentShell.runOnce` returns output.
- [ ] Change a provider key in identity → call `agent.restart` → `/meta.info` flips to `opencodeReady: false` briefly, then back to true; new opencode process has fresh env (verify via ps/child env dump in test).
- [ ] Two `cc-env` processes on the same host (different `CC_STATE_DIR` and `CC_PORT`) both run opencode concurrently without conflict.
- [ ] `/agent/config` proxy round-trips and returns 200 with upstream opencode basic auth injected transparently.
- [ ] Identity returns 401 → env server sets `identityReady: false`, stops opencode, leaves shells/fs working.
- [ ] Removing the secrets file and restarting cc-env → `identityReady: false`; `agent.sessionStart` returns a clear error.

---

## Phase 5 — Container image + orchestrator integration

### Build
- Update `docker/base-sandbox/Dockerfile`: bundle `cc-env` binary, change `Cmd` to run it, drop the now-unused `tail -f /dev/null`.
- Remove from `cc-control`: `AgentService` lifecycle bootstrap, `/ws/shell/:id` handler, `/sandbox/:id/agent/*` proxy, per-env routers.
- Update orchestrator `env.createContainer` to wait for the new container's `/healthz`.

### Acceptance
- [ ] `env.createContainer` returns a URL the browser can reach; curl-ing that URL + bearer envToken against `meta.info` succeeds.
- [ ] Inside the container, `ps` shows `cc-env` as PID 1 and `opencode serve` as its child.
- [ ] `env.restart` stops and re-starts the container; same envToken works after restart.
- [ ] `env.delete` removes the container and the `envs` row; subsequent `env.get` returns not-found.
- [ ] End-to-end from webapp (manual): create container env, hit shell + opencode directly against env URL.
- [ ] Removed routers no longer resolve on `cc-control` — `curl /trpc/shell.create` returns 404.

---

## Phase 6 — `install.sh`

### Build
- `scripts/install.sh`: platform detect, download + verify binary, prompt inputs, run device flow, write plist/unit, bootstrap.
- Uninstall doc (not script) in `docs/local-env-install.md`.

### Acceptance
- [ ] On a fresh mac, running `install.sh` with env `CC_IDENTITY_URL` set:
  - Prompts for `workingDir` + `label`; rejects non-absolute or non-existent paths.
  - Prints a URL + code; after approval in the browser, proceeds.
  - Writes `~/Library/LaunchAgents/com.cloudcode.env.plist` with correct env vars.
  - `launchctl list | grep cloudcode` shows it running.
  - `curl http://localhost:47821/healthz` returns 200 within 10s of script completion.
- [ ] Repeat on Linux with systemd — same outcome.
- [ ] `tail ~/Library/Application Support/cc-env/log/cc-env.log` shows the pairing code when `pair.start` is called.
- [ ] Re-running `install.sh` with a different workingDir overwrites the plist; old workingDir no longer active.
- [ ] Script exits non-zero on: sha256 mismatch, device flow timeout, invalid workingDir, missing `CC_IDENTITY_URL`.
- [ ] Incomplete run (Ctrl-C during device poll) leaves no stray launchd agent.

---

## Phase 7 — Webapp

### Build
- `Env` type + `envTokens` localStorage map.
- `makeEnvClient(env, token)` factory + per-env WS/proxy URL builders.
- `/sandbox/:id` route renamed to `/env/:id`; all per-env calls use env client.
- "Environments" list view (replacing "Sandboxes").
- "Add local environment" dialog: URL input + pair code entry.
- Settings → after provider-key save, prompt to `agent.restart` each running env; fan out on click.

### Acceptance
- [ ] Env list shows both container and local envs; kind badge visible.
- [ ] Creating a container env via UI navigates to `/env/:id` and shell + opencode work.
- [ ] "Add local env" full flow: URL → pair.start shows code field → user pastes code from the launchd log → pair.confirm → env appears in list.
- [ ] Shell in a local env streams via `ws://localhost:47821/ws/shell/:id` (no central server involved — verified by stopping `cc-control` mid-session; shell keeps working).
- [ ] Opencode in a local env works through `http://localhost:47821/agent/*`.
- [ ] Change Anthropic key in settings → prompt appears → click "Apply to N envs" → each env's `agent.restart` is called; opencode-dependent features work against the new key.
- [ ] localStorage survives reload — paired local env still accessible after browser refresh.
- [ ] Losing localStorage (`clear()` in devtools) → env shows `unreachable` (since envToken gone); `cc-env pair reset` + repairing restores access.
- [ ] Env that fails `/healthz` shows an `unreachable` badge; clicking it does not crash the app.
- [ ] Cross-origin requests to `http://localhost:47821` work from the HTTPS webapp (no mixed-content blocking; no CORS failures).

---

## Cross-cutting acceptance (run at every phase when relevant)

- [ ] No envToken or identityToken ever appears in `cc-control` logs.
- [ ] No identity or provider keys ever appear in the webapp bundle or network tab beyond the expected `settings.*` paths.
- [ ] CORS config allows the webapp origin on all three services; denies unknown origins.
- [ ] `/healthz` endpoints respond in <100ms even while opencode is spawning.

---

## Explicit non-tests (v1)

- No token-revoke UX test (CLI-only, out of scope).
- No cross-device sync of local-env config.
- No binary auto-update.
- No migration test (existing sandboxes wiped per Spec §9).
- No multi-user-on-one-host test.
