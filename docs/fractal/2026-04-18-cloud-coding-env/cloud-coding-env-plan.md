# Cloud Coding Environment — Execution Plan

Five phases. One PR per phase. Each phase ships something end-to-end testable. No phase is merged until its acceptance checklist passes.

Dependency lattice: **1 → 2 → (3 ∥ 4) → 5**. Phases 3 and 4 can be done in either order; plan assumes 3 first because repos and previews make phase 4 more fun to demo.

Environment assumptions for all tests: operator has Docker installed; a Postgres is reachable (via the bundled compose file for local dev); Anthropic (or other provider) API key available for phase 4+.

---

## Phase 1 — Foundation

**Ships:** monorepo + `app` Docker image + base-sandbox image + Postgres + Drizzle migrations + auth + empty React shell with a working login.

**Acceptance:**

- `docker compose up` brings up `app` + `postgres`. Both healthy.
- `docker build` for `app` and `base-sandbox` images succeed. Base-sandbox image includes git, node, python, tmux-free (we're not using it), `opencode` binary, and runs as uid 1000.
- First-run with no `ADMIN_PASSWORD_BOOTSTRAP`: `/` renders a "set admin password" form; submitting creates the admin row and logs the user in.
- First-run with `ADMIN_PASSWORD_BOOTSTRAP` set: `/` renders the login form directly; env-var password works.
- Logged-out user hitting any authed route gets redirected to `/login`.
- `auth.login.mutate` with wrong password → generic error; correct → session cookie set; subsequent tRPC calls carry the session.
- Idle cookie past 30 min → unauthorized; absolute 7 days → unauthorized.
- `auth.logout.mutate` → `web_sessions` row deleted, cookie cleared.
- Brute-force: 10 wrong attempts from one IP within 10 min → login temporarily locked for that IP.
- `secrets.key` is created on first boot (mode 0600). A round-trip encrypt/decrypt test passes.
- tRPC devtools / `@trpc/client` types resolve from the frontend.
- CI green: typecheck, lint, unit tests, a smoke Playwright test that logs in.

---

## Phase 2 — Workspace (sandboxes + files + shells)

**Ships:** `SandboxManager`, `FileService`, `TerminalService`, sandbox list, sandbox detail with file tree + terminal.

**Acceptance:**

**Sandboxes**

- `sandbox.create.mutate({ name })` → DB row + running container (label `coding-env.sandbox=<id>`) + bind-mounted `workspace` + `opencode` dirs.
- `sandbox.list.query` returns live status joined with Docker state.
- `sandbox.archive` stops the container, preserves the workspace dir, keeps the DB row with `status=archived`.
- `sandbox.delete` removes container + workspace dir + cascades DB rows.
- Restarting `app` while a sandbox is active → reconciler finds the container by label, keeps it; user still sees it as active; no orphans.
- Killing the sandbox container out-of-band → next reconciler tick marks it `crashed`; UI shows restart button.
- Sandbox container runs as uid 1000, read-only rootfs, memory/cpu caps applied (verify via `docker inspect`).

**File explorer**

- `fs.list.query({ sandboxId, path: "/" })` returns top-level entries from the host-side workspace path.
- `fs.write.mutate` + `fs.read.query` round-trip preserves content byte-for-byte.
- Creating/modifying/deleting a file inside the sandbox via shell → `fs.watch.subscribe` emits a matching event within 1s.
- File over 5 MB → read returns `tooLarge: true`, not the bytes.
- Binary files (image, elf) → read returns binary sniff result; UI shows placeholder.
- Path traversal (`fs.read({ path: "../../etc/passwd" })`) → rejected, returns error.

**Shells**

- `shell.create` → a PTY opens into the sandbox; `/ws/shell/:id` upgrade sends the serialized snapshot, then live bytes. Typing in the browser reaches the shell; output streams back.
- Browser refresh → reconnecting to the same shell id replays the scrollback and continues live.
- Two tabs attached to the same shell both see output; keystrokes from either reach the shell.
- `shell.resize` → PTY cols/rows update; `stty size` inside the shell matches.
- `shell.runOnce({ cmd: "echo hi" })` → returns `{ stdout: "hi\n", exitCode: 0, truncated: false }`.
- `shell.runOnce` with a command that exits 42 → `exitCode: 42`.
- `shell.runOnce` with 50 MB of output → `truncated: true`, stdout ≤ 10 MB.
- `shell.runOnce({ timeoutMs: 500, cmd: "sleep 5" })` → error, process killed within a second or two.
- Disposing a sandbox with active shells → all their sockets close cleanly, no orphaned node-pty processes on the host.
- Scrollback buffer cap (10k lines) enforced.

---

## Phase 3 — Code workflows (repos + GitHub + preview)

**Ships:** `RepoService`, `GitHubService`, `PreviewService` (port scan + reverse proxy), settings UI, repo picker, preview iframe pane.

**Acceptance:**

**Repos (URL)**

- `repo.add.mutate({ sandboxId, source: "url", url, ref })` → clone runs as a tracked job; `job.watch.subscribe({ jobId })` streams progress; clone appears at `/workspace/repos/<slug>` inside the sandbox.
- Invalid URL / bad ref → job ends with error; UI shows it.
- Closing the browser mid-clone → reopening and subscribing to the same job id resumes progress (server kept working).
- `repo.remove` → workspace files gone; DB row gone.

**GitHub integration**

- `github.connectStart` → redirect URL goes to GitHub's App manifest creation page with expected scopes.
- GitHub redirects back to `/api/github/callback` → app exchanges code → `github_install` row populated; private key stored encrypted; UI shows "Connected to `<org>`".
- `github.listOrgRepos` returns a non-empty list (against a test org with at least one repo).
- `repo.add` with `source=github` clones using a freshly-minted installation token (not a stored PAT). Install tokens cached for ≤60 min.
- Removing the GitHub App from the org → `github.listOrgRepos` returns a clear error; URL-based clones still work.

**Preview**

- Open a shell, `cd repos/<name>`, run a dev server (e.g., `python3 -m http.server 5173`) → within 5s `preview.ports.subscribe` emits an entry for port 5173.
- Browser hits `/preview/<sandbox>/5173/` → served from the sandbox container. Static assets load. WebSockets to the dev server upgrade cleanly.
- Kill the dev server → port disappears from the list within ~3s.
- `/preview/<sandbox>/<port>/` while logged out → 401.
- Content that sets `X-Frame-Options: DENY` → proxy strips it; iframe embed in the UI works.
- Two concurrent dev servers on two different ports → both appear; both previewable independently.

---

## Handoff context (written 2026-04-18 after Phase 3 QA)

These are facts the next implementer needs that are not derivable from reading the code alone.

**OpenCode is already installed in the base sandbox image.**
- Installed via `npm install -g opencode-ai` in `docker/base-sandbox/Dockerfile` (not the original `curl | bash` install script — that silently no-op'd on network hiccups; npm fails loudly). Current version: `1.4.12`. Binary at `/usr/bin/opencode`.
- Rebuild with `npm run docker:sandbox` if you bump the version.

**Provider keys bootstrap path exists.**
- `.env.example` documents `ANTHROPIC_API_KEY_BOOTSTRAP` + `ANTHROPIC_BASE_URL_BOOTSTRAP` (and OPENAI equivalents).
- Validated in `server/env.ts`; wired through `docker-compose.yml`.
- Phase 4 should have `AgentService` (or a dedicated `ProviderKeysService`) read these on first start: if `secrets` has no matching row, encrypt + persist, then log "bootstrapped provider X from env, you can remove the env var now". The Settings UI is the long-term path (add/rotate/delete per provider).

**Anthropic base URL rewrite for sandboxes (Docker Desktop).**
- In the current dev setup the operator points Anthropic-compatible traffic at a local proxy at `http://localhost:8137` on the host. A sandbox container's `localhost` is the container itself, so we must rewrite `localhost` / `127.0.0.1` → `host.docker.internal` when injecting the base URL into the sandbox's `opencode serve` env.
- On Linux hosts (where Docker Desktop's magic host alias isn't present), operators need `--add-host=host.docker.internal:host-gateway` on the sandbox container. Either add that flag unconditionally in `SandboxManager.createContainer` (harmless on Docker Desktop, required on Linux) or document as an operator knob.

**Existing sandboxes don't have OpenCode running.**
- Phase 3 shipped sandboxes that started without the `opencode serve` process. The Phase 4 bootstrap reconciler should detect active sandboxes with no OpenCode process and start it on demand, not just on create. UI: an "Agent not running" state with a "Start agent" button in the sandbox detail, wired to a `sandbox.startAgent` / `agent.bootstrap` mutation.

**Auth cookie is already SameSite=Lax.**
- Phase 3 changed `server/auth/cookie.ts` from Strict to Lax so the GitHub App OAuth callback could carry the session. The same works for any future OAuth-style redirects (e.g. if Phase 4 adds provider OAuth flows).

**Reverse-proxy for the OpenCode web UI.**
- The `AgentUIProxy` is a third reverse proxy on the main app (alongside `/preview/...` and the GitHub HTTP routes). Path: `/sandbox/:id/agent/*` → `http://<container-ip>:<opencode-port>/...`.
- Reuse the proxy pattern from `server/preview/proxy.ts`: `onRequest` hook for HTTP, `@fastify/websocket` route for upgrades. Note: `@fastify/websocket` installs its own upgrade listener that races any manual `prependListener('upgrade')`; Phase 3 learned this the hard way and switched to registering a real Fastify WS route. Follow that pattern.
- For HTTP, the existing preview proxy forwards the **full URL** (including the `/preview/<sb>/<port>/` prefix) upstream — this lets Vite (with `base` set) work without redirect loops. Decide whether the agent UI also needs its prefix preserved; OpenCode may have similar base-path sensitivity.
- Auth header injection into the iframe: OpenCode's `opencode web` reads its own password from the env at start. The proxy should inject `Authorization: Bearer <password>` (or whatever OpenCode expects) so the iframe doesn't prompt for a second login. **Verify during implementation** — if OpenCode doesn't accept header-based auth on its web UI, fall back to the signed-URL scheme called out in the Spec, or (last resort) build our own UI on the SDK.

**`host.docker.internal` from Docker Desktop on macOS.**
- The existing `docker-compose.yml` doesn't add this to the sandbox containers yet (sandboxes are created at runtime by `SandboxManager`, not by compose). Add `ExtraHosts: ['host.docker.internal:host-gateway']` to the `HostConfig` in `SandboxManager.createContainer`; works on both Docker Desktop and Linux.

**Path-based previews leak the proxy prefix to dev servers (v1 limitation).**
- Documented in README + the demo repo `samdesota/demo-application` has a `VITE_BASE` env-var workaround in its `vite.config.ts`. Not blocking for Phase 4 but worth knowing — the agent UI will hit the same class of issue if its assets use absolute paths.

**Dev/QA environment.**
- Operator runs via `docker compose up` with `PUBLIC_URL=<tailscale-funnel-url>` set so GitHub App redirects work.
- Because MagicDNS on the origin machine resolves the funnel hostname to the local Tailscale IP (no cert), a `/etc/hosts` override is required to point the hostname at the funnel public ingress IP for the operator's own browser. This is operator-side, not app-side.
- Demo repo already created: `https://github.com/samdesota/demo-application` (private). It has Phase-3-specific hardcodes in `package.json` / `vite.config.ts` (the sandbox id + funnel host) — irrelevant to Phase 4 but note if you reuse it.

**Encryption + secrets helpers are ready.**
- `server/secrets/index.ts` exposes `putSecret(name, value)` / `getSecret(name)`. Use for provider keys (`provider.anthropic.api_key`, `provider.anthropic.base_url`, `sandbox.<id>.opencode_password`). Schema already has the `secrets` table; no migration needed.

---

## Phase 4 — Built-in agent (OpenCode)

**Ships:** `opencode serve` bootstrap inside sandboxes, `AgentService`, `AgentUIProxy`, provider-key settings, agent panel embed.

**Acceptance:**

**Bootstrap**

- Sandbox create → `opencode serve` started inside the container with a random password and provider keys injected from settings. Readiness probe succeeds within 5s.
- OpenCode port + encrypted password recorded on the `sandboxes` row.
- Settings UI: add Anthropic API key **and optional base URL** → both stored encrypted; can be rotated and deleted. Missing provider key → agent panel shows "provider not configured" rather than crashing.
- `ANTHROPIC_API_KEY_BOOTSTRAP` / `ANTHROPIC_BASE_URL_BOOTSTRAP` env vars (and OpenAI equivalents) seed the encrypted store on first start when the corresponding row is absent; log a one-line note telling the operator they can unset the env var.
- **Existing sandboxes** (created under Phase 2/3 without OpenCode) must be upgradable: reconciler detects missing OpenCode process → sandbox detail shows "Start agent" button → `sandbox.startAgent` mutation runs the same bootstrap on the live container.
- Sandbox containers get `ExtraHosts: ['host.docker.internal:host-gateway']` so the injected Anthropic base URL can point at the operator's host loopback (common when a local LiteLLM/Anthropic-compatible proxy is in use).
- Anthropic base URLs with `localhost` / `127.0.0.1` are auto-rewritten to `host.docker.internal` before being injected into the sandbox's `opencode serve` env.

**Agent sessions via tRPC**

- `agent.sessionStart.mutate({ sandboxId, prompt })` → creates an OpenCode session + `agent_sessions` row; returns our id.
- `agent.transcript.subscribe({ sessionId })` streams assistant output as the session runs.
- `agent.sessionSend` → follow-up prompt reaches the running session.
- `agent.sessionStatus` includes any pending permission requests from OpenCode.
- `agent.sessionApprove` / `reject` resolves an approval; session proceeds or halts accordingly.
- Killing the OpenCode process out-of-band → next call surfaces a restart attempt; on second failure, session marked `unavailable` with a clear error.
- `agent_transcripts` table has rows for each turn (role, content, seq monotonic).

**Embedded UI**

- `/sandbox/:id/agent/` iframe loads `opencode web` without a second login prompt (header/token injection path verified). If header auth doesn't work: fallback path from Spec is in place and loads the iframe.
- Agent edits a file → file tree shows the change; `fs.watch` fires; terminal running `git status` reflects the change.
- Logged-out user hitting `/sandbox/:id/agent/*` directly → 401.

---

## Phase 5 — Agent Tool Protocol surface

**Ships:** `ProtocolGateway` — `/.well-known/agent-tools.json`, `/agent/rpc`, `/agent/events`, page-mode SDK, `session.handshake`, `workspace.current_context`, static + dynamic instructions endpoints, all orchestrator tools wired.

**Acceptance:**

**Discovery + handshake**

- `GET /.well-known/agent-tools.json` returns a valid manifest matching the protocol-spec schema. Validates against the schema from spec #1.
- HTML shell includes `<link rel="agent-tools">`.
- `session.handshake` called from an authenticated page → returns `{ token, expiresAt, context: { sandboxId } }`. Token is 256-bit base64url. `agent_tokens` has a matching `sha256(token)` row.
- Called without the admin cookie → 401.
- Handshake with no focused sandbox → clear error.

**Endpoint-mode RPC**

- `POST /agent/rpc` with no `Authorization` → 401.
- With a valid token + correct `meta.context.sandboxId` → method dispatch works. With a mismatched sandboxId → error.
- `sandbox.list` / `sandbox.create` via RPC round-trip with UI-visible effects.
- `repo.add` via RPC clones into the right sandbox.
- `shell.runCommand` via RPC returns stdout/stderr/exitCode.
- `fs.read` / `fs.write` / `fs.list` sandbox-scoped; attempts outside workspace rejected.
- `agent.session_start` via RPC → creates a session the UI's Agent panel also shows (shared state with phase 4).
- `agent.session_send` → follow-up reaches the same session.
- `agent.session_approve` / `reject` → pending gate resolved.
- `$/cancel` for a long-running RPC call → aborts (e.g., cancels a mid-flight `shell.runCommand`).

**Events stream**

- `GET /agent/events` (SSE, authed) streams: `agent.transcript_delta`, `agent.pending_approval`, `shell.output` (for subscribed shells), `preview.ports_changed`, `fs.changed`, `session.invalidate`.
- Token expiry mid-stream → `E_SESSION_EXPIRED` emitted; client re-handshakes and reconnects.
- Admin logout → all open tokens for that cookie invalidated; active SSE connections close with `session.invalidate`.

**Instructions**

- `GET /agent/instructions.md` returns a non-empty static instruction doc. Hash embedded in the manifest matches its contents (cache correctness).
- `workspace.current_context` returns the focused sandbox + active file + active shell; reflects the UI state when called from the page.
- Manifest's `dynamicMaxTokens` honored — tool returns a payload under the budget.

**End-to-end orchestrator demo**

- Drive the whole system from a scripted external orchestrator: handshake → create sandbox → add repo → start dev server via `shell.runCommand` → observe port in `preview.ports` → start an agent session → watch transcript → approve one pending call → done. Scripted with a test client in the repo, asserts each step.

---

## Cross-cutting (checked at every phase)

- Typecheck clean; lint clean.
- No unpinned deps; no `any` in public APIs; zod schemas on every tRPC input.
- Unit tests for any module with non-trivial logic; integration tests for tRPC routers against a real Postgres (testcontainers OK in CI).
- Playwright smoke for the phase's headline user flow.
- `README.md` updated with the newly-enabled operator-level functionality.
