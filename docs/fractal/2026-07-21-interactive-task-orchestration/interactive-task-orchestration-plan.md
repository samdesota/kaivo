# Interactive Task Orchestration Plan

## Task 1: Establish Safe Task Provisioning

Create the independently testable integrity boundary required before an agent can provision worktrees and sessions. This Task has no product UI, but prevents the first user-facing dispatch path from shipping with global agent authority or unrecoverable partial state.

**Steps**
- Add env SQLite migrations and shared contracts for agent-session kinds, durable orchestration subtasks, operation IDs, provisioning checkpoints, worktree/session bindings, lifecycle state, delivery placeholders, and structured failures.
- Extend authenticated env request context with user and session-bound agent principals and centralized capabilities for dispatch, own-task delivery updates, orchestration reads, and user-only completion.
- Extend repository provisioning to resolve an explicit branch, tag, or commit exactly; create a deterministic branch in a dedicated Kaivo worktree clone; and reject ownership, path, ref, and branch conflicts without fallback.
- Add a focused orchestration service that reserves an operation and advances idempotent worktree, independent root OpenCode session, persisted `subtask` session, and initial-prompt stages.
- Persist artifact ownership, retryability, and residual artifacts; add conservative stage compensation and startup reconciliation that resume safe stages or record an integrity failure.
- Expose service-level dispatch and retry procedures behind workspace and principal checks, without registering an agent tool or product entry point yet.

**Tests**
- Unit: Migrate fresh and existing env databases, rerun migrations idempotently, restart the database, and verify normal `chat` sessions retain existing behavior.
- Unit: Provision from branch, tag, and commit refs; reject unresolved refs and deterministic path/branch collisions without fallback or unrelated cleanup.
- Unit: Fault-inject every provisioning boundary, retry the same operation ID, and verify one task, worktree, OpenCode session, initial prompt, and accurate residual-artifact report.
- Unit: Reconcile reserved, cloned, session-created, prompt-accepted, missing-worktree, and orphan-session states with the specified retryable or terminal outcome.
- Unit: Verify user, dispatch-session, subtask-session, wrong-workspace, and unbound-agent capabilities at service and tRPC boundaries.

**Maintainability**
- Keep orchestration in a new service/router instead of adding provisioning and hierarchy logic to the already oversized agent service.
- Define session kind, lifecycle, provisioning, artifact, and failure contracts once for schema, service, plugin client, and future UI use.
- Implement provisioning stages as small idempotent handlers with declared inputs, outputs, and owned artifacts.
- Keep principal and capability checks in authenticated context helpers rather than duplicating token-condition branches.
- Make compensation ownership-aware and conservative; never remove or attach to a pre-existing path, branch, repository row, or session.

**Depends on:** none

**Status:** done

## Task 2: Dispatch One Interactive Subtask

Ship the first useful end-to-end experiment: a user starts a dispatch thread, asks it to launch one task from an agent-chosen ref, and opens the independently interactive subtask chat on desktop or a narrow screen.

**Steps**
- Add the dispatch-only plugin tool with validated operation ID, title, instruction, repository, source ref, branch, and delivery mode; bind caller identity from tool context and do not expose the tool to subtask sessions.
- Add the experimental dispatch-session creation choice and ensure the selected provider, model, effort, workspace, and working directory follow existing session behavior.
- Seed each subtask session with bounded context containing its task identity, dispatch title, delivery mode, source ref, and branch, without exposing sibling tasks or transcripts.
- Expose workspace-scoped orchestration snapshots and changes needed to show top-level dispatch sessions and nested provisioning, active, and failed subtasks.
- Extract a reusable selected-session chat surface so dispatch and subtask rows reuse existing transcripts, streaming, sends, follow-ups, approvals, questions, and abort behavior.
- Build the orchestration navigator and selected-chat view with selectable progress/failure rows, stable parentage, and no positional OpenCode-child matching.
- Use two columns at wide sizes and navigator/chat screens with back navigation at narrow sizes; preserve ordinary chat-session rendering unchanged.

**Tests**
- E2E: Start an orchestration session, ask the dispatch agent to launch a task from an explicit ref, observe its nested row, open its chat, and exchange a user/agent turn independently of the dispatcher.
- E2E: Repeat the flow at a narrow viewport, navigate into the subtask and back, and retain the active stream and selected row.
- Unit: Verify the dispatch tool derives its dispatch session/workspace, returns provisioning/active/failed results, preserves operation IDs across transport retries, and is absent from subtask sessions.
- Unit: Verify initial subtask context contains its required task and Git metadata and excludes sibling task state and transcripts.
- Unit: Verify hierarchy selection, provisioning progress, failure rendering, normal-chat rendering, and workspace isolation.

