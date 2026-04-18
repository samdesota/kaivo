# Agent Tool Protocol (ATP) — v0.1

**Status**: Draft. Source of truth.
**Last updated**: 2026-04-18

ATP lets a website publish a tool surface that agentic web browsers can adopt. A site advertises a manifest; a conforming agent browser loads it, obtains user consent, and exposes the declared tools to the agent running in the user's session. Tools execute in one of two modes: **page mode** (dispatched to the open tab via `postMessage`) or **endpoint mode** (dispatched to an HTTPS JSON-RPC endpoint). Both modes share a single wire envelope.

ATP also contributes **prompt content** (static + dynamic) and a stream of **events** the agent can subscribe to.

---

## 1. Terminology

- **Site** — the web origin publishing ATP tools.
- **Agent browser** — a browser (or extension) that hosts an LLM agent, discovers ATP manifests, and routes tool calls.
- **Agent** — the LLM driving the agent browser.
- **Page** — an open document from the Site, where page-mode tool handlers run.
- **Server** — the Site's backend, where endpoint-mode handlers run.
- **Manifest** — the JSON document declaring the Site's tool surface.
- **Session** — an agent-scoped authorization context minted by the Site via the handshake.
- **Tool** — one named, typed RPC method declared in the manifest.

---

## 2. Discovery

The agent browser discovers a Site's ATP manifest through, in order of precedence:

1. `<link rel="agent-tools" href="..." />` in `<head>`. `href` may be relative.
2. `<script type="application/agent-tools+json">...</script>` inline in the document (for fully-static sites).
3. `window.__agentTools = { ... }` — a JS bootstrap that the agent browser polls for during page load (permitted for SPAs that construct the manifest dynamically).

The manifest URL MUST be same-origin with the page, unless the agent browser user has explicitly allowlisted the manifest origin.

