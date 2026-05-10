# Zoottle

Zoottle is a local-first desktop app. Electron owns a local identity/app server and a matching `cc-env` process, auto-pairs them on startup, and opens the React UI against the local app server.

The old remote Docker sandbox/orchestrator path is legacy while the new remote-env design is rebuilt later. Keep `cc-env` as the environment-service boundary.

## Requirements

- Node.js 20.11+
- npm
- Docker is not required for the default desktop workflow.
- Postgres is not part of the local app runtime.

## Quick Start

```bash
npm install
npm run dev
```

`npm run dev` builds and launches the Electron desktop app with service management enabled. It starts:

- local identity/app server on an instance-scoped loopback port
- local `cc-env` on an instance-scoped loopback port
- per-instance SQLite app DB under `.cloud-code/instances/<instance-id>/app/app.db`
- per-instance `cc-env` SQLite DB under `.cloud-code/instances/<instance-id>/env-state/env.db`

The desktop app auto-pairs with its matching `cc-env`; no pairing code is needed for the normal desktop flow.

## Multiple Worktrees

Development defaults derive the instance id from the worktree path, so two worktrees can run concurrently without sharing ports or state.

Useful overrides:

```bash
CC_INSTANCE_ID=my-branch npm run dev
CC_INSTANCE_ROOT=/tmp/zoottle-a CC_APP_PORT=3101 CC_ENV_PORT=48001 npm run dev
```

Each instance scopes its app DB, env DB, logs, ports, env label, and pairing token.

## Browser-Only Development

Use this when debugging the web app outside Electron:

```bash
npm run dev:web
```

This starts the local SQLite app server and Vite client. Open <http://127.0.0.1:5180>.

Manual cc-env pairing remains available from the dashboard for browser-only or externally managed `cc-env` flows.

## External Desktop Debugging

Use this when you already have a server/Vite stack running and want Electron to point at it without managing services:

```bash
npm run dev:desktop:external
```

Override the chrome URL if needed:

```bash
CC_DESKTOP_CHROME_URL=http://127.0.0.1:5180 npm run dev:desktop:external
```

## Build And Test

```bash
npm test
npm run build
npm run build:desktop
npm run test:e2e:desktop:app
```

## Legacy Docker Path

The Compose stack and sandbox image scripts are retained temporarily for historical/debugging use, but they are no longer the default product path.

Legacy commands:

```bash
docker compose up
npm run docker:sandbox
```

Do not add new default workflows that require Docker, Postgres, `zoottle-sandbox:dev`, or fixed `cc-env` port `47821`.

## Fractal Plan

Current refactor plan:

- [`docs/fractal/2026-04-26-local-first-desktop-env/local-first-desktop-env-spec.md`](docs/fractal/2026-04-26-local-first-desktop-env/local-first-desktop-env-spec.md)
- [`docs/fractal/2026-04-26-local-first-desktop-env/local-first-desktop-env-plan.md`](docs/fractal/2026-04-26-local-first-desktop-env/local-first-desktop-env-plan.md)
