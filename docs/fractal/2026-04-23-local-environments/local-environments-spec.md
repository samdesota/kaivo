# Local Environments

## Seed

Add local environments to our coding tool. Local envs will run on the user's
computer: the app connects to a service running locally that provides basic
APIs (shell + opencode access). We will build the local service, then the app
needs to connect to the local service via some auth scheme, then the app gets
a version of the containerized service that runs locally — with a base working
directory, but no container.

## Outline

### Topology (new model)
- Current: one monolithic server owns containers, proxies opencode/shell to the webapp, and stores global state (auth, github, repo configs, settings).
- New: split into three services. The webapp talks to all three directly.
  - **Identity service** — global/user state. Auth, GitHub, repo configs, provider keys. One per deployment.
  - **Orchestrator service** — env registry + container lifecycle. Creates container envs, tracks connected local env servers. One per deployment (sits next to identity on the same box for now).
  - **Environment server** — the per-env API (shell, fs, opencode, preview, jobs, repos). Each env = one workingDir = one env server. Same binary whether it runs in an orchestrator-managed container or as a launchd agent on the user's host.
- An **environment** is "just a server" with a known URL and token. Local vs container is only a deployment property — the webapp treats both the same way once registered.
- The orchestrator is a *registry + container driver*, not a proxy — the webapp connects directly to each env server for per-env ops.

### Services and their API surfaces