**Maintainability**
- Keep plugin handlers as validated clients of orchestration procedures; do not duplicate provisioning logic in the plugin process.
- Extract the chat surface instead of cloning transcript and interaction behavior or expanding the workspace route.
- Use stable persisted IDs for hierarchy and selection rather than OpenCode child order or render position.
- Share one responsive orchestration tree across breakpoints; change navigation presentation rather than duplicating desktop and mobile state.
- Keep the first UI limited to one complete dispatch path and defer aggregate polish without omitting required failure visibility.

**Depends on:** Task 1

**Status:** done

## Task 3: Review Every Returned Turn

Turn completed subtask responses into a durable inbox: returned tasks show their latest summary and runtime attention, remain interactive, and are visible in fresh dispatcher context.

**Steps**
- Persist immutable orchestration returns with a unique `(subtask_id, assistant_message_id)` constraint, response/error kind, bounded summary, and stable sequence for replay.
- Add an isolated turn observer that records each new terminal assistant message, including textless tool turns and errors, while excluding pending questions, permissions, and aborted turns without a terminal message.
- Transition `active` to `returned` on a return and back to `active` when a user starts another subtask turn without deleting return history or treating idle as completion.
- Publish sequenced orchestration changes merged with projected running and attention state; implement reconnect replay and stale-cursor snapshot replacement in a focused client store.
- Show latest summaries, response/error state, running and attention indicators, and initial dispatch aggregate counts in navigator rows while retaining the full selected transcript on the right.
- Inject a bounded, regenerated orchestration snapshot into each dispatch-agent turn so the dispatcher sees active and returned work without sibling transcript content.

**Tests**
- E2E: Let a subtask finish, see its row become returned with the latest summary, open the full response, send a follow-up, and see the next terminal turn replace the row summary.
- E2E: Trigger a question, permission request, textless tool turn, and terminal error; verify only terminal turns create response/error returns while attention remains independent.
- Unit: Replay duplicate idle, reconnect, and assistant-message events and verify exactly one immutable return.
- Unit: Verify snapshot/change ordering, merged runtime state, stale-cursor recovery, workspace isolation, and returned-to-active transitions.
- Unit: Verify dispatcher context is bounded and current on every turn and excludes sibling transcript content.

**Maintainability**
- Keep terminal-turn detection and summary derivation as pure logic called by the observer rather than embedding orchestration branches in generic event handling.
- Treat SQLite lifecycle and returns as durable authority; keep running, questions, and permissions as explicitly transient projections.
- Use one sequenced orchestration event contract for hydration, replay, and live updates instead of parallel polling shapes.
- Derive aggregate counts and row state from normalized store data rather than persisting duplicate counters.
- Bound summaries and injected context through shared deterministic formatters so UI and agent context cannot drift.

**Depends on:** Task 2

**Status:** done

## Task 4: Complete and Hand Off Work

Let subtasks report PR or dispatcher-integration results, then let only the user mark work complete with an explicit confirmation that feeds the outcome back to the dispatcher.

**Steps**
- Add the subtask-scoped delivery-reporting tool and mutation for summary, PR URL, and head commit; enforce that an agent can update only the task bound to its session.
- Project delivery mode, worktree path, branch, PR URL, head commit, latest result, and completion metadata into task details and dispatcher context.
- Add an idempotent, user-only completion mutation that preserves the session, transcript, worktree, return history, unresolved attention, and first completion timestamp.
- Record a late terminal assistant turn after completion for history without making it actionable or moving the task out of `completed`.
- Add **Mark complete** to active and returned task views and implement its typed detached-overlay confirmation, including delivery metadata and warnings for expected but missing metadata.
- Update completed navigator rows and aggregates immediately while keeping completed chats readable and visually de-emphasized.

**Tests**
- E2E: Have a subtask report an independent PR, confirm completion from its returned chat, switch to the dispatcher, and verify completed status and PR metadata there.
- E2E: Complete a dispatcher-integration task with branch/head metadata but no PR and verify no merge, archive, worktree deletion, or attention dismissal occurs.
- Unit: Reject cross-task delivery updates and agent completion attempts; verify repeated user completion preserves the first timestamp and one completed state change.
- Unit: Complete during an in-flight turn, process its late terminal message, and verify return history grows while lifecycle remains completed and no inbox action reappears.
- E2E: In Electron, verify the completion confirmation renders above browser tabs and both cancel and confirm responses work through the detached overlay.

