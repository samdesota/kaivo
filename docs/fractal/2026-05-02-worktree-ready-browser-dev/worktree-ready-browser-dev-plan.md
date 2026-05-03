# Worktree-Ready Browser Dev Plan

## Task 1: Shared Runtime Resolution

Extend the local runtime resolution so app/identity, cc-env, and client dev server all share one instance model and one free-port allocation contract.

**Steps**
- Extend the existing desktop runtime config types to include the client dev server port, URL, log path, and health/startup metadata.
- Add a reusable port allocator that starts from deterministic preferred ranges, honors explicit overrides, and returns a complete non-conflicting service port set.
- Preserve existing per-worktree instance id, root, DB, state, workspace, and log path behavior.

**Tests**
- Unit: `instance-runtime.test.ts` covers client port resolution, override precedence, unique full port sets, and no dependency on fixed `3000`, `47821`, or `5180`.
- Integration: none.
- Manual: run two dry runtime resolutions from different worktree paths and inspect distinct roots and ports.

**Depends on:** none

**Status:** done

## Task 2: Local Launcher And Manifest

Add the launch script that owns browser-ready local startup and writes the gitignored runtime manifest for agents and humans.

**Steps**
- Add a Node/TypeScript launcher that allocates ports, prepares instance directories, starts app/identity, cc-env, and client dev server as one service set.
- Write `<CC_INSTANCE_ROOT>/launch.json` atomically with instance, server, storage, command, status, PID, health URL, and log path fields.
- Implement retry-on-collision: if startup reports bind failure, failed health, or mismatched instance id, stop the full service set, allocate a fresh set, update the manifest, and retry.

**Tests**
- Unit: launcher manifest serialization redacts secrets and includes every service URL, port, health URL, and log path.
- Integration: launcher test with fake child services retries after an occupied port or mismatched `/healthz`, then writes a healthy manifest.
- Manual: run the launcher once and inspect `.cloud-code/instances/<id>/launch.json` plus app/env/client logs.

**Depends on:** Task 1

**Status:** done

## Task 3: Dev Script And Vite Wiring

Route browser development through the launcher and make Vite consume allocated ports and proxy targets.

**Steps**
- Update `npm run dev:web` to use the launcher instead of fixed server/client commands.
- Make Vite read the launcher-provided client host/port and app proxy URL.
- Keep `npm run dev`, `npm run dev:desktop`, and external desktop debugging compatible with the new runtime values.

**Tests**
- Unit: Vite config test covers dynamic client port and dynamic app proxy target.
- Integration: `npm run dev:web` smoke test starts app, env, and client with manifest-reported URLs.
- Manual: open the manifest client URL in a normal browser and confirm the app reaches the local app API.

**Depends on:** Task 2

**Status:** done

## Task 4: Instance-Safe Pairing And Health

Harden service health and pairing so stale services from another worktree cannot be reused accidentally.

**Steps**
- Ensure app and cc-env `/healthz` responses expose the instance id needed by launcher and supervisor checks.
- Require same-instance verification before env-token reuse, desktop pairing, and local env registration.
- Keep provider credentials out of pairing payloads, env DB, logs, and manifest files.

**Tests**
- Unit: `desktop-pairing.test.ts` rejects token reuse and registration for a mismatched instance id.
- Integration: `service-supervisor.test.ts` and env HTTP tests reject cross-worktree `/healthz` and `/pair/desktop` mismatches.
- Manual: start one worktree, then launch another and verify it does not attach to the first worktree's cc-env.

**Depends on:** Task 2

**Status:** done

## Task 5: Seed Integration

Wire local launch seeding to the resolved app DB and encrypted app secrets for the current instance.

**Steps**
- Invoke or reuse the dev seed path from the launcher after the app DB path and secrets path are known.
- Ensure seeded admin state, `provider.openai.api_key`, `provider.openai.base_url`, and `agent.default_model` are idempotent and instance-local.
- Preserve production safety checks and environment-driven seed inputs.

**Tests**
- Unit: `seed-dev` tests cover target DB resolution from launcher env, idempotent upsert, and production force behavior.
- Integration: launcher startup seeds the selected app DB and agent provider resolution returns expected env keys without cc-env persistence.
- Manual: change `CC_SEED_OPENAI_BASE_URL`, relaunch, and verify the app settings/agent provider resolution uses the updated local value.

**Depends on:** Task 2

**Status:** done

## Task 6: Browser-Only Pane Fallbacks

Make browser-mode workspace panes usable when native `webframe` browser panes are unavailable.

**Steps**
- Update browser tab rendering so unavailable native panes show the URL and an external-open action instead of a dead pane.
- Wire workspace preview/open-pane events so preview requests render via browser-compatible preview behavior or an explicit fallback.
- Hide or disable desktop-only pane controls in normal browser mode with clear copy.

**Tests**
- Unit: React tests cover browser tab fallback UI, external-open action, and native-control disabled state when `window.webframe` is absent.
- Integration: workspace open-pane flow renders browser and preview requests instead of silently dropping preview events.
- Manual: run browser mode, trigger an agent/browser open and a preview open, and confirm both produce usable tabs or links.

**Depends on:** Task 3

**Status:** done

## Task 7: Operator Docs And End-To-End Smoke

Document the manifest-first local workflow and verify simultaneous worktree readiness end to end.

**Steps**
- Update `CLAUDE.md` to tell agents to read `.cloud-code/instances/<id>/launch.json` before assuming ports, URLs, DB paths, or log locations.
- Document that `.cloud-code/` is gitignored and contains per-worktree runtime state, logs, DBs, and the launch manifest.
- Add a smoke procedure for running two worktrees at once and opening the manifest client URL/browser pane for each.

**Tests**
- Unit: none.
- Integration: `npm run typecheck`, `npm test`, and targeted desktop/browser tests for runtime, launcher, pairing, seed, and pane fallback changes.
- Manual: start two worktrees concurrently, verify distinct manifests, distinct app/env/client ports, seeded LLM credentials, and usable browser-pane or browser-mode fallback behavior.

**Depends on:** Tasks 3, 4, 5, 6

**Status:** done
