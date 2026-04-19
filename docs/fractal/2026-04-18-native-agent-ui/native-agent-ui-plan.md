# Native Agent UI — Execution Plan

Seven phases. One PR per phase. Each phase ships something end-to-end testable.

Dependency lattice: **0 → 1 → 2 → 3 → 4 → 5 → 6**. Phase 0 is a test-harness prereq. Phase 1 is the new UI shell and can land with the existing iframe + existing shell panel inside it — no dependency on later phases. Phases 2–4 are the server-side bridge. Phase 5 lands the native agent view inside the already-shipped shell.

Environment for all tests: the operator has Phase-1–4 of `cloud-coding-env` running (compose up, sandboxes can be created, OpenCode runs in them). A real Anthropic key is **not** required for CI — phase 0 provides a deterministic fake. Live-key runs are gated by `LIVE_LLM=1` and skipped in CI.

---

## Phase 0 — Anthropic mock (test harness)

**Ships:** a tiny Anthropic-compatible HTTP server used by all agent-flow tests. Lives in `tests/mocks/anthropic/` as a reusable harness (not shipped in production builds).

**What it does:**

- Exposes `POST /v1/messages` with both streaming (SSE) and non-streaming responses matching Anthropic's wire format closely enough for OpenCode's provider code to parse.
- Responses come from a **script** the test loads before the turn: an ordered list of assistant turns, each either a text chunk, a `tool_use` call (name + input), or a compound sequence (text → tool_use → text). The mock replays turns in order; if the conversation runs past the script, returns a harmless `{text: "done"}`.
- Exposes a control API (e.g. `POST /__script`) so tests push a new script per session without restarting the server.
- Reachable from the sandbox container at `host.docker.internal:<port>` (leveraging the existing base-URL-rewrite path from `server/agent/providers.ts`).

**Acceptance:**

- `tests/mocks/anthropic/server.ts` starts on a port assigned by the test runner; test can POST a script, then trigger any agent action and receive the scripted replies.
- OpenCode running against the mock successfully completes a session with: (a) text-only response, (b) single tool_use → tool_result → text, (c) multi-step tool sequence.
- Mock logs every request to a test-readable buffer so assertions like "the model was asked with tools=[bash, pty, ...]" are possible.
- No real network calls leak when `ANTHROPIC_BASE_URL_BOOTSTRAP=http://host.docker.internal:<mock-port>` is set in the compose for CI.
- A Playwright smoke spec uses the mock end-to-end: seeded script → drive `sessionStart` via tRPC → assert transcript contains the scripted assistant text.
- CI workflow boots the mock before running the agent-flow Playwright suite.
- Live-key override works: `LIVE_LLM=1 npm test` bypasses the mock and hits real Anthropic (for local manual verification only; skipped in CI).

---

## Phase 1 — Sandbox tab shell

**Ships:** new sandbox detail page with fixed Agents-left / tabs-right layout; right-pane tab types `newtab`, `shell`, `file`, `preview`; top-chrome Shells + Previews dropdowns; localStorage tab persistence. Existing iframe is embedded as the Agents pane's content for now. Old `/sandbox/:id/agent|shells|preview` routes removed and replaced with a single route.

**Acceptance:**

- Opening a fresh sandbox: Agents pane shows the existing iframe (placeholder until phase 5); right pane shows a single `newtab`.
- `newtab` lists: quick actions ([ New shell ]), running shells (via `shell.list`), running previews (via `preview.ports`), and the file tree (`fs.list` / `fs.watch`).
- Clicking a shell in the `newtab` list or Shells dropdown → adds a `shell` tab and activates it. xterm shows the shell's scrollback replayed via the existing `/ws/shell/:id` WebSocket.
- Clicking `[terminate]` on a shell (in the dropdown, newtab, or shell-tab ⋯ menu) → calls `shell.dispose`; entry disappears from all views; if a tab was open for that shell it stays open but shows a "shell terminated" placeholder.
- **Closing a shell tab does not terminate the shell.** Verify: open shell in tab, run `watch date`, close the tab, reopen from Shells dropdown → shell still running with uninterrupted output.
- Clicking a file in the `newtab` tree → opens a `file` tab with the file contents. Closing and reopening hits `fs.read` afresh.
- Clicking a preview in the Previews dropdown → opens a `preview` tab with an iframe pointing at `/preview/:id/:port/`. Multiple previews on multiple ports → multiple tabs.
- Refreshing the browser: tab set restored from localStorage. Dropped tabs: any `shell` tab whose id is missing from `shell.list`. If all tabs drop, a fresh `newtab` appears.
- Navigating between sandboxes: each sandbox has its own tab state (separate localStorage key).
- No visual regressions to the existing agent iframe, shell input, or preview proxy.
- Playwright smoke: open sandbox → open shell from newtab → close tab → verify shell survives via Shells dropdown → reopen shell → see live output.

---

## Phase 2 — Streaming shells foundation

