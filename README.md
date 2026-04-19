# Cloud Coding Environment

A cloud coding environment that runs as a single Docker deployment inside a VPC. See the fractal spec for the big picture:

- [`docs/fractal/2026-04-18-cloud-coding-env/cloud-coding-env-spec.md`](docs/fractal/2026-04-18-cloud-coding-env/cloud-coding-env-spec.md)
- [`docs/fractal/2026-04-18-cloud-coding-env/cloud-coding-env-plan.md`](docs/fractal/2026-04-18-cloud-coding-env/cloud-coding-env-plan.md)

## Status — Phase 4

Shipped in Phase 4 (in addition to Phase 3):

- Built-in **OpenCode agent**: each active sandbox gets `opencode serve` bootstrapped on container start, bound to the container's docker-network IP (never published to the host) and gated by a per-sandbox random bearer token stored encrypted in `secrets`.
- `AgentService` — tRPC `agent.*` surface: `sessionList`, `sessionStart`, `sessionSend`, `sessionStatus`, `sessionApprove`, `sessionReject`, and a `transcript` subscription. Pending approvals are tracked in-memory and mirrored via events; `agent_sessions` + `agent_transcripts` persist a minimal cross-session history.
- `AgentUIProxy` — `/sandbox/:id/agent/*` (HTTP + WS) reverse-proxies the OpenCode web UI. Admin cookie gates the proxy; the bearer token is injected as `Authorization` upstream so the embedded iframe doesn't prompt for a second login.
- **Provider keys**: Settings UI for Anthropic and OpenAI (API key + optional base URL). Stored encrypted; the sandbox's `opencode serve` receives them via `-e` flags at start.
- **Env bootstrap**: `ANTHROPIC_API_KEY_BOOTSTRAP` / `ANTHROPIC_BASE_URL_BOOTSTRAP` (and OpenAI equivalents) seed the encrypted store on first run. A one-line log tells the operator they can unset the env var afterwards.
- **Upgrading existing sandboxes**: the sandbox detail page shows an "Agent not running" state with a "Start agent" button for sandboxes created before Phase 4 — the boot reconciler also auto-starts OpenCode on surviving sandboxes.
- **Loopback rewrite**: provider base URLs like `http://localhost:8137` (common for local LiteLLM / Anthropic-compatible proxies) are rewritten to `http://host.docker.internal:8137` before being injected into the sandbox. New sandbox containers get `ExtraHosts: host.docker.internal:host-gateway` so this works on both Docker Desktop and Linux hosts.

Shipped in Phase 3 (in addition to Phase 2):

- `RepoService` — per-sandbox repo management. `repo.list` / `repo.add` / `repo.remove` tRPC procedures. Clones run through an in-container `git clone` and are tracked by a `jobs` row; progress streams to subscribers.
- `JobManager` — generic job record + in-memory log buffer (500 lines) + tRPC `job.watch` subscription. Reconnect-friendly: `job.get` returns the current state for polling fallback.
- `GitHubService` — GitHub App manifest bootstrap (`/api/github/connect` auto-submits the form; `/api/github/callback` exchanges the code; `/api/github/setup` captures the installation id). Installation tokens minted via RS256 JWT, cached per-process and in `github_token_cache` (60 min). `github.listOrgRepos` returns the install-scoped repo list.
- `PreviewService` — per-sandbox `ss -lntp` poll every 3 s; diffs emitted over `preview.ports` subscription. Reverse proxy at `/preview/:sandboxId/:port/*` (HTTP + WebSocket), admin-cookie auth, strips `X-Frame-Options` / CSP so iframes load.
- Settings route (`/settings`) with GitHub connect/disconnect.
- Sandbox detail: tabbed sidebar (files / repos / ports), with a repo picker (URL or GitHub installation), a ports panel with one-click preview, and an iframe pane.

Shipped in Phase 2 (in addition to Phase 1):

- `SandboxManager` — create / list / archive / delete / restart containers from the `base-sandbox` image, with bind-mounted workspace + opencode dirs, resource caps, read-only rootfs, and a boot-time reconciler.
- `FileService` — host-side `fs` access to the bind-mounted workspace: `fs.list`, `fs.read` (5 MB cap, binary detection), `fs.write`, plus a debounced `chokidar` `fs.watch` tRPC subscription.
- `TerminalService` — `node-pty` PTYs via `docker exec`, buffered through `@xterm/headless` with `@xterm/addon-serialize` for snapshot replay; multi-subscriber attach; `runOnce` bypass with 10 MB cap + timeout; raw WebSocket transport at `/ws/shell/:id`.
- tRPC routers: `sandbox.*`, `fs.*`, `shell.*`, all `protectedProcedure` + zod.
- Frontend: sandbox list on `/` with create/archive/delete/restart; `/sandbox/:id` with a live file tree, minimal textarea editor, and an xterm.js terminal wired to the WS endpoint.
- `docker-compose.yml` now mounts `/var/run/docker.sock` into the `app` container so it can manage sandboxes; runtime image ships the `docker` CLI and native build tools for `node-pty`.

Shipped in Phase 1:

- Monorepo scaffold (TypeScript, Vite, Fastify, tRPC, Drizzle, React 19, Tailwind v4).
- `app` Docker image (multi-stage build, production bundle served by Fastify).
- Base sandbox Docker image (Debian + git + node + python + opencode, runs as uid 1000).
- Postgres 16 via `docker compose`.
- Drizzle schema and SQL migrations, auto-applied on startup.
- Master encryption key (`DATA_DIR/secrets.key`, mode 0600) with AES-256-GCM wrap/unwrap.
- Admin auth: bootstrap, login, logout, session cookies (30-min idle, 7-day absolute), brute-force throttle.

## Requirements

