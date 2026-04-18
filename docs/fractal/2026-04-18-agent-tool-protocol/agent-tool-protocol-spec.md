# Agent Tool Protocol — Spec

## Seed

Design a protocol that agentic web browsers use to adopt tools from websites. A website publishes a script reference (a manifest/endpoint pointer). An agentic browser that has agentic access reads that reference and pulls in tools the agent can invoke to interact with the page. Tool invocations travel over an RPC protocol between the agent and the page.

This protocol is spec 1 of 2. Spec 2 is a cloud coding environment (clone repo, edit files, run shells, start dev servers, spawn Docker containers, expose preview URLs) that will be the first consumer of this protocol — proving it handles non-trivial tool surfaces beyond simple form-filling.

## Outline

### Two execution modes — the central choice

- **Page mode**: tool call is dispatched to the open page (JS handler). For tools that need DOM state, the user's logged-in session, or the live app context (selected file, current cursor, in-page caches).
- **Endpoint mode**: tool call is dispatched to an HTTP endpoint. For long-running server ops (clone repo, start container, stream logs), ops callable without the tab alive, and ops that need server-side privileges.
- **Same wire shape both modes** — one JSON-RPC-style envelope; only the transport differs. The agent should not need mode-specific code paths beyond "where do I send this request."
- **A single manifest can mix both** — e.g. `workspace.select_file` runs in-page while `repo.clone` hits an endpoint. Each tool declares its mode.

### Discovery

- Website advertises tools via a single reference the browser can find on the page:
  - Primary: `<link rel="agent-tools" href="/.well-known/agent-tools.json">` in the document head.
  - Fallback: a `<script type="application/agent-tools+json">` inline block, or a `window.__agentTools` bootstrap for SPAs that want to register dynamically.
- The reference points to a **manifest** (static JSON or dynamically generated per-session).
- Manifest URL is scoped to an origin; cross-origin manifests are rejected unless explicitly allowlisted by the agent browser's settings.

### Manifest shape

Top-level fields:

- `protocolVersion` — version of this protocol the manifest targets (semver).
- `name`, `description` — human/LLM-readable summary of what this tool surface is for.
- `server` — endpoint-mode config (omit if page-mode-only):
  - `rpcUrl` — single JSON-RPC endpoint all endpoint-mode tools POST to.
  - `eventsUrl` — SSE/WebSocket endpoint for server-pushed events.
- `session` — handshake config (required if `server` is present or any tool uses endpoint mode):
  - `handshakeTool` — name of the page-mode tool that returns `{ token, expiresAt, context }`.
  - `contextField` — where to put `context` on outbound calls (default: JSON-RPC `meta.context`).
- `instructions`:
  - `static` — inline string **or** `{ url }` pointing to a text resource. Appended to agent system prompt; cached by manifest version hash.
  - `dynamicSource` — name of a tool the agent calls before each user turn for fresh state. Omit for sites with no dynamic state.
  - `dynamicMaxTokens` — agent's budget for the dynamic slot (default: 2000).
- `tools[]` — see below.
- `events[]` — declared event channels (name, description, payload schema) the agent may subscribe to on `server.eventsUrl`.

Per-tool fields:

- `name` — dotted identifier (`workspace.select_file`, `repo.clone`).
- `version` — semver; lets a site ship v1 and v2 of the same tool in parallel.
- `description` — LLM-readable.
- `mode` — `"page"` | `"endpoint"`.
- `inputSchema`, `outputSchema` — JSON Schema.
- `streaming` — `false` | `"partial"` (chunked frames share the request id).
- `timeoutMs` — agent-enforced upper bound; server/page may finish sooner.
- `sideEffects` — `"none"` | `"reversible"` | `"destructive"` — drives consent UI.
- `mode === "page"` adds: `channel` — the postMessage handler name the page registers.
- `mode === "endpoint"` adds: nothing beyond the shared `server.rpcUrl`; `name` is the JSON-RPC `method`.

Sketch:

```json
{
  "protocolVersion": "0.1",
  "name": "Cloud Coding Workspace",
  "server": { "rpcUrl": "/agent/rpc", "eventsUrl": "/agent/events" },
  "session": { "handshakeTool": "session.handshake" },
  "instructions": {
    "static": { "url": "/agent/instructions.md" },
    "dynamicSource": "workspace.current_context",
    "dynamicMaxTokens": 3000
  },
  "tools": [
    { "name": "session.handshake", "mode": "page", "channel": "session.handshake",
      "version": "1.0.0", "sideEffects": "none", "outputSchema": { "...": "..." } },
    { "name": "workspace.current_context", "mode": "page", "channel": "ctx",
      "version": "1.0.0", "sideEffects": "none" },
    { "name": "repo.clone", "mode": "endpoint", "version": "1.0.0",
      "streaming": "partial", "timeoutMs": 120000, "sideEffects": "reversible" }
  ],
  "events": [
    { "name": "shell.output", "payloadSchema": { "...": "..." } },
    { "name": "session.invalidate", "payloadSchema": { "...": "..." } }
  ]
}
```

### Page mode transport

