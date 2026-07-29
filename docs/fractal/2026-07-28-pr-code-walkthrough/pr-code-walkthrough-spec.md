# PR Code Walkthrough

## Seed

Build a streaming workflow that turns a PR diff into a logically ordered Markdown walkthrough, letting a reviewer start reading immediately while guaranteeing every changed line is represented and relegating non-primary dependency and lockfile noise to collapsed sections at the end.

## Solution

- Input: accept one immutable unified PR diff as the walkthrough's sole code context in the initial workflow.
- Generation: use a dedicated agent session to stream a logically ordered Markdown narrative as soon as content is available.
- Document format: represent file and hunk embeds with readable, portable fenced directives carrying stable diff references and optional collapsed state.
- Rendering: resolve directives against the canonical input diff so displayed code is exact rather than agent-reproduced text.
- Ordering: let the agent choose the conceptual review order while placing non-primary dependency and lockfile changes in a collapsed final appendix.
- Coverage: parse the input into deterministic coverage units and track which units are claimed by successfully parsed embed directives.
- Completion: validate coverage after the main stream, feed all missing units back to the same agent, and append annotations until coverage is complete.
- Streaming state: persist sequenced walkthrough events using the existing agent transcript/replay pattern so generation can reconnect and replay without restarting.

## Spec

### Scope

The first version adds a **Code Walkthrough** workspace pane opened from the `Cmd+T` menu. It acquires changes through the same repository discovery and comparison choices as the existing Git Diff pane:

- compare the current branch with an origin branch, with optional uncommitted changes;
- compare staged, unstaged, and untracked working-tree changes.

The workflow receives no source files, PR metadata, repository search, network access, or agent tool access. Its code context is the complete diff snapshot and a manifest deterministically derived from that snapshot. Pulling a hosted PR or fetching extra context is out of scope.

### User Flow

1. The reviewer opens **Code Walkthrough** from `Cmd+T`.
2. The pane discovers the repository and exposes the same comparison controls and defaults as Git Diff.
3. The reviewer selects **Generate walkthrough**. The server captures a new immutable diff snapshot from the selected comparison; a previously rendered or retained client snapshot is never reused implicitly.
4. The pane switches to the walkthrough document and begins rendering Markdown as soon as the first stream event arrives. A status indicator distinguishes thinking, writing, checking coverage, repairing coverage, complete, cancelled, and failed states.
5. Completed directives become interactive canonical diff embeds as they arrive. The reviewer can expand or collapse each embed without affecting generation.
6. On completion, the pane shows full coverage. A reviewer may return to the comparison controls and generate a new walkthrough; this creates a separate walkthrough rather than mutating the prior snapshot.

Closing or reopening the pane does not cancel generation. The pane reconnects from its last event cursor and can reconstruct the same document. The reviewer may explicitly cancel a running walkthrough.

### Shared Diff Acquisition

The Git Diff and Code Walkthrough panes use one comparison value and selector contract rather than independently reproducing branch-selection behavior. The comparison remains:

```ts
type GitDiffComparison =
  | { kind: 'branch'; originBranch: string | null; includeUncommitted: boolean }
  | { kind: 'working-tree'; branch: {
      kind: 'branch'
      originBranch: string | null
      includeUncommitted: boolean
    } }
```

Starting a walkthrough resolves the default origin branch, invokes the existing environment-local Git service, and freezes the returned repository identity, comparison, refs/OIDs, file metadata, warnings, and patch. The server computes a SHA-256 digest over the exact UTF-8 patch bytes and stores it with the walkthrough.

Empty diffs cannot start a walkthrough. Truncated diffs are rejected because aggregate file metadata cannot recover omitted patch content. Inputs that exceed the configured model context or storage limit fail explicitly before an agent session starts; the service never silently truncates or samples them.

### Canonical Diff Model

A server-side parser converts the frozen patch into a lossless canonical model. The parser preserves input order and raw text while assigning snapshot-local identities to:

- every file section, including old and new paths, status, mode and rename/copy metadata;
- every hunk and its header;
- every context, addition, deletion, and `No newline at end of file` row;
- binary, submodule, mode-only, empty-file, and metadata-only changes.

Each coverable unit is one indivisible diff row or one file-level metadata record that has no row representation. Unit IDs derive from the diff digest, file ordinal, section ordinal, and row ordinal; paths are validation data, not identity. Duplicate paths and renames therefore remain unambiguous.

The canonical model is the only source rendered inside an embed. Agent output selects units but never supplies displayed code. A directive with a stale digest, mismatched paths, nonexistent range, or malformed body renders an inline error and claims no coverage.

### Agent Input And Ordering

The dedicated agent receives:

