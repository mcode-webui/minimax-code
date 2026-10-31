# WebUI comprehensive test strategy implementation plan

**Status:** Closed at the user's direction — acceptance incomplete, 2026-10-23. This is an administrative closure only; it does not mean the approved strategy passed its acceptance criteria. **Completed evidence recorded:** Phase 0 baseline/inventory; six named production-path journey families; a full WebUI Vitest run (213 files, 3,301 passed, 0 skipped); a Linux built-Chromium run (183/183 passed across 34 specs, 0 skipped); root and WebUI TypeScript checks; WebUI dependency/boundary and standalone checks; installed WebUI package verification; and a local-runtime capability suite (236 files, 5,811 passed, 18 environment/platform skips). Later continuation entries document additional targeted production-path journeys and fixes. **Acceptance remains incomplete:** the source-grounded matrix of every user-reachable control and material state combination has not been fully reconciled; the complete per-case disposition/conditional-skip ledger and critical mutation ledger are not reconciled; and no successful final Linux `pnpm verify` is recorded. The Linux `pnpm verify` attempt passed `check:source` and `check:tsconfig`, then stopped at `export source preview` because the working tree contains uncommitted tracked changes, so later gates did not run. This plan is closed by user instruction and is not a completion certificate. Do not commit or reset user changes to bypass the verification precondition. Phase 0 and case-level evidence remain outside the repository at `/home/fectivnfy/.codex/visualizations/2026/10/22/01a16408-54f2-7220-8e9c-f335d5a8b0b9/phase0-audit.md` and `integration-case-disposition.md`.

**Latest verification attempt (2026-10-23):** `pnpm build:webui` completed successfully. The subsequent focused `agent-transcript.test.ts` execution was started, then interrupted at the user's direction before completion (exit 130); it has no pass/fail result and is not counted as evidence. No gate or test was run after that interruption.

**Continuation update (2026-10-23, corrected after source re-read):** The `webui-development` skill now requires source-grounded business-flow matrices, real control interaction, full client/service/runtime/persistence paths for integration claims, built-Chromium DOM/geometry/screenshot usability checks, and targeted break-link controls. Skill validation passed. The earlier diagnosis that the `@`/attachment turn was missing from persisted history was invalid: that history assertion ran before the new attachment action. The mounted composer scenario now selects a synthetic `@reference-target.md` through the actual mention picker, adds a synthetic text attachment through the real file input, and observes the path and exact staged bytes in the production runtime request; after correcting the assertion ordering, the complete real-host integration passed. Separately, the queued follow-up had a reproducible stream ownership race: its `session.start` recheck could resolve before the previous terminal released its lease, leaving no subscription for the active queued turn. A terminal follow-up active-turn recheck was added with a no-lease recheck path fenced against a newer lease. Controlled removal of that follow-up made the production integration fail on the missing queued answer and stale queue row; restored code, rebuilt client and reran the same case passed. Logs: `queue-recheck-mutation-test.log`, `queue-recheck-restored-test.log` in the external task record. The broader matrix, test disposition, remaining mutations and final verification are still incomplete.
**Continuation status (2026-10-23):** Current Playwright collection is 174 tests in 34 specs, and all 174 now have case-level path/assertion/boundary/disposition entries in the external ledger. The 13 real-browser bridge cases passed on Chromium and Edge; three modified acceptance receipts were restored with matching SHA-256 hashes. The 22 architecture, picker, native-runtime, review, terminal and transcript-scroll cases plus the final 4 zone-recovery cases passed on Linux Chromium. A case-level Vitest audit has now covered 1,735 executed composer/submission, session/import/export/turn/transcript/retry/catalogue, plan-mode, browser-input, browser-service, browser-state, browser-tool-adapter, session-search/purge, account workflow, connection-health, model/provider, model-picker projection, composer-state, plugin, settings/personalization, transcript/error-rendering, context-usage, activity-indicator, goal-owner, operation/loopback, fork/adoption, interaction-owner, workspace-panel/browser, terminal, workspace-file-view, runtime-contract, overlay/interaction, provider-editor/form-panel, command/queue, goal-outcome, markdown-rendering and review/freshness cases in focused runs across 117 files. One session-release test was strengthened to deterministically wait for the real service subscription in its recording provider and reject a late frame after release. Session-import tests assert format refusal, request body/target construction, hostile identity isolation and server error mapping with synthetic files and an injected fetch stub; they do not prove the real upload route. Delivery-disposer tests exercise production application and turn-command ownership/release with injected event/turn/transport ports; the transport is a test double and does not prove host cancellation or a real socket lifecycle. HTTP transfer route tests run a real local `WebuiService` and TCP fetch request, asserting payload bytes, import/export compatibility, canonical snapshot lineage, authentication, exact route matching, status/error mapping and failed-import cleanup. Their `WebuiHarnessPort` is stubbed, so runtime persistence/replay still needs the separate real-host integration path. Download-button and URL/name tests assert production client helpers and route wiring, but do not automate a browser download gesture. Profile file tests perform actual read/write/delete operations in per-test temporary directories and assert profile marker parsing, size limits, traversal refusal, idempotent clearing and preservation after failed writes; these exercise production storage helpers but not the settings panel's browser UI or live runtime prompt assembly. The 11 operation-codec, real-host adapter and loopback-integration cases used a real local service/socket and isolated production host data directory; the loopback leaf harness is scripted and no online model/account service is called. The 21 runtime environment/event-catalogue/operation-typing tests use synthetic temporary auth data and compile-time/runtime contracts; they do not read real credentials or prove an external runtime event source. The 125 dropdown/outside-close/overlay geometry/rail-menu tests use production policy/placement/menu declarations, truth tables, source assertions and synthetic bounds; browser event dispatch/visual geometry is separately established only by built-client browser tests. The 29 provider editor/panel tests and 42 command/turn/queue/goal-outcome tests use production owners/components with injected fake ports and synthetic state; they do not alone prove real Agent delivery, browser event dispatch or host persistence. The 25 markdown/link/code-fence tests use production render projections with synthetic Markdown strings and SSR; syntax DOM output is asserted, while actual visual typography remains browser screenshot evidence. The 85 request-freshness/review tests use production owner/projection/component modules with deterministic synthetic reads and SSR; request epochs and visible diff/view state are asserted, but real Git/runtime review data is not fetched. Their path and boundary notes are in the external task record. This does not complete the full user-operation/state matrix or the item-by-item audit of all registered Vitest declarations; the full mutation ledger and a successful final `pnpm verify` are also still outstanding. Do not retire this plan until those acceptance conditions and the final verification run after the Linux baseline are complete. See the external task record for exact evidence and limits.
**Continuation update (2026-10-23):** The current source-to-ledger filename cross-check found 212 Vitest paths registered in `test/vitest-suites.json`; 125 filenames appear in the case disposition ledger and 87 did not appear in that ledger's text search, so the remaining files still require actual audit rather than assuming absence means invalid. Focused runs added 166 passing cases across nine files: session import/disposers (24), session-transfer HTTP/download (53), profile storage (39), stream reducer/transport/transcript wiring (50); cumulative audited execution count is now 1,785 across 120 files. A stream-answer break-link mutation set the production reducer's mapped answer to empty; `webui-stream.test.ts` failed 7/19 with explicit answer mismatch. The source was restored, and that file passed 19/19. Red/green logs and case-level boundaries are in the external task record. The full surface map, remaining test audits, other critical mutations, and final verify are still outstanding.
**Continuation update (2026-10-23):** Eight additional registered shell/settings/slash/thinking/context/rail test files passed focused Vitest execution: `rail-pin-affordance`, `settings-modal`, `settings-workflows`, `shell-surface`, `slash-classification`, `slash-palette`, `thinking-control`, and `token-plan-model` (134/134). The running case-audit tally is 1,919 passed cases across 128 focused files; these tests primarily prove production policy/owners and SSR contracts with synthetic state, and do not replace built-browser pointer/keyboard geometry or the real account boundary. Their per-file cases and evidence limits are recorded in the external disposition ledger. The full 212-file audit, remaining operation/state map, full mutation ledger, and final Linux verify remain open.
**Continuation update (2026-10-23):** Twelve registered application ownership/submission test files passed 128/128 focused cases: adoption, bindings, commands, lifecycle, application coordination, event coordination/generation, identity epoch wiring, runtime lifecycle invariants, execution target, admission and transition. The running audited execution tally is now 2,047 passed cases across 140 files. These tests use production owners/coordinators with synthetic session state and injected ports; actual client/socket/runtime/persisted-result evidence must remain separately attributed to the browser and real-host tests. The source-to-ledger filename cross-check currently leaves 84 registered paths without a filename mention; detailed per-file review and the remainder of the matrix/mutation/final-verification work are still outstanding.
**Continuation update (2026-10-23):** The real-client/runtime integration path for runtime todo → progress panel received a controlled negative control. A first probe removed message-carried progress reduction but the integration still passed, showing that the scenario also has a separate live event route; that probe did not cut the observed path and is recorded as an ineffective probe, not a mutation success. A targeted render-boundary mutation then made `WebuiProgressPanel` map an empty todo slice; after building the mutated client, `agent-transcript.test.ts` failed because the runtime-produced todo row was absent. The render was restored, rebuilt, and the same production integration case passed. A source-restored run had a 5-second post-reload user-message visibility timeout failure; after increasing only that locator wait to 15 seconds, the complete focused integration passed. Expected text and subsequent `resumeSession`/cursor assertions remain unchanged. Two successful focused executions after the wait adjustment add to the prior tally (2,049 passing case executions across 140 unique focused files). Exact outputs and boundaries are in the external ledger. Other mutation edges, remaining registered test audits, complete surface reconciliation, and final verify remain open.
**Continuation update (2026-10-23):** Audited and executed 15 additional registered browser bridge/target/toolbar files (223/223): reconnect and retry contracts; pairing, key/credential isolation and secret redaction; upgrade admission including dev-mode refusal; live session lifecycle; registry routing and target-generation fences; adversarial frame/duplicate/revocation behavior; browser operation and toolbar target binding; and SSR panel branches. Server/upgrade/adversarial/credential-secrecy suites use a real loopback HTTP/WebSocket server, production bridge/WebSocket server, `ws` clients and an in-memory credential store; they do not launch an installed browser extension. Pairing/secure-store platform-command tests use an injected fake command runner (and isolated temp path for the Windows file-backed branch), so no real OS keychain or credential is accessed. Toolbar/panel tests use SSR, source bindings and synthetic target/frame state, not browser event dispatch. No `skipIf`/`describe.skip`/`it.skip` markers were found in these 15 files. Current cumulative focused passing execution count is 2,272 across 155 unique files. The registration-to-ledger filename cross-check has 57 paths not yet mentioned. Full browser surface and all registered test audits, remaining mutation edges and final Linux verify remain pending.

