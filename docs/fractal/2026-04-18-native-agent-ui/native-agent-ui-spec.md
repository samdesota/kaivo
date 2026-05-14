# Native Agent UI — Spec

## Seed

Phase 4 shipped a basic OpenCode web-UI proxy (iframe). The UI works but is missing features we want and doesn't integrate with the rest of our ecosystem. Build our own OpenCode UI on top of the OpenCode SDK. Requirements:

- **Agent shells are our shells.** When the agent opens a shell, it opens one in our existing `TerminalService` so it appears alongside human shells in the sandbox.
- **Live one-off command output.** When the agent runs a one-off bash command, the user can scroll through the output as it streams.
- **Collapsible detail.** Diffs and shell results are visible but not overwhelming by default — click to expand.
- Use the OpenCode SDK; drop the iframe.

## Outline

### Scope

- Replace the `/sandbox/:id/agent/*` iframe with a native React panel rendered by our SPA.
- Restructure the whole sandbox detail page around a new **tab shell** (two panes: Agents-left / tabs-right). Previous routes (`/agent`, `/shells`, `/preview`) collapse into right-pane tab types.
- Keep everything non-UI the same: `AgentService`, OpenCode `serve` per sandbox, transcripts table, permission flow, tRPC surface. Extend, don't rewrite.
- When parity is reached, delete `AgentUIProxy` (`server/agent/proxy.ts`) and the asset-rewrite code.
- Out of scope: changing OpenCode, adding model-config UI, session branching, replacing OpenCode for non-embedded users. Dynamic pane splitting is planned-for but not built in v1.

### Sandbox tab shell (new UI structure)

- **Two-pane layout.** Left (70%): fixed Agents pane. Right (30%): tab container.
- **Right-pane tab types:** `newtab`, `shell`, `file`, `preview`. `newtab` is the default and landing page.
- **`newtab` content:** quick actions (`+ New shell`), running-shells list (click-open or terminate), running-previews list (click-open), and a file tree over the sandbox workspace. Clicking a file opens it as a new `file` tab.
- **Shell lifecycle is independent of tabs.** Closing a shell tab does not terminate the shell; the shell stays live in `TerminalService`. A separate explicit terminate action is available (in the shells dropdown, on the `newtab` list, or via a shell-tab menu).
- **Top-chrome Shells dropdown.** Lists all running shells across open and closed tabs; offers open/terminate per shell. A parallel Previews dropdown does the same for live ports (data already available from `preview.ports` subscription).
- **Agents pane = the Native Agent UI.** Session switcher (dropdown) + transcript + composer. Not collapsible in v1.
- **Pane tree model designed for dynamic splitting.** v1 only constructs fixed shapes (single-leaf right-pane tabs); v2 can add arbitrary splits without changing the model or storage.
- **Tab state persists in localStorage** per sandbox in v1. Upgrade to DB if cross-device parity is needed.
- **Agent-opened persistent shells** appear in the Shells pool with an "agent" badge; same open/terminate affordances.

### The shell bridge (central requirement)

- **Mechanism: an OpenCode plugin.** Shipped in the base-sandbox image; loaded by `opencode serve` via its config. The plugin replaces the agent's shell-taking tools with ones that call back to our app.
  - Target tools: `bash` (one-off commands) and `pty` (persistent shells).
  - If custom tools don't cleanly replace builtins, fall back to `tool.execute.before` hooks that reroute the real tool into our app. **Verify during impl.**
- **Plugin ↔ app transport: tRPC.** Plugin runs `@trpc/client` against our main app's tRPC router over the sandbox Docker network. Typed end-to-end by importing `AppRouter`'s type. Auth: bearer token injected into `opencode serve`'s env at sandbox start, validated in `createContext` alongside the existing session cookie.
- **New tRPC router `agentShell.*`:**
  - `runOnce` — **subscription.** Streams `{type: "stdout"|"stderr", chunk}` and ends with `{type: "exit", code}`. Creates a TerminalService shell under the hood so the UI can also attach live via the existing `/ws/shell/:id`.
  - `open` — mutation. Creates a persistent shell tagged with the agent session id; returns shell id.
  - `write` / `close` — mutations for persistent shells.
  - `resize` — piggybacks on the existing `shell.resize` (agent shells are regular shells).
