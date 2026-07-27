# Interactive Task Orchestration

## Seed

Add an experimental orchestration mode where a dispatch agent launches work in dedicated worktrees with fully interactive chats and coordinates their results back into a central task thread. Returned work that needs user review appears in an inbox represented initially as a new agent-session type.

## Solution

- Session model: Add first-class dispatch and subtask session kinds with durable parentage and task lifecycle state.
- Dispatch: Give dispatch agents an orchestration tool that provisions a dedicated Kaivo worktree and an interactive subtask session as one recoverable operation.
- UI: Use a two-column agent-session view with the orchestration navigator on the left and the selected dispatch or subtask chat on the right.
- Navigation: List dispatch threads at the top level, with their running and returned subtasks nested underneath.
- Returns: Treat every completed subtask agent turn as a review return and show its latest assistant-message summary in the navigator; the task remains active.
- Completion: Only the user marks a subtask complete; completed status and returned work are visible to the dispatch agent when its thread resumes.
- Ownership: Persist orchestration, session, transcript, and worktree state in the environment; keep only workspace presentation state in the app.
- Experiment boundary: Introduce orchestration as a new agent-session mode while reusing the existing interactive chat and transcript experience.

## Spec

### Scope

The experiment adds an orchestration session mode to a workspace. A user chats with a dispatch agent, the agent creates independently interactive subtask chats in dedicated Kaivo worktrees, and the user moves between every chat from one orchestration view. In the current repository service, a Kaivo worktree is an independent repository clone rather than a linked Git `worktree`; this feature preserves that product abstraction.

The experiment coordinates work and exposes delivery metadata. A subtask may produce an independent pull request or leave work for the dispatcher to integrate. It does not add a bespoke merge, cherry-pick, or pull-request review workflow; agents continue to use their normal Git and GitHub capabilities.

### Domain Model

#### Agent sessions

Every persisted agent session has a kind:

```ts
type AgentSessionKind = "chat" | "dispatch" | "subtask";
```

`chat` preserves current behavior. A `dispatch` session is a top-level orchestration thread. A `subtask` session is an independent root OpenCode session, not an OpenCode child session, so the user can open it, send messages, answer questions, grant permissions, and resume it directly.

#### Subtasks

A durable subtask record binds one dispatch session to one subtask session and one provisioned Kaivo worktree.

```ts
type SubtaskState =
  | "provisioning"
  | "active"
  | "returned"
  | "completed"
  | "failed";

type DeliveryMode = "pull_request" | "dispatcher_integration";

type ProvisioningStage =
  | "reserved"
  | "worktree_created"
  | "session_created"
  | "prompt_accepted";

interface OrchestrationSubtask {
  id: string;
  workspaceId: string;
  dispatchSessionId: string;
  sessionId: string | null;
  repositoryId: string;
  worktreeId: string | null;
  title: string;
  instruction: string;
  sourceRef: string;
  branchName: string;
  deliveryMode: DeliveryMode;
  state: SubtaskState;
  provisioningStage: ProvisioningStage | null;
  latestReturnId: string | null;
  delivery: SubtaskDelivery;
  completedAt: string | null;
  failure: {
    stage: string;
    message: string;
    retryable: boolean;
    residualArtifacts: string[];
  } | null;
  createdAt: string;
  updatedAt: string;
}
```

`sourceRef` is always supplied by the dispatch agent. Provisioning must resolve that branch, tag, or commit exactly and fail rather than silently falling back. `branchName` identifies the subtask's working branch. The environment stores authoritative orchestration state; app persistence may store only selected row, panel size, or ordering preferences.

`completed` is terminal for orchestration and can only be set by an authenticated user action. `failed` is reserved for provisioning or worktree/session integrity failures, not ordinary agent-turn errors. Archiving a chat does not complete its subtask, and an idle agent does not imply completion. A completed subtask remains readable and visible under its dispatch thread.

#### Returns

Each qualifying completed assistant turn creates an immutable return:

```ts
interface OrchestrationReturn {
  id: string;
  subtaskId: string;
  assistantMessageId: string;
  kind: "response" | "error";
  summary: string;
  createdAt: string;
}
```

`(subtaskId, assistantMessageId)` is unique. The summary is derived from the latest assistant message and is bounded for navigator display. Full content remains in the canonical transcript.

When a return is recorded, an `active` subtask becomes `returned`. A further user message in the subtask chat may resume execution and move it back to `active`; the next completed assistant turn returns it again. Opening a return does not complete or delete it. A user may explicitly complete a subtask from either `active` or `returned` state.

