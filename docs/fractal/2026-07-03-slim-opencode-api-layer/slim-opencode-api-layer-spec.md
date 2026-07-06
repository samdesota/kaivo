# Slim OpenCode API Layer Spec

## Seed

Kaivo should keep OpenCode as an embedded engine, but slim the frontend-facing agent API so canonical OpenCode concepts like session messages and status flow through the raw OpenCode-compatible proxy where possible.

The work should preserve Kaivo-only behavior: env auth/lifecycle, directory routing, transcript replay, synthetic session errors, queued follow-ups, pending approvals/questions, todos, running state, context usage, and child-session awareness.

## Solution

- Boundary: Kaivo remains the product session runtime; OpenCode remains the embedded canonical engine.
- Proxy: `/agent/*` is the OpenCode-compatible gateway and escape hatch, not a replacement for Kaivo runtime APIs.
- Messages: OpenCode is the durable source for message history; Kaivo stores only durable overlay events such as session errors, not a SQLite mirror of every message/part event.
- Loading: keep full message hydration for now; rely on bottom-anchored lazy rendering for transcript performance.
- Status: keep status as a Kaivo composite because it combines OpenCode state with queued follow-ups, approvals/questions, context usage, retries, and child-session awareness.
- API slimming: remove or avoid only wrappers that are pure pass-throughs; keep wrappers that add Kaivo semantics.
- Auth: the frontend uses env-token auth; env-server owns OpenCode Basic Auth injection and never exposes OpenCode credentials.

## Spec

### Target Shape

Kaivo keeps the embedded OpenCode runtime and the env-server session control plane. OpenCode remains the durable owner of OpenCode session messages. Kaivo SQLite stores session metadata and Kaivo overlay events that are not safely recoverable from OpenCode.

The frontend transcript remains a merged projection:

1. Cold OpenCode message history from `session.messages`.
2. Cold child-session message history where the UI needs child transcripts.
3. Durable Kaivo overlay events replayed from SQLite.
4. Live OpenCode/Kaivo events applied in memory after subscription starts.
5. Periodic Kaivo status reconciliation for runtime facts that are not transcript content.

### Data Ownership

`agent_sessions` remains the Kaivo session index. It owns Kaivo session IDs, workspace mapping, OpenCode session IDs, working directory, selected model, title, archive/status fields, and activity timestamps.

`agent_transcripts` becomes an overlay-event log, not a full OpenCode transcript mirror. It keeps replay sequence numbers and durable Kaivo events needed after reload/reconnect.

OpenCode owns message history. Kaivo should not persist ordinary OpenCode `message.updated` or `message.part.updated` events once the overlay path is in place.

### Persisted Events

Persist these events in `agent_transcripts`:

- `session.error`: preserves durable error visibility after OpenCode has stopped or restarted.
- `child.session.created`: preserves parent/child discovery when OpenCode event timing makes child mapping ambiguous.
- `permission.replied`: only if the UI needs durable reply history beyond current pending state.
- `question.replied` and `question.rejected`: only if the UI needs durable answer history beyond current pending state.

Do not persist these as durable transcript rows:

- `message.updated`
- `message.part.updated`
- `session.busy`
- `session.idle`
- `todo.updated`, unless a future UI requires durable todo history rather than current status.
- `permission.updated`, unless a future UI requires durable permission history rather than current pending status.
- `question.asked`, unless a future UI requires durable question history rather than current pending status.

Live handling for non-persisted events remains. The server can still receive OpenCode events and forward them to active subscribers; the change is that normal OpenCode transcript events stop being written to SQLite as durable replay rows.

### Hydration And Replay

Initial hydration loads full OpenCode messages for the root session and full OpenCode messages for displayed child sessions. Backend pagination is out of scope for this pass; the UI continues to rely on `BottomAnchoredLazyList` for lazy rendering.

After message hydration, the frontend applies durable overlay events from `agent_transcripts`. Persisted `session.error` events are projected into the transcript as synthetic `session-error` parts so existing user-visible behavior is preserved.

Subscription starts from the latest overlay sequence. Live message and part events update the in-memory transcript projection, but they are not persisted as durable rows. Live durable overlay events are both persisted and emitted with a sequence.

Reconnect re-fetches OpenCode messages, replays overlay events since the last seen sequence, reapplies optimistic messages, and resubscribes. Duplicate or late sequence numbers must remain harmless.

### Status Boundary

`sessionStatus` remains a Kaivo API. It returns a composite view containing:

- Kaivo session summary, including `opencodeSessionId` and `workingDir`.
- Pending approvals across related root/child sessions.
- Pending questions across related root/child sessions.
- Current todos.
- Running state.
- Queued follow-ups.
- Context usage.
- Retry/error handling state.

Status polling remains separate from transcript replay. Runtime facts can update the UI without becoming durable transcript rows.

### OpenCode Proxy Boundary

`/agent/*` remains the OpenCode-compatible gateway. It authenticates with the Kaivo env token and injects OpenCode Basic Auth internally.

Direct frontend use of `/agent/*` is acceptable for OpenCode-native reads that do not require Kaivo semantics. It should not bypass Kaivo APIs for lifecycle, session identity mapping, queued follow-ups, approvals/questions aggregation, notifications, or status composition.

All OpenCode calls for sessions with a non-default working directory must preserve the existing directory behavior: pass `directory` and `x-opencode-directory` where the OpenCode endpoint expects them. Existing sessions with `workingDir = null` continue to mean the env default working directory.

### Compatibility

Existing transcript rows must remain readable. The parser should tolerate old rows containing full message and part events, and old sessions should continue to hydrate correctly.

The implementation may keep `withPersistedSessionErrors()` temporarily while the explicit overlay projection is introduced. The final shape should avoid returning Kaivo synthetic errors as if they came from raw OpenCode `session.messages`.

The `agent.sessionMessages` tRPC route may remain during migration. It should be removed or narrowed only after the frontend can hydrate from OpenCode messages plus overlay replay without behavior loss.

### Edge Cases

If OpenCode is unavailable during cold hydration, the UI should surface a recoverable error and retry using the existing reconnect path.

If OpenCode is available but overlay replay fails, raw messages should still render and the error should be visible to diagnostics.

If a user abort turns an OpenCode `session.error` into idle behavior, it must not create a persisted error overlay.

If child-session mapping arrives before the parent mapping is known, the service should still resolve parent/child relationships through OpenCode session metadata or the durable `child.session.created` overlay.

If a session has many messages, full hydration is acceptable for now, but rendering must remain bottom-anchored and lazy.