**Continuation update (2026-10-23):** The boundary/dependency gate and service/host/proxy batch passed 246/246 across six registered files. `webui-boundary-check` exercises clean and contaminating build-graph inputs, including temp-file checks for forbidden references; `webui-dependency-check` runs the real AST resolver/classifier against synthetic temp trees and the frozen metadata oracle. `webui-service` covers real loopback HTTP/WebSocket and the shipped client transport against production service code, with synthetic harness ports, deterministic socket clients and temp file fixtures; it is strong service/transport evidence but not a production runtime/session persistence journey. Host-contract derivation and host-shape invariants use source/contract fixtures; the dev-proxy suite exercises the proxy path with controlled local servers. All six files were registered and passed; no files were removed. Full registration disposition, remaining journey audits, required mutation checks and final Linux `pnpm verify` remain pending. See external task record `gate-service-focused-current.log` and the corresponding case-disposition section.

**Continuation update (2026-10-23):** The account/composer/connection/session workflow batch passed 316/316 across 22 registered files. It covered production account/login owners and panel states; composer intent, field, history, seed and submission admission; command/turn ownership and task/session adoption; fork/import/goal/session isolation; connection watcher health and visible status/activity states. These tests use synthetic state, injected local ports and in-memory storage; they do not call account/model services or themselves prove rendered browser geometry or persisted runtime sessions. Those evidence layers are tracked separately. Total focused passing executions recorded so far: 2,834; do not infer unique-file completion from this count. Full registered-file and behavior disposition, remaining mutations, final docs synchronization review and Linux verification remain pending. See external task record `workflow-audit-current.log` and case-disposition section.

**Continuation update (2026-10-23):** The model/catalogue/context/thinking batch passed 207/207 across 18 unique registered files. It exercised catalogue/provider owners, credential-change invalidation, typed mutation/reconciliation, credential-safe provider projections, usage/context ownership and plan projection, protocol/session-fact classification, connection channel health, model effort and thinking-choice wire projection. All provider and usage values were synthetic and all mutations used controlled local ports; no online provider/account call occurred. Total focused passing executions recorded so far: 3,041. Complete registered-file and user-operation dispositions, required mutation matrix, final documentation sync/review and Linux full verification remain pending. See external task record `model-context-current.log` and case-disposition section.

**Continuation update (2026-10-23):** Transcript/error/retry, session transfer and overlay batch passed 391/391 across 20 registered files. Unit cases use synthetic messages, diff results, transfer payloads and callback/geometry inputs; they establish production projection and component state, not persisted runtime behavior or Chromium geometry. The true transcript/client path and browser evidence remain separately scoped. Focused execution total is 3,432. Remaining registered suites, mutation controls, documentation reconciliation, plan retirement and final Linux verify are still outstanding. See external task record `transcript-overlay-current.log` and case-disposition section.

**Continuation update (2026-10-23):** Settings/provider/personalization/plugin batch passed 210/210 across 14 unique registered files. It covers settings layouts and workflow owners, validated global-instruction operations, provider/profile projections, plugin inventory/dialog/catalogue/status and operation wiring. Synthetic fixture data and injected local ports were used; no account, credential or marketplace service was called. Focused execution total is 3,642. Remaining registration and source-surface audits, mutation controls, final docs review, strategy plan retirement and final Linux verify remain pending. See external task record `settings-plugin-current.log` and case-disposition section.

