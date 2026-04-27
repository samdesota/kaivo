# Cloud Code Tools — operator notes

Cloud Code is currently local-first. The default product path is the Electron desktop app, which starts a local identity/app server and a matching local `cc-env`, then auto-pairs them.

Remote Docker sandboxes/orchestrator are legacy for now. The production box still has old data that will be exported into local SQLite at the final migration step of the current Fractal plan.

Production box: `root@161.35.136.150` → legacy `https://code.438d.xyz`.

Local repo lives at `/Users/sam/d/cloud-code-tools`. The box has its own checkout at `/opt/cloud-code-tools`.

## Default Local Desktop

```bash
cd /Users/sam/d/cloud-code-tools
npm run dev
```

This runs Electron with `CC_DESKTOP_MANAGE_SERVICES=true`. Electron starts/discovers:

- identity/app server, SQLite app DB under `.cloud-code/instances/<id>/app/app.db`
- `cc-env`, SQLite env DB under `.cloud-code/instances/<id>/env-state/env.db`
- instance-scoped ports, logs, labels, and pairing token

Multiple worktrees can run together because the default instance id is derived from the worktree path. Override with `CC_INSTANCE_ID`, `CC_INSTANCE_ROOT`, `CC_APP_PORT`, and `CC_ENV_PORT` when needed.

## Browser-Only Development

```bash
npm run dev:web
```

Open <http://127.0.0.1:5180>. Manual local env pairing remains available from the dashboard for browser-only or externally managed `cc-env` flows.

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
# (-claude-login, -codex-login, -gemini-login, …)
```

Open the printed OAuth URL in your local browser. Auth files persist in `/root/.config/cli-proxy/auths/` on the box.
