# Cloud Coding Environment — Spec

## Seed

A cloud coding environment we can run via Docker inside a VPC. It exposes a single web service with a password-gated web UI (password set at install time). From the UI, a user creates **sandboxes**. Inside a sandbox they can pull in one or more repositories and either start dev servers directly in the sandbox container or spin up per-repo Docker containers. The web UI exposes:

- A simple file explorer for the workspace and its repos.
- Live shell sessions.
- **GitHub integration** — user connects their GitHub org; the UI lists org repos and clones them into a sandbox with stored credentials.
- A built-in **coding agent** running inside the environment with its own session UI (watch/steer). The external agent that speaks the Agent Tool Protocol is an **orchestrator** for this internal agent — it starts sessions, feeds them prompts, and observes their work. Direct file/shell tools still exist for cases where the orchestrator wants fine-grained control.
- The UI registers as an **Agent Tool Protocol** provider. This is spec #2 of the pair; it is the first real consumer of the protocol defined in `docs/fractal/2026-04-18-agent-tool-protocol/`.

## Outline

### Deployment & install

- Single Docker image for the main app, run inside a VPC by the operator. Behind their own reverse proxy / TLS termination (we don't ship TLS).
- Install-time bootstrap sets the admin password (env var or first-run prompt). Password hash stored in a persistent volume alongside all state.
- **Only the main app has Docker socket access** — it's the sole privileged boundary. Uses it exclusively to start/stop/exec sandbox containers. No general-purpose container server and no "spawn arbitrary sibling containers" surface in v1.
- State persisted under a single mounted volume (`/data`): sandboxes, repos, credentials, session logs, agent transcripts.

### Auth & multi-tenancy

- **Single tenant, single admin password.** Aligned with "password set on setup." No user accounts, no RBAC in v1.
- Web login sets an HTTP-only session cookie. Agent Tool Protocol handshake returns its own bearer token scoped per-sandbox.
- GitHub integration is org-wide, not per-user — one GitHub App install per deployment.

### Sandboxes

- A sandbox = `{ name, container, workspace dir on /data, shells, agent sessions }`. Lifecycle: create → active → archived/deleted. Archive stops the container but keeps the workspace on disk.
- **One container per sandbox**, spawned by the main app from a known base image (pre-baked with git, node, python, common build tools, the internal agent binary).
- Workspace lives at `/data/sandboxes/<name>/` on the host volume, bind-mounted into the sandbox container at a fixed path (`/workspace`). Repos live under `/workspace/repos/<repo>`.
- Sandboxes are on a shared Docker network so the main app can reach them for exec, file I/O, and reverse-proxying preview ports.

### Running code & previews

- **No dev-server service.** A "dev server" is just a shell running a long-lived command. Start = open a shell and run it. Stop = Ctrl+C the shell or dispose it. Logs = the shell's scrollback. Agent and human use the same mechanism.
- **`PreviewService`** handles the two things that aren't shell concerns: (a) scanning which ports are listening inside the sandbox (via `ss -lntp` polled every 3s), and (b) reverse-proxying `/preview/<sandbox>/<port>/*` to the sandbox's container IP on the Docker network. The scan result is published to the UI as the "Ports" panel. No host port mappings.
- **Optional convenience later:** a `saved_commands` table (`{ sandboxId, name, cwd, command }`) so "Run dev server" can be a named button that opens a shell + sends the command. Not in v1 critical path.
- **Docker-enabled sandboxes (deferred, v2)**: opt-in flag attaches a DinD sidecar (or uses sysbox-runc if the operator installed it) and sets `DOCKER_HOST` in the sandbox. Lets users run compose stacks / testcontainers. Designed in now, not built in v1 — users who need Docker inside a sandbox wait for v2.

### File explorer

- Read-only-first tree view of the sandbox workspace; open file → render with syntax highlight.
- Editing is possible but the **coding agent** is the primary author — v1 file editor can be minimal (textarea + save) since real edits flow through the agent.
- Watches the FS for changes so agent-authored edits show up live.

### Shells

- **Session manager lives in the main app, not the sandbox.** A small `TerminalService` built on `node-pty` + `@xterm/headless` + `@xterm/addon-serialize`. Proven stack (Coder, Gitpod, code-server use variants of it). Faster than tmux in practice: direct byte path from sandbox PTY → node-pty → WebSocket, no PTY-in-PTY.
- **Per session state:** `{ id, sandboxId, ptyProcess, headlessTerm, subscribers[] }`. Operations: create, attach, detach, resize, sendKeys, getScrollback, dispose.
- **How the PTY gets into the sandbox:** `ptyProcess = spawn("docker", ["exec", "-it", sandboxId, "bash"], { ... })` with cwd/env set via `docker exec` flags. The node-pty is local to the main app; the shell it runs is inside the sandbox.
- **Scrollback on reconnect:** `@xterm/addon-serialize` snapshots the headless terminal; the browser replays it, then switches to live stream. Configurable buffer size (default ~10k lines).
- **Persistence:** survives browser refresh/disconnect. Does **not** survive sandbox restart (pty dies with `docker exec`) or main-app restart (headless term is in-memory). Acceptable for v1.
- **Browser side:** xterm.js over WebSocket. One socket per attached session.
- **`shell.runCommand`** bypasses the session manager — plain `docker exec`, capture `stdout`/`stderr`/`exitCode`, return. No PTY, no scrollback overhead.
- **`shell.output` protocol event** streams live bytes from a session so the orchestrator can tail without the UI.
- Each shell is tied to a sandbox; cwd defaults to the sandbox workspace or a selected repo.

### GitHub integration

- **GitHub App**, not OAuth — installed once into the user's GitHub org at setup. Stores the install id + private key on the mounted volume.
- Provides: list org repos, clone with short-lived installation token, push branches, open PRs. No pull of private org secrets.
- Per-sandbox credential scope: a sandbox can access only the repos the user explicitly added to it.

### Built-in coding agent

- **Engine: [OpenCode](https://opencode.ai).** Self-hosted, open-source, supports 75+ models, headless-server mode (REST + SSE), JS/TS SDK, built-in permission/approval flow. Matches every requirement we'd otherwise build ourselves.
- **One `opencode serve` process per sandbox**, started inside the sandbox container (via `docker exec`) with cwd pinned to `/workspace`. Sessions live inside that server. Bound to localhost inside the container; the main app reaches it over the sandbox's Docker network.
- **UI: drop in `opencode web` for v1.** Main app iframes/reverse-proxies it at `/sandbox/<name>/agent/`. Avoids building a session UI from scratch. If the embed UX falls short (deep-linking to a specific session, approval handoff, session-list filtering by sandbox), we build our own on the SDK later — no other architectural change needed.
- **Protocol surface is independent of the UI.** Orchestrator tools (`agent.session_start`, `agent.session_send`, `agent.session_approve`, `agent.transcript_delta` events) call OpenCode's HTTP/SSE API via the SDK from the main app. Works whether the UI is iframed or native.
- Auth: the sandbox's `opencode serve` uses OpenCode's env-var password, seeded at container start from a value only the main app knows. End users reach it only through the authenticated reverse-proxy path.
- Session state persistence is OpenCode's responsibility; its session store lives on the sandbox workspace volume (`/workspace/.opencode` or similar) so sessions survive sandbox restarts along with the workspace.
- Model/provider credentials: the main app injects provider API keys (Anthropic, OpenAI, etc.) into `opencode serve`'s env at start. Keys stored encrypted-at-rest in `/data`.

### Agent Tool Protocol surface

- Manifest served at `/.well-known/agent-tools.json`; `<link rel="agent-tools">` in the web UI's HTML.
- **Session-oriented tools (endpoint mode — survive tab close):**
  - `sandbox.list` / `sandbox.create` / `sandbox.archive`
  - `repo.add` (clones from GitHub App or URL into sandbox)
  - `preview.ports` — list currently-listening ports in a sandbox (for "where's the dev server?").
  - `agent.session_start` (sandbox + initial prompt + optional repo list) → returns session id
  - `agent.session_send` (follow-up message to a live session)
  - `agent.session_status` (current state + pending approvals)
  - `agent.session_approve` / `agent.session_reject` (resolve pending gate)
- **Fine-grained tools (for when the orchestrator wants to bypass the built-in agent):**
  - `fs.read` / `fs.write` / `fs.list` (sandbox-scoped)
  - `shell.runCommand` — one-off command exec in the sandbox; returns `{ stdout, stderr, exitCode }` (streaming optional). For the orchestrator's "just run `git status`" case without spinning up a persistent shell.
  - `shell.open` / `shell.write` / `shell.close` — persistent interactive shells. Dev servers are just long-lived shells.
- **Page-mode tools** (tiny surface):
  - `session.handshake` — the required page-mode handshake from protocol spec.
  - `workspace.current_context` — which sandbox the UI is focused on, currently open file.
- **Events stream:** `agent.transcript_delta`, `agent.pending_approval`, `shell.output`, `preview.ports_changed`, `session.invalidate`.

### State & persistence

- Everything under `/data`: `auth/`, `github/`, `sandboxes/<name>/{repos,shells,agent-sessions}/`, `tokens/`.
- Agent transcripts and shell scrollback are the largest items — size caps + rotation per session.
- Backup story: "snapshot the volume." Nothing fancier in v1.

### Security

- Password brute-force throttle; single admin cookie with short idle timeout.
- GitHub App private key + agent API keys stored encrypted-at-rest with a key derived from the install password (so snapshots of `/data` alone aren't useful).
- Docker socket lives only in the main app container and is only used for sandbox lifecycle + exec. Arbitrary-container spawning is not exposed to sandboxes in v1 (so a rogue agent can't use it to escape).
- Sandbox container runs as non-root by default, with a resource ceiling (cpu/mem/pids) and no host network. Agent and shell commands inherit that confinement.
- CSP on the web UI; origin-locked manifest; agent-tool handshake requires the admin session cookie before issuing a bearer token.

### Non-goals (v1)

- Multi-user accounts, team RBAC, audit logs beyond session transcripts.
- Docker-enabled sandboxes (DinD / sysbox). Designed in, not built.
- Pluggable container runtimes / multi-VPC placement. Single-host Docker only; revisit when multi-host is a real need.
- Hot-migrating a sandbox across hosts.
- Running on Kubernetes / non-Docker hosts.
- GPU / heavy-compute workloads.

## Spec

### System shape

Single deployment = three containers on the operator's Docker host, glued by a shared network and a `/data` volume:

1. **`app`** — Node 20+ / TypeScript. Serves the React UI, the HTTP API, all WebSockets, the reverse proxy, and the Agent Tool Protocol endpoints. Holds all the session managers. The only container with the Docker socket mounted.
2. **`postgres`** — stock Postgres 16. Metadata + auth + transcripts.
3. **sandbox containers** (0..N) — spawned by `app` on demand. One per sandbox. Not running at boot.

`app` is a single Node process. It has these internal services (boundaries, not necessarily separate modules): `AuthService`, `SandboxManager`, `RepoService`, `GitHubService`, `FileService`, `TerminalService`, `PreviewService` (port scan + reverse proxy together), `AgentService`, `ProtocolGateway`, `AgentUIProxy`.

### Tech stack

- **Backend:** Node 20+, TypeScript. **Fastify** as the HTTP host. **tRPC** (`@trpc/server` via the Fastify adapter) for the internal UI↔backend API — queries, mutations, and subscriptions for JSON event streams. Fastify handles the non-tRPC surfaces: raw-WS PTY streams, the Agent Tool Protocol endpoints (JSON-RPC 2.0 per spec #1), reverse proxies, static SPA. Plus: `dockerode`, `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `pg` + `drizzle-orm`, `zod`, `bcrypt`, `chokidar`, `@opencode-ai/sdk`, `undici`.
- **Frontend:** React 19, Vite, Tailwind v4, **shadcn/ui**, `xterm.js` + `xterm-addon-fit`, `@trpc/client` + `@trpc/react-query` (wraps TanStack Query), TanStack Router.
- **DB:** Postgres 16.
- **Build/ship:** single `app` Docker image (multi-stage build, serves built SPA as static). Separate base-sandbox image.

### Database schema (Postgres, drizzle)

Tables, condensed:

- `admin` — single-row: `password_hash`, `created_at`. (No multi-user in v1.)
- `web_sessions` — `id`, `expires_at`, `last_seen`. Cookie stores `id`.
- `github_install` — `installation_id`, `app_id`, `org_login`, `encrypted_private_key_ref`, `connected_at`.
- `sandboxes` — `id` (ulid), `name`, `container_id` (nullable when archived), `status` (`active` | `archived` | `crashed`), `opencode_port`, `opencode_password_enc`, `created_at`.
- `repos` — `id`, `sandbox_id`, `name`, `origin_url`, `ref`, `workspace_path`, `source` (`github` | `url`), `github_repo_id?`.
- `shell_sessions` — `id`, `sandbox_id`, `cwd`, `cols`, `rows`, `created_at`, `last_activity_at`. (Scrollback lives in-memory in `TerminalService`, not in the DB.)
- `agent_sessions` — `id`, `sandbox_id`, `opencode_session_id`, `title`, `created_at`, `archived_at?`.
- `agent_transcripts` — append-only mirror of OpenCode's message stream, for cross-session search. `session_id`, `seq`, `role`, `content_json`, `ts`.
- `agent_tokens` — `token_hash`, `sandbox_id`, `scopes_json`, `expires_at`, `issued_for_cookie` (binds the bearer to a specific admin login).
- `secrets` — `name`, `ciphertext`, `iv`, `created_at`. Key material wraps GitHub App private key, provider API keys, and per-sandbox OpenCode passwords.

All `*_id` foreign keys cascade on sandbox delete.

### Configuration & install

Env vars on `app`:

- `DATABASE_URL`
- `DATA_DIR` (default `/data`)
- `PUBLIC_URL` (used in GitHub App callback + manifest origin)
- `ADMIN_PASSWORD_BOOTSTRAP?` (optional; seeds first install non-interactively)
- `SANDBOX_BASE_IMAGE` (default `ghcr.io/<us>/cloud-code-sandbox:<tag>`)
- `DOCKER_NETWORK` (default `cloud-code-net`)

First-run (no `admin` row): if `ADMIN_PASSWORD_BOOTSTRAP` is set, seed from it; else the login page shows a "set password" form. Master encryption key (`secrets.key`) generated on first run into `DATA_DIR/secrets.key` (mode 0600). All DB `secrets` rows are encrypted with it.

### Auth flows

- **Login:** `auth.login.mutate({ password })`. bcrypt compare; create `web_sessions` row; set `Set-Cookie: sid=...; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=...`. 30-min idle timeout, 7-day absolute.
- **Logout:** `auth.logout.mutate()` — delete session row + clear cookie.
- tRPC `createContext` reads `sid` from the cookie, hydrates `{ isAdmin, webSessionId }`. A `protectedProcedure` middleware gates everything except login + first-run bootstrap.
- **Agent handshake (page-mode tool):** requires the admin cookie on the tab. Generates a 256-bit token, stores `sha256(token)` in `agent_tokens` bound to current focused sandbox, returns `{ token, expiresAt, context: { sandboxId } }` to the caller. TTL 1h.
- **Endpoint-mode calls** (`/agent/rpc`): require `Authorization: Bearer <token>` AND a `meta.context.sandboxId` matching the token's bound sandbox. Token hash lookup; constant-time compare.

### Sandbox lifecycle

- **Create** (`SandboxManager.create({ name })`):
  1. insert `sandboxes` row with random id + `status=active`
  2. `mkdir -p /data/sandboxes/<id>/{workspace,opencode}`
  3. `docker create` from `SANDBOX_BASE_IMAGE`, with bind mounts for `workspace` → `/workspace` and `opencode` → `/home/coder/.opencode`, on `DOCKER_NETWORK`, labels `coding-env.sandbox=<id>`, resource caps (`--cpus=2 --memory=4g --pids-limit=512`), no host network, read-only rootfs with tmpfs on `/tmp`, `/run`.
  4. `docker start`
  5. `docker exec -d opencode serve --port <free> --hostname 127.0.0.1` with env including random `OPENCODE_PASSWORD` and injected provider keys; store port + encrypted password.
  6. Wait for OpenCode readiness probe on `/config` endpoint (5s timeout; retry once; else mark `crashed`).
- **List:** join DB rows with live docker state (via dockerode); surface diffs as `status=crashed` when container is gone.
- **Archive:** stop container, clear `container_id`, keep workspace dir.
- **Delete:** archive first, then `rm -rf` workspace dir and cascade DB rows.
- **App-boot reconciler:** on startup, for each `status=active` sandbox, verify the container exists (by label) and is running; start if stopped; mark `crashed` if missing.

### Base sandbox image

- From `debian:bookworm-slim`.
- Installs: `git`, `curl`, `ca-certificates`, `bash`, `coreutils`, `procps`, `iproute2` (for port scan), `python3`, `nodejs` (nvm-less, via Nodesource), build-essentials, `opencode` (pinned version).
- Non-root user `coder` (uid/gid 1000 — matches `app` container's expected workspace owner).
- Entrypoint: `tail -f /dev/null` (idle; app execs in).

### Repo management

- **GitHub source:** `repo.add.mutate({ sandboxId, source: "github", repoFullName, ref })`. Service mints installation token, `git clone` via `docker exec` in sandbox.
- **URL source:** `{ source: "url", url, ref, credentialRef? }`. Optional stored PAT for private clones.
- Clone runs as a job record. Progress streamed via `job.watch.subscribe({ jobId })` (tRPC subscription).
- Repos live at `/workspace/repos/<repo-slug>` inside the sandbox.

### GitHub integration

- **Bootstrap via GitHub App Manifest flow:** `GET /api/github/connect` returns a manifest POST form that redirects to `github.com/organizations/<org>/settings/apps/new?state=<csrf>&manifest=<json>`; GitHub redirects back to `PUBLIC_URL/api/github/callback?code=...`; app exchanges the code for the app credentials (id, webhook secret, PEM) and stores them in `github_install` + `secrets`.
- Permissions requested: contents (read/write), pull_requests (write), metadata (read).
- **Installation token minting** per request: JWT from PEM → exchange for installation token; 60-min cache.
- List-org-repos endpoint backs the "Add repo" picker.

### PreviewService (port scan + reverse proxy)

- **Port scan:** every 3s per active sandbox, `docker exec <sandboxId> ss -lntp` → parse → diff → emit the current listening-port set over a tRPC subscription (`preview.ports.subscribe({ sandboxId })`). Cached per-sandbox in memory.
- **Reverse proxy:** `/preview/:sandboxId/:port/*` → `undici` HTTP/WS proxy to the sandbox container's IP on the Docker network. WebSocket upgrades supported. Iframe-friendly headers stripped (remove `X-Frame-Options`, rewrite `Content-Security-Policy` if present — scoped to preview routes only).
- **Access check:** proxy requires the admin cookie, same as the rest of the app.
- **No "dev server" concept.** Dev servers are shells running long-lived commands; stop/start by shell operations. UI's "Ports" panel is the source of truth for "what's runnable as a preview."

### File explorer

- Because `/data/sandboxes/<id>/workspace` is bind-mounted on the host, **`app` reads/writes it directly via host `fs`** (no `docker exec` round-trip). Shared uid 1000 across app + sandbox avoids perms issues.
- tRPC: `fs.list.query({ sandboxId, path })` → entries one level deep. `fs.read.query({ sandboxId, path })` → contents (capped at 5 MB). `fs.write.mutate({ sandboxId, path, content })`.
- **Watcher:** `chokidar` on the workspace; streamed via `fs.watch.subscribe({ sandboxId })`. Debounced.
- Binary detection via file-type sniff; binaries show a placeholder in the UI.

### TerminalService (shells)

```ts
class TerminalService {
  create(opts: { sandboxId: string; cwd?: string; cols: number; rows: number }): { id: string }
  attach(id: string, ws: WebSocket): void        // sends snapshot then live bytes
  resize(id: string, cols: number, rows: number): void
  sendKeys(id: string, data: string): void
  dispose(id: string): void
  runOnce(opts: { sandboxId: string; cmd: string; cwd?: string; timeoutMs?: number })
    : Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }>
}
```

- `create`: `pty.spawn("docker", ["exec", "-it", "-w", cwd, sandboxId, "bash"], { cols, rows })`. Pipe stdout through `@xterm/headless` instance (buffer 10k lines). Write `shell_sessions` row.
- `attach`: send `@xterm/addon-serialize` snapshot on open, then forward live bytes. Multiple subscribers per session OK.
- `runOnce`: `docker exec` without pty, stdout/stderr capped at 10 MB each, `truncated: true` if hit.
- Disposal: on sandbox stop/delete, drop all its sessions.
- **Transport split:** control plane (create / resize / dispose / runOnce / list) is tRPC (`shell.*` procedures). The byte stream is a **raw WebSocket** at `/ws/shell/:id` — tRPC subscriptions serialize per-message and add overhead we don't want for high-frequency PTY bytes. The WS upgrade checks the admin cookie.

### Agent integration (OpenCode)

- **Per-sandbox client:** `new OpenCodeClient({ baseUrl: http://<sandbox-ip>:<port>, password: <decrypted> })`, cached by sandbox id.
- **Tool → SDK mapping:**
  - `agent.session_start({ sandboxId, prompt, model?, title? })` → `client.session.create()` + `client.session.prompt()`; insert `agent_sessions` row; return our id.
  - `agent.session_send({ sessionId, message })` → lookup, `client.session.prompt()`.
  - `agent.session_status({ sessionId })` → `client.session.get()` + pending approvals.
  - `agent.session_approve / reject` → OpenCode permission endpoints.
- **Transcript mirror:** subscribe to `client.event.subscribe()` per active session; append messages to `agent_transcripts`; forward to `AgentService` subscribers as `agent.transcript_delta` protocol events.
- **UI embed (`AgentUIProxy`):** `/sandbox/:id/agent/*` proxies to the sandbox's `opencode web` (served by `opencode serve`'s web handler). Proxy injects the `Authorization` header from the stored password so the iframe doesn't prompt for a second login. Fallback if OpenCode doesn't support header-based auth on its web UI (**verify during implementation**): keep a `/api/agent-ui-token` endpoint that returns a signed URL with the password encoded, consumed by the proxy's `beforeRequest`. If neither works, fall back to building our own UI on the SDK (outline-level decision already).

### Agent Tool Protocol (manifest + endpoints)

- **Served:** `/.well-known/agent-tools.json` (public). HTML shell includes `<link rel="agent-tools" href="/.well-known/agent-tools.json">`.
- Manifest fields (per spec #1): `protocolVersion: "0.1"`, `server: { rpcUrl: "/agent/rpc", eventsUrl: "/agent/events" }`, `session: { handshakeTool: "session.handshake" }`, `instructions: { static: { url: "/agent/instructions.md" }, dynamicSource: "workspace.current_context", dynamicMaxTokens: 3000 }`, plus full `tools[]` and `events[]`.
- **`/agent/rpc`**: JSON-RPC 2.0 POST. Supported methods = endpoint-mode tools from the Outline. Page-mode tools are handled in the browser via the page-mode SDK (a small `/agent/page-sdk.js` we ship from the HTML shell), *not* at this endpoint.
- **`/agent/events`**: SSE. Event types: `agent.transcript_delta`, `agent.pending_approval`, `shell.output`, `preview.ports_changed`, `fs.changed`, `session.invalidate`.
- **Cancellation:** `$/cancel` JSON-RPC method; cancels by request id (aborts `docker exec` streams, forwards cancel to OpenCode where supported).

### Reverse proxy routing (inside `app`)

- `/trpc/*` → tRPC router (queries, mutations, subscriptions over the Fastify adapter). The internal UI API.
- `/ws/shell/:id` → raw WebSocket for PTY bytes.
- `/agent/rpc`, `/agent/events`, `/.well-known/agent-tools.json`, `/agent/instructions.md`, `/agent/page-sdk.js` → Agent Tool Protocol (external; not tRPC).
- `/sandbox/:id/agent/*` → `AgentUIProxy` → OpenCode web in the sandbox.
- `/preview/:sandbox/:port/*` → `PreviewProxy` → sandbox container.
- `/*` → static React SPA.

### Persistence layout (`/data`)

```
/data
├── secrets.key                         # master encryption key, 0600
├── github-app/
│   └── private-key.pem                 # referenced by secrets.encrypted_private_key_ref
├── sandboxes/
│   └── <sandbox-id>/
│       ├── workspace/                  # bind-mounted → /workspace in the sandbox
│       └── opencode/                   # bind-mounted → /home/coder/.opencode
└── postgres/                           # if operator opts into in-deployment Postgres
```

### Security details

- Login throttling: progressive backoff (2⁴→2^n seconds) per source IP; lock at 10 failures within 10 min.
- Cookies: `HttpOnly; Secure; SameSite=Strict`. CSRF token required for non-GET API calls.
- CSP on the SPA: `default-src 'self'; frame-src 'self'; connect-src 'self' wss:; script-src 'self'`. `frame-ancestors 'self'` so we can safely iframe `opencode web` from the same origin.
- Preview routes served from a subdomain in future (to sandbox cookies). v1: accept that preview content shares the main origin; warn in docs.
- Sandbox containers: non-root, read-only rootfs, tmpfs for `/tmp` and `/run`, `--pids-limit`, `--cpus`, `--memory`, no host network. No capabilities beyond default. `no-new-privileges`.
- Agent tokens: stored only as `sha256`; 1h TTL; invalidated on admin logout.
- Audit: every state-changing API call + every endpoint-mode tool call logged (JSONL in `/data/audit/`).

### tRPC router shape (sketch)

```ts
appRouter = router({
  auth:       router({ login, logout, status }),
  sandbox:    router({ list, create, archive, delete, get }),
  repo:       router({ list, add, remove }),
  github:     router({ connectStart, connectCallback, listOrgRepos, status }),
  fs:         router({ list, read, write, watch /* subscription */ }),
  shell:      router({ list, create, resize, dispose, runOnce }), // byte stream is raw WS
  preview:    router({ ports /* subscription */ }),
  agent:      router({ sessionList, sessionStart, sessionSend, sessionStatus,
                       sessionApprove, sessionReject,
                       transcript /* subscription */, pendingApproval /* subscription */ }),
  job:        router({ watch /* subscription */ }),
  settings:   router({ providers, setProviderKey }),
})
```

Every procedure validates input with `zod` and runs under `protectedProcedure` (cookie-authed) unless marked public (login, first-run bootstrap, GitHub App callback).

### Dependencies (pinned in package.json)

Backend: `fastify`, `@fastify/static`, `@trpc/server`, `@trpc/server/adapters/fastify`, `ws`, `dockerode`, `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `drizzle-orm`, `pg`, `zod`, `bcrypt`, `chokidar`, `undici`, `@opencode-ai/sdk`, `jose` (for GitHub App JWT), `pino` (logging), `ulid`, `superjson`.

Frontend: `react`, `react-dom`, `@trpc/client`, `@trpc/react-query`, `@tanstack/react-query`, `@tanstack/react-router`, `tailwindcss`, `@radix-ui/*` (via shadcn), `xterm`, `xterm-addon-fit`, `xterm-addon-web-links`, `superjson`.

Dev: `typescript`, `vitest`, `playwright`, `@testing-library/react`, `drizzle-kit`, `tsx`, `tsup` (or `esbuild`).

### Edge cases

- **App restart with active sandboxes:** boot reconciler reads Docker labels → rebinds session records → restarts OpenCode processes inside surviving containers. Shell sessions are lost (browser will auto-reconnect to a fresh session).
- **Sandbox container crash:** reconciler marks `crashed`; UI shows a restart button.
- **OpenCode process dies:** `AgentService` detects on SDK call failure; attempts one restart; else marks sessions `unavailable` and surfaces error.
- **Browser tab close mid-clone:** job keeps running server-side; UI reconnects via `/ws/jobs/:id`.
- **Token expiry mid-stream:** endpoint returns `E_SESSION_EXPIRED`; orchestrator re-handshakes.
- **GitHub App not connected:** `repo.add` with `source=github` returns a clear error pointing at the Connect flow; URL source still works.
- **Long-running shell output:** scrollback cap in `@xterm/headless` (10k lines) bounds memory; oldest lines fall off the buffer. Clients attaching late see only what's in the buffer.
- **Two browser tabs on the same shell:** both subscribe; keystrokes from either are merged.
- **Password set via bootstrap env var, then removed:** subsequent restarts don't re-seed; the stored password wins.
- **Docker daemon unreachable on boot:** `app` refuses to start; health endpoint reports clear error so the operator sees it.
