# Kaivo — operator notes

## Modal and Overlay Layer

Any UI that behaves like a modal, command palette, picker, confirmation dialog, or blocking overlay must render in the detached overlay layer, not inside the workspace/app DOM. This is required because in-app modals can appear underneath Electron browser tabs.

Use `src/lib/overlay-layer-controller.tsx` as the app-facing API. Add a typed `OverlayRequest`/`OverlayResponse` in `src/routes/internal/overlay-layer.tsx`, render the modal UI there, and expose an `openXOverlay(...)` function from the controller. Env-backed overlays must pass `env` and `envToken`; the overlay layer creates its own `envTrpc` provider. App/identity data is available through the normal root `trpc` provider.

Do not add new `<Modal>`, `role="dialog"`, command palette, or picker UI directly to workspace/app routes unless it is intentionally non-blocking inline UI. If a route needs to trigger a modal from JSX, create a small `XOverlayLauncher` component that calls the controller and returns `null`.

Kaivo is currently local-first. The default product path is the Electron desktop app, which starts a local identity/app server and a matching local `cc-env`, then auto-pairs them.

Remote Docker sandboxes/orchestrator are legacy for now. The production box still has old data that will be exported into local SQLite at the final migration step of the current Fractal plan.

Production box: `root@161.35.136.150` → legacy `https://code.438d.xyz`.

Local repo lives at `/Users/sam/d/repos/cloud-code-tools/zootle`. The box has its own legacy checkout at `/opt/cloud-code-tools`.

## Default Local Desktop

```bash
cd /Users/sam/d/repos/cloud-code-tools/zootle
npm run dev
```

This runs Electron with `CC_DESKTOP_MANAGE_SERVICES=true`. Electron starts/discovers:

- identity/app server, SQLite app DB under `.cloud-code/instances/<id>/app/app.db`
- `cc-env`, SQLite env DB under `.cloud-code/instances/<id>/env-state/env.db`
- instance-scoped ports, logs, labels, pairing token, and launch manifest

Multiple worktrees can run together because the default instance id is derived from the worktree path. Override with `CC_INSTANCE_ID`, `CC_INSTANCE_ROOT`, `CC_APP_PORT`, and `CC_ENV_PORT` when needed.

Before assuming local ports, URLs, database paths, or log locations, read the current launch manifest:

```bash
cat .cloud-code/instances/<id>/launch.json
```

The manifest lists the app/identity server, `cc-env`, client dev server, health URLs, PIDs, SQLite/state paths, workspace path, secrets-key path, and log files for that worktree. `.cloud-code/` is gitignored and contains local runtime state only.

## Browser-Only Development

```bash
npm run dev:web
```

This routes through the local launcher, finds free ports for app/identity, `cc-env`, and Vite, seeds local dev LLM credentials, and writes `.cloud-code/instances/<id>/launch.json`. Open the manifest's `client` URL instead of assuming `http://127.0.0.1:5180`.

Manual local env pairing remains available from the dashboard for browser-only or externally managed `cc-env` flows.

## Worktree Readiness Smoke

```bash
# Terminal 1, worktree A
CC_INSTANCE_ID=smoke-a npm run dev:web

# Terminal 2, worktree B
CC_INSTANCE_ID=smoke-b npm run dev:web
```

Verify each `.cloud-code/instances/<id>/launch.json` has distinct app, env, and client ports; `curl` each app/env `healthUrl` and confirm the `instanceId`; open each manifest `client` URL in the browser pane or a normal browser.

## External Desktop Debugging

```bash
CC_DESKTOP_CHROME_URL=http://127.0.0.1:5180 npm run dev:desktop:external
```

Use this only when another server/Vite stack is already running.

## Legacy Docker

These are retained temporarily for reference and migration work, not the default path:

```bash
docker compose up
npm run docker:sandbox
```

Do not add new default workflows that require Docker, Postgres, sandbox image builds, or fixed `cc-env` port `47821`.

## Logs

- Desktop-managed app log: `.cloud-code/instances/<id>/logs/app.log`
- Desktop-managed cc-env log: `.cloud-code/instances/<id>/logs/cc-env.log`
- Browser/dev client log: `.cloud-code/instances/<id>/logs/client.log`
- Local launcher manifest: `.cloud-code/instances/<id>/launch.json`
- Desktop harness log when set: `CC_DESKTOP_TEST_LOG`
- Legacy local cc-env launchd log: `~/.local/share/cc-env/state/log/cc-env.log`
- Legacy opencode logs: `~/.local/share/cc-env/state/xdg/data/opencode/log/`

## Databases

- Local identity/app SQLite: `.cloud-code/instances/<id>/app/app.db`
- Local cc-env SQLite: `.cloud-code/instances/<id>/env-state/env.db`
- Legacy production export source: Postgres on the box, via `cloud-code-postgres-1`

## LLM proxy

`cli-proxy-api` on the box, exposed at `https://llm.438d.xyz`. Models auto-discovered from upstream login. To add a provider:

```bash
# 1. SSH tunnel for the OAuth callback (run on your mac, leave open):
ssh -L 1455:127.0.0.1:1455 root@161.35.136.150
# 2. In that SSH session, run the interactive login:
docker exec -it cli-proxy-api /CLIProxyAPI/CLIProxyAPI -<provider>-login -no-browser
# (-Codex-login, -codex-login, -gemini-login, …)
```

Open the printed OAuth URL in your local browser. Auth files persist in `/root/.config/cli-proxy/auths/` on the box.