**Continuation update (2026-10-23):** Workspace/review/queue/terminal batch passed 360/360 across 23 registered files. Production workspace tree/tab/archive/canvas/preview, review and queue owners, worktree and terminal contracts, freshness fencing and rail pin callback wiring were exercised using synthetic fixtures or controlled local ports. No actual workspace mutation, terminal process or Git change was created by these unit tests. Focused execution total is 4,002. Remaining suite audit, browser/integration completion, mutation controls, documentation/plan retirement and final Linux verify are pending. See external task record `workspace-review-current.log` and case-disposition section.

**Continuation update (2026-10-23):** The final registered-file batch passed 831/831 across 51 files, covering remaining package/source contracts, host/adaptor composition, store and stream reducers, auth/usage projections, shell/error-boundary rendering, browser frame validation, and worktree state/panels. No skip was reported by Vitest. Inputs are source/synthetic fixtures or controlled local ports; no account, provider, or user data was used. Cumulative focused executions logged: 4,833 (this is execution count, not unique assertions). The filename basename cross-check now has no unmentioned registered WebUI test files. Case-level descriptions remain in the external ledger. Remaining tasks are final integration recheck, mutation evidence reconciliation, package/source gates, final Linux verify once, and retiring the plan after acceptance review.

**Continuation update (2026-10-23):** Restored the plugin/Skills/MCP gap with 9 additional built-client browser cases across `plugin-catalogue-layout.spec.mjs` and `visual-baselines.spec.mjs`: marketplace install and expand/collapse; Skill marketplace install and composer menu insertion; Skill create/enable/delete; plugin enable/uninstall; MCP create/enable/edit/delete; visible success, idle, disabled, unavailable and error rows; and stale MCP detail/Git preview/import settlement. The first focused regression after the contrast fix passed 11/11. The focused Skill/MCP toggle and MCP edit test initially failed because its staged detail response did not match the production `getMcpServer` `{name, config, enabled}` shape; the fixture was corrected to match that observed contract and the test passed 1/1. A broader 13-case plugin/MCP focused rerun is in progress. Added four Linux Chromium screenshot baselines (10 total) for marketplace grids and Skill/MCP management rows; inspected the MCP baseline after fixing its failure-reason text from tertiary (`rgb(173, 173, 173)`) to secondary (`rgb(102, 102, 102)`). The red assertion reproduced the contrast defect before the style fix; the focused browser case passed afterward. Browser evidence remains fixture-backed and does not prove marketplace, installed-plugin filesystem, production runtime-plugin, or live MCP execution. The final `pnpm verify`, full Vitest item-by-item disposition reconciliation, mutation ledger reconciliation, and source inventory check after new snapshots remain pending.

**Continuation update (2026-10-23):** Added a production client/service/runtime queue workflow to `agent-transcript.test.ts`: submit with Enter while an answer is streaming, observe the real enqueue request and queue row, reload and resume, then verify runtime queue drain, both rendered answers, and exact persisted message order. This test exposed and fixed a real event-wiring defect: `session.queue.updated` refreshed pending interactions instead of the Composer queue projection, so the queued turn could not drain. A specific `refresh-queue` effect now reaches the Composer controller. The reducer/application focused unit cases passed 61/61; the restored real-path integration passed 1/1. A controlled event-route break-link mutation made the same integration fail because the queued answer never arrived, then the mutation was restored. Evidence and logs are in the external task record (`queue-refresh-focused.log`, `queue-refresh-mutation-red.log`, `queue-refresh-restored-green.log`). This completes one queue/send/resume slice only; tool/diff output, Ask User, slash modes, references/attachments, fork isolation, runtime environment/todo, active browser overlap, cancel/retry, full registered-test reconciliation, remaining mutation checks, and final Linux verification remain outstanding. The plan stays Active.

**Continuation update (2026-10-23):** Extended that same production-path browser integration with a third composer turn whose local model stub emits an OpenAI `todowrite` tool call. The production runtime executes the tool; the browser observes the tool activity label and todo in the rendered progress card, and the harness session stores the todo and final answer. After building the client, a controlled `selectWebuiWorkspaceProgress` mutation that returned an empty todo list made the same integration fail at the progress-card assertion; the mutation was restored, the client rebuilt, and the full integration passed 1/1 (`queue-todowrite-restored-green.log`). This establishes one real `todowrite` → panel path, but not runtime environment changes or concurrent embedded-browser operations. The earlier historical todo-integration claim remains invalid; this is new, current evidence. Other mandatory flows, full suite/disposition reconciliation and final Linux verification remain outstanding.

**Evidence correction (2026-10-23):** An earlier continuation note incorrectly described `agent-transcript.test.ts` as already covering runtime todo → progress panel; at that time, the current complete file contained only transcript/refresh/resume and did not support the historical mutation claim. That historical receipt remains excluded. The current todo coverage is the separately implemented and reverified real `todowrite` model-tool flow documented in the immediately preceding continuation entry; do not retroactively credit the stale receipt.

**Premature retirement record (2026-10-23; superseded when this plan was restored):** The plan was removed from the source tree after a failed Linux `pnpm verify` at the browser gate, despite its acceptance criteria still being open. The retained external record preserves the then-current log and disposition work. The plan is active again; this historical entry is not a completion claim.
**Decision:** [ADR 0023](../../packages/webui/docs/adr/0023-webui-test-coverage-follows-user-workflows-and-evidence-levels.md)
**Scope:** `packages/webui` user-facing behavior, runtime integration, test suites and their operating documentation.

## Objective

Build a reliable, end-to-end test system for the complete user-reachable WebUI. It must verify
observable behavior through the correct evidence layer, expose drift and fake-green coverage, retain
valid existing tests, and repair reproducible failures discovered by the full WebUI Vitest and
built-browser gates.

The plan includes a complete existing-test audit, a surface-to-test coverage map, critical end-to-end
workflows, browser layout and interaction coverage, real-path local integration, gate organization,
documentation synchronization and repair of issues found during execution. No implementation work
starts until an independent MiniMax Code M3.1 review finds no scope drift, conflicting policy or
unresolved decision.

## Approved constraints

- Default tests are deterministic, local and isolated. Use synthetic files, temporary workspaces and
  session stores, local origins and local deterministic model stubs. Do not use real user data.
- Default gates do not call online model providers or account-backed APIs and do not consume model
  tokens. Live-provider, OAuth, paid, packaged-client, real Chrome/Edge and external bridge checks
  remain explicitly separate and environment-gated where applicable.
- The built-client browser suite uses Chromium, DOM outcomes, geometry and committed representative
  screenshot baselines for stable visual behavior. Generate and compare baselines on the Linux CI
  browser environment; keep them alongside browser tests and inventory them as source assets.
  Existing browser-generated tests remain and are reviewed for their actual evidence boundary.
