# PR Code Walkthrough Execution Plan

## Task 1: Generate A Basic Complete Walkthrough

Deliver the smallest useful end-to-end workflow: a reviewer opens Code Walkthrough, chooses an existing Git comparison, and receives a persisted deterministic Markdown document embedding every changed file. This proves snapshot, pane, storage, API, and coverage boundaries before model generation is introduced.

**Steps**
- Extract the Git comparison value, defaults, branch resolution, and reusable controls from `src/routes/env/tabs/git-diff-tab.tsx` and `git-diff-tab-state.ts` without changing existing Git Diff behavior.
- Add the `code-walkthrough` workspace pane contract and persistence across `shared/workspace-pane.ts`, workspace tab collections/conversions, app-server workspace storage, `src/routes/workspace.tsx`, and `src/components/tab-icon.tsx`.
- Add **Open Code Walkthrough** beside Git Diff in `src/routes/env/universal-menu/universal-menu.tsx`; build `src/routes/env/tabs/code-walkthrough-tab.tsx` with Configure and Read modes using the shared comparison controls.
- Add environment-server walkthrough tables and repositories for immutable snapshot metadata, patch bytes/digest, assembled Markdown, coverage, status, request key, and monotonically sequenced events.
- Add a lossless canonical parser under `packages/env-server/src/walkthrough/` with stable file, section, row, and coverage-unit identities; initially reject unsupported, empty, truncated, and oversized inputs rather than degrading them.
- Add an authenticated walkthrough router with `start`, atomic `snapshot`, `events`, and `cancel`; make the initial service emit deterministic whole-file directives in file order and complete only after every canonical unit is selected.
- Persist the returned walkthrough ID on the tab and render the deterministic document, status, warnings, and exact coverage count.

**Tests**
- E2E: Open Code Walkthrough from `Cmd+T`, select branch and working-tree comparisons, generate, and verify the pane displays every changed file with 100% coverage.
- Unit: Round-trip the new pane through shared, client, and app-server tab schemas and local migrations.
- Unit: Parse ordinary multi-file and multi-hunk fixtures losslessly; assert stable IDs, exact raw rows, digest validation, and complete deterministic directives.
- Integration: Mutate a temporary repository after `start` and verify the stored patch, refs, and rendered document remain unchanged.
- Unit: Verify empty, truncated, oversized, and unsupported snapshots fail before creating a running workflow.

**Maintainability**
- Keep comparison acquisition shared and presentation-neutral so Git Diff and Code Walkthrough cannot drift.
- Separate canonical parsing, persistence, service orchestration, and tRPC transport rather than creating one walkthrough service file with all responsibilities.
- Treat the environment server's canonical model as authoritative; do not reuse the presentation-only client diff parser.
- Centralize pane serialization in existing conversion boundaries instead of adding walkthrough-specific persistence paths.

**Depends on:** none

**Status:** done

## Task 2: Stream An Agent-Ordered Narrative

Replace deterministic file-order generation with a useful conceptual walkthrough that starts rendering before inference finishes. Kaivo owns the workflow while a model-neutral runner uses OpenCode only for pinned, tool-free model turns.

**Steps**
- Define `WalkthroughModelRunner` and model-neutral message/stream event contracts under `packages/env-server/src/walkthrough/`.
- Implement an OpenCode runner using the existing supervisor and SDK patterns; create private sessions, pin provider/model/variant, explicitly disable every tool, stream text, continue the same session, and abort through `AbortSignal`.
- Build the generation prompt from the complete raw diff and compact canonical manifest only; prohibit tool requests and instruct conceptual review ordering plus portable directive output.
- Extend the walkthrough service to drive `thinking`, `streaming`, and `checking` transitions, coalesce model deltas into bounded persisted chunks, and fence callbacks after terminal state.
- Implement snapshot-first pane hydration and `afterSeq` event subscription with one atomic snapshot cursor, replay/live deduplication, and incremental Markdown rendering.
- Persist the resolved provider, model, variant, and internal runner session identity with the walkthrough while keeping OpenCode transcripts outside the durable document model.

**Tests**
- E2E: Start a walkthrough against a scripted model stream and verify useful narrative appears before the terminal event and remains in model-selected conceptual order.
- Unit: Drive the service with a fake runner split across arbitrary token boundaries and verify persisted Markdown/event ordering and status transitions.
- Integration: Insert an event between snapshot creation and subscription and verify it is received exactly once after the snapshot cursor.
- Integration: Extend the real-OpenCode harness to verify the request pins model settings, disables every tool, streams output, and supports a second turn.
- Unit: Verify model refusal, error, oversized output, and late callbacks cannot produce an invalid completed state.

