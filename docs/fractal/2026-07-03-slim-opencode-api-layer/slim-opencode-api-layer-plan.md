# Slim OpenCode API Layer Plan

## Task 1: Mocked-LLM OpenCode E2E Harness

Create a hermetic E2E path that runs the real app, real env-server, and real `opencode serve`, while routing model calls to a deterministic mocked LLM API. This stands alone because later API-slimming work needs proof that the UI is tested through OpenCode, not through mocked env tRPC responses.

**Steps**
- Add a test-only OpenAI-compatible mock LLM HTTP server that returns deterministic streaming and non-streaming chat responses.
- Add test bootstrap that seeds provider credentials/base URL so env-server launches OpenCode against the mock provider.
- Add a Playwright setup command or fixture that creates isolated app/env state, free ports, temp XDG/state dirs, and tears them down after tests.
- Add one smoke E2E that opens the real UI, creates or opens a workspace chat, sends a prompt, waits for the mocked response, and confirms the transcript renders.

**Tests**
- E2E: Start the real Kaivo/OpenCode stack with the mocked LLM, send a chat prompt through the UI, and assert the assistant response appears.
- E2E: Assert the test path does not use mocked env tRPC agent responses by verifying OpenCode/session identifiers or OpenCode-backed events are present.
- Unit: Mock LLM server returns stable responses for the request shapes OpenCode sends.

**Maintainability**
- Keep the mock LLM server isolated under test utilities; do not bake test behavior into production provider code.
- Use explicit test env vars for mock provider wiring so local dev credentials are never read in CI.
- Reuse existing local launcher/env-server startup code where practical instead of creating a second bespoke launcher.
- Ensure teardown kills child processes and removes temp state to avoid port leaks and flaky follow-up tests.

**Depends on:** none

**Status:** done

## Task 2: Message Hydration From OpenCode Plus Overlay Events

Change transcript hydration so OpenCode message history is the durable source and Kaivo replay rows are treated as overlay events. This ships a user-visible behavior only when reload/reconnect still renders existing messages and persisted Kaivo errors correctly.

**Steps**
- Introduce a frontend/server adapter boundary that names the two inputs separately: OpenCode messages and Kaivo overlay replay events.
- Preserve full message hydration for root and child sessions; do not add backend pagination in this task.
- Project persisted `session.error` overlay events into `session-error` transcript parts after OpenCode message hydration.
- Keep `agent.sessionMessages` available during migration, but stop relying on it as the conceptual source for Kaivo overlay data.

**Tests**
- E2E: With the mocked-LLM OpenCode stack, reload an active chat and assert previously generated OpenCode messages render from cold hydration.
- E2E: Inject or trigger a persisted session error, reload the chat, and assert the `session-error` UI still renders.
- Unit: Transcript projection merges OpenCode messages and overlay `session.error` events without duplicating messages after reconnect.
- Unit: Existing legacy replay rows containing `message.updated` or `message.part.updated` remain tolerated by the parser.

**Maintainability**
- Keep OpenCode message types separate from Kaivo overlay event types; avoid widening both into untyped `unknown` blobs at the UI boundary.
- Do not move synthetic error creation into generic OpenCode message fetch code.
- Keep merge/projection logic in a small focused module rather than expanding `chat-state.ts` into a larger catch-all.
- Preserve optimistic-message handling as a separate concern from cold hydration.

**Depends on:** Task 1

**Status:** done

**Status:** done

## Task 3: Stop Persisting OpenCode Message Mirrors

Narrow SQLite transcript persistence so ordinary OpenCode message and part updates are live-only events, while durable Kaivo overlay events still replay after reload. This is the core storage simplification and should not change what users see in an active chat.

**Steps**
- Update `recordReplayEvent` call sites or event filtering so `message.updated` and `message.part.updated` are emitted live but not inserted into `agent_transcripts`.
- Keep durable insertion for `session.error` and any approved overlay events such as `child.session.created`.
- Preserve sequence behavior for persisted overlay events and subscription replay from `sinceSeq`.
- Keep tolerant reading for existing databases that already contain full transcript mirror rows.