- instructions describing the walkthrough format, review-oriented writing style, ordering rules, and directive grammar;
- the complete raw unified diff;
- a compact manifest listing the canonical file, section, row, and unit references derived only from that diff.

The agent first reasons about a useful review order, then streams a concise explanation interleaved with directives. It should lead with entry points and behavior, follow data/control flow through supporting changes, and keep related hunks together even when they occur in different files. It must not narrate file order mechanically when a clearer conceptual order exists.

Known lockfiles and dependency-manifest hunks containing only dependency/version updates are marked as noise candidates in the manifest. They must appear collapsed in a final dependency/generated appendix unless the agent promotes them as primary to the change. Promotion must include a short explanation and is appropriate when dependency work is itself the apparent purpose of the diff or is essential to understanding behavior. Generated files follow the same default when confidently detected; ordinary source changes are never hidden by filename heuristics alone.

### Markdown Directive Contract

Walkthroughs are ordinary GitHub-flavored Markdown plus versioned `kaivo-diff` fenced blocks. The fence body is JSON so any Markdown consumer still exposes a readable, lossless reference without requiring Kaivo-specific HTML.

```kaivo-diff
{
  "version": 1,
  "diff": "sha256:<digest>",
  "id": "request-validation",
  "file": { "index": 2, "oldPath": "src/request.ts", "newPath": "src/request.ts" },
  "sections": [
    { "kind": "hunk", "index": 1, "rows": [1, 18] }
  ],
  "collapsed": false
}
```

Directive fields:

- `version` is required and initially `1`.
- `diff` must equal the walkthrough snapshot digest.
- `id` is unique within the document and provides stable UI state.
- `file.index` is the canonical zero-based file ordinal; `oldPath` and `newPath` must match canonical nullable paths.
- `sections` selects one or more metadata sections or inclusive row spans within hunks. Omitting `sections` selects the entire file. Spans cannot cross hunks.
- `collapsed` sets only the initial presentation state. Reviewer interaction wins afterward.
- `primaryReason` is required only when a noise candidate is promoted out of the final collapsed appendix.

A directive claims the union of canonical units it selects. Repeated selections are allowed but do not compensate for omitted units. One directive may embed a whole file or selected parts of one file; it cannot select across files.

Only a syntactically complete closing fence makes a directive valid. During streaming, Markdown before an unfinished directive remains readable while the pending fence is represented by a small loading placeholder. The renderer does not expose partial JSON as a large code block. Unknown directive versions remain visible as plain fenced source with an unsupported-version message.

### Coverage And Repair

Coverage is a set comparison between all canonical unit IDs and units selected by valid directives. It is recomputed server-side whenever a complete directive is appended and exposed as covered, total, and missing counts. Narrative text never claims coverage.

After the agent's initial response ends:

1. If no units are missing and appendix ordering rules hold, the walkthrough completes.
2. Otherwise status changes to `repairing`. The same agent receives the missing unit references, their exact diff excerpts, and any ordering violations, all derived from the frozen snapshot.
3. The agent appends a final coverage section; existing Markdown is immutable during repair.
4. Validation repeats for a bounded number of repair attempts.
5. If agent repair still misses units, the service appends deterministic, collapsed directives for every remaining unit under **Automatically included for complete coverage** and records a warning.

The terminal `completed` state therefore always means exact 100% canonical coverage. A terminal failure or cancellation may expose a readable partial document but must never label it complete. Repair output remains part of the same live stream, so a reviewer can continue reading while validation finishes.

### Workflow Service

The environment server owns a dedicated walkthrough service rather than treating a chat transcript as the durable workflow record. A walkthrough stores its repository and comparison identity, frozen diff and digest, canonical manifest, linked internal agent session, assembled Markdown, coverage summary, status, timestamps, warnings, and terminal error when present.

The walkthrough service, not the model runtime, owns the deterministic loop: generate once, validate coverage and ordering, request bounded repairs when needed, then apply canonical fallback. It invokes inference through a model-neutral boundary:

```ts
interface WalkthroughModelRunner {
  run(input: {
    model: ModelSelection
    messages: WalkthroughMessage[]
    signal: AbortSignal
  }): AsyncIterable<ModelStreamEvent>
}
```

The initial runner uses a private OpenCode session because OpenCode already owns configured provider credentials, OAuth refresh, model discovery, variants, custom base URLs, streaming, continuation, and cancellation. The runner pins the selected provider, model, and variant for the walkthrough; explicitly disables every tool; sends generation and repair turns; and translates OpenCode callbacks into the small runner event contract. OpenCode chat transcripts and session status are not used as walkthrough persistence.

The boundary permits a future direct model implementation without changing workflow or storage semantics. A direct Vercel AI SDK runner should use explicit `streamText` calls rather than `ToolLoopAgent`, because repair decisions belong to the walkthrough service. It is viable only after Kaivo exposes a provider-neutral credential broker that supports all configured credentials, including OAuth, without reading OpenCode's private auth store or duplicating provider configuration.

