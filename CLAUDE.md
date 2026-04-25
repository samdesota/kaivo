# Cloud Code Tools — operator notes

Three services, deployed independently. There is no CI; every change ships
by hand from this repo.

| Service       | What it is                                  | Where it runs                               |
| ------------- | ------------------------------------------- | ------------------------------------------- |
| Identity      | Orchestrator + webapp (`cloud-code-app`)    | Box, in docker, fronted by Caddy            |
| Sandbox env   | `cc-env` inside `cloud-code-sandbox` image  | Box, per-user docker container              |
| Local env     | `cc-env` as a launchd service               | The operator's mac                          |

Production box: `root@161.35.136.150` → `https://code.438d.xyz`.

Local repo lives at `/Users/sam/d/cloud-code-tools`. The box has its own
checkout at `/opt/cloud-code-tools`.

## Deploy the orchestrator + webapp

Migrations run on app boot, so a restart is enough to apply them.

```bash
git push origin main
ssh root@161.35.136.150 'cd /opt/cloud-code-tools \
  && git pull --ff-only \
  && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build app'
```

Verify:

```bash
ssh root@161.35.136.150 'docker logs cloud-code-app-1 2>&1 | tail -20'
```

## Deploy the sandbox image (cc-env for container envs)

Rebuilds `cloud-code-sandbox:dev` on the box. Existing sandboxes are not
recreated — only spinups *after* the rebuild pick up the change.

```bash
ssh root@161.35.136.150 'cd /opt/cloud-code-tools && npm run docker:sandbox'
```

## Deploy local cc-env (mac)

The launchd service runs from a deployed bundle, not from the repo. Build,
copy artifacts, restart.

```bash
cd /Users/sam/d/cloud-code-tools/packages/env-server
npm run build
cp dist/main.js     /Users/sam/.local/share/cc-env/app/main.js
cp dist/main.js.map /Users/sam/.local/share/cc-env/app/main.js.map
rsync -a --delete migrations/ /Users/sam/.local/share/cc-env/app/migrations/
launchctl kickstart -k gui/$(id -u)/com.cloudcode.env
```

Service settings live in `~/Library/LaunchAgents/com.cloudcode.env.plist`
(env vars: `CC_KIND`, `CC_LABEL`, `CC_WORKING_DIR`, `CC_PORT`, `CC_STATE_DIR`,
`CC_IDENTITY_URL`, `CC_OPENCODE_PLUGIN_PATH`, `PATH`).

## Caddyfile

Source of truth: `docker/Caddyfile` in this repo. Production copy lives at
`/etc/caddy/Caddyfile` on the box; ship with `scp` then reload.

```bash
scp docker/Caddyfile root@161.35.136.150:/etc/caddy/Caddyfile
ssh root@161.35.136.150 'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy'
```

## Logs

- **Centralized** `event_logs` table (Postgres on the box). Every Node service
  + the browser ships entries here:
  ```bash
  ssh root@161.35.136.150 'docker exec cloud-code-postgres-1 sh -c \
    "psql -U \$POSTGRES_USER \$POSTGRES_DB -c \"SELECT event_ts, source, level, msg, ctx \
    FROM event_logs ORDER BY event_ts DESC LIMIT 50;\""'
  ```
- **Local cc-env stdout**: `~/.local/share/cc-env/state/log/cc-env.log` (pino JSON).
- **Local opencode**: `~/.local/share/cc-env/state/xdg/data/opencode/log/` (one
  file per opencode start). Useful for debugging tool calls / model errors.

## Databases

- **Identity** (Postgres, on the box): exec `psql` inside `cloud-code-postgres-1`.
- **Local cc-env** (sqlite): `~/.local/share/cc-env/state/env.db`. Tables:
  `agent_sessions`, `agent_transcripts`, `shell_sessions`, `env_meta`, …

## LLM proxy

`cli-proxy-api` on the box, exposed at `https://llm.438d.xyz`. Models
auto-discovered from upstream login. To add a provider:

```bash
# 1. SSH tunnel for the OAuth callback (run on your mac, leave open):
ssh -L 1455:127.0.0.1:1455 root@161.35.136.150
# 2. In that SSH session, run the interactive login:
docker exec -it cli-proxy-api /CLIProxyAPI/CLIProxyAPI -<provider>-login -no-browser
# (-claude-login, -codex-login, -gemini-login, …)
```

Open the printed OAuth URL in your local browser. Auth files persist in
`/root/.config/cli-proxy/auths/` on the box.

API key for the proxy is in `/root/.config/cli-proxy/config/config.yaml`
under `api-keys`.

## Quick sanity test against the proxy

```bash
curl -sS https://llm.438d.xyz/v1/messages \
  -H "Authorization: Bearer <key>" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-7","max_tokens":32,
       "messages":[{"role":"user","content":"hi"}]}'
```