- Integration tests must use real WebUI client/service/runtime and persisted harness-session paths
  for the behavior they claim to prove. Browser-local preferences (such as composer drafts) are a
  separate persistence contract. Stubbing model output is allowed; substituting demo UI data for the
  client-to-runtime path is not integration evidence.
- Include all reachable surfaces, controls and operations, not just the user-provided examples.
  Test applicable success, loading, empty/unavailable, refusal/error, cancellation/retry,
  concurrency/queue and refresh/session restoration states without exhaustive Cartesian products.
- Preserve existing tests by default. Keep, correct, strengthen, consolidate or replace each only
  after classifying its contract, path and assertions. Delete a test only if its behavior is retired
  or replacement coverage is demonstrated and documented.
- Fix reproducible product defects, test drift, false-green conditions and broken test infrastructure
  encountered in the full `pnpm test:webui` and `pnpm test:webui-browser` runs. Report environmental
  failures separately.
- Keep established test tier names and evidence boundaries aligned with
  `packages/webui/docs/verification/gates.md` and `browser-suite.md`.

## Current baseline to verify during execution

The current package declares four test areas: `test/unit`, `test/integration`, `test/browser` and
`test/gates`. `test/vitest-suites.json` explicitly registers Vitest files. The Playwright harness
runs the built client in Chromium, with deterministic in-page transport fixtures in most browser
specs; the native-runtime and real-browser integration cases exercise additional real boundaries.
Existing integration tests include loopback harness, agent transcript, production-host turn, real
browser navigation and workspace-browser-tab acceptance paths.

These are inventory starting points, not acceptance claims. The audit must read the current test,
harness and gate code and prove what each test executes. Prior task notes reported failures in
browser-workspace, questionnaire, rail-pin, CSS structure, workspace tab strip and shell suites at
one point; those results are historical leads only. Re-run current gates and classify each observed
failure from fresh output before treating it as a current defect.

## Coverage model

Every user-reachable operation gets an inventory row with: surface and entry point; user action;
observable expected result; owning business; relevant state branches; test file(s); evidence level;
real and stubbed boundaries; gate registration; and audit disposition. Evidence levels follow
`docs/verification/gates.md`: pure behavior, assembled application, real boundary, built browser,
live product. A test cannot claim a higher level than the path it actually executes.

| Surface / workflow family | Required behaviors and states | Primary evidence |
| --- | --- | --- |
| Composer and turn lifecycle | Text send, slash palette including `/plan`, `/goal`, `/compact`, plugin and skills entries, model/effort selection, attachments, `@` references, send/stop/retry, queued send during active stream, send errors, input clearing/retention, thinking/reasoning and ordered transcript | Main browser + real-path integration; focused unit tests for transitions |
| Agent interaction | Ask User prompt, answer submission and continuation in the same turn; refusal, cancellation, reconnect and pending states | Main integration flow + focused browser interaction |
| Transcript and review | User/assistant/tool/reasoning messages, streamed updates, reload/resume, session switch, message ordering and retention, diff/change card ownership and rendering, copy/share/feedback controls where available | Built browser + persisted harness-session integration + focused unit |
| Sessions and navigation rail | Create, select, copy/fork, rename, archive/unarchive, pin/unpin, search, transfer/import/export, delete/purge and navigation/adoption; empty/loading/error and stale selection states | Browser surface flows + persisted harness-session integration + unit/application tests |
| Goal and plan | Goal creation/submission, outcome, retention, session ownership, progress and restart behavior | Browser + integration for composer-to-runtime path + unit ownership tests |
| Environment/progress/todo | Runtime environment changes, todo creation/update/completion, progress events and panel selection/session linkage, empty/loading/error states | Real-path integration reflected in built browser; focused projection tests |
| Embedded browser/workspace panel | New tab/tool selection, navigation, back/forward/reload, input, close, multiple tabs/pages, browser authorization and unavailable state, Agent and user actions, concurrent todo updates; canvas, archive view, directory browser and panel controls | Built browser for controls/layout + real local-origin Chromium integration for service path |
| Files and workspace tools | File tree navigation, preview supported text/media/HTML, refresh, errors/unavailable content and tab lifecycle; workspace tabs and supported file types | Built browser + focused integration at file/runtime boundary where available |
| Terminal | Start, input, output, resize, stop/exit, cross-page/session behavior, unavailable PTY and shutdown | Local host integration + browser interaction; native evidence labeled per platform |
| Models and provider setup | Picker open/search/select, grouping and effort states; provider configuration validation, test/save/discovery and failure/pending behavior | Browser + application/contract tests; external provider invocation remains separately gated |
| Settings, personalization and account | Tabs/routes including coding, worktree and archived views, theme, instructions/preferences, usage/account states, loading, empty, error, save and navigation behavior; assert disabled tabs remain unavailable | Browser layout/interaction + focused application tests; no real account by default |
| Plugins and MCP | Catalogue, install/configuration/action workflows, status, permission/refusal, errors, empty and loading states | Built browser + local service/contract integration as applicable; external services excluded by default |
| Global interactions and shell | Menus/dialogs, keyboard shortcuts, dropdown dismissal/placement, connection status, startup errors/recovery, responsive or constrained geometry, focus and accessible operation | Built browser, representative screenshot baselines and focused pure/view tests |

The table is a coverage taxonomy, not the detailed operation checklist. Phase 0 expands it against
all feature UI, command registries, public actions, and `docs/known-gaps.md` / `docs/open-questions.md`.
That source-grounded checklist must explicitly include `/compact`; slash-palette plugin and skills
states (including runnable, inert-wired and intentionally unsupported entries); all 29 plugin
management actions; settings' coding, worktree and archived views plus disabled/unavailable tabs;
workspace canvas, archive view, directory browser and panel controls; and the currently shipped
terminal, file-preview, browser, session transfer and account flows. Unsupported states are tested
as unsupported/unavailable; the plan does not imply implementing missing features. No feature family
is complete solely because a family row exists.

## Mandatory end-to-end journeys

1. **Agent reply, refresh and resume.** From a fresh isolated session, send a composer message;
   stream reasoning and tool/activity events followed by a final response; verify message order,
   final content and review/diff card; refresh during a controlled active response and after
   completion; verify the resumed stream and persisted transcript do not drop or reorder messages.
2. **Plan, goal, reference and attachment.** Start `/plan` and `/goal` using the composer; choose an
   `@` file reference and add an attachment; verify selected identities and intended content
   metadata reach the runtime request, and verify resulting goal/plan state in the session.
3. **Queue and Ask User.** During a streamed response, send a second message and verify queue order
   and eventual delivery. In another turn, make the local model stub emit an Ask User event, answer
   in the UI, and prove the same runtime turn continues with that answer.
4. **Fork and session isolation.** Copy/fork a conversation; verify the new session has the intended
   transcript, an independent identity and independent subsequent messages. Switch between source
   and destination and verify each restore correctly.
5. **Progress and embedded browser together.** Emit environment/progress/todo events from the real
   local runtime path and assert the right panel updates for the correct session. While a response
   and todo update are active, operate the embedded browser's supported controls against a local HTTP
   origin; assert tab, page and progress states are correct and independent.