**Tests**
- E2E: Send a prompt through the mocked-LLM OpenCode stack, reload, and assert messages still render even though new message/part events were not persisted by Kaivo.
- E2E: Disconnect/reconnect or reload during/after a response and assert the UI recovers from OpenCode cold messages plus overlay replay.
- Unit: `message.updated` and `message.part.updated` are not inserted into `agent_transcripts` for new events.
- Unit: `session.error` still gets a replay sequence and survives cold reload.

**Maintainability**
- Keep live fanout and durable persistence decisions visibly separate so future events do not accidentally become durable rows.
- Avoid schema churn unless the existing `agent_transcripts` table cannot express overlay-only events.
- Document the event allowlist near the persistence filter, with a short reason for each durable event.
- Keep legacy-row compatibility tests so cleanup does not become a hidden migration requirement.

**Depends on:** Task 2

**Status:** done

## Task 4: Preserve Composite Status While Slimming Pass-Through Calls

Keep `sessionStatus` as the Kaivo composite runtime API, but remove avoidable full-transcript reads and identify any pure pass-through wrappers that can move behind `/agent/*` later. This stands alone because status correctness is user-visible through running indicators, approvals/questions, todos, queued messages, and context usage.

**Steps**
- Keep `sessionStatus` returning Kaivo session summary, pending approvals/questions, todos, running state, context usage, queued follow-ups, and retry handling.
- Use the lightest safe OpenCode message read for context usage, such as `limit`, while preserving correctness for current models.
- Confirm non-default `workingDir` calls preserve `directory` and `x-opencode-directory` behavior.
- Mark pure pass-through tRPC routes as deprecated only when an equivalent `/agent/*` proxy path is documented and covered by tests.

**Tests**
- E2E: With mocked LLM through OpenCode, assert the UI transitions through running and idle states while sending a message.
- E2E: Trigger or simulate a pending approval/question path and assert status polling updates the UI without relying on persisted message mirrors.
- Unit: Context usage reads only the needed recent message data and preserves model limit lookup behavior.
- Unit: `directoryOpts` are present for status/todo/message calls that need working-directory routing.

**Maintainability**
- Do not split `sessionStatus` into many endpoints until there is a clear frontend consumer boundary.
- Keep retry/error status handling close to the OpenCode status read so abort/surface behavior remains understandable.
- Avoid duplicating directory-option construction in frontend and backend code.
- Treat route deprecation as documentation plus tests, not immediate deletion.

**Depends on:** Task 3

**Status:** done

## Task 5: Raw OpenCode Gateway Compatibility Check

Make `/agent/*` an explicitly tested compatibility gateway for OpenCode-native reads without making it the primary Kaivo session runtime. This gives future slimming work a safe escape hatch and proves external-style clients can reach OpenCode through Kaivo auth.

**Steps**
- Add a small test client or Playwright helper that calls `/agent/*` with env-token auth and verifies OpenCode Basic Auth remains internal.
- Document which frontend reads may use `/agent/*` directly and which must stay on Kaivo tRPC.
- Verify message reads through `/agent/*` work for default and non-default working directories.
- Keep lifecycle, queued follow-ups, notifications, and composite status on Kaivo APIs.

**Tests**
- E2E: Fetch session messages through `/agent/*` using env-token auth after creating a chat through the UI.
- E2E: Attempt the same request without env-token auth and assert it is rejected.
- Unit: Proxy strips or rewrites auth/header behavior without exposing OpenCode Basic Auth to the frontend.

**Maintainability**
- Keep gateway tests focused on compatibility, not duplicating every OpenCode API behavior.
- Avoid coupling UI components directly to raw proxy URLs; use a small adapter if the frontend needs direct OpenCode reads.
- Keep auth expectations explicit so future refactors do not leak OpenCode credentials.
- Document unsupported direct-proxy use cases instead of silently allowing partial behavior.

**Depends on:** Task 1