**Ships:** `shell_sessions.owner_kind` / `owner_session_id` columns, `TerminalService.runOnceStream`, `agent_shell_tokens` table (schema only, no auth wiring yet). Refactored `<XTermAttached shellId>` component reused by the Shells tab and the newtab list.

**Acceptance:**

- Drizzle migration adds `owner_kind` (default `'human'`) and `owner_session_id`. Existing rows backfilled to `'human'`. New schema round-trips.
- `TerminalService.runOnceStream({ sandboxId, cmd: "for i in 1 2 3; do echo $i; sleep 1; done" })` returns a handle with a `shellId` before the command completes. Attaching `/ws/shell/:id` during the run streams bytes as they arrive (not in one burst).
- `exitPromise` resolves with `{ exitCode: 0, truncated: false }` after ~3 s.
- A client attaching **after** the command exits still sees full scrollback via the xterm snapshot.
- Shell is kept for 10 min post-exit, then disposed (verify via fake clock or a reduced-constant test build).
- `runOnce` (the existing buffered variant) still passes its existing acceptance tests — untouched semantics.
- Shells panel UI: a column (or badge) exists for `owner_kind`; human shells unchanged; `<XTermAttached shellId>` is the single place that opens the shell WS.
- `agent_shell_tokens` table exists; no procedures use it yet.

---

## Phase 3 — `agentShell.*` router + token auth

**Ships:** `agentShellProcedure` middleware (bearer-or-cookie), `agentShell` router (`runOnce`, `open`, `write`, `close`, `tail`), token minting/verification, test client.

**Acceptance:**

- New tRPC router at `agentShell.*` mounted on the existing tRPC endpoint.
- Calling any `agentShell.*` procedure without a valid bearer or admin cookie → 401.
- A minted token issued for sandbox A cannot call `agentShell.runOnce` against sandbox B's shells (scope check).
- Token hash stored as `sha256`, never as plaintext. Revoking (`revoked_at`) blocks subsequent calls.
- `agentShell.runOnce` subscription (called from a test Node script with a bearer): first event is `{ type: 'started', shellId }`, followed by interleaved `{ type: 'stdout'/'stderr', b64 }`, ending with `{ type: 'exit', code, truncated }`. Chunks arrive live (not batched at the end).
- `agentShell.open` → returns `shellId`; that shell appears in `shell.list` with `owner_kind='agent'`. Follow-up `agentShell.write` delivers bytes to the PTY. `agentShell.close` disposes it.
- `agentShell.tail({ shellId, maxBytes })` returns the last N bytes of the shell's scrollback plus the exit code if any.
- AbortSignal / subscription-unsubscribe on `runOnce` kills the underlying shell within a second.
- Typecheck: a stand-alone test package can `import type { AppRouter }` and call all four procedures with end-to-end types.

---

## Phase 4 — OpenCode plugin (bash + pty)

**Ships:** `packages/opencode-plugin`, base-sandbox image with plugin preinstalled and config wired, `SandboxManager` injects `CLOUDCODE_AGENT_TOKEN` + `CLOUDCODE_APP_URL`, reconciler handles missing tokens on existing sandboxes.

**Acceptance:**

- Base-sandbox image rebuilds clean. The plugin is installed and referenced by `~/.opencode/config.json`.
- Creating a new sandbox → `docker inspect` shows `CLOUDCODE_AGENT_TOKEN` and `CLOUDCODE_APP_URL` in `opencode serve`'s env. A corresponding `agent_shell_tokens` row exists.
- Agent-flow tests drive OpenCode via the phase-0 mock with scripted tool_use turns; no live Anthropic key needed.
- Prompting the agent (via a scripted `bash` tool_use) "run `ls` in /workspace":
  - The tool invocation flows through our plugin (logs on the app show an `agentShell.runOnce` call with a matching bearer).
  - A `shell_sessions` row with `owner_kind='agent'` is created for the command.
  - `message.part.updated` event fires with a `tool` part whose `metadata.cloudcode_shell_id` matches the new shell id.
  - OpenCode's transcript contains the full stdout when the tool completes.
- Scripted `pty` tool_use turn "open a long-running shell and run `top`":
  - The `pty` tool runs → `agentShell.open` called → shell appears in the normal Shells panel with `owner_kind='agent'` and the agent's label.
  - Human can attach the shell from the Shells panel and see `top` running live; keystrokes from the human reach the PTY.
- Decision on `bash` tool name collision documented in the PR (replace-vs-shadow or fallback to `cloud_bash` + prompt nudge).
- Existing sandboxes (predating this phase) get a token minted on next `startAgent`; no manual operator step.
- Plugin unreachable (simulate by blocking the app port): bash tool returns `{ exitCode: 1, stderr: "cloud-code app unreachable" }` after backoff; session continues.
- Plugin exception inside `execute`: the tool returns a structured error; OpenCode session does not move to `errored`.

---

## Phase 5 — Native AgentSessionView (read-only)