**Maintainability**
- Keep OpenCode types behind `WalkthroughModelRunner` so workflow, tests, and future direct SDK support remain provider-neutral.
- Keep prompts in a focused module with contract-level tests rather than embedding long strings in orchestration code.
- Persist events before publication and project snapshots transactionally to avoid separate sources of truth.
- Reuse replay concepts but not the sparse chat transcript implementation or its split snapshot/latest-sequence hydration.

**Depends on:** Task 1

**Status:** done

## Task 3: Render Portable Interactive Diff Embeds

Turn completed `kaivo-diff` fences into exact, interactive file and range embeds while ordinary Markdown continues streaming. Plain Markdown remains understandable, and incomplete or malformed directives never claim coverage.

**Steps**
- Add direct Unified/MDAST dependencies and a versioned directive schema/parser that recognizes only closed `kaivo-diff` fences and validates digest, unique ID, file ordinal/paths, metadata sections, hunk ranges, collapse state, and promotion reason.
- Add a streaming Markdown partitioner that keeps prior narrative visible, replaces an unfinished directive with a compact placeholder, and preserves unknown versions as readable fenced source with an error.
- Extract reusable syntax-highlighted row and metadata presentation from `src/routes/env/agent/parts/diff-view.tsx` without changing chat or Git Diff rendering.
- Add walkthrough document and diff-embed components that render only canonical snapshot content, support whole-file and exact section/range selections, lazily highlight large hunks, and remain usable at narrow pane widths.
- Store reviewer expansion state by directive ID independently of generated `collapsed` defaults and document replay.
- Feed successfully parsed directive selections back into the server coverage projection; malformed or stale references claim no units and display inline errors.

**Tests**
- E2E: Stream narrative and split directives, then verify each embed appears only after its closing fence and displays exact frozen diff rows.
- Unit: Test every character prefix of valid and malformed fences; narrative stays visible, partial JSON never renders, and closing the fence atomically creates coverage.
- Unit: Validate stale digests, mismatched paths, duplicate IDs, cross-hunk spans, unknown versions, and promoted noise without `primaryReason`.
- Unit: Render whole-file, ranged, metadata-only, and large lazy embeds; verify generated defaults and reviewer expansion choices do not overwrite each other.
- E2E: Verify the walkthrough and embeds remain readable and horizontally contained in a narrow viewport.

**Maintainability**
- Maintain one versioned directive contract shared by server validation and client decoding rather than parallel handwritten shapes.
- Reuse low-level diff presentation primitives, not the canonical parser or walkthrough state, across existing views.
- Keep streaming partitioning separate from React rendering so boundary behavior is table-testable.
- Key interaction state by stable directive identity and never mutate model-authored Markdown to record UI choices.

**Depends on:** Task 2

**Status:** done

## Task 4: Guarantee Coverage And Deprioritize Noise

Make completion trustworthy: the service detects omissions and ordering violations, asks the same model session to append repairs, and inserts exact fallback embeds if bounded repair fails. Dependency and generated noise moves to a collapsed final appendix unless it is genuinely primary.

**Steps**
- Implement set-based coverage over canonical units, counting each selected unit once and reporting covered, total, and missing values after each complete directive.
- Add conservative noise-candidate classification for known lockfiles, dependency-only manifest hunks, and confidently detected generated files; never classify ordinary source changes from filename alone.
- Validate that unpromoted candidates are collapsed and follow substantive changes, while promoted candidates include `primaryReason` and may appear in the conceptual flow.
- Extend the walkthrough service with `checking` and bounded `repairing` turns; pass only missing references, their exact frozen excerpts, and ordering violations to the same runner session.
- Enforce append-only repair output, revalidate each attempt, then append deterministic collapsed directives under **Automatically included for complete coverage** for any remaining units.
- Surface live coverage, repair state, promotions, and fallback warnings in the pane; reserve `completed` exclusively for exact 100% coverage.

**Tests**
- E2E: Script an initial response that omits source and lockfile ranges; verify repair appends missing source and leaves non-primary lockfile changes collapsed at the end.
- Unit: Verify duplicate selections do not hide omissions and metadata, no-newline markers, and unrendered rows all count independently.
- Unit: Drive complete, incomplete, malformed, refusal, and successive repair responses through a fake runner; assert bounded turns, immutable prior Markdown, and completion iff coverage is 100%.
- Unit: Verify deterministic fallback covers every remaining unit exactly from canonical data and records a visible warning.
- Unit: Test dependency-primary promotion and conservative noise classification across package manifests, lockfiles, generated files, and similarly named source files.