- `window.postMessage` between the agent-browser's content-script bridge and the page. The page opts in by registering a handler (e.g. a small JS SDK: `agentTools.register("workspace.select_file", handler)`).
- Request/response envelope: JSON-RPC 2.0 (`id`, `method`, `params`, `result`/`error`).
- Streaming results: chunked messages sharing the request id with `partial: true` until a terminal message.
- The page cannot call the agent — only respond to tool calls. (Unsolicited "the user did X, please react" goes through the events stream, not an RPC back-channel.)

### Endpoint mode transport

- Plain HTTPS. One URL per tool (`POST {server.baseUrl}/{tool.path}`) or a single RPC endpoint with `method` in the body — **pick one and stick to it.** Proposal: single RPC endpoint, JSON-RPC 2.0 body, for symmetry with page mode.
- Long-running calls use SSE or chunked transfer: server streams `partial` result frames, final frame carries `result` or `error`.
- Events stream is its own SSE/WebSocket endpoint the agent subscribes to with the session token.

### Authentication & session

- Agent identifies itself to the site via a session handshake: agent posts (user-approved) identity + requested capabilities; site returns a session token + scoped manifest.
- Page mode: session token is passed in each `postMessage` envelope (the in-page SDK verifies).
- Endpoint mode: `Authorization: Bearer <token>`.
- No cookies implied — sessions are explicit so a site can distinguish agent traffic from browser traffic for audit/rate-limiting.

### Bridging page → endpoint: context & auth injection

- The page holds the user's real login session; endpoints need to act on behalf of that user without the agent having raw cookies. The handshake is how the page hands a **scoped bearer token** to the agent.
- Handshake is always a **page-mode call** (even for endpoint-heavy sites, one small in-page bridge is required). Manifest declares it: `session.handshake` → returns `{ token, expiresAt, context }`.
- **`context`** is a site-defined blob the agent must echo back on every endpoint call (e.g. `{ workspaceId, branch }` for the cloud coding env). Sent as `X-Agent-Context: <base64 JSON>` header or JSON-RPC `meta` field — **pick one; propose `meta` field** so page and endpoint transports stay symmetrical.
- Context must be **signed by the page-issued token** server-side (or be a server-verifiable opaque blob) so a compromised agent can't tamper with it.
- **Context refresh**: page state can change mid-session (user switches workspace). Two triggers:
  - Token TTL expiry → agent re-calls `session.handshake`.
  - Page emits a `session.invalidate` event on the events stream → agent re-handshakes before next call.
- If the tab closes, the token is still valid until `expiresAt` — endpoint-mode tools keep working for their declared TTL. This is the whole point of endpoint mode for long-running work.

### User consent & permissioning

- Agent browser shows the user a consent prompt when first loading a manifest from an origin, listing tools and modes.
- Per-tool granularity: user can allow a subset (e.g. allow read-only tools, deny destructive ones).
- Consent is remembered per origin + manifest version hash. Manifest version bump → re-prompt.

### Prompt injection: static + dynamic

- Manifest contributes to the agent's prompt in two slots, distinguished by caching semantics:
  - **`instructions.static`** — site-authored text appended to the system prompt. Covers the "how this tool surface works" context (domain model, conventions, warnings, preferred workflows). Stable for the manifest version → lives in the prefix-cached region of the prompt.
  - **`instructions.dynamic`** — refreshed state injected before each user message. Covers what's changing (current workspace, open files, running shells, last build status). Lives after the cached prefix → does not invalidate the cache on prior turns.
- **Source of each**:
  - Static: inline string in manifest, or a URL (fetched once, cached by manifest version hash).
  - Dynamic: a declared tool name (`instructions.dynamicSource = "workspace.current_context"`). Agent calls that tool before each user turn. The tool itself is page- or endpoint-mode like any other — whichever has the state.
- **Ordering in the agent's prompt**:
  1. Agent's own system prompt
  2. `instructions.static` (prefix-cached)
  3. Conversation history (also cached up to this point)
  4. `instructions.dynamic` output — regenerated each turn, placed just before the next user message so it doesn't invalidate earlier cache entries
- **Size guidance in the manifest** — site declares `instructions.dynamicMaxTokens` so the agent can budget. If the dynamic tool returns more, agent truncates or surfaces a warning.
- **Failure mode**: if the dynamic source fails, the agent proceeds without it (surfacing the error to the model) rather than blocking the turn.

### Errors, timeouts, cancellation

- JSON-RPC error codes plus a small domain set (`E_PERMISSION_DENIED`, `E_SESSION_EXPIRED`, `E_RATE_LIMITED`, `E_TOOL_UNAVAILABLE`).
- Cancellation: agent sends a `$/cancel` with the target request id; both transports must honor it (page handler receives an abort signal; endpoint receives an HTTP cancellation or explicit cancel RPC).
- Timeouts declared per tool in the manifest; agent respects them and surfaces them to the model.

### Lifecycle

- Manifest loaded on page navigation / activation; cached by version hash.
- Page mode tools are only live while the tab is open; if the tab closes mid-call, the agent gets `E_TOOL_UNAVAILABLE`.
- Endpoint mode tools survive tab close — useful for the cloud coding env where a build is running server-side.
- Manifest refresh: the page can emit an event telling the agent to reload the manifest (new tools came online).

### Versioning

- Protocol `version` in manifest; agent refuses manifests newer than it understands.
- Individual tools can be versioned via name suffix or an explicit `version` field — **pick one; propose `version` field with semver.**