**Ships:** `agent.sessionMessages` tRPC query, `AgentSessionView` mounted as the Agents-pane content inside the phase-1 tab shell, with transcript renderers (`TextPart`, `ReasoningPart`, `ToolPart` for `bash` / `pty` / other, `FilePart`, `PatchPart`, `StepFinish`), permission banner (display only), `<XTermAttached>` integration for expanded bash parts. Feature-flagged behind `preferences.agent_ui='native'`; iframe remains the default until phase 6.

**Acceptance:**

- With `agent_ui='native'`, the Agents pane renders `AgentSessionView` in place of the iframe; layout, right-pane tabs, and shells dropdown unaffected.
- Cold load: opening a prior session fetches `agent.sessionMessages`, renders the whole history in order. Part order matches OpenCode's canonical order (stable across reloads).
- Live updates: starting a new session (driven by the phase-0 mock with a canned multi-part script) → new parts appear in the native view as they arrive, no page reload.
- Text parts stream character-by-character (delta merges in place). Assistant cursor visible while `state.status === 'running'`; hidden on `completed`.
- `ToolPart` for a `bash` run:
  - Collapsed: shows `$ <command-preview>` + a status dot + the last line of output.
  - Expanded: mounts `<XTermAttached shellId>` with the metadata id and replays scrollback; if still running, live bytes continue to arrive.
  - Exit code and duration visible in expanded header.
- `ToolPart` for a `pty` open:
  - Collapsed: `Opened shell <label>`.
  - Expanded: "Open shell" button adds a shell tab in the right pane and activates it.
- `FilePart` / `PatchPart`: collapsed `<path> +A -D`; expanded renders a unified diff.
- `PermissionRequestBanner` appears inline at the tool part with the matching `callID` when `permission.updated` fires. Buttons are disabled / display-only in this phase (approval wiring is phase 6).
- Long transcripts (≥ 500 parts) render with virtualization; scroll stays smooth. Collapsing/expanding a part does not reflow the whole list.
- Two tabs open on the same session: both receive live updates; both can expand a bash part and watch output concurrently.
- Logged-out user hitting the sandbox page → redirected to login (tRPC cookie auth still enforced for `sessionMessages` and `transcript`).

---

## Phase 6 — Composer, permission approval, parity cutover

**Ships:** composer (sessionSend), permission approve/reject wired to existing procedures, session switcher (dropdown at top of Agents pane), session-create flow, polish (empty states, error states, reconnect banner). Preference flipped to `native` by default; `AgentUIProxy` removed; the Agents pane no longer has an iframe fallback.

**Acceptance:**

- Composer sends a prompt via `agent.sessionSend`; reply streams in. Textarea clears on send; Enter sends, Shift+Enter newlines.
- Composer disabled with a banner when `sessionStatus` shows a pending permission; approving/rejecting re-enables it.
- Approve button: tool call resumes; the banner disappears; session proceeds. `sessionApprove` is called with `always: false` by default; a checkbox offers "always allow this kind".
- Reject: the tool call surfaces an error part and the session waits for the next user turn.
- Session switcher dropdown (top of Agents pane):
  - Lists sessions for the current sandbox, newest first.
  - "New session" option → `sessionStart` with a small modal for optional title + initial prompt.
  - Selecting a session swaps the transcript in place (no page navigation).
- Network drops mid-stream: transcript subscription auto-reconnects (existing `AgentService.scheduleRestart`); a small "Reconnecting…" banner shows during the gap.
- Preference default flipped to `'native'`. An escape hatch in settings allows reverting to `'iframe'` for one release.
- `AgentUIProxy`, its route, and the asset-rewrite code removed. Base-sandbox image no longer needs the `opencode web` UI for our use (keep the binary; it just stops being embedded).
- Scripted end-to-end demo test (using the phase-0 mock with a pre-written script):
  1. Create sandbox, add repo, start session; mock scripts the assistant to emit text → `bash(git diff)` tool_use → final text.
  2. Native UI shows streaming text, a `bash` tool with live output, an edit patch, and a final response.
  3. Expanding the bash part shows scrolling `git diff` output in xterm.
  4. Asserts transcript order matches `agent.sessionMessages` after reload.
  5. Test also exercises the approve-permission path: a second script turn requests a gated tool; Playwright clicks Approve; session resumes.
- The obsolete preference row is a no-op in a follow-up; this PR does not delete it yet.

---

## Cross-cutting (checked at every phase)

- Typecheck and lint clean; zod schemas on every tRPC input.
- Unit tests for non-trivial server logic (stream retention timers, token middleware scope check, plugin fallback branching).
- Integration tests for tRPC routers against a real Postgres.
- Playwright smoke for each phase's headline user flow (phase 1: shell attach; phase 4: view a session; phase 5: send a message + approve a permission).
- README updated as operator-visible behavior changes (env vars for base-sandbox plugin, preference toggle, proxy removal).