### Components

#### Orchestration service

The environment server owns subtask creation, lifecycle changes, return recording, hierarchy queries, and change publication. It enforces that dispatch session, subtask session, repository clone, and workspace all belong to the paired environment and same workspace.

Creation is an idempotent saga because Git, the filesystem, SQLite, and OpenCode cannot share a transaction. Each request carries an operation ID and progresses through durable provisioning stages:

1. Reserve the subtask identity and deterministic clone/branch names.
2. Resolve the requested source ref and create the dedicated Kaivo worktree clone.
3. Create an independent OpenCode session rooted at that worktree and persist its `subtask` agent-session row.
4. Send the initial instruction asynchronously and mark the subtask `active`.

A retry with the same operation ID returns or resumes the same operation. A naming or ref conflict fails before session launch. Later failures trigger best-effort compensation and persist any residual paths, repository records, or OpenCode session IDs for diagnosis and retry; the API never reports strict atomicity.

#### Dispatch tool

Only `dispatch` sessions receive the orchestration tool:

```ts
dispatch_subtask({
  operationId: string;
  title: string;
  instruction: string;
  repositoryId: string;
  sourceRef: string;
  branchName: string;
  deliveryMode: "pull_request" | "dispatcher_integration";
}): Promise<{
  subtaskId: string;
  sessionId?: string;
  state: "provisioning" | "active" | "failed";
  worktreePath?: string;
  failure?: {
    stage: string;
    message: string;
    retryable: boolean;
    residualArtifacts: string[];
  };
}>;
```

The tool derives the dispatch session and workspace from tool context rather than accepting them as arguments. It is nonblocking once the initial prompt is accepted: the dispatcher can launch multiple subtasks and continue chatting. Subtask sessions do not receive this tool in the experiment, preventing recursive orchestration.

Subtask sessions instead receive a scoped delivery-reporting tool:

```ts
report_subtask_delivery({
  pullRequestUrl?: string;
  headCommit?: string;
  summary?: string;
}): Promise<SubtaskDelivery>;
```

The tool derives the subtask from session context and cannot update another task. Repeated calls patch the same delivery record and publish orchestration changes.

#### Turn observer

The agent runtime observes idle transitions for persisted `subtask` sessions. It records a return whenever the session has a new terminal assistant message. Text responses use a bounded text summary; tool-only or otherwise textless turns use a bounded status summary. Duplicate idle events, reconnect replay, and server restart cannot duplicate a return because assistant message ID is the durable idempotency key.

An aborted turn without a terminal assistant message creates no return. A terminal assistant error creates an error return with a bounded diagnostic and leaves the task available for another user message; it does not use the provisioning-only `failed` state. Pending permission or question states remain active attention states and do not create returns.

#### Dispatcher context

Before each dispatch-agent turn, the environment injects a compact orchestration snapshot into system context. It contains subtask ID, title, lifecycle state, delivery mode, source ref, worktree path, branch, latest return summary, completion metadata, PR URL, and head commit when known. The snapshot is regenerated from durable state, not appended permanently to chat history.

This lets the dispatcher reason about newly returned and user-completed work after the user switches back to its chat. The dispatcher cannot mark a task complete through the context or tool.

Subtask agents receive their task identity, dispatch thread title, delivery mode, source ref, and branch in initial context. They do not receive transcripts from sibling tasks.

#### Orchestration API

The authenticated environment API exposes conceptual operations equivalent to:

```ts
listOrchestration(workspaceId): OrchestrationSnapshot;
subscribeOrchestration(workspaceId, cursor): OrchestrationChangeStream;
dispatchSubtask(input): DispatchResult;
completeSubtask(subtaskId): OrchestrationSubtask;
updateSubtaskDelivery(subtaskId, patch): SubtaskDelivery;
retryProvisioning(subtaskId): DispatchResult;
```

The snapshot groups top-level dispatch sessions with their subtasks and latest returns. Each subtask projection also includes its durable provisioning stage plus current `running` and `pendingAttentionCount` values from the existing agent runtime projection; those runtime values are allowed to be reconstructed after restart. The sequenced change stream carries durable orchestration changes and merged runtime changes, supports replay after disconnect, and directs clients to replace local state from a fresh snapshot if the cursor is no longer available. Completion is idempotent. Agent/tool credentials may dispatch and read; a subtask agent may update only its own delivery metadata; only a user-authenticated request may complete.

### User Experience

#### Entry and layout