**Maintainability**
- Keep coverage as deterministic set logic with no model-dependent interpretation.
- Keep noise classification conservative, data-driven, and independently testable from ordering enforcement.
- Use one service state machine for initial generation, repair, fallback, and terminal transitions rather than recursive prompt callbacks.
- Bound repair attempts and prompt excerpts explicitly to prevent infinite loops and context growth.

**Depends on:** Task 3

## Task 5: Survive Reconnects, Cancellation, And Restarts

Make long-running walkthroughs dependable when panes close, clients reload, streams reconnect, users cancel, or the environment server restarts. Partial work remains readable without being mislabeled complete.

**Steps**
- Complete the durable event protocol with `started`, status, Markdown append, coverage, warning, completion, failure, and cancellation events; flush buffered Markdown before status and terminal events.
- Add cursor-retention detection and snapshot-reload responses; guarantee subscription replay and live buffering cannot miss or reorder events around hydration.
- Make closing/unmounting a pane detach only the client; reopening by persisted walkthrough ID reloads the snapshot and resumes strictly after its sequence.
- Implement idempotent explicit cancellation that aborts the runner, flushes accepted text, persists `cancelled`, clears queued repair work, and rejects all later callbacks.
- On environment-server startup, reconcile interrupted nonterminal walkthroughs: reattach only when runner identity is provably live and safe, otherwise persist a clear failed terminal state.
- Add New Walkthrough behavior that returns to shared comparison controls and creates a distinct immutable record without mutating prior output.

**Tests**
- E2E: Start generation, close and reopen the pane, reload the application, and verify the same document resumes without restarting or duplicating content.
- E2E: Cancel during a buffered stream and verify accepted text remains readable, status is terminal, and later model output is ignored.
- Integration: Exercise replay/live duplicates, inserts at the snapshot boundary, stale cursors, out-of-order callbacks, and retention loss with deterministic barriers.
- Integration: Restart with nonterminal rows and verify safe reattachment or durable failure according to runner liveness.
- Unit: Repeat `start` with one request key and `cancel` multiple times; verify idempotency while deliberate new starts create distinct walkthroughs.

**Maintainability**
- Express lifecycle transitions in one validated state machine and reject illegal terminal-to-active changes.
- Keep client projections idempotent so replay and reconnect behavior does not rely on timing.
- Separate event retention policy from workflow records so compaction cannot destroy the current snapshot.
- Use abort signals and terminal guards consistently instead of scattered boolean cancellation flags.

**Depends on:** Task 4

## Task 6: Cover Real-World Diff And Operational Edge Cases

Broaden canonical support and harden limits so valid Git comparisons either produce exact walkthroughs or fail explicitly. Finish with full regression coverage across desktop-sized and adversarial changes.

**Steps**
- Extend canonical fixtures and rendering for rename/copy, quoted and duplicate paths, CRLF, missing-final-newline markers, binary files, submodules, mode-only changes, empty files, deletions, untracked files, and metadata-only changes.
- Verify Git acquisition retains complete metadata-to-patch association and rejects any output-limit truncation before generation; correct shared Git service behavior where positional matching can become unsafe.
- Add configurable patch, context, event-chunk, directive, output, storage, and repair limits with specific user-facing failures and no silent sampling.
- Sanitize all untrusted Markdown and directive fields, keep HTML disabled, display paths as text, and prove directives cannot access source files or filesystem paths.
- Add responsive and performance coverage for many files and very large hunks, including lazy highlighting without excluding canonical units.
- Run and stabilize the focused unit/integration suite, workspace typecheck/build, Playwright walkthrough flow, existing Git Diff regressions, and real-OpenCode harness.

**Tests**
- E2E: Generate a walkthrough from a fixture repository containing binary, rename, deletion, untracked, and metadata-only changes; verify exact 100% coverage and responsive interaction.
- Unit: Round-trip the adversarial fixture corpus and assert raw preservation, stable ordinals, unique units, exact selections, and correct canonical summaries.
- Integration: Force Git output and model-context limits and verify generation is rejected before any partial walkthrough is labeled active or complete.
- Unit: Inject hostile Markdown, HTML, paths, oversized directives, and malformed event chunks; verify safe bounded rendering and storage.
- E2E: Run existing Git Diff and chat diff tests to prove shared control and presentation extraction introduced no regressions.

**Maintainability**
- Add edge cases to a reusable fixture corpus rather than embedding large patches across test files.
- Fail closed on unsupported Git syntax; do not add heuristic compatibility that weakens exact coverage.
- Keep configurable limits centralized and expose typed failure codes instead of matching error strings in the UI.
- Preserve lazy rendering as a presentation optimization only; canonical storage and coverage remain complete.

**Depends on:** Task 5