Statuses are:

```ts
type WalkthroughStatus =
  | 'queued'
  | 'thinking'
  | 'streaming'
  | 'checking'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'cancelled'
```

The environment-local API provides operations equivalent to:

```ts
start(input: { cwd: string; comparison: GitDiffComparison }): { walkthroughId: string }
snapshot(input: { walkthroughId: string }): WalkthroughSnapshot
events(input: { walkthroughId: string; afterSeq: number }): AsyncIterable<WalkthroughEvent>
cancel(input: { walkthroughId: string }): void
```

`start` is idempotent for one client request key, but two deliberate starts create distinct immutable walkthroughs. Authorization follows the existing environment token boundary and repository paths are constrained by existing Git service rules.

### Event Stream And Recovery

Every state transition and Markdown delta is persisted in a complete, monotonically sequenced event log before publication. Event variants include `started`, `status.changed`, `markdown.appended`, `coverage.changed`, `warning`, `completed`, `failed`, and `cancelled`.

The snapshot returns assembled state and the sequence that produced it. Subscription starts strictly after that sequence, preventing the hydration race possible when state and latest sequence are read separately. Replayed and live events share the same IDs and are deduplicated client-side. If a cursor predates retained events, the server instructs the client to reload a fresh snapshot.

Agent token callbacks may be coalesced into modest Markdown chunks before persistence, but ordering is preserved and buffered text is flushed before status or terminal events. Cancellation stops agent work, flushes already accepted text, persists `cancelled`, and rejects later callbacks. Restart recovery marks interrupted nonterminal work failed with a clear reason unless the underlying agent can be proven active and safely reattached.

### Walkthrough Pane

The pane has two modes:

- **Configure:** shared repository/comparison toolbar, current change counts, warnings, and Generate action.
- **Read:** streaming Markdown, canonical diff embeds, progress/status, coverage count, Cancel while active, and New walkthrough after a terminal state.

The document uses the existing Markdown visual language and diff syntax highlighting. Embeds reuse diff presentation primitives but support exact canonical section/range rendering. Expansion state is keyed by directive ID and kept independently from the generated document. The pane is responsive: narrow layouts stack controls and content without requiring the changed-file navigator used by the raw Git Diff view.

Malformed directives, generation warnings, and terminal errors appear inline without replacing already readable content. Blocking dialogs are not required; any future confirmation overlay must use the detached overlay layer.

### Failure And Edge Cases

- Repository, branch, merge-base, timeout, and Git command failures are shown before generation and remain retryable from Configure mode.
- A repository change after Start does not alter the frozen walkthrough. A new generation captures a new snapshot.
- Agent refusal, model failure, malformed output, or disconnect enters repair or failure according to whether generation can continue; exact canonical fallback may complete coverage only when a coherent document already exists.
- Binary and metadata-only changes are represented by canonical summary embeds and count toward coverage even without textual hunk rows.
- Very large individual hunks may render lazily, but cannot be omitted from coverage.
- Raw diff text and model output are treated as untrusted content. Directive JSON is schema-validated, Markdown HTML is not enabled, paths are displayed as text, and no directive can read a filesystem path.
- Walkthrough event chunks, directives, and canonical rows are bounded to prevent a malformed agent response from exhausting memory or storage.

### Dependencies And Compatibility

The feature reuses the existing Git service, environment tRPC transport, Markdown stack, Shiki-based diff styling, workspace pane persistence, and agent runtime. Unified/MDAST packages used to recognize custom fences must be direct dependencies rather than undeclared transitive imports. The canonical parser may use an existing diff library only if lossless metadata and row identity are verified; otherwise it remains a focused internal parser.

This introduces a new persisted pane type and walkthrough schema. Existing Git Diff panes and agent chats retain their behavior and storage. Directive versioning allows future document migrations without interpreting old annotations under new semantics.

### Acceptance Criteria

- A reviewer can open Code Walkthrough from `Cmd+T`, choose every comparison available in Git Diff, and start from a fresh immutable snapshot.
- Useful Markdown appears before generation finishes and remains readable through reconnect/replay.
- Every valid embed displays exact content from the frozen diff, never agent-authored code.
- Completion is impossible while any canonical diff unit is uncovered.
- Missing or malformed agent annotations are repaired at the end of the stream, with deterministic fallback guaranteeing complete coverage.
- Non-primary lockfile and dependency-only updates appear collapsed after substantive changes; primary dependency changes can be promoted with explanation.
- Truncated or silently sampled diffs cannot enter generation.
- Cancelled and failed walkthroughs preserve partial readable output without claiming completion.