**Maintainability**
- Keep delivery state independent from lifecycle so missing or changing PR metadata cannot corrupt completion transitions.
- Reuse the typed overlay request/response controller; do not add an in-workspace modal or duplicate confirmation state.
- Centralize session-bound ownership checks for dispatch and delivery tools instead of trusting caller-supplied task IDs.
- Keep completion idempotent and side-effect free with respect to Git, archives, notifications, and filesystem cleanup.
- Render delivery metadata through one compact component shared by task details and completion confirmation.

**Depends on:** Task 3

**Status:** done

## Task 5: Surface Recovery and Integrity Failures

Expose the safe provisioning and restart behavior from Task 1 in the product so interrupted operations recover automatically or give the user an accurate retry path without hidden or duplicate work.

**Steps**
- Reconcile the latest terminal assistant message through the same return path during startup so restarts cannot lose or duplicate returned work.
- Stream durable provisioning stage, retryability, and residual-artifact changes into selectable progress and failure panes.
- Offer retry only for safe stages and resume the same operation; classify missing or externally moved worktrees as non-retryable, disable chat sending, and direct the user to request a replacement dispatch.
- Preserve hierarchy, latest return, completion, and selected chat across app reloads, environment-server restarts, reconnect replay, and stale-cursor snapshot replacement.
- Make startup reconciliation bounded and observable so one damaged task becomes a visible failed row rather than blocking environment startup.

**Tests**
- E2E: Force a retryable provisioning failure, inspect its details, retry it, and reach the same single interactive subtask without duplicate artifacts.
- E2E: Reload during provisioning and restart after a subtask response; verify hierarchy, progress, latest return, completion, and chat selection recover.
- E2E: Remove or move a subtask worktree, verify its chat becomes non-sendable with an integrity failure, and request a replacement from the dispatcher.
- Unit: Reconcile a missed terminal message through live return logic and verify assistant-message deduplication.
- Unit: Verify missing worktree, residual artifact, stale cursor, and retryable stage projections produce the specified send/retry actions and converge after recovery.

**Maintainability**
- Share live and startup return recording so deduplication and summary behavior have one code path.
- Render typed failure data directly; do not parse retryability, stage, or artifact identity from error strings.
- Keep reconciliation independent per task and bounded so one failure cannot stop other sessions or startup.
- Reuse the orchestration change store for progress and recovery rather than introducing a second polling authority.

**Depends on:** Task 4

**Status:** done

## Task 6: Operate Multiple Threads Reliably

Finish the experiment for sustained use: parallel dispatch threads remain understandable and resource-bounded, and archive and notification behavior cannot silently mutate orchestration state.

**Steps**
- Finalize stable dispatch ordering, nested task creation order, aggregate running/returned/attention/failed/completed counts, and selection fallback as sessions change.
- Preserve live chat state for selected and relevant sessions while fixing retain/release eviction so inactive subtasks stop permanent subscriptions and status polling.
- Support parallel updates without selection jumps, duplicate rows, positional child matching, or transcript cross-talk; keep ordinary OpenCode child transcripts separate.
- Prevent archived dispatch sessions from creating tasks until reopened; keep archived subtask records readable and restore interaction only after the session reopens. Archive never completes a task.
- Refine wide and narrow navigation, keyboard focus restoration, and realistic summary truncation without changing the shared hierarchy state.
- Mirror returns into global notifications only as optional awareness; notification open/dismiss actions must not mutate return or completion state.

**Tests**
- E2E: Run two dispatch threads with parallel active, returned, attention-needed, failed, and completed tasks; switch chats and verify stable ordering, aggregates, and no transcript cross-talk.
- E2E: Archive a dispatch and reject a new dispatch until reopen; archive and reopen a subtask and verify its task remains incomplete, visible, and interactive only after reopen.
- E2E: At narrow and wide sizes, navigate among dispatch and subtask chats without losing streaming output, focus, selection, or completion controls.
- Unit: Verify normalized projections, aggregate selectors, out-of-order events, selection fallback, and retain/release cleanup for many sessions.
- Unit: Open and dismiss mirrored notifications and verify durable returns, summaries, lifecycle, and completion remain unchanged.
- Human: Review hierarchy density, state distinction, returned-message readability, and navigator/chat transitions with long realistic titles and summaries.

**Maintainability**
- Split navigator, row, detail, and responsive-navigation responsibilities into focused components rather than growing workspace or session-view routes.
- Use stable persisted IDs for hierarchy and selection; never infer orchestration parentage from render order or OpenCode child position.
- Centralize store retention and cleanup so components cannot leak subscriptions through ad hoc retain calls.
- Keep responsive behavior state-driven and shared across breakpoints instead of maintaining separate desktop and mobile trees.
- Derive optional notifications from orchestration events while preserving env SQLite as the sole inbox authority.

**Depends on:** Task 5

**Status:** done