Starting an orchestration session creates a `dispatch` agent session through an experimental session-mode choice. Existing normal sessions remain unchanged.

The orchestration view has two columns:

- Left: all workspace dispatch threads as top-level rows, each followed by its nested subtasks.
- Right: the existing interactive chat surface for the selected dispatch or subtask session.

Selecting a row changes only the right chat and preserves live state for other running sessions. The existing transcript, streaming, permission, question, abort, and follow-up behavior is reused.

On narrow screens the columns become navigator and chat screens rather than forcing two compressed panes. Selecting a row opens chat; a back action returns to the navigator.

#### Navigator rows

A dispatch row shows its title and aggregate counts for running, returned, attention-needed, failed, and completed subtasks. Its subtasks retain stable creation order beneath it.

A subtask row shows title, state, running/attention indicator, and branch. When the latest agent turn has returned, it also shows a truncated summary of that assistant message. Summary text never replaces the state or title and is available without loading the full transcript.

`provisioning` and `failed` rows are selectable even before a chat exists. Their right pane shows the durable provisioning stage or persisted failure. It offers retry only when the failure is marked retryable; missing or externally moved worktrees are not recreated over potentially lost work and instead require a replacement dispatch. Completed rows remain available but are visually de-emphasized.

#### Review and completion

Returned subtasks function as the inbox. Selecting one opens its full chat at the latest response. The user can continue the conversation, leave it returned, or choose **Mark complete**. Continuing the chat returns the task to active execution; the next completed agent turn creates a new return and updates the row summary.

Completion requires confirmation through the detached overlay layer. The confirmation includes delivery mode, branch, and PR URL when available so the user does not confuse orchestration completion with code integration. Completion does not archive the session, delete the clone, merge code, or dismiss unresolved approvals/questions.

### Delivery Metadata

Subtasks expose mutable result metadata separately from lifecycle state:

```ts
interface SubtaskDelivery {
  pullRequestUrl?: string;
  headCommit?: string;
  summary?: string;
}
```

For `pull_request`, the subtask agent is expected to create and report an independent PR. For `dispatcher_integration`, the dispatcher receives clone path, branch, and head commit and may integrate using normal Git tools. Missing delivery metadata does not block a user from completing a task, but the confirmation makes the omission visible.

### Realtime and Restart Behavior

SQLite orchestration records and returns are authoritative across environment-server restarts. Running, approval, and question state may still be reconstructed from OpenCode, but a restart must not erase task hierarchy, returned summaries, completion state, or provisioning failure details.

After restart, the service reconciles nonterminal records against clone paths, persisted sessions, and OpenCode sessions. It resumes a safe provisioning stage when possible; otherwise it marks the task failed with residual artifacts. Idle reconciliation fetches the latest assistant message and uses the same message-ID deduplication as live observation.

App notifications may mirror returns for global awareness, but they are not the inbox source of truth. Opening or dismissing a notification cannot mutate orchestration lifecycle.

### Failure and Edge Cases

- Invalid or unavailable source ref: fail provisioning before creating an agent session; preserve the requested ref in the failure.
- Duplicate operation: return the original subtask regardless of repeated tool delivery or network timeout.
- Clone/branch collision: reject deterministically; never attach to an existing unrelated directory.
- Partial provisioning: compensate what can be safely removed and report every retained artifact.
- Initial prompt failure: retain a selectable failed task and session when created; retry must not create a second task.
- Dispatch session archived: keep its hierarchy readable; prevent new dispatches until it is reopened.
- Subtask session archived: keep the task record; reopening restores interaction. Archive is not completion.
- User message after return: transition to active when execution starts, but retain return history and latest summary until superseded.
- Late terminal turn after completion: preserve the completed state and record the return for history without making it actionable.
- Concurrent completion: idempotently retain the first completion timestamp.
- Deleted or externally moved clone: show a non-retryable failed integrity state, disable sending, and preserve metadata so the user can recover it externally or ask the dispatcher to create a replacement task.
- Workspace mismatch: reject without exposing session, repository, path, or transcript data.

### Dependencies and Boundaries

The feature reuses environment SQLite migrations, paired env tRPC authentication, repository clone management, OpenCode root-session APIs and plugin hooks, sequenced realtime stores, the existing session chat surface, responsive split-pane primitives, and the detached overlay controller.

No remote orchestrator, Docker sandbox, new message store, or app-database copy of orchestration state is introduced. Existing OpenCode child sessions remain available for ordinary task-tool delegation inside any agent chat and are not promoted into orchestration subtasks.