#### 1. Identity service (tRPC)
Houses today's global routers; keep names.
- `auth.*` — status, bootstrap, login, logout.
- `settings.*` — listProviders, setProviderKey, setProviderBaseUrl, deleteProvider.
- `github.*` — status, connectStart, disconnect, listOrgRepos.
- `repoConfig.*` — list/get/create/update/remove + listFiles/readFile/putFile/removeFile.
- **Env-facing endpoints** (authenticated with an env's identity token, not a user session):
  - `env.resolveProviderKeys()` → `{ ANTHROPIC_API_KEY, OPENAI_API_KEY, … }` for injecting into opencode.
  - `env.getRepoConfig({ slug })` → config contents needed to bootstrap an env.
- **Token-issuance endpoints**:
  - `envAuth.issueFromService({ orchestratorServiceToken, userId, label })` → `{ identityToken }`. Called only by the orchestrator using its own long-lived service credential. Used for container envs.
  - `envAuth.deviceStart()` → `{ deviceCode, userCode, verificationUrl }`. Called by install.sh; unauthenticated.
  - `envAuth.deviceConfirm({ deviceCode })` → called from a browser page where the user is already logged in; approves the pending request.
  - `envAuth.devicePoll({ deviceCode })` → `{ identityToken } | { status: 'pending' | 'denied' }`. install.sh polls until approved.
  - (Alt form: a single browser-redirect flow with a localhost `redirect_uri` — nicer UX, pick one in Spec.)

#### 2. Orchestrator service (tRPC)
Owns env identities. Has its own long-lived service credential to call `envAuth.issueFromService` on identity. Rough shape:
- `env.list()` → `[{ id, kind: 'container' | 'local', label, url, status, createdAt, … }]`. Tokens are NOT returned here — handed out once at create/pair time; webapp caches them.
- `env.get(id)` → same shape as a list row plus richer metadata.
- `env.createContainer({ name, … })` → mints `envToken` (for webapp) and `identityToken` (from identity), spins up container with both in env vars, returns `{ id, url, envToken }` exactly once.
- `env.archive(id)`, `env.delete(id)`, `env.restart(id)` — container-only lifecycle ops.
- `env.registerLocal({ url, envToken, label })` → webapp calls this after pairing; orchestrator stores `{ id, url, label, kind: 'local' }` but NEVER keeps `envToken`. (The env's `identityToken` is invisible to the orchestrator — it was obtained independently via install.sh's device flow.)
- `env.unregister(id)` — remove a local registration. For container envs this is `delete`.
- `env.health(id)` — orchestrator pings the env's URL (with no auth — just a ping endpoint). Passive status, not a heartbeat.

#### 3. Environment server (tRPC + WS + HTTP proxy)
Same binary whether it runs in a container or locally. Scope is *one workingDir*. Single process, single port, single env.

Two tokens live on the env server:
- `envToken` — authorizes **webapp → env** calls. Minted by orchestrator (container) or during pairing (local).
- `identityToken` — authorizes **env → identity** calls. Minted by orchestrator via `envAuth.issueFromService` (container) or by install.sh's device auth flow (local). Never touches the webapp.

Routers:
- `meta.info()` → `{ kind, workingDir, opencodeReady, identityReady, versions, … }`.
- `shell.*` — list, create, resize, dispose, runOnce.
- `fs.*` — list, read, write, watch, find, diff (all scoped to `workingDir`; escapes rejected).
- `agent.*` + `agentShell.*` — opencode session APIs (same names as today).
  - **`agent.restart()`** — kills the child `opencode serve`, re-fetches keys + configs from identity, re-spawns. Webapp invokes after settings/key changes.
- `preview.*` — config, ports, portsSnapshot.
- `job.*` — get, list, watch.
- `repo.*` — list, add, remove (the env has repos cloned inside `workingDir`).
- Pairing (local-only, active until paired):
  - `pair.start()` → `{ sessionId, code }`. Code goes to stdout/launchd log. Only responds if the env has no paired client yet (or pairing explicitly re-enabled via CLI).
  - `pair.confirm({ sessionId, code })` → `{ envToken }`. Token stored in the env's local SQLite.
  - Container envs skip pairing entirely: orchestrator injects `envToken` at container start.
- Non-tRPC:
  - `GET /healthz` — no auth, 200/503 only; used by orchestrator `env.health`.
  - `GET /ws/shell/:id` — PTY WebSocket. Auth via `envToken` in first frame or query param.
  - `GET /agent/*` — HTTP proxy to the local `opencode serve`. `envToken` at the env-server boundary; env server injects opencode's basic auth upstream.
- Bootstrap behavior (both kinds):
  - On start, if `identityToken` is present, fetch provider keys + applicable repo configs via `env.resolveProviderKeys` / `env.getRepoConfig`.
  - Launch `opencode serve` as a child process. Per-env `XDG_CONFIG_HOME` + `XDG_DATA_HOME`; unique port; plugin pointer set to the env server's installed plugin path; keys injected into opencode env.
  - If `identityToken` is missing (local env post-install but pre-auth), start without opencode and report `identityReady: false` from `meta.info`.
- Container-env specifics: image baked; env server runs as PID 1; `workingDir = /workspace`; `envToken`, `identityToken`, `CC_IDENTITY_URL` injected as env vars at container start by the orchestrator.
- Local-env specifics: env server runs under launchd; `workingDir` is the host path the user picked at install time; pairing flow issues `envToken`; install.sh's device-auth flow writes `identityToken` + `CC_IDENTITY_URL` into the plist (or an accompanying secrets file with tight perms).

### Local install
- Ship an `install.sh`. It:
  1. Installs the env-server binary (bundled self-contained, or `npm i -g` — pick one in Spec; leaning bundled binary for no-node-dependency).
  2. Prompts for a `workingDir`, a friendly `label`, and the identity service URL (defaulted).
  3. Runs the **device-auth flow** against identity to obtain an `identityToken`:
     - Calls `envAuth.deviceStart` → shows user a code + URL.
     - User opens URL in an already-logged-in browser, enters code, approves "Authorize local environment '<label>'".
     - install.sh polls `envAuth.devicePoll` until approved, receives `identityToken`.
  4. Writes `~/Library/LaunchAgents/com.cc.env.plist` pointed at the binary with env vars: `CC_WORKING_DIR`, `CC_PORT=47821`, `CC_IDENTITY_URL`, plus a secrets file (mode 0600) at `~/Library/Application Support/cc-env/identity_token` the binary reads on boot.
  5. `launchctl bootstrap`s the plist so the env server starts now and at login.
- State dir: `~/Library/Application Support/cc-env/` (mac; platform-appropriate elsewhere) — SQLite with `{ envToken, pairedAt, workingDir, label }` and a separate 0600 secrets file for `identityToken`. One row — one env per install.
- Re-running install.sh with a different workingDir overwrites the plist (v1 limitation; multi-local-env is deferred to the future "workspaces" concept).

### Pairing (webapp ↔ local env server)
1. User runs `install.sh`; launchd brings up the env server on `http://localhost:47821`.
2. Webapp "Add local environment" dialog: `POST http://localhost:47821/pair/start` with no auth → `{ sessionId, code: "123456" }`. Code is written to the env server's stdout (visible in the launchd log).
3. User copies the code into the webapp → `POST /pair/confirm { sessionId, code }` → `{ envToken, label, workingDir }`. Token stored in localStorage under `envTokens[envId]`.
4. Webapp calls orchestrator `env.registerLocal({ url: 'http://localhost:47821', token: envToken, label })` so the env shows up in `env.list()` for this account across future sessions. (Token is NOT sent — orchestrator records URL + label only.)
5. Env server is now paired; `pair.*` endpoints reject further requests until CLI re-enables (`cc-env pair reset`).

### Auth summary
- **Webapp → identity**: session cookie (as today).
- **Webapp → orchestrator**: session cookie (orchestrator validates with identity service).
- **Webapp → env server** (container or local): `Authorization: Bearer <envToken>`. Webapp caches `{envId: envToken}` in localStorage.
- **Pairing calls** (`pair.start`, `pair.confirm`): unauthenticated, but gated by single-use and only accepted while env is unpaired.
- **Orchestrator → identity**: long-lived service credential, used to call `envAuth.issueFromService`.
- **Env server → identity**: `Authorization: Bearer <identityToken>`. Issued by orchestrator (container) or obtained via install.sh's device flow (local). Never flows through the webapp.

### CORS + mixed content
- All services that the browser hits directly (orchestrator, identity, env servers) must CORS-allow the webapp origin (configurable list).
- `http://localhost` is a secure context, so mixed-content rules don't block an HTTPS webapp calling `http://localhost:47821` over HTTP/WS.

### Webapp changes
- New `Env` concept in the frontend: `{ id, kind, url, token?, label, status }`.
- Extract a tRPC client factory so we can create per-env clients against `env.url` with the right token; identity + orchestrator are their own clients.
- One `QueryClient`, but query keys namespaced with `envId` (or service id for global).
- Env list view: orchestrator gives the list; webapp creates per-env clients lazily on navigation.
- "Connect a local environment" flow: enter code from the installed env's launchd log → webapp pairs → registers with orchestrator.
- Auth injection per backend: cookies for identity/orchestrator; bearer tokens from localStorage for env servers.

### Migration shape (what moves where)
- **Stays in identity**: `auth`, `settings`, `github`, `repoConfig`.
- **Moves to orchestrator**: the current `sandbox` router becomes the `env` router (with semantics change: "sandbox" today ≈ container env tomorrow).
- **Moves to env server**: `shell`, `fs`, `agent`, `agentShell`, `preview`, `job`, `repo`, plus `/ws/shell/:id` and the `/sandbox/:id/agent/*` proxy (dropping the `:sandboxId` segment since each env server only hosts itself).

### What we're explicitly NOT doing (v1)
- No sandboxing / security boundary around local envs — it's the user's own machine.
- No multi-env per local install — one install.sh run = one env. Multiple local envs lands with the future "workspaces" concept in the identity service.
- No migration UI between local and container envs.
- No multi-user on one host.
- No orchestrator-driven heartbeat for local envs — health is passive (webapp probes on list).

### Credential rotation / opencode restart
- Env server caches provider keys in memory only; they're fetched from identity at each opencode spawn.
- Webapp calls `agent.restart()` on the env server to force a respawn with fresh keys. Settings UI offers this explicitly after a key change ("Restart opencode in active environments").
- No push from identity; env server never polls on a timer — only on explicit `agent.restart()`.

### Risks / open questions
- Where does the orchestrator run in dev? Same process as identity for v1 (cheap), or already split? Recommendation: same process, separate routers — split into processes later.
- `identityToken` lifetime: long-lived or refreshable? v1 propose long-lived (no expiry); add revoke-list on identity later.
- Local env post-install state where device auth was interrupted — env runs but `identityReady: false`; webapp surfaces a "finish setup" action that re-runs the device flow and POSTs the resulting token to the env server via a privileged endpoint (authed by `envToken`).
- Revocation UX for local tokens — CLI only in v1.

## Spec

### 1. Service topology

Three logical services. Two processes in v1:

- **Process A — `cc-control`**: hosts both the **Identity** and **Orchestrator** routers. Uses the existing monolith's Postgres. Keeps the current Fastify server. Drops the per-env routers and the `/ws/shell/:id` + `/sandbox/:id/agent/*` handlers.
- **Process B — `cc-env` (one per env)**: a new binary. Runs inside an orchestrator-managed Docker container OR under user launchd. Hosts the env-scoped routers, its own Fastify server, and a child `opencode serve` process. Uses a per-env SQLite.

**Packages.** The repo grows one new package and reshapes the existing server:
- `server/control/` — current `server/` minus per-env code. Identity + Orchestrator routers.
- `packages/env-server/` — new. Shares code with `server/control/` where applicable (shell/terminal service, fs, agent routers) via a shared `packages/shared/` or direct imports (impl's call).
- `scripts/install.sh` — new installer.

### 2. Data ownership

**Identity (Postgres, existing tables)**
- `webSessions`, `admin`, `secrets` (provider keys), `githubInstall`, `githubTokenCache`, `repoConfigs`, `repoConfigFiles`.
- New: `envAuthTokens` — `{ id, userId, envId, envLabel, token_hash, issuedAt, revokedAt? }`. Issued via `envAuth.issueFromService` or device flow. Bearer-auth for env→identity calls.
- New: `envAuthDeviceRequests` — `{ deviceCode, userCode, status, userId?, expiresAt, grantedTokenId? }`. For the device flow.
- New: `serviceCredentials` — orchestrator's long-lived service token (a single row seeded at boot from env var).

**Orchestrator (Postgres, new schema)**
- `envs` — `{ id, userId, kind: 'container'|'local', label, url, status, containerId?, createdAt, lastSeenAt? }`. Replaces the current `sandboxes` table for the orchestrator's purposes.

**Env server (per-env SQLite at `$CC_ENV_STATE_DIR/env.db`)**
- Migrated from the current Postgres schema: `repos`, `shellSessions`, `agentSessions`, `agentTranscripts`, `agentShellTokens`, `jobs` (sandbox-scoped subset).
- New: `envMeta` — single-row `{ envToken_hash, workingDir, label, pairedAt, opencodePort, opencodePasswordHash }`.
- Secrets file (0600) at `$CC_ENV_STATE_DIR/secrets.json` holds `{ identityToken, opencodePassword }` — not in SQLite so backups of the DB don't leak credentials.

### 3. Environment server (`cc-env`)

#### 3.1 Process model
- Binary entry: `packages/env-server/src/main.ts` (compiled to `dist/cc-env` via tsup).
- Reads env:
  - `CC_WORKING_DIR` (required; absolute path).
  - `CC_PORT` (required; listens on loopback for local, `0.0.0.0` only in a container where the orchestrator routes to it).
  - `CC_IDENTITY_URL` (required; e.g. `https://cc.internal` or local dev URL).
  - `CC_STATE_DIR` (required; local uses `~/Library/Application Support/cc-env/`, container uses `/var/lib/cc-env/`).
  - `CC_KIND` (`container` | `local`).
  - For container boot only: `CC_ENV_TOKEN` (pre-seeded, so pairing is skipped) and `CC_IDENTITY_TOKEN` (pre-seeded).
- On start: run SQLite migrations → load secrets file → open pairing endpoints if no envToken → start Fastify with tRPC + WS + proxy → if `identityToken` present, bootstrap opencode (§3.4); otherwise mark `identityReady: false` and wait.
- `SIGTERM`: kill opencode child, flush state, exit.

#### 3.2 Router: `env` tRPC app

Procedures (mirror current routers, 1 env in scope):
- `meta.info()` → `{ kind, workingDir, opencodePort, opencodeReady, identityReady, version }`.
- `pair.start()` → `{ sessionId, code }`. Rejects if already paired.
- `pair.confirm({ sessionId, code })` → `{ envToken }`. Token hashed + stored in `envMeta`. Marks paired; no further pair endpoints until `pair.reset` (CLI only).
- `shell.list/create/resize/dispose/runOnce` — same inputs/outputs as today's `shell.*`, minus `sandboxId`.
- `fs.list/read/write/watch/find/diff` — scoped to `CC_WORKING_DIR`. Reject paths not resolving inside it (check after `realpath`).
- `agent.*` — all current procedures, minus `sandboxId`. Add `agent.restart()` → kills opencode child, re-fetches keys (§3.4), respawns.
- `agentShell.runOnce/open/write/close/tail`.
- `preview.config/ports/portsSnapshot`.
- `job.get/list/watch` (drop `listBySandbox`; plain `list`).
- `repo.list/add/remove` — per-env.

Auth middleware:
- `pair.*` — no auth; gated by "not paired".
- All others — `Authorization: Bearer <envToken>`. Constant-time compare against `envMeta.envToken_hash`.

#### 3.3 Non-tRPC endpoints
- `GET /healthz` — no auth, returns `{ ok: true, identityReady, opencodeReady }`.
- `GET /ws/shell/:id` — Fastify WebSocket. Auth: `envToken` in `sec-websocket-protocol` or `?token=` query. Same `terminalService.attach` flow as today.
- `ALL /agent/*` — HTTP proxy (incl. WS upgrade) to `127.0.0.1:<opencodePort>`. Strip leading `/agent`, attach opencode basic auth. Auth: `envToken` at the boundary (drop the current `sandboxId` URL parsing — there's only one opencode per env).

#### 3.4 Opencode lifecycle
- On first start AND on `agent.restart()`:
  1. `identityClient.env.resolveProviderKeys()` using `identityToken` → provider env map.
  2. `identityClient.env.getRepoConfig({ slug })` for each repo in `repos` table → apply rulesets to workingDir as today.
  3. Mint new `opencodePassword` (32 bytes base64url), persist hash to `envMeta`.
  4. Write per-env opencode config file at `$CC_STATE_DIR/xdg/config/opencode/opencode.json` pointing `plugin` at the bundled plugin path.
  5. Spawn child process: `opencode serve --port <CC_OPENCODE_PORT> --hostname 127.0.0.1` with env:
     - `OPENCODE_SERVER_PASSWORD=<opencodePassword>`
     - `XDG_CONFIG_HOME=$CC_STATE_DIR/xdg/config`
     - `XDG_DATA_HOME=$CC_STATE_DIR/xdg/data`
     - `CLOUDCODE_AGENT_TOKEN=<agent shell token, minted per start>`
     - `CLOUDCODE_APP_URL=<env server's own URL>` (plugin → env server, not back to central)
     - Provider keys from step 1.
     - `HOME` left alone in local mode; set to `/home/coder` in container mode.
  6. Poll `http://127.0.0.1:<opencodePort>/config` with basic auth until 2xx or 45s timeout.
- Port selection: `CC_OPENCODE_PORT` env var if set, else pick a free high port at first start and persist in `envMeta.opencodePort`.
- Cloudcode plugin: the container image ships it at `/opt/cloud-code-plugin/index.js`; the npm-bundled local variant ships it inside the `cc-env` install (resolve via `require.resolve` to give opencode an absolute `file://` URL).

#### 3.5 Identity client
Thin tRPC client against `CC_IDENTITY_URL`, bearer-authed with `identityToken`. Endpoints it calls:
- `env.resolveProviderKeys()`
- `env.getRepoConfig({ slug })`
On any `401` response, set `identityReady: false`, stop spawning opencode, surface in `meta.info`.

### 4. Orchestrator (`env` router in `cc-control`)

#### 4.1 Procedures
- `env.list()` → `[{ id, kind, label, url, status, lastSeenAt }]` for the caller's userId. No tokens returned.
- `env.get({ id })` → same shape + container metadata.
- `env.createContainer({ name })` → `{ id, url, envToken }`:
  1. Insert `envs` row with placeholder url.
  2. Call identity `envAuth.issueFromService({ userId, label })` → `identityToken`.
  3. Mint random `envToken` (32 bytes base64url).
  4. Create Docker container from the base image with env vars from §3.1 + `CC_ENV_TOKEN` + `CC_IDENTITY_TOKEN`. Working dir volume and `/var/lib/cc-env` volume same as today's workspace + opencode-data binds.
  5. Start container; wait for `GET /healthz` 200.
  6. Resolve container URL (docker network IP + port, or the reverse-proxy path the current deploy uses — keep the same preview/agent-proxy topology but now the whole env server lives there).
  7. Update `envs.url`; return.
- `env.archive({ id })`, `env.delete({ id })`, `env.restart({ id })` — container-only. Archive stops container but keeps the row; delete removes container + row; restart stops and re-starts (preserves `envToken` + `identityToken` by passing same env vars).
- `env.registerLocal({ url, envToken, label })` → `{ id }`:
  1. Probe `url + /healthz` with `envToken` to verify.
  2. Insert `envs` row with `kind='local'`, `url`, `label`.
  3. Do NOT persist `envToken`. Orchestrator treats local envs as opaque URLs.
- `env.unregister({ id })` — remove `envs` row (local or container-after-delete).
- `env.health({ id })` — probe `GET /healthz` (no auth required), update `lastSeenAt`, return status. Used by the webapp on the list screen; not a background poller.

Auth: session cookie, validated against identity's `webSessions`.

#### 4.2 Container image evolution
- `base-sandbox` image already has opencode + node. Add the `cc-env` binary to it (either baked in `COPY` at build time, or `npm i -g cc-env` at build time).
- Container `Cmd` changes from `tail -f /dev/null` to `cc-env`.
- `AgentService` in `cc-control` disappears — opencode lifecycle moves inside the env server; the orchestrator only cares about the container, not opencode.

### 5. Identity (`cc-control`)

#### 5.1 Changes to existing routers
None. `auth.*`, `settings.*`, `github.*`, `repoConfig.*` are unchanged; they continue to authenticate via session cookie.

#### 5.2 New routers

`envAuth.*` (public-ish; specific auth noted per proc):
- `issueFromService({ userId, label })` → `{ identityToken }`. Requires `X-CC-Service-Token: <service credential>`; token comes from `serviceCredentials` table. Only orchestrator holds this.
- `deviceStart()` → `{ deviceCode, userCode, verificationUrl, expiresIn }`. No auth. Creates an `envAuthDeviceRequests` row.
- `deviceConfirm({ userCode })` → `{ ok: true }`. Requires session cookie (user must be logged in). Sets `status='approved'`, records `userId`.
- `devicePoll({ deviceCode })` → `{ status: 'pending' } | { status: 'approved', identityToken } | { status: 'denied' | 'expired' }`. No auth; throttled to 5s poll interval.

`env.*` internal (authed by `Authorization: Bearer <identityToken>` against `envAuthTokens`):
- `env.resolveProviderKeys()` → `{ ANTHROPIC_API_KEY?, OPENAI_API_KEY?, ... }`. Reads from `secrets` for the token's `userId`.
- `env.getRepoConfig({ slug })` → existing repoConfig shape for the given slug. Only configs owned by token's `userId`.

Token lifetime: long-lived. `revokedAt` set on user-initiated revoke (CLI v1). All `env.*` calls check `revokedAt IS NULL`.

### 6. Pairing flow (local)

End-to-end:
1. Env server boot with no `envToken` in `envMeta` → `pair.*` endpoints active; all other env routers return `412 PRECONDITION_FAILED`.
2. User opens webapp → "Add local environment" dialog → `POST http://localhost:47821/trpc/pair.start` (no auth) → env server generates `sessionId` (UUID) + `code` (6 digits), stores in memory with 5-min expiry, logs `pair code: <code>` to stdout (visible via `log show --predicate 'subsystem contains "cc-env"'` on mac, or `journalctl` on linux).
3. User enters code → webapp `POST /trpc/pair.confirm { sessionId, code }` → env server:
   - Validate sessionId + code + not expired.
   - Generate `envToken` (32 bytes base64url).
   - Hash + store in `envMeta`.
   - Close all pending pair sessions.
   - Return `{ envToken }`.
4. Webapp stores `envToken` in localStorage under `envTokens[<orchestrator-envId>]`.
5. Webapp calls orchestrator `env.registerLocal({ url, envToken, label })` → orchestrator verifies env via `/healthz` + returns `envId`.
6. Webapp maps the localStorage token to that `envId` (re-key from a temp id to `envId`).

CLI: `cc-env pair reset` (local admin) truncates `envMeta.envToken_hash`, re-opens `pair.*`. Not a webapp feature.

### 7. `install.sh`

Bash script, POSIX-y. Lives at `scripts/install.sh` in repo; copyable via `curl | sh`.

Flow:
1. Detect OS; fail for non-mac/linux in v1. Pick install dir (`~/.local/bin`) and state dir.
2. Download the `cc-env` binary for the platform from the release URL (hard-coded to `$CC_ENV_RELEASE_URL`, default a GitHub Releases URL). Verify sha256.
3. Prompt: `workingDir` (absolute path, must exist and be a dir), `label` (default `basename workingDir`), `identityUrl` (default `https://cc.yourdomain.com` or from `$CC_IDENTITY_URL`).
4. Device-auth flow:
   - `curl -X POST $identityUrl/trpc/envAuth.deviceStart` → `{ userCode, verificationUrl, deviceCode }`.
   - Print: `Open $verificationUrl and enter code: $userCode` (and `open $verificationUrl` on mac).
   - Poll `envAuth.devicePoll` every 5s for up to 10min until `approved` → capture `identityToken`.
5. Write files:
   - `$stateDir/secrets.json` (mode 0600): `{"identityToken":"...","opencodePassword":""}`.
   - `~/Library/LaunchAgents/com.cloudcode.env.plist` (mac) / `~/.config/systemd/user/cc-env.service` (linux) with:
     - `ProgramArguments`: `[~/.local/bin/cc-env]`
     - `EnvironmentVariables`: `CC_WORKING_DIR`, `CC_PORT=47821`, `CC_IDENTITY_URL`, `CC_STATE_DIR`, `CC_KIND=local`
     - `RunAtLoad: true`, `KeepAlive: true`
     - `StandardOutPath` / `StandardErrorPath` set to `$stateDir/log/cc-env.log` for easy tailing by pairing code lookup.
6. `launchctl bootstrap gui/$(id -u) <plist>` / `systemctl --user enable --now cc-env`.
7. Print next step: "Open the webapp and run the pairing flow. Your code will be in `$stateDir/log/cc-env.log`."

Uninstall script `cc-env-uninstall.sh`: `launchctl bootout` + remove files. Not part of v1 deliverable; documented in install.md.

### 8. Webapp changes

#### 8.1 Env data model
```ts
type Env = {
  id: string          // orchestrator-assigned
  kind: 'container' | 'local'
  label: string
  url: string         // base URL for env server; may be https:// container or http://localhost:47821
  status: 'running' | 'archived' | 'unreachable'
  lastSeenAt?: string
}
```
Env tokens kept separately in localStorage: `envTokens: Record<envId, string>`.

#### 8.2 tRPC client factory
`src/trpc.ts` splits into three factories:
- `controlClient` — current client, bearer/cookie as today; talks to identity + orchestrator routers.
- `makeEnvClient(env: Env, token: string)` — tRPC client pointed at `env.url`. HTTP batch + WS links. Bearer token in headers. Per-env WebSocket URL constructed from `env.url`.
- Cached via a `Map<envId, ReturnType<typeof makeEnvClient>>` keyed by `envId`; invalidated on token change.

Query-key namespacing: all env-scoped queries use `['env', envId, …]` to avoid cache collisions across envs.

#### 8.3 New routes / flows
- **Env list** (`/envs`): uses `control.env.list`. Each row shows kind badge + reachability (`env.health` probed lazily on render).
- **Add local env dialog**: URL input (default `http://localhost:47821`) + pairing code input. On submit: `envClient = makeEnvClient(tempEnv, undefined)`; call `pair.start` → show code-entry UI → call `pair.confirm` → call `control.env.registerLocal` → navigate to new env.
- **Existing sandbox route** (`/sandbox/:id`) renames to `/env/:id`. Uses `makeEnvClient(env, envTokens[id])` for all per-env calls.
- **Settings → provider keys**: after a save mutation, show a toast "Apply to running environments?" with a button that fans out `agent.restart()` to each running env's client.

#### 8.4 Transport URL updates
- `xterm-attached.tsx`: build WS URL from `new URL('/ws/shell/' + shellId, env.url)`, attach `?token=` query.
- Opencode proxy: drop the central `/sandbox/:id/agent/*` path; use `new URL('/agent/...', env.url)` directly. Pass `envToken` in a header (not a cookie — cross-origin to localhost).

#### 8.5 Service worker
If a service worker exists: skip caching for localhost origins and for env-scoped URLs. Confirm in implementation.

### 9. Migration from current monolith

v1 strategy: **do not migrate existing sandboxes**. Dev data only. Ship path:
1. Tag a release of the current monolith as `legacy-monolith`.
2. Drop the current `sandboxes`, `repos`, `shellSessions`, `agentSessions`, `agentTranscripts`, `agentShellTokens`, `jobs` tables from the central Postgres; replace with the new `envs` table and the `envAuth*` tables.
3. Rebuild container image with `cc-env` baked in.
4. Users recreate environments post-migration.

If later a migration is wanted: orchestrator gets a one-shot `migrateLegacySandbox` script that (a) starts a cc-env container for the sandbox, (b) restores its per-env tables into the container's SQLite, (c) writes the `envs` row.

### 10. Dev and deployment

Local dev:
- `npm run dev` in the root runs `cc-control` (current behavior minus per-env code).
- `npm run dev:env -- --working-dir=/tmp/foo` runs a local `cc-env` on port 47821 pointed at `http://localhost:3000` for identity. Skip device-auth by allowing a `CC_IDENTITY_TOKEN_FILE` bypass in dev.
- Docker sandboxes work as today, just with the new image + `cc-env` as PID 1.

Prod:
- Existing deploy (Fly.io / Docker Compose) runs `cc-control` as before.
- Container envs spawned inside the sandbox docker host continue to listen on the existing docker network; the reverse proxy now routes all `/env/:id/*` paths straight to the env container instead of through the old `/sandbox/:id/agent/*` + `/ws/shell/:id` handlers.
- `install.sh` pointed at `CC_IDENTITY_URL=https://cc.<domain>` is how users self-onboard.

### 11. Non-goals (v1)

- No workspace concept (multiple local envs per user); one install.sh run = one local env.
- No binary auto-update.
- No web-UI token revoke; CLI only.
- No offline-first env server; `identityReady: false` just blocks opencode, not shells/fs.
- No SSO between identity and container envs beyond `identityToken`.
- No TLS on local env server (loopback only).