6. **Errors and recovery.** Exercise model/runtime refusal or failure, cancellation, reconnect,
   retry and session switching; assert visible recovery behavior and no duplicate, missing or
   cross-session messages.

The model stub controls only deterministic model output and timing. Browser input, WebUI transport,
service dispatch, runtime adapter, persisted harness session, stream persistence and rendering remain
the real application path for integration claims. Browser-local preferences and drafts are a
separate persistence contract. Every journey records its exact stub seam.

## Existing test audit and disposition policy

Create a complete, run-specific manifest from all registered Vitest files, all Playwright specs,
conditional or environment-gated suites, and package scripts. Keep the detailed manifest and
disposition ledger in the task's external review record, outside the repository; the user-requested
strategy plan in `.plan/` is the sole in-repository planning artifact. For every existing test record:

1. What behavior/contract it claims to protect.
2. Which user operation or state branch it covers.
3. Which code path actually runs (and which source files or owners it bypasses).
4. What is real versus synthetic, mocked, stubbed, skipped or environment-gated.
5. Whether assertions would fail if the behavior were broken; include observable outcomes rather than
   selector/test-id presence or fixture self-confirmation.
6. Whether it is registered in the correct gate and executes in CI as intended.
7. Its disposition: **keep**, **correct drift**, **strengthen**, **consolidate**, **replace**, or
   **retire**. Include evidence and replacement pointer for any consolidation/replacement/retirement.

Do not remove tests merely because new end-to-end coverage overlaps them: focused tests continue to
provide faster localization. Detect fake greens by running controlled break-link/mutation checks on
critical user-input → request, stream → transcript, persisted session → refresh, runtime todo → panel,
and browser control → browser service edges. Include a negative-control assertion so a mutation is
shown to fail the intended test. Prefer narrow, reviewable mutations and restore only the mutation
after recording results.

## Implementation phases

### Phase 0 — Baseline and inventory — COMPLETE

- Record branch, working tree and available gate artifacts without disturbing unrelated changes.
- Inventory source surfaces, registered tests, browser specs, integration harnesses, scripts and CI
  gates; trace test calls to real boundaries.
- Run `pnpm verify` once at baseline on Linux and classify each gate as in-scope or unrelated
  before changes. It builds the client and includes `pnpm test:webui` and `pnpm test:webui-browser`;
  use those results as the baseline instead of rerunning the same gates separately. On non-Linux
  hosts, `pnpm verify` skips the browser gate, so run `pnpm test:webui-browser` once there if a local
  baseline is needed and label its platform. Save raw outcomes outside the repository in the task
  record. Reproduce individual failures narrowly before classifying them. A historical
  `.last-run.json` or an environment-skipped case is not current passing/failing execution evidence.
- Classify each full-verify gate before changes. This gives final verification a comparison point
  for repository-wide gates outside the two WebUI suites. Do not widen product fixes to unrelated
  failures without evidence they were caused by this work.
- Deliver the complete coverage manifest and existing-test disposition ledger in the external task
  record before adding or changing scenarios.

### Phase 1 — Critical real-path workflows — COMPLETE (six named journeys)

- Strengthen or add integration journeys for composer-to-Agent reply, reasoning and transcript
  order, refresh/resume, `/plan`, `/goal`, reference and attachment delivery, in-flight queue,
  Ask User continuation, fork/session isolation and todo/environment panel updates.
- Use the production WebUI client/service/runtime and persisted harness-session path with isolated
  temporary state. Browser-local preferences and drafts remain a separate persistence contract.
- Run critical journeys in the browser where actual user input/rendering is part of the behavior;
  keep a service-only integration claim separate from a UI end-to-end claim.

### Phase 2 — Surface and interaction completion — IN PROGRESS (183 browser cases pass; full operation/state matrix open)

- Expand the operation/state matrix to every user-reachable control across the surface families.
- Add/strengthen built-client Chromium tests for interactions, navigation, empty/loading/error and
  cancellation/recovery branches.
- Verify actual geometry and stable representative screenshots for shell, transcript/composer,
  rail, settings, progress panel, embedded browser and representative overlays. Commit baselines
  generated in the Linux CI Chromium environment, inventory the binary files, and update a baseline
  only alongside an explained intended visual change. Generate/update with
  `pnpm exec playwright test packages/webui/test/browser --update-snapshots` on Linux matching CI;
  inspect the image diff before accepting it. Keep DOM and geometry assertions independent and use a
  documented pixel tolerance for renderer noise. Linux CI is authoritative for visual baselines; on
  other operating systems report visual comparisons as not run rather than treating cross-platform
  pixel drift as a product regression.
- Retain synthetic fixtures for deterministic client-only cases and label them accurately.

### Phase 3 — Reliability audit and failure repair — IN PROGRESS (focused mutations and full suites recorded; final ledgers/verify open)

- Execute mutation/break-link probes for the critical seams and close fake-green gaps.
- Repair every reproducible product bug, drifted assertion, missing registration, brittle harness
  assumption and reproducible gate failure in scope. Do not weaken expected behavior to obtain green.
- After every file addition, move or deletion, regenerate `release/public-source.json` with
  `node scripts/source-inventory.mjs --write` and run `pnpm check:source`; Vitest additions must also
  be registered in the `webui` group of `test/vitest-suites.json`.
- Build with `pnpm build:webui` before `pnpm test:webui-browser`. Re-run after relevant source,
  fixture or screenshot-baseline changes.
- Re-run affected focused suites during repair. On Linux, make the final full-suite execution a
  single `pnpm verify` run: it includes `pnpm test:webui` and `pnpm test:webui-browser`, and its
  command output is the source for per-suite executed/skip details. Do not run those unchanged full
  suites a second time after verify. On non-Linux, run `pnpm test:webui-browser` once separately
  because verify skips that platform-gated step.
- Report each gate's executed, skipped and environment-blocked cases separately. A skip means the
  corresponding behavior was not proven in that run. Keep external/browser-platform/environment
  failures distinct from product failures and include exact evidence and the remaining boundary.

### Phase 4 — Durable documentation and gate alignment — IN PROGRESS (verification docs synced; plan retirement waits on acceptance)

- Synchronize `docs/verification/gates.md` and `docs/verification/browser-suite.md` with actual test
  tiers, model stub seam, screenshot baselines, suite registration, harness exceptions, skip
  accounting and live/external boundaries. Correct the real-browser bridge spec extension names in
  the docs if the source confirms the drift.
- Keep the user-requested strategy plan in `.plan/`; keep run-specific inventory, test dispositions,
  logs and verification reports outside the repository.
- Before closing the implementation, update this plan's status and acceptance summary so it no longer
  says implementation has not started. Retire the completed plan after its durable decisions and
  operational rules are represented by ADR 0023 and the verification docs; regenerate
  `release/public-source.json` and run `pnpm check:source` when the plan file is removed, following
  the repository's plan-retirement convention.