- **Shell ownership metadata.** Add `ownerKind: "human" | "agent"` and optional `ownerSessionId` to `shell_sessions`. Agent shells appear in the normal Shells panel alongside human ones, visually tagged.
- **Why not after-the-fact mirroring.** Letting OpenCode run its own bash and scraping output loses: cwd persistence, interactive control, shared shell state between agent and human. The whole point of the requirement is the agent and human share shells.

### TerminalService extension

- Add `runOnceStream({ sandboxId, cmd, cwd, onStdout, onStderr })` → non-buffered sibling of `runOnce`. Returns `{ exitCode }` on close.
- Implementation: same `docker exec` base, but no 10 MB buffer — bytes stream directly to callback. Keep an in-memory ring buffer (~200 KB) so a late-attaching UI still sees the tail.
- Assign each run a stable shell id so the browser can attach via the existing `/ws/shell/:id` WebSocket path. This reuses the xterm snapshot/live-stream machinery for free.
- Disposal: when `run-once` completes, the shell id is retained for N minutes (say 10) so the user can still scroll through output, then garbage-collected.

### Event pipeline (server side)

- `AgentService` already subscribes to OpenCode's SSE and mirrors `message.updated` to DB. Extend:
  - Forward all message-part event types (`message.part.updated` with `TextPart`, `ToolPart`, `FilePart`, `PatchPart`, `ReasoningPart`, `step-start`, `step-finish`) over the existing `agent.transcript` tRPC subscription.
  - Keep DB persistence to the message level (parts denormalized inside `content_json`).