- Node.js 20.11+
- Docker 24+ (for compose-based run; not required for `npm run dev` unit tests).
- A running Postgres 16 for local dev (the bundled compose file brings one up).

## Quick start — `docker compose`

```bash
cp .env.example .env
docker compose build
docker compose up
```

Open <http://localhost:3000>. Without `ADMIN_PASSWORD_BOOTSTRAP`, the first page is a **set admin password** form. Set one, and you're in.

Alternatively, seed a password non-interactively:

```bash
ADMIN_PASSWORD_BOOTSTRAP=changeme docker compose up
```

Then log in at `/login` with `changeme`.

Before creating sandboxes, build the base sandbox image:

```bash
npm run docker:sandbox
# equivalent to:
# docker build -t cloud-code-sandbox:dev -f docker/base-sandbox/Dockerfile docker/base-sandbox
```

## Local development (without Docker app container)

```bash
cp .env.example .env

# start Postgres
docker compose up -d postgres

npm install

# apply schema
npm run db:migrate

# start server (3000) + Vite client (5173)
npm run dev
```

The Vite dev server proxies `/trpc`, `/api`, and `/healthz` to the Fastify backend. Open <http://localhost:5173>.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server + Vite, concurrent. |
| `npm run build` | Build SPA (`dist/client`) + server bundle (`dist/server`). |
| `npm start` | Run the production server (expects `dist/` present). |
| `npm run typecheck` | TypeScript check for server + client. |
| `npm run lint` | ESLint. |
| `npm test` | Vitest unit suite. |
| `npm run test:e2e` | Playwright smoke (requires a reachable Postgres at `PLAYWRIGHT_DATABASE_URL`). |
| `npm run db:migrate` | Apply SQL migrations in `migrations/`. |
| `npm run docker:sandbox` | Build the `cloud-code-sandbox:dev` base image (required before creating sandboxes). |

## Configuration

See `.env.example` for the full list. Highlights:

- `DATABASE_URL` — Postgres connection string.
- `DATA_DIR` — where `secrets.key`, workspaces, and app-local state live. Defaults to `/data` in Docker, `./data` locally.
- `ADMIN_PASSWORD_BOOTSTRAP` — optional first-run admin password. Ignored once an admin row exists.
- `PUBLIC_URL` — used by the GitHub App flow (Phase 3) and the agent-tool manifest (Phase 5).
- `ANTHROPIC_API_KEY_BOOTSTRAP` / `ANTHROPIC_BASE_URL_BOOTSTRAP` (plus OpenAI equivalents) — optional; seeded into the encrypted `secrets` table on first run when the corresponding row is absent. Remove from the environment once you see the "bootstrapped" log line.

## Layout

```
.
├── server/              # Fastify + tRPC + Drizzle backend
│   ├── auth/            # bootstrap/login/logout + throttle + cookies
│   ├── db/              # schema + migrations runner
│   ├── docker/          # dockerode client + network helpers
│   ├── sandbox/         # SandboxManager + path helpers
│   ├── fs/              # FileService (host-side + chokidar watcher)
│   ├── terminal/        # TerminalService (node-pty + xterm headless)
│   ├── ws/              # raw WebSocket handler for /ws/shell/:id
│   ├── jobs/            # JobManager (in-memory log buffer + DB row)
│   ├── repo/            # RepoService (clone jobs)
│   ├── github/          # GitHubService (app install, install tokens)
│   ├── preview/         # PreviewService (port scan) + reverse proxy
│   ├── agent/           # OpenCode bootstrap, AgentService, AgentUIProxy
│   ├── http/            # non-tRPC HTTP routes (GitHub App manifest flow)
│   ├── secrets/         # AES-256-GCM master-key module
│   ├── trpc/            # tRPC init + routers
│   ├── env.ts           # zod-validated env
│   └── index.ts         # entry point
├── src/                 # React SPA (Vite)
│   ├── components/ui.tsx
│   ├── routes/          # login / setup / dashboard / sandbox detail
│   ├── router.tsx       # TanStack Router + auth gate
│   ├── trpc.ts          # typed tRPC client
│   └── main.tsx
├── migrations/          # plain SQL, applied in order at startup
├── docker/
│   └── base-sandbox/    # sandbox container image
├── tests/
│   ├── setup.ts         # vitest env setup
│   └── e2e/login.spec.ts
├── Dockerfile           # main `app` image
├── docker-compose.yml
└── docs/fractal/        # specs + plan
```

## Phase 1 acceptance — how to verify

1. **`docker compose up` healthy.** Both `app` and `postgres` report healthy; `/healthz` returns `{"ok":true}`.
2. **Images build.** `docker build -t cloud-code-app:dev .` and `docker build -t cloud-code-sandbox:dev docker/base-sandbox` both succeed.
3. **First-run without bootstrap.** Delete the app volume (or the `admin` table) → visit `/` → set-password form appears → submitting creates the admin and logs in.
4. **First-run with bootstrap.** Set `ADMIN_PASSWORD_BOOTSTRAP`, delete the admin row, restart → `/` renders the login form; the env password works.
5. **Session behaviour.** Cookie is `HttpOnly; SameSite=Strict`; idle timeout 30 min (mutate `last_seen` in DB, next request gets 401); absolute 7-day expiry.
6. **Lockout.** 10 wrong attempts from one IP inside 10 min → login returns `TOO_MANY_REQUESTS` with `retryAfterSec`.
7. **`secrets.key`.** First boot creates it at `$DATA_DIR/secrets.key` mode `0600`; `npm test` includes a round-trip encrypt/decrypt assertion.
8. **Types end-to-end.** `npm run typecheck` clean; frontend imports `AppRouter` from the server with no TS errors.
9. **CI.** Typecheck, lint, unit tests, and the Playwright login smoke all pass.