- Reconcile the external test disposition ledger, final surface map, CI gates and ADR 0023 before
  declaring the strategy implemented.

## Gate and test file rules

- Vitest test files are explicitly listed in the `webui` group of `test/vitest-suites.json`; verify
  each intended test is registered and each registered path runs. Every added, moved or removed
  package file must also be reflected in `release/public-source.json`: run
  `node scripts/source-inventory.mjs --write`, then `pnpm check:source`. This includes browser specs,
  screenshot binaries and documentation files.
- Deterministic fixture browser specs import `test` from `packages/webui/test/browser/harness.mjs`
  so the harness's run-id checks apply. Real-browser bridge specs use their own extension/browser
  lifecycle and are exempt from that fixture harness; audit their own server/build identity and
  report skips when the required browser is unavailable. Preserve these existing real-browser specs.
- Do not add jsdom, happy-dom or Testing Library, and do not change the shared `node` Vitest
  environment. Use pure transitions, SSR branch assertions, and real Playwright for behavior SSR
  cannot reach.
- Follow existing verification scripts rather than introducing a parallel gate inventory. Keep
  default deterministic gates separate from slow or environment-dependent gates according to the
  evidence boundary. Report all skips per gate; a skipped test does not count as passing evidence.
- Build with `pnpm build:webui` before `pnpm test:webui-browser`; baselines are committed and
  generated/compared using the Linux CI Chromium environment. Do not accept local cross-platform
  pixel drift as a baseline update without checking the declared CI environment. Use the documented
  baseline update command and inspect the diff; snapshots supplement but never replace observable
  DOM/geometry assertions. Screenshot comparison counts as executed only on Linux; report it as not
  run on other operating systems.
- After source changes, use appropriate typecheck/build/focused gates, then run `pnpm verify` on the
  final inputs before declaring implementation complete, as required by `packages/webui/AGENTS.md`.
  On Linux, its `test:webui` and `test:webui-browser` steps are the final full-suite runs; use their
  command output to record executed, skipped and environment-blocked cases instead of rerunning them.
  On non-Linux, run `pnpm test:webui-browser` once separately because verify skips it. Compare
  repository-wide gates with the Phase 0 baseline: every in-scope gate must pass; unrelated
  pre-existing failures must be identified by gate and reported as such, not attributed to this
  change or silently counted as a pass.

## Acceptance criteria

- Every user-reachable operation and material state branch appears in the source-grounded coverage
  manifest kept in the external task record and has a test at an appropriate evidence layer or an
  explicit, justified limitation.
- All six mandatory journeys prove their expected transitions and final persisted/rendered outcomes.
- Every test in the existing suite has an evidence-backed disposition; valid tests remain, and any
  consolidated/replaced/retired test has equivalent or intentionally superseding coverage recorded.
- Critical connection mutations fail the intended tests, demonstrating that assertions detect a
  broken connection rather than only confirming a fixture's own input.
- The test suite distinguishes built-client browser behavior, real local integration, native local
  behavior and live external service behavior without overstating any result.
- Screenshot baselines cover representative stable layouts, have documented viewport and update
  review rules, and are not used as the sole assertion for dynamic content.
- `pnpm build:webui` and `pnpm check:source` pass, and final `pnpm verify` executes on the final
  inputs. On Linux this final verify includes both full WebUI suites; on other platforms run the
  browser gate separately because verify skips it. All in-scope gates pass after reproducible defects
  are fixed. Compare unrelated full-verify gates with the Phase 0 baseline and report any pre-existing
  or environment-blocked failure by name; do not present it as caused by this work or as a pass.
  Report skips separately; a gate that completes with skips does not prove those skipped behaviors.
- `docs/verification/gates.md`, `docs/verification/browser-suite.md`, ADR 0023 and the test-suite
  registration agree with the implemented system.
- A final plan review confirms no remaining scope drift, contradictory policy or unresolved decision
  blocks implementation.

**Current status update (2026-10-23):** A built-Chromium integration execution has passed through stream reasoning/final answer and reload/resume, queued second turn and queue-row clearing, `todowrite`→progress card, `@` reference plus file attachment delivery to the model request, `/plan`, Ask User same-turn continuation, `/goal` creation/pause/clear, and mounted production MCP list/create. Production code now rechecks authoritative active-turn state after an attached stream ends and refreshes the queue projection; removing only `refreshQueue` makes the target integration fail on the stale queue row, and restoring it passed once (`queue-refresh-link-mutation-red.log`, `queue-refresh-link-restored-green.log` in the external task record). **That queue result is not stable yet:** subsequent full replays failed again because the runtime queue emptied while the mounted transcript did not render the queued reply, even though the event channel was active and received `session.queue.updated`. Treat queued-turn rendering/recovery as an unresolved product defect until repeated source-restored runs pass. A new fork/copy integration attempt is currently blocked behind that queue failure; an earlier attempt found the rail's visible session-more control was hit-tested through the underlying session link, and its style correction has not yet been verified by reaching the control. Fork/copy isolation, runtime environment events, browser controls concurrent with Agent/todo activity, cancellation/retry/reconnect/error recovery and session switching remain open, along with full registered-test disposition, remaining break-link controls, final docs reconciliation and final Linux `pnpm verify`.

**MCP page and form coverage update (2026-10-23):** `real-host-loopback.test.ts` now includes an isolated built-Chromium UI case against the production local runtime/service. It clicks Plugins → Manage → MCP, checks the returned `{servers: []}` result and visible error absence, opens the Add MCP Server dialog, asserts fixed viewport overlay, center placement and field/control alignment at 1440×900, then submits a disabled synthetic stdio server and observes it in the reloaded list. This addresses the previously untested mounted page and form layout on the real local operation path; the disabled process is not started and no live MCP handshake is claimed. A targeted local-runtime list-shape mutation reproduced the exact `pluginManagement returned a body that does not match its declared result` page error; restored code, build and rerun passed. Logs are in the external task record (`mcp-targeted-mutation-red.log`, `mcp-targeted-restored-green.log`). The complete `agent-transcript.test.ts` was also rerun green after source restoration. Remaining journeys and final acceptance requirements above remain open.

**Continuation update (2026-10-23, message-row fork):** The fork coverage now targets the user's actual assistant message action (“复制为新会话”), not the session-rail context menu. A real built-client integration red reached the production fork request and shell navigation but found the returned session missing from the left tree. The production `forkSession` application wrapper now waits for `sessionWorkflows.refresh()` before returning the result to navigation, and reports refresh failure through the session workflow error state. The green journey checks request identity/title/assistant-message id, returned session id, hash, active visible rail item and a refreshed session tree. A pointer interception when returning to the source row was corrected in the test to click the visible session label instead of the full-width anchor's center; this retains a real browser click. The same production-client/runtime integration then passed twice in focused runs, with the saved receipt `message-fork-flow-green.log`. It also verifies the clear-goal request and success response before checking persisted deletion. This closes the new-session visibility gap for the message-row fork path, but not independent subsequent messages in fork/source sessions; environment updates, browser operations during active Agent/todo work, and cancel/reconnect/retry/error recovery remain open. Overall plan status stays Active; do not count this local journey pass as completion of the six acceptance criteria, full surface matrix, mutation ledger or final verification.