- Cold load for the transcript panel: `client.session.messages({ id })` → returns full `[{ info, parts }]` array. Hydrate the UI, then switch to live stream. (Same pattern as xterm's snapshot+live.)
- Expose the underlying events as a stable discriminated union over tRPC — don't leak raw OpenCode types into frontend; wrap them to insulate us from SDK churn.

### Agents-pane UI

- **Agents pane** = session switcher (dropdown at top) + transcript (main) + composer (bottom). Lives in the left pane of the tab shell; not itself a tab.
- **Transcript is a sequence of rendered `Part`s**, not chat bubbles. Each part has a default compact rendering and a click-to-expand detail.
- **Part renderers:**
  - `text` / `reasoning`: prose, streaming deltas in place.
  - `tool` (bash one-off): collapsed = one-line command preview + running/exit indicator + last line of output. Expanded = inline xterm attached to the streaming shell id.
  - `tool` (pty / persistent shell): collapsed = "Opened shell `<label>`" with a jump-to-Shells-panel link. Expanded inline optional.
  - `file` / `patch`: collapsed = `path.ts  +12 -3`. Expanded = diff view (existing component if we have one, else minimal side-by-side).
  - `permission`: inline call-to-action card at the point the gate paused the session. Approve/reject buttons wired to existing `sessionApprove` / `sessionReject`.
  - `step-finish`: tiny footer (cost + tokens).
- **Default density.** Collapsed by default. Option in settings: "expand tool outputs by default" for power users.
- **"Jump to shell"** on agent-shell parts navigates to the Shells panel with that shell pre-focused.

### Permission flow

- Unchanged on the wire — `permission.updated` / `permission.replied` events already flow.
- UI surfaces the request inline on the blocked tool call (not a modal). Session status banner up top shows "Waiting for your approval" when any permission is pending.

### State, caching, perf

- Transcript state lives in TanStack Query, keyed by `sessionId`. Live events merge into the cache. Cold load is `session.messages`.
- Part-level memoization so a streaming delta on one text part doesn't re-render the whole transcript.
- Virtualize long transcripts (TanStack Virtual). Tool output inside a part lives in its own scroll container so expansion doesn't reflow the whole list.

### Migration & rollout

- Build the new panel behind a per-user preference (`agent.ui=native|iframe`, default `iframe` until parity).
- Iframe remains the fallback for unsupported flows during development.
- Remove `AgentUIProxy` + related routes in a follow-up PR after parity.

### Risks / verify-during-impl

- Does a plugin-defined tool named `bash` replace the builtin, or do they collide? If collision: use `tool.execute.before` rerouting.
- Does OpenCode stream tool stdout in chunks (via `delta` on `ToolPart`) or only at completion? If only at completion: our `/agent-shell/run-once` SSE back to the plugin is what powers the live view; OpenCode's transcript gets the final string. UI still gets live via the shell-id WS.
- Does `pty` exist as a tool we can intercept the same way, or is it implemented differently from `bash`? If different: scope persistent shells as v2; v1 ships bash-only.
- Plugin loading path in the base-sandbox image: config file vs. install into `node_modules`. Needs confirmation from OpenCode docs.

### Non-goals

- Multi-provider model picker UI.
- Session branching / checkpoints.
- Replacing the stand-alone `opencode web` for users who run OpenCode outside our env.
- Inline editor for agent edits (file tree + existing editor stays).

## Spec

### Component map

```
┌───────────────────────── main app ──────────────────────────┐
│  TerminalService (+ runOnceStream)                          │
│  AgentService (SSE → transcript stream) ─┐                  │
│  tRPC: agentShell.*, agent.* (existing)  │                  │
│  WS: /ws/shell/:id (existing)            ▼                  │
│                          ┌─ React panel: AgentSessionView ──┤
│                          │    transcript = Part[] renderer  │
│                          │    inline xterm for live output  │
│                          └─────────────────────────── UI ───┤
└──────────────────────────┬──────────────────────────────────┘
                           │ tRPC over Docker net (bearer)
                           ▼
┌───────────── sandbox container ─────────────┐
│  opencode serve  ← plugin (bash/pty tools)  │
│     │                                       │
│     └── trpc client → app.agentShell.*      │
└─────────────────────────────────────────────┘
```

### Data model changes

- `shell_sessions` gets two nullable columns:
  - `owner_kind` — `'human' | 'agent'`, default `'human'`.
  - `owner_session_id` — ulid of the `agent_sessions` row if `owner_kind='agent'`, else null.
- No other schema changes. Transcripts continue to use `agent_transcripts.content_json`.
- Migration: additive, drizzle migration + default backfill (`'human'` for existing rows).

### `TerminalService.runOnceStream`

```ts
interface RunOnceStreamOpts {
  sandboxId: string
  cmd: string
  cwd?: string
  cols?: number           // default 120
  rows?: number           // default 30
  onStdout?: (chunk: Uint8Array) => void
  onStderr?: (chunk: Uint8Array) => void
  signal?: AbortSignal
}

interface RunOnceStreamHandle {
  shellId: string              // stable id; browser can attach /ws/shell/:id
  exitPromise: Promise<{ exitCode: number; truncated: boolean }>
  dispose(): Promise<void>     // idempotent
}

runOnceStream(opts: RunOnceStreamOpts): RunOnceStreamHandle
```

- Implementation mirrors `runOnce` (`server/terminal/service.ts:290-303`) but stdout/stderr pipe through headless xterm (same scrollback, 10 k lines) without the 10 MB buffer accumulator.
- A `shell_sessions` row is created, `owner_kind='agent'`, tagged with the caller's agent session id (passed through by the `agentShell.runOnce` procedure).
- Retention: shell kept live for 10 minutes after `exitPromise` resolves so late UI attachment still sees scrollback; then `dispose()`.
- Stdout and stderr are separate callback streams; rendered xterm merges them (stderr optionally colored).

### `agentShell.*` tRPC router

All procedures use a new `agentShellProcedure` middleware that accepts either:
- the admin session cookie (for UI-driven calls — rare but allowed), or
- a bearer token header `Authorization: Bearer <token>` whose hash matches a row in a new `agent_shell_tokens` table `{ token_hash, sandbox_id, issued_at, revoked_at? }`. Token is minted during sandbox start and injected into `opencode serve`'s env as `CLOUDCODE_AGENT_TOKEN`.

The context includes `sandboxId` (from token row or from input for cookie calls).

```ts
agentShell = router({
  // One-off bash command. Streams chunks; ends with exit.
  runOnce: agentShellProcedure
    .input(z.object({
      cmd: z.string().min(1).max(64_000),
      cwd: z.string().optional(),
      agentSessionId: z.string().optional(),   // for owner tagging
      cols: z.number().int().min(1).max(500).default(120),
      rows: z.number().int().min(1).max(200).default(30),
    }))
    .subscription(({ input, ctx }) =>
      observable<
        | { type: 'started'; shellId: string }
        | { type: 'stdout'; b64: string }
        | { type: 'stderr'; b64: string }
        | { type: 'exit'; code: number; truncated: boolean }
      >((emit) => { /* bridge to TerminalService.runOnceStream */ })
    ),

  // Persistent shell (maps to OpenCode's pty tool).
  open: agentShellProcedure
    .input(z.object({
      cwd: z.string().optional(),
      agentSessionId: z.string().optional(),
      cols: z.number().int().default(120),
      rows: z.number().int().default(30),
      label: z.string().max(120).optional(),   // surfaced in Shells panel
    }))
    .mutation(async ({ input, ctx }) => ({ shellId: string })),

  write: agentShellProcedure
    .input(z.object({ shellId: z.string(), data: z.string() }))  // utf-8 data
    .mutation(...),

  close: agentShellProcedure
    .input(z.object({ shellId: z.string() }))
    .mutation(...),

  // Optional: read the tail of a persistent shell's scrollback as text.
  // The plugin uses this to return a final "output" string to OpenCode
  // when the tool completes; the UI doesn't need it (it attaches live).
  tail: agentShellProcedure
    .input(z.object({ shellId: z.string(), maxBytes: z.number().default(65_536) }))
    .query(async ({ input }) => ({ stdout: string, stderr: string, exitCode?: number })),
})
```

Byte chunks in subscriptions are base64-encoded — tRPC subscriptions are JSON. Frontend consumer rarely uses this path (it attaches the xterm directly via `/ws/shell/:id`); it's primarily for the plugin.

### The OpenCode plugin (`@kaivo/opencode-plugin`)

- Ships as a JS/TS module installed into the base-sandbox image at a fixed path, referenced from `~/.opencode/config.json` (or the opencode-config location; **verify in impl**).
- Startup: reads `CLOUDCODE_AGENT_TOKEN` and `CLOUDCODE_APP_URL` from env. Builds a typed tRPC client against our `AppRouter` type.
- Registers two tools in `Hooks.tool`:

```ts
bash: {
  description: "Run a shell command. Output streams to the user live.",
  args: z.object({ command: z.string(), cwd: z.string().optional(), timeout_ms: z.number().optional() }),
  async execute(args, ctx) {
    const sub = client.agentShell.runOnce.subscribe({
      cmd: args.command, cwd: args.cwd, agentSessionId: ctx.sessionID,
    })
    let shellId: string | undefined
    const stdout: string[] = []
    const stderr: string[] = []
    let exit = 0
    for await (const evt of sub) {
      if (evt.type === 'started') {
        shellId = evt.shellId
        ctx.metadata({ cloudcode_shell_id: shellId })   // surfaces to UI
      }
      if (evt.type === 'stdout') stdout.push(atob(evt.b64))
      if (evt.type === 'stderr') stderr.push(atob(evt.b64))
      if (evt.type === 'exit') { exit = evt.code; break }
      if (ctx.abort.aborted) break
    }
    return { exitCode: exit, stdout: stdout.join(''), stderr: stderr.join('') }
  },
},

pty: {
  description: "Open a long-lived shell. Returns a shell id you can write to.",
  args: z.object({ cwd: z.string().optional(), label: z.string().optional() }),
  async execute(args, ctx) {
    const { shellId } = await client.agentShell.open.mutate({
      cwd: args.cwd, label: args.label, agentSessionId: ctx.sessionID,
    })
    ctx.metadata({ cloudcode_shell_id: shellId })
    return { shellId }
  },
},
```

- Tool-name collision handling: if defining `bash` / `pty` in the plugin does not shadow builtins, the plugin falls back to `tool.execute.before` hooks that throw to OpenCode and delegate via our custom tools under different names (e.g., `cloud_bash`, `cloud_pty`) surfaced through `tool.definition` so the model sees them. The agent prompt will nudge toward the custom names. **Decide during impl after verifying SDK semantics.**

### `AgentService` extensions

- `handleEvent` (`server/agent/service.ts:386`) already forwards `message.part.updated` — no change needed for the primary stream. Confirm that tool-part `metadata.cloudcode_shell_id` survives the passthrough (it should — `payload` is raw props).
- Add a cold-load method:
  - `sessionMessages(sessionId: string): Promise<Array<{ info: Message, parts: Part[] }>>` → proxies `client.session.messages({ path: { id: opencodeSessionId } })`.
- Add a tRPC query: `agent.sessionMessages({ sessionId })`.
- No change to existing `sessionStart` / `sessionSend` / approve / reject.

### Frontend: Sandbox tab shell

The sandbox detail page is restructured around a fixed two-pane layout with a tab container on the right. Previous sub-routes (`/agent`, `/shells`, `/preview`) are removed; everything lives under one route and tab state is client-side.

**Layout sketch:**

```
┌─────────────────────── Sandbox: my-sbx ──────────────────────────────────┐
│                              Shells ▾ (3)  Previews ▾ (1)   ⚙ status     │
├────────────────────────┬─────────────────────────────────────────────────┤
│ Agents                 │ [tests*] [server/auth.ts] [5173 preview] [+]    │
│ session ▾ fix auth     │ ────────────────────────────────────────────── │
│ ────────────────────── │ $ npm test --watch                              │
│ > swap cookie to Lax   │  RUNS server/auth/cookie.spec.ts                │
│ v $ npm test …running  │ ...                                             │
│ > edit cookie.ts +3-1  │                                                 │
│ …                      │                                                 │
│ ┌────────────────────┐ │                                                 │
│ │> message …  [Send] │ │                                                 │
│ └────────────────────┘ │                                                 │
└────────────────────────┴─────────────────────────────────────────────────┘
        70%                                30%
```

**New-tab page (right-pane default):**

```
┌─ [+ New*] ────────────────────────────────────────────────────────────────┐
│   Quick actions   [ New shell ]                                           │
│                                                                           │
│   Running shells                                                          │
│    ● tests         npm test --watch              [open] [terminate]       │
│    ● dev server    npm run dev    (agent)        [open] [terminate]       │
│                                                                           │
│   Running previews                                                        │
│    ● :5173         dev server                    [open]                   │
│                                                                           │
│   Files                                                                   │
│    v repos/zoottle/                                                       │
│      > server/                                                            │
│        README.md                                                          │
└───────────────────────────────────────────────────────────────────────────┘
```

**Pane tree data model** (designed for dynamic splitting; v1 only emits fixed shapes):

```ts
type PaneNode =
  | { kind: 'leaf'; content: PaneContent }
  | { kind: 'split'; dir: 'h' | 'v'; ratio: number; children: [PaneNode, PaneNode] }

type PaneContent =
  | { type: 'newtab' }
  | { type: 'shell';   shellId: string }
  | { type: 'file';    path: string }
  | { type: 'preview'; port: number }

interface RightPaneState {
  tabs: Array<{ id: string; title: string; content: PaneContent }>
  activeTabId: string
}
```

v1 uses `RightPaneState` directly; the `PaneNode` type is declared but only leaf-single shapes are constructed. Dynamic splitting in a later release will replace `RightPaneState.tabs[].content` with a `PaneNode` root.

**Tab persistence:**

- `localStorage` key `sandbox.<id>.rightPane` holds the `RightPaneState` JSON.
- On sandbox open: hydrate from localStorage; if empty or invalid, initialize with `{ tabs: [{ newtab }], activeTabId: <newtab.id> }`.
- On tab changes (add/remove/activate/reorder), persist synchronously.
- **Shells referenced by closed tabs remain live** — the tab state only describes views, not shell lifecycle. On hydration, each `shell` tab checks `shell.list` and drops itself if the shell id no longer exists.

**Top-chrome dropdowns:**

- **Shells ▾ (n)**: backed by `shell.list.query({ sandboxId })` (already exists, filtered to current sandbox). Each entry: status dot, label, command preview, `owner_kind` badge, `[open] [terminate]`. `open` dispatches "add shell tab & activate"; `terminate` calls existing `shell.dispose`.
- **Previews ▾ (n)**: backed by `preview.ports.subscribe({ sandboxId })`. Each entry: port, process hint, `[open]`. `open` dispatches "add preview tab & activate".
- Both are popovers closed by click-outside.

**Right-pane tab chrome:**

- Each tab: title + small close button. Close removes the tab from state; does **not** terminate the backing shell / preview.
- `+` at the end of the tab bar opens a new `newtab`.
- Overflow: horizontal scroll on the tab bar; no dropdown in v1.

**Tab content renderers** (`src/routes/sandbox/tabs/`):

- `NewTabContent` — quick actions, running-shells list (consumes `shell.list`), running-previews list (consumes `preview.ports`), file tree (consumes `fs.list` / `fs.watch` — both already exist).
- `ShellTabContent` — wraps the existing `<XTermAttached shellId>`. A small toolbar on top with label, exit status (if applicable), and a ⋯ menu offering "Terminate shell".
- `FileTabContent` — file viewer (read-only in v1; the file editor is a separate future concern — the current minimal editor in the codebase can be lifted in).
- `PreviewTabContent` — iframe pointed at `/preview/:sandboxId/:port/`. Reuses the existing reverse proxy verbatim.

**Route changes:**

- `src/routes/sandbox/$sandboxId.tsx` becomes the tab-shell host. It renders `<AgentSessionView>` (left) and `<RightPaneTabs>` (right). No sub-routes.
- Old `sandbox/$sandboxId/agent`, `sandbox/$sandboxId/shells`, `sandbox/$sandboxId/preview` routes removed. Any deep links in docs/PR comments get redirected via a simple `<Navigate>` shim during one release.

### Frontend: `AgentSessionView`

Location: new directory under `src/routes/sandbox/agent/`. Rendered as the left-pane content of the tab shell.

- **Mount point:** inside the tab shell at `<LeftPane>`; not a standalone route.
- **Data:**
  - TanStack Query key `['agent','messages',sessionId]` populated by `agent.sessionMessages`.
  - tRPC `agent.transcript` subscription merges events into the same cache (immutable updates; part lookups by `partID`).
- **Part renderers** (`src/routes/sandbox/agent/parts/`):
  - `TextPart` — streaming prose; cursor blink while `state.status === 'running'`.
  - `ReasoningPart` — collapsed by default under "Thinking" disclosure.
  - `ToolPart`
    - `tool === 'bash'` → `BashToolPart`: header row `$ <command>` + status dot (running/exit). Collapsed shows last line of output (from the attached shell's scrollback, tailed from xterm). Expanded mounts an `XTerm` component attached to `metadata.cloudcode_shell_id` via existing `/ws/shell/:id` WebSocket.
    - `tool === 'pty'` → `PtyToolPart`: header `Opened shell <label>`, button "Open in Shells panel" that navigates to `/sandbox/:id/shells/:shellId`.
    - Any other tool → generic collapsed `tool-name` + pretty-printed input/output on expand.
  - `FilePart` / `PatchPart` — collapsed `path.ts +A -D`. Expanded shows unified diff (use a minimal `react-diff-viewer` or roll one; not specified here).
  - `PermissionRequestBanner` — inline card at the tool part with the matching `callID`, Approve / Reject buttons hitting existing procedures.
  - `StepFinish` — thin footer with cost/tokens (dim text).
- **Composer:** textarea + Send button → `agent.sessionSend`. Disabled when `sessionStatus` shows pending approval; banner explains why.
- **Virtualization:** `@tanstack/react-virtual` on the parts list. Each part's expanded content owns its own scroll.
- **XTerm reuse:** factor the existing `Terminal` component at `src/routes/sandbox/terminal.tsx:7` into a `<XTermAttached shellId>` that both the Shells panel and `BashToolPart` use.

### Session startup: where does `agentSessionId` come from?

- `sessionStart` already inserts an `agent_sessions` row (our ulid) and maps it to `opencodeSessionId`.
- The plugin sees OpenCode's session id (`ctx.sessionID`). To tag our shells with our id, add a lookup table in memory (or query `agent_sessions` by `opencodeSessionId` on each `agentShell` call — small, cached).
- `agentShell` procedures accept `agentSessionId` as the *OpenCode session id*; backend resolves to our id via `AgentService`. Simpler than threading our id through the plugin.

### Auth — `agent_shell_tokens`

- Minted by `AgentService.startAgent` (or `bootstrap` in the lifecycle); stored `sha256(token)` → sandbox id mapping.
- Lifetime: as long as the `opencode serve` process lives. Rotated on sandbox restart.
- Injected into `opencode serve` env alongside existing provider keys. The app URL also injected: `CLOUDCODE_APP_URL=http://app:3000` (container-internal DNS on `DOCKER_NETWORK`).
- Middleware `agentShellProcedure` checks the bearer; rejects 401 with typed tRPC code.
- Scope check: every procedure verifies the shell or session in its input belongs to the token's sandbox.

### Base-sandbox image changes

- Add `npm install -g @kaivo/opencode-plugin@<pinned>` (or bundle as a local tarball if we keep it in-repo; pick during impl).
- Seed an `~/.opencode/config.json` template that wires the plugin path.
- No change to `opencode-ai` version requirement; plugin targets the running version.

### Sandbox startup sequence (updated)

1. `SandboxManager.create` — unchanged up to container start.
2. Mint `CLOUDCODE_AGENT_TOKEN`; insert `agent_shell_tokens` row.
3. `docker exec -d opencode serve ...` with env: existing vars **plus** `CLOUDCODE_AGENT_TOKEN`, `CLOUDCODE_APP_URL`.
4. Readiness probe unchanged.
5. `AgentService` subscribes to SSE as before.

On `app` restart: reconciler re-reads tokens; if a token row is missing for an active sandbox (unlikely), it mints a new one and restarts opencode-serve to pick it up. Otherwise no-op.

### `agent.ui` preference

- New user-scope preference row `preferences.agent_ui` (enum `'native' | 'iframe'`, default `'iframe'` during development, flipped to `'native'` once parity).
- Sandbox detail page reads preference and renders either `<AgentSessionView>` or the old iframe.
- Preference is trivial UX plumbing — if it turns out we don't care about the iframe fallback, we can skip this and just cut over. Decide based on confidence at parity.

### Reverse-proxy routing (updated)

- Keep `/sandbox/:id/agent/*` (old iframe proxy) only if the preference toggle survives; otherwise delete `AgentUIProxy` and its route.
- Add nothing new on the HTTP surface — `agentShell.*` lives under the existing `/trpc/*` route.

### Edge cases

- **Agent runs bash before opening any persistent shell.** `runOnceStream` still creates a shell_sessions row owned by the agent session. It just doesn't auto-surface in the Shells panel unless the user explicitly asked. Convention: **run-once shells don't show in the Shells panel list**; they only exist to host live output. Persistent (`open`) shells do.
- **Agent's bash command exits instantly.** The `started` event still fires so the UI has a `shellId`; the xterm attaches, replays scrollback (the whole completed output), sees no more live bytes. Works the same.
- **User kills an agent-owned persistent shell from the Shells panel.** Next `agentShell.write` from the plugin returns an error → the plugin returns `{ exitCode: 130, stderr: "shell terminated by user" }` to OpenCode. Session continues.
- **Plugin can't reach the app (network blip).** Plugin retries with exponential backoff up to ~10 s, then returns `{ exitCode: 1, stderr: "cloud-code app unreachable" }`. OpenCode sees a normal tool error.
- **Session held open for hours, long transcript.** Virtualization keeps the DOM small. `agent_transcripts` inserts continue. Event stream reconnect on network drop already handled by `AgentService.scheduleRestart`.
- **Two tabs watching the same session.** Both subscribe to `agent.transcript`; both can attach to the same shell's WS. Merged keystrokes only apply to persistent shells (bash run-once shells are output-only from the user's POV; typing into them does nothing useful — disable composer in the `BashToolPart` inline xterm).
- **Plugin tool throws.** Plugin wraps everything in try/catch and returns a structured `{ exitCode: 1, stderr: "<err.message>" }` so OpenCode never sees a JS exception (it would otherwise mark the session errored).
- **Switching `agent.ui` mid-session.** Both renderers are just views of the same `agent_sessions` / OpenCode state; switch reloads the page. No data migration.
- **Stored tab references a dead shell.** On hydration, shell tabs verify against `shell.list`; missing shells drop silently. An empty tab set falls back to a single `newtab`.
- **Closing the last right-pane tab.** Auto-open a `newtab` — the right pane always has at least one tab.
- **Preview tab whose port is no longer listening.** Tab stays open; iframe shows a "port closed" placeholder served by the preview proxy. User closes the tab manually.
- **localStorage quota or corruption.** Catch parse errors, log, reset to default `newtab` state. Never block render on tab-state issues.

### Dependencies (new)

Backend: no new runtime deps. (`@trpc/client` already transitively; confirm.)

Sandbox plugin package (`@kaivo/opencode-plugin`): `@opencode-ai/plugin`, `@trpc/client`, `zod`, `undici` (for fetch if needed on older Node). Shipped as its own workspace package in the monorepo.

Frontend: `@tanstack/react-virtual` (if not already present). Everything else is already in the stack.

### File layout (new or touched)

```
server/
  agent/
    service.ts              # add sessionMessages(); no event changes
    shell-bridge.ts         # NEW — TerminalService.runOnceStream wiring
    token.ts                # NEW — mint/verify agent_shell_tokens
  terminal/
    service.ts              # add runOnceStream
  trpc/
    routers/
      agent-shell.ts        # NEW — the router above
      agent.ts              # add sessionMessages query
    middleware/
      agent-shell-auth.ts   # NEW — bearer-or-cookie middleware
  db/
    schema.ts               # shell_sessions.owner_kind/owner_session_id,
                            # agent_shell_tokens
  sandbox/
    manager.ts              # inject CLOUDCODE_AGENT_TOKEN / APP_URL

packages/opencode-plugin/   # NEW workspace package
  src/index.ts
  src/tools/bash.ts
  src/tools/pty.ts
  src/trpc-client.ts

src/routes/sandbox/
  $sandboxId.tsx            # tab-shell host (replaces sub-routes)
  shell/
    tab-shell.tsx           # top chrome + Shells/Previews dropdowns + LeftPane/RightPane
    right-pane-tabs.tsx     # tab bar + content dispatch
    tab-state.ts            # RightPaneState + localStorage persistence
  tabs/
    new-tab.tsx             # quick actions, shells/previews lists, file tree
    shell-tab.tsx           # <XTermAttached> + terminate menu
    file-tab.tsx            # file viewer
    preview-tab.tsx         # iframe to /preview/:id/:port/
  agent/
    session-view.tsx        # AgentSessionView (left pane)
    session-switcher.tsx    # dropdown at top of AgentSessionView
    parts/                  # one file per Part renderer
    xterm-attached.tsx      # factored from terminal.tsx; shared with shell-tab
```

Old `sandbox/$sandboxId/{agent,shells,preview}` route files are removed.