A Site MAY serve a different manifest per request (e.g. based on the user's cookie-auth state). The agent browser MUST NOT assume the manifest is stable across navigations.

---

## 3. Manifest

### 3.1 Schema

```ts
interface Manifest {
  protocolVersion: string;          // semver; this document defines "0.1"
  name: string;
  description: string;              // LLM-readable
  server?: {
    rpcUrl: string;                 // absolute or same-origin path
    eventsUrl?: string;             // SSE; WebSocket allowed if prefixed wss://
  };
  session?: {
    handshakeTool: string;          // name of a page-mode tool
    contextField?: "meta.context";  // only permitted value in v0.1
  };
  instructions?: {
    static?: string | { url: string };
    dynamicSource?: string;         // tool name, page- or endpoint-mode
    dynamicMaxTokens?: number;      // default 2000
  };
  tools: Tool[];
  events?: EventChannel[];
}

interface Tool {
  name: string;                     // dotted identifier, unique within manifest
  version: string;                  // semver
  description: string;
  mode: "page" | "endpoint";
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  streaming?: "none" | "partial";   // default "none"
  timeoutMs?: number;               // default 30000
  sideEffects: "none" | "reversible" | "destructive";
  // page-mode only:
  channel?: string;                 // postMessage handler name
}

interface EventChannel {
  name: string;
  description: string;
  payloadSchema: JSONSchema;
}
```

### 3.2 Identity & versioning

- The manifest's **identity hash** is `sha256(canonicalJSON(manifest))`. Consent decisions are cached against this hash.
- A Site MUST bump `protocolVersion` only when this document bumps. Individual tools are versioned per-tool (`Tool.version`).
- Two tools MAY share a `name` if their `version` differs, to support staged migrations. The agent selects the highest version it understands.

### 3.3 Constraints

- `tools[].name` is a case-sensitive dotted identifier matching `[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*`.
- If any `tool.mode === "endpoint"`, `server.rpcUrl` MUST be present.
- If `server` is present or any tool is endpoint-mode, `session.handshakeTool` MUST be a declared page-mode tool.
- `instructions.dynamicSource` MUST be a declared tool name with `outputSchema` producing `{ text: string }`.

---

## 4. RPC envelope

Both transports use JSON-RPC 2.0 with a single extension field: `meta`.

### 4.1 Request

```json
{
  "jsonrpc": "2.0",
  "id": "req-7",
  "method": "repo.clone",
  "params": { "url": "https://github.com/..." },
  "meta": {
    "token": "<session bearer>",
    "context": { "workspaceId": "abc123" },
    "toolVersion": "1.0.0"
  }
}
```

- `id` is a string chosen by the agent, unique per in-flight request.
- `meta.token` is REQUIRED for endpoint mode; OPTIONAL for page mode (the page's own postMessage origin check is the primary trust boundary).
- `meta.context` is the opaque blob returned by the handshake.
- `meta.toolVersion` lets the handler pick behavior for concurrent tool versions.

### 4.2 Response — terminal

```json
{ "jsonrpc": "2.0", "id": "req-7", "result": { "commit": "deadbeef" } }
```

or

```json
{ "jsonrpc": "2.0", "id": "req-7", "error": { "code": -32000, "message": "...", "data": { "kind": "E_RATE_LIMITED" } } }
```

### 4.3 Response — partial (streaming tools)

Tools declared `streaming: "partial"` MAY emit intermediate frames before the terminal frame:

```json
{ "jsonrpc": "2.0", "id": "req-7", "result": { "progress": 0.4 }, "meta": { "partial": true } }
```

Frames sharing an `id` belong to the same call. The last frame has no `meta.partial` (or explicit `partial: false`).

### 4.4 Cancellation

The agent MAY send:

```json
{ "jsonrpc": "2.0", "method": "$/cancel", "params": { "id": "req-7" } }
```

Handlers SHOULD honor this:
- Page mode: the registered handler receives an `AbortSignal`.
- Endpoint mode: the server aborts, responds with `error.code: -32800`.

Cancellation is best-effort; a destructive side effect may have already occurred.

---

## 5. Page mode transport

### 5.1 Registration

The page loads a small SDK (the Site provides it; ATP specifies the interface it must implement) that registers handlers:

```js
agentTools.register("session.handshake", async (params, { signal }) => {
  return { token: "...", expiresAt: 1713456789, context: { workspaceId: "..." } };
});
```

### 5.2 Wire

The agent browser posts JSON-RPC requests into the page via `window.postMessage` with a well-known envelope:

```json
{
  "__atp": "1",
  "direction": "a2p",
  "payload": { "jsonrpc": "2.0", "id": "...", "method": "...", "params": { } }
}
```

Responses travel page→agent with `direction: "p2a"`. The SDK is responsible for origin checks (`event.origin`, `event.source`) and for dispatching to the registered handler by `payload.method`.

### 5.3 Streaming

Streaming tools post multiple `p2a` messages sharing a single `payload.id` with `payload.meta.partial: true` until a terminal message.

### 5.4 Tab close

If the tab hosting the page closes while a page-mode request is in flight, the agent browser MUST synthesize `error.code: -32001` (`E_TOOL_UNAVAILABLE`) and fail the call.

---

## 6. Endpoint mode transport

### 6.1 RPC

All endpoint-mode tool calls POST to `server.rpcUrl`.

- `Content-Type: application/json`
- `Authorization: Bearer <token>` (from handshake)
- Body: JSON-RPC request from §4.1

Non-streaming responses are returned as a single JSON object with the JSON-RPC response.

### 6.2 Streaming

For tools declared `streaming: "partial"`, the server responds with `Content-Type: text/event-stream` and emits one SSE `data:` frame per JSON-RPC frame. The stream ends after the terminal frame; the server MUST close the response.

Clients MUST accept both behaviors: a tool declared `streaming: "partial"` MAY still terminate in a single frame if there was no intermediate progress.

### 6.3 Events

The agent browser subscribes to `server.eventsUrl` once per session:

- `GET server.eventsUrl` with `Authorization: Bearer <token>` and `Accept: text/event-stream`.
- Server emits SSE frames whose `event:` field is the channel name (`tools[].name` or `events[].name`) and `data:` is the payload JSON.
- The agent browser routes events to subscribed tools/UI.

Events are unidirectional (server → agent). If the agent needs to act on an event, it calls a tool.

---

## 7. Session & handshake

### 7.1 Flow

1. Agent browser loads manifest. If session is required, it invokes the declared `session.handshakeTool` via page mode.
2. The page-mode handler exchanges the user's in-page credentials (cookies, OAuth, etc.) for an agent-scoped bearer token and returns:
   ```json
   { "token": "...", "expiresAt": 1713459999, "context": { "workspaceId": "abc123" } }
   ```
3. The agent browser stores `{ token, expiresAt, context }` and includes them on subsequent calls per §4.1.

### 7.2 Refresh

The agent browser re-calls the handshake when any of the following occurs:

- `Date.now() / 1000 >= expiresAt - 30`.
- A `session.invalidate` event (if declared) arrives on the events stream.
- Any call returns `E_SESSION_EXPIRED`.

Refresh is best-effort on a per-call basis: if a refresh fails, in-flight calls surface the underlying error.

### 7.3 Context integrity

`context` is opaque to the agent. The Site's server is responsible for binding `context` to the token such that tampered or stale contexts are rejected. Recommended: sign `context` with a server-side key and include the signature inside the `context` object.

### 7.4 Tab-independence

The token is valid until `expiresAt` regardless of whether the tab that issued the handshake is still open. Endpoint-mode tools MAY continue to run after tab close; page-mode tools MAY NOT (see §5.4).

---

## 8. Instructions (static + dynamic)

### 8.1 Static

- `instructions.static` is either an inline string or `{ url }` that returns `text/plain` or `text/markdown`.
- Fetched once per manifest identity hash; cached.
- The agent browser appends `static` to the agent's system prompt verbatim, inside a clearly-labeled ATP block.
- Stable content → benefits from prompt prefix caching on the agent browser's LLM provider.

### 8.2 Dynamic

- `instructions.dynamicSource` names a tool (page- or endpoint-mode) whose `outputSchema` is `{ text: string }`.
- The agent browser calls this tool **once per user turn**, immediately before sending the user's message to the model.
- The returned text is inserted into the prompt **after** the conversation history and **before** the new user message.
  - Rationale: keeps the cacheable prefix (system prompt + static instructions + prior turns) stable, while letting the current turn see fresh state.
- If the call fails, the turn proceeds without the dynamic block; the agent browser surfaces a terse error line to the model (`[atp: dynamic context unavailable]`) so the model knows.

### 8.3 Budget

- `instructions.dynamicMaxTokens` bounds the dynamic slot. If the returned text exceeds it, the agent browser truncates from the end and appends `…[truncated]`.

### 8.4 Prompt layout (informative)

```
<system prompt>
<ATP static block: site name + instructions.static>              ← prefix-cached
<conversation history t0..tN-1>                                   ← prefix-cached up to here
<ATP dynamic block: instructions.dynamicSource output>            ← regenerated per turn
<user message tN>
```

---

## 9. Permissions & consent

### 9.1 First-load consent

The agent browser prompts the user on first encounter of a manifest identity hash, showing:

- Site origin.
- Manifest `name` + `description`.
- Each tool: `name`, `description`, `sideEffects`.
- Whether the handshake will grant the agent a scoped token to the Site backend.

### 9.2 Granularity

The user MAY:

- Allow all.
- Allow a subset of tools.
- Allow only `sideEffects: "none"` tools.
- Deny.

Consent is cached per `(origin, manifest identity hash)`. A different manifest hash re-prompts.

### 9.3 Destructive tools

`sideEffects: "destructive"` tools SHOULD trigger an additional per-call confirmation the first time the agent invokes them in a conversation. Agent browsers MAY let the user disable this after seeing the pattern.

### 9.4 Kill switch

The user can revoke consent for a manifest at any time. All in-flight calls are canceled per §4.4 and subsequent calls return `E_PERMISSION_DENIED`.

---

## 10. Errors

Error codes use JSON-RPC ranges plus an ATP-specific `data.kind` discriminator.

| Code     | `data.kind`            | Meaning                                    |
| -------- | ---------------------- | ------------------------------------------ |
| -32600   | —                      | Invalid JSON-RPC                           |
| -32601   | —                      | Method not found                           |
| -32602   | —                      | Invalid params (schema violation)          |
| -32603   | —                      | Internal error                             |
| -32000   | `E_RATE_LIMITED`       | Site rate-limited this agent               |
| -32001   | `E_TOOL_UNAVAILABLE`   | Tool exists but cannot run now (tab closed, backend down) |
| -32002   | `E_SESSION_EXPIRED`    | Token rejected; agent should refresh       |
| -32003   | `E_PERMISSION_DENIED`  | User or Site refuses                       |
| -32004   | `E_CONTEXT_INVALID`    | Server rejected `meta.context`             |
| -32800   | `E_CANCELED`           | Cancellation honored                       |

Sites MAY add their own codes in `data.kind` but MUST use code `-32000` for unmapped errors.

---

## 11. Lifecycle

- **Manifest load**: on page load, agent browser fetches the manifest (subject to consent state).
- **Re-evaluate on navigation**: same-origin navigation in the same tab reuses the session and consent; cross-origin re-discovers.
- **Refresh signal**: the page MAY emit an `atp.manifest_changed` event (a reserved event name). The agent browser re-fetches the manifest; consent is re-evaluated only if the identity hash changed.
- **Session invalidation**: see §7.2.
- **Shutdown**: when the user closes the tab, endpoint-mode work continues up to token expiry. Page-mode work fails per §5.4.

---

## 12. Security considerations

- **Origin confusion**: agent browsers MUST verify `event.origin` on every inbound postMessage and reject those not matching the page's origin.
- **Token exfiltration**: the agent browser MUST NOT expose the handshake token to the page's non-ATP JS once received. It is scoped to endpoint calls only.
- **Context tampering**: see §7.3. Sites that skip server-side binding allow a compromised agent to forge context.
- **CSRF**: endpoint-mode calls carry a bearer token, not cookies. Sites SHOULD reject calls to `rpcUrl` that arrive with a session cookie but no `Authorization` header.
- **Prompt-injection via dynamic instructions**: sites control text that lands in the agent's system prompt. Agent browsers SHOULD wrap the ATP static block in a delimiter that discourages the inner text from claiming higher-level instructions (e.g. `=== Begin ATP instructions from <origin> === ... === End ATP instructions ===`).
- **Destructive tools**: see §9.3.

---

## 13. Conformance

An implementation is "ATP v0.1 conformant" as:

- **Site conformant**: serves a valid manifest; implements the declared page-mode handlers via the specified `window.postMessage` envelope; implements `rpcUrl` and `eventsUrl` per §6 if it declares them.
- **Agent browser conformant**: discovers manifests per §2; obtains user consent per §9; issues valid JSON-RPC per §4; implements the handshake/refresh loop in §7; injects instructions per §8; honors cancellation per §4.4.

---

## 14. Appendix A — Minimal example

### Manifest (`/.well-known/agent-tools.json`)

```json
{
  "protocolVersion": "0.1",
  "name": "Cloud Coding Workspace",
  "description": "Clone repos, edit files, run shells, and start dev containers in a sandboxed environment.",
  "server": {
    "rpcUrl": "/agent/rpc",
    "eventsUrl": "/agent/events"
  },
  "session": { "handshakeTool": "session.handshake" },
  "instructions": {
    "static": {
      "url": "/agent/instructions.md"
    },
    "dynamicSource": "workspace.current_context",
    "dynamicMaxTokens": 3000
  },
  "tools": [
    {
      "name": "session.handshake",
      "version": "1.0.0",
      "description": "Mint a per-agent session token.",
      "mode": "page",
      "channel": "session.handshake",
      "sideEffects": "none",
      "inputSchema": { "type": "object", "properties": {} },
      "outputSchema": {
        "type": "object",
        "required": ["token", "expiresAt", "context"],
        "properties": {
          "token": { "type": "string" },
          "expiresAt": { "type": "integer" },
          "context": { "type": "object" }
        }
      }
    },
    {
      "name": "workspace.current_context",
      "version": "1.0.0",
      "description": "Return a text snapshot of the user's current workspace state.",
      "mode": "page",
      "channel": "workspace.current_context",
      "sideEffects": "none",
      "inputSchema": { "type": "object", "properties": {} },
      "outputSchema": {
        "type": "object",
        "required": ["text"],
        "properties": { "text": { "type": "string" } }
      }
    },
    {
      "name": "repo.clone",
      "version": "1.0.0",
      "description": "Clone a Git repo into the current workspace.",
      "mode": "endpoint",
      "streaming": "partial",
      "timeoutMs": 120000,
      "sideEffects": "reversible",
      "inputSchema": {
        "type": "object",
        "required": ["url"],
        "properties": {
          "url": { "type": "string", "format": "uri" },
          "ref": { "type": "string" }
        }
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "progress": { "type": "number" },
          "commit": { "type": "string" }
        }
      }
    }
  ],
  "events": [
    {
      "name": "shell.output",
      "description": "Stdout/stderr from a running shell.",
      "payloadSchema": {
        "type": "object",
        "properties": {
          "shellId": { "type": "string" },
          "stream": { "enum": ["stdout", "stderr"] },
          "data": { "type": "string" }
        }
      }
    },
    {
      "name": "session.invalidate",
      "description": "Session context changed; agent should re-handshake.",
      "payloadSchema": { "type": "object" }
    }
  ]
}
```

### Wire trace — `repo.clone`

Agent → `POST /agent/rpc` with `Authorization: Bearer <token>`:

```json
{
  "jsonrpc": "2.0",
  "id": "req-12",
  "method": "repo.clone",
  "params": { "url": "https://github.com/example/app" },
  "meta": {
    "context": { "workspaceId": "abc123", "sig": "..." },
    "toolVersion": "1.0.0"
  }
}
```

Server → SSE:

```
event: message
data: {"jsonrpc":"2.0","id":"req-12","result":{"progress":0.3},"meta":{"partial":true}}

event: message
data: {"jsonrpc":"2.0","id":"req-12","result":{"progress":0.8},"meta":{"partial":true}}

event: message
data: {"jsonrpc":"2.0","id":"req-12","result":{"progress":1.0,"commit":"deadbeef"}}
```

Then closes the response.