**Continuation update (2026-10-23, message toolbar workflow):** The image-referenced row controls are now driven in the production mounted-client integration rather than counted only from SSR or fixture browser coverage. After a real streamed Assistant reply, Chromium clicks copy and reads the browser clipboard, then clicks like and dislike and checks the selected states. It copies an actual runtime-generated user message and checks the clipboard. In the returned fork session, the test sends a new prompt, proves it persists only in the fork, opens the real rewind-preview dialog through `getSessionRewindPreview` and cancels, then edits the user prompt through the inline editor. The production `editSessionMessage` operation returns success, the controlled local model emits a new answer, the edited prompt/answer persist, the old prompt is absent, and the source session remains unchanged. Focused command `pnpm exec vitest run --config vitest.oss.config.mjs packages/webui/test/integration/agent-transcript.test.ts` passed 1/1; full output is in the external record `transcript-message-actions-integration.log`. The tested boundaries are real Chromium/WebUI transport/service/runtime/persisted harness sessions; only deterministic model output and timing are controlled. The test was moved after the source-session journeys to avoid introducing a navigation race into their todo-panel assertions. This closes the toolbar workflows shown in the screenshots for copy, like/dislike, fork, user-message rewind preview, and edit/resubmit; it does not close other remaining surface, mutation-negative-control or final-verification requirements. Plan remains Active.

**Continuation update (2026-10-23, same-session persisted message actions):** The registered built-client integration now waits for `port.getActiveTurn()` to become `undefined` and confirms the sent prompt is in the production harness history before treating a row as persisted. Without reload or route/session navigation, it completes a second UI-driven turn, then hovers the earlier message and clicks its rewind control. Chromium observes the preview dialog, request body tied to the exact session/message id, matching service response, a visible/reachable overlay and usable cancel button; after cancel, the message remains rendered as expected because no rewind confirmation was submitted. The scenario then continues into the existing reload/resume flow. A placement attempt after `/goal` exposed that the expected rewind button was unavailable in that later state, so the action scenario was moved before `/plan` rather than treating that state as a no-op bug. The first dialog geometry assertion also used `innerWidth`/`documentElement.clientWidth`; actual measurements showed the portal target is `document.body` with client box 1274×720 while the window/html width is 1280, so the assertion now uses the measured body portal box. Final production-restored invocation passed 1/1 (`persisted-message-actions-same-session-geometry-green2.log`). This is production Chromium → WebUI socket/service → runtime adapter → persisted harness history, with only model output/timing controlled; it proves the same-session, no-navigation historical-row path in a fresh isolated test session. It still does not load a previously-existing session from disk before mounting Chromium, and it has not reproduced the user's report on their own already-open session. No product-code fix is claimed.

**Continuation update (2026-10-23, historical rewind negative control):** After the same-session persisted-row case passed, temporarily changed only the production user-message `onRewind` binding to a no-op and rebuilt. The same focused integration failed at the visible `rewind-preview-dialog` assertion before any operation assertion (`historical-message-rewind-handler-mutation-red.log`). Restored the original handler, rebuilt, and reran the full focused integration successfully (1/1; `historical-message-rewind-restored-green.log`). The temporary source mutation has been reverted; `MessageItem.tsx` is not changed by this strategy work. The targeted check proves the historical-row browser assertion detects a broken click handler; it does not prove the reported live-session incident fixed. Full journey matrix, remaining mutation ledger, all registered-test audit reconciliation, and final verification remain open; plan stays Active.

**Continuation correction (2026-10-23, confirmed same-session rewind):** The preceding rewind probe only opened the preview and cancelled it; its “message remains visible” assertion did not cover a committed rewind. The workflow now confirms “仅回退对话” from a completed persisted message while the same session remains mounted, checks the actual `rewindSession` request/response, verifies the deleted message is absent from the runtime's persisted history and the rendered transcript, and verifies an earlier message, route and selected session remain. This exposed a production defect: persistence removed the turn, but the browser transcript retained it. First adding a history refresh still failed because the transcript merged a stale settled stream-only message back into the refreshed page. The production fix now invalidates cached transcript pages and replaces the selected session's page after rewind, and settled projection no longer resurrects stream-only rows absent from authoritative history. The regression failed before the fix at the visible message assertion; after the fix, `pnpm build:webui`, the registered integration (1/1), `transcript-shape.test.ts` (63/63), and `pnpm typecheck:webui` passed. A controlled refresh-link break (omitting the application refresh) failed because no post-rewind `getMessages` request occurred (`rewind-refresh-link-mutation-red.log`); restored-source built-client integration passed (`message-rewind-confirmation-current-session-green.log`). This is isolated Chromium with a deterministic local model stub, production WebUI service/transport/runtime adapter and persisted harness session; it reproduces the state divergence without using a live user session. The remaining strategy matrix and final Linux verification are still open; plan remains Active.

**Continuation update (2026-10-23, action after same-session rewind):** Extended that same production Chromium journey to hover a surviving user row after the confirmed rewind and open its inline editor, asserting the expected prompt and canceling without reload or navigation. This specifically checks that the mounted transcript's remaining row controls are still usable after message deletion. The added end-to-end case passed in `post-rewind-edit-integration.log`; after a controlled `MessageItem.onEdit` disconnect, the full journey failed at the earlier pre-rewind edit control (`post-rewind-edit-mutation-red.log`), so that mutation proves the general edit-control assertion is red-capable but does not isolate the new post-rewind assertion. The mutation was restored and rebuilt. One restored run later failed at the existing immediate `@` reference DOM-order assertion (`post-rewind-edit-restored-green.log`); the next source-restored focused run passed 1/1 (`post-rewind-edit-repro.log`). The case now waits for the runtime turn to settle and the referenced user row to be visible before asserting final DOM order; this stronger settled-state observation passed 1/1 in `post-rewind-edit-rendered-reference-check.log`. Preserve the earlier failure in the stability record until the final suite replay. The gates and browser-suite docs now describe the current `/plan`, `/goal`, Ask User, fork-only follow-up and post-rewind editor coverage; runtime environment events, other recovery combinations, remaining mutation controls and final verification remain open. The plan stays Active.

**Continuation update (2026-10-23, independent todo and browser paths under concurrency):** Extended the registered `agent-transcript.test.ts` built-client journey with a local isolated Chromium provider and synthetic local page. The runtime-issued `todowrite` still independently produces the rendered progress item; the deterministic local model stub then holds its follow-up response so the Agent turn remains active. During that hold, the mounted WebUI browser control opens the local page, the user types through the rendered frame, the production browser service receives the browser input operation, and the page reports the exact typed value to its local origin. The test checks visible frame/panel bounds, confirms the todo is still visible and the Agent turn is still active, then releases the model reply and closes the tab after the turn settles. This is explicitly concurrency/non-interference coverage: todo does not cause browser input and browser input does not cause todo. Linux Chromium built-client/production service/runtime/browser integration passed with `pnpm build:webui` followed by `pnpm exec vitest run --config vitest.oss.config.mjs packages/webui/test/integration/agent-transcript.test.ts` (1/1, 29.93 seconds). A first cleanup attempt exposed `ENOTEMPTY` deleting the Chromium profile; cleanup now uses bounded retries. An attempt to close the web tab while the model response was still held prevented the later transcript completion assertion, so close-tab is ordered after turn settlement; this was test sequencing and does not claim a production defect. Browser input break-link mutation, environment events, other recovery combinations, remaining test/mutation audits and final verification remain open; keep the plan Active.

**Continuation verification (2026-10-23, browser input break-link and final focused result):** After the initial overlap case passed, the registered production integration was rerun on the current source after explicit adapter typing and passed 1/1 in 32.52 seconds (`browser-input-final-green.log`). `pnpm typecheck:webui` passed its host-event, server, client and test projects. A controlled source mutation returned immediately from `BrowserPanel.onKeyDown`, rebuilt the client and caused the same test to fail because the synthetic local page did not receive `browser-while-todo-active` (`browser-input-mutation-red.log`); the mutation was removed, the restored client rebuilt and the focused integration passed again. Full build/test/mutation outputs are recorded in the external task ledger. The browser-input negative control is now complete; environment events, other recovery combinations, the rest of the mutation/test audit and final verification remain open. The plan stays Active.

**Continuation update (2026-10-23, active-turn cancellation and recovery):** Extended the same registered production Chromium integration after the fork-session message actions. The local model stub emits visible reasoning and holds its response; the user clicks the mounted composer Stop button. The test verifies the exact `abortSession` WebUI request for the selected fork session and successful response, waits for the production runtime turn to settle and Stop to disappear, then confirms the held late answer is absent from both rendered transcript and persisted harness history. A new user message in that same session receives a successful answer and persists, proving the composer/runtime path recovers after cancellation. Restored-source focused integration passed 1/1 in 28.21 seconds (`agent-stop-restored-green.log`). A controlled mutation replacing the production composer stop callback with a no-op, followed by a client build, made the same integration fail because no `abortSession` request was issued (`agent-stop-mutation-red.log`). The source mutation was removed, the client rebuilt, and the restored integration passed. No production defect was observed in this cancellation scenario. Runtime environment updates, tool-driven workspace file changes, reconnect/retry/error recovery combinations, remaining registered-test and mutation audits, and final verification remain open; keep the plan Active.

## Review checklist for MiniMax Code M3.1

Review this plan against the current repository source, `packages/webui/AGENTS.md`, verification docs,
test inventory, root AGENTS instructions and ADR 0023. Check:

- Does it include all source-grounded user-reachable surfaces and all user decisions?
- Does it distinguish synthetic browser behavior, real runtime integration and external/live tests
  precisely?
- Does it preserve valid existing tests and provide a defensible, observable audit for fake greens?
- Does any requirement conflict with the current gate architecture, package policy or file inventory?
- Are dependencies, execution order, evidence, failure handling and acceptance criteria complete?
- Are any decisions still required from the user before implementation can begin?

Return findings with exact plan section and repository evidence. Do not implement. The plan will be
revised and re-reviewed until the reviewer reports no blocking drift, conflict or unresolved decision.

## Continuation update (2026-10-23, runtime environment refresh)

The Agent-write → environment-panel path is now covered and the reproduced refresh defect is fixed.
The root cause was split workspace Git ownership: the process-local WebUI application retained V1
`getMetadata`/`getChanges`, while only review reads were wired through the V2 `WorkspaceGitService`.
The V2 watcher therefore never owned the environment query instance and could not publish the
`workspace.git.changed` event that invalidates the panel. `composeProcessLocalApplication` now routes
those environment reads through V2; the production file watcher, global event stream, client query
invalidation and visible line-count update remain in the asserted path.

Evidence: the composition test first failed with `legacy-main` instead of `v2-main`; a controlled
break-link mutation restoring the V1 route failed the same assertion. After restoration, the
composition test passed 6/6. `pnpm build:webui` passed before the built-Chromium production
integration, which passed 1/1 and observed the actual Agent `write` tool, a matching
`workspace.git.changed` event on the runtime event stream, a new WebUI `getWorkspaceEnvironment`
request, the rendered “新增 1 行，删除 0 行” count, and the production environment result with one
changed file. The production-backed integration has deterministic local model output/timing and uses
only a temporary Git workspace, isolated session store, local origin and local Chromium. No live
model, user data, account service or paid call is used. See external record
`environment-runtime-event-assertion.log` (negative control) and
`environment-restored-integration.log` (restored green).

This closes runtime workspace-environment refresh for the tested Agent `write` path only. It does not
close all write/edit/Bash mutation combinations, session/workspace switching, broader retry/reconnect
and model-error recovery, the remaining registered Vitest audit and surface matrix, remaining
mutation controls, documentation reconciliation or final Linux verification. The plan remains Active.

## Continuation update (2026-10-23, model error, retry, session isolation and reconnect)

The real Chromium journey now returns an upstream 400 from the local deterministic model endpoint
until the user retries. It waits for the actual runtime `session.error` on the page's event WebSocket,
checks the visible error and retry control, switches to the source session and confirms that error is
not shown there, returns to the fork and confirms its error remains, then clicks Retry. The retry
uses the normal WebUI `sendMessage` path for the same fork session; the local model stub succeeds,
the error disappears and the answer is present in persisted harness history.

This exposed a production defect. `session.error` wrote the refusal, then the terminal active-turn
recheck found no active turn and started a history reconciliation. The stream history anchor treated
that reconciliation as a fresh active-turn attachment and erased the refusal before the mounted
composer could render it. The sink now accepts an explicit `clearRefusalOnAnchor` policy: ordinary
new-turn/active-turn anchoring retains its clearing behavior, while turn-id-less no-active-turn
history reconciliation preserves the terminal refusal. A controlled break-link that restored the
default clearing behavior made the same production integration fail at the error-surface assertion.
Restoring the fix, rebuilding, and replaying the same full journey passed; the subsequent replay with
session switching and reconnect assertions also passed. `pnpm typecheck:webui` passed for host events,
server, client and tests.

The same journey closes the reconnect slice by deliberately closing the production `watchEvents`
WebSocket, observing a new watch request and service acknowledgement, then confirming the next real
Agent write still reaches the workspace event and visible environment refresh. This is a local
service/runtime integration with isolated temporary data/session/workspace and deterministic model
responses; it does not use an online model, real account, live MCP server or paid API. Exact evidence
is in the external task record: `agent-retry-event-ingress-check.log` (event arrival before repair),
`agent-retry-restored-green.log` (first restored retry), `agent-retry-break-link-red.log` (negative
control), and `agent-error-reconnect-session-green.log` (restored retry, session switching and
reconnect). This closes these recovery combinations only; the full operation/state matrix, registered
Vitest disposition, remaining mutations, documentation reconciliation and final Linux verification
remain open. Keep the plan Active.
