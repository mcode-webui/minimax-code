# Source evidence and refresh

## Baseline

Investigated on 2026-10-19 starting at HEAD `4de6a59a5df5fa8a2eeab782fdb71603e1da9197` in `/home/fectivnfy/my_data/project/my_project/minimax-code`. The working tree already contained modifications to the package manifest and browser/integration tests, and a staged test-result deletion. `test/browser/fixture.mjs` also changed during the investigation. Concurrent work advanced HEAD to `7574e4b07579570c08fd1d83af67cc92294de75d`; the intervening diff changes the package manifest and tests, with no `packages/webui/src/` changes. Final capture provenance records that later clean tree and input hashes. This skill creation did not edit or commit repository files.

The dependency checker scanned all 435 TypeScript source files and 1,557 in-package references: zero direction violations, cycles, role violations or publication violations; one declared structural exception. The current build succeeded with 108 server inputs, 331 client inputs and 432 combined inputs. Counts describe that run only and are not acceptance thresholds.

Human/source investigation followed all four execution boundaries, all business homes, application wiring and teardown, request-freshness and submission mechanisms, validators/registry/bindings, capability derivation, runtime resources, style/token/compiler setup and representative unit/integration/browser tests. This is comprehensive architecture-oriented coverage, not a claim that every line of every file received an exhaustive correctness review.

Independent read-only forward-testing exercised file-preview refresh during session switching and a new appearance settings row. It confirmed useful routing and found two refinements incorporated here: inspect leaf-owner disposal rather than universalizing application fencing, and settle/verify the actual surface before screenshot capture. The helper now checks finite animation settlement, image loads, theme and settings-versus-conversation identity. The final six originals were visually inspected. Full repository test suites and real provider/account scenarios were not executed for this external skill-only change.

## Source anchors by claim

| Claim | Read/refresh in the repository |
| --- | --- |
| Operating rules and doc authority | root/package `AGENTS.md`, `packages/webui/docs/README.md`, `CONTEXT.md` |
| Layer and role direction | `scripts/lib/webui-dependency-rules.mjs` (`ALLOWED_EDGES`, `PROJECTION_DOMAIN`, `classifyLayers`, `classifyRole`, role/publication checks), `scripts/check-webui-dependency.mjs` |
| Browser wiring | `src/client/main.tsx`, `application/create-application.ts`, `port-slices.ts`, `bindings/application-context.tsx` |
| Canonical state and temporal identity | `application/session-store.ts`, `identity-epochs.ts`, `conversation/request-freshness.ts`, `session-scope.ts`, `stream-lease.ts` |
| Creation and submission | `application/task-session-workflows.ts`, `features/turn/contracts/submission.ts`, `application/submission-admission.ts`, `composer-submission.ts`, `turn-commands.ts`, Composer controller |
| Independent business ownership | Feature application modules listed in `architecture.md`; per-session Goal/Interactions, separate Review families, provider editor, terminal owner |
| Ingress and delivery | `client/platform/event-channel.ts`, `features/turn/application/event-coordinator.ts`, `session-fact.ts`, `conversation/stream-loop.ts`, Turn sink adapter |
| Loopback contract | `shared/operation-names.ts`, `server/operation/{operations,bind-handlers,binding-mechanism,operation-dispatch}.ts` |
| Support/readiness | `shared/capability-manifest.ts`, `server/service.ts`, `runtime/harness/adapter.ts` |
| Process close | `runtime/assembly.ts`, `runtime/lifecycle.ts`, `runtime/terminal.ts`, `server/service.ts` |
| Browser action semantics | `packages/browser-core/src/browser-core.ts`, `browser-actions.ts`, `browser-action-targets.ts`, `browser-transport.ts`; the WebUI adapters `src/runtime/browser/isolated-chromium/core-transport.ts` and `src/server/browser-bridge/core-transport.ts`; the authoritative narrative `packages/webui/docs/browser-use/10-browser-core-integration.md` |
| Visual baseline | `client/styles/{tokens,index,shell}.css`, `tailwind.config.cjs`, feature CSS, `ConversationSurface.tsx`, `WebuiClientFoundationApp.tsx`, Settings appearance source |
| Verification | `scripts/verify.mjs`, root/package scripts, `test/vitest-suites.json`, `playwright.config.mjs`, browser harness/server/fixture, token tests |

Unless explicitly prefixed, source rows refer to `packages/webui/src/`. Use symbol search for exact current locations rather than freezing line numbers that will drift.

### Refresh of 2026-10-26 — the Browser Core layer

A documentation synchronization pass brought the WebUI documents and this skill in line with the
Browser Core integration (`eb6cd3e5`, `88c83655`). The facts it established, all read from the tree
at `webui` / `88c83655`:

| Claim | Evidence |
| --- | --- |
| The browser's action semantics belong to `@mavis/browser-core`, and both surfaces execute it over a `BrowserTransport` | `packages/browser-core/src/browser-transport.ts`; `src/runtime/browser/isolated-chromium/core-transport.ts`; `src/server/browser-bridge/core-transport.ts` |
| `src/client/` and `src/shared/` may not import the core; the gate enforces it | `scripts/lib/webui-dependency-rules.mjs` — the workspace-host check for `client/` and `shared/` |
| The restricted vocabulary is stated twice, and a test pins them together | `src/shared/contracts/browser.ts`; `packages/webui/test/unit/browser-restricted-commands.test.ts` |
| The bridge's `open_tab` and `upload_files` are refused; the isolated surface refuses `return_to_previous_tab` | `src/server/browser-bridge/server.ts`; `src/runtime/browser/isolated-chromium/provider.ts`; `packages/browser-extension/src/cdp.ts` (the allowlist, 45 commands, without `Page.captureScreenshot` or `DOM.setFileInputFiles`) |
| The bridge's screenshot comes from the extension's pushed visible-tab frame | `src/server/browser-bridge/server.ts` — `#captureVisibleFrame`; `packages/browser-extension/src/images.ts` |
| The three new suites' evidence levels | `packages/webui/test/integration/browser-core-agent-actions.test.ts` (real browser), `packages/webui/test/unit/browser-bridge-core-actions.test.ts` (wiring, extension as a double), `packages/webui/test/unit/browser-restricted-commands.test.ts` (pure) |

The line-number citations in `packages/webui/docs/browser-use/*.md` that this pass corrected were
verified against the tree by reading the cited line, not by pattern-matching the file name. **New
citations should be made the same way** — a citation that was not read at the cited line is not
evidence.

One capability difference is recorded but **not** pinned by a test: the bridge refuses `upload_files`.

### Refresh of 2026-10-30 — the scheduled-task surface and stale rosters

A documentation pass brought the WebUI documents and this skill in line with the scheduled-task
surface (`c4082a66`…`16678b05`) and with rosters that had been stale for several features. Read from
`webui` at `786ad138`, working tree checked before and after:

| Claim | Evidence |
| --- | --- |
| The WebUI is a scheduler host: the `scheduling` business lists, creates, edits, enables, deletes, runs now and reads run history of scheduled tasks | `src/client/features/scheduling/**`; the rail row in `client/features/sessions/ui/SessionRailRegion.tsx`; six operations registered at `server/operation/operations.ts:332-337` |
| The client reaches the v2 runtime's Cron service through the harness port, and its DTOs are the WebUI's own | `src/runtime/port.ts:725-730`; `src/runtime/harness/cron.ts`; `src/shared/contracts/cron.ts` |
| The `webui` row differs from `tui` in **thirteen** cells | `packages/local-runtime/test/unit/runtime-owner-policy.test.ts:317` — the assertion enumerates all thirteen |
| The roster is **99** bindings and **18** dedicated handlers covering **117** operation names | `packages/webui/test/unit/webui-operation-binding.test.ts:47-50` |
| Sixteen business ports cut **fifteen** slices (terminal folds into workspace, `turn` builds its own) | `src/client/application/port-slices.ts` (`WebuiPortSliceSource`, `createWebuiPortSlices`) |
| R2's restore write is guarded by `state` as well as both counters | `packages/local-runtime-v2/src/infra/scheduler/index.ts` — `updateRestoredJob` (`:794`), the `state` guard at `:814` |
| The scheduled-task evidence is seven test files at levels 1, 4 and 5 | `docs/verification/gates.md`, "The scheduled-task suites" |

**One counting trap worth keeping.** `operations.ts` has 131 `registerOperation` calls, while the
roster test pins 99 + 18 = 117. The gap is handler-entry factories (browser, Mini App, Mini App agent)
registering operations the bindings-plus-dedicated list does not name. Take the numbers from the test
and describe them in its words — "N bindings and M dedicated handlers covering K operation names" —
and do not call K "operations", because the registry is larger than K.

**Not re-verified by this pass:** every entry of `docs/known-gaps.md` (its dated record stays
2026-10-27 / `d9593276`; this pass added a note for the closed §7 and changed no entry), and the
runtime behaviour of any surface — this was a static read of source and tests.

## Refresh workflow

When using this skill, re-read current operating instructions and touched source. Refresh a reference only when changed source or an actual task reveals it is stale. Check callers, tests and decision rationale together; repository documents are navigation, not implementation proof. Never restore retired plans/generated navigation tables merely because a past memory mentions them.

For a visual refresh: inspect source/CSS changes, rebuild, run the capture helper to a new external directory, inspect original PNGs in both themes, review the manifest/errors and only then deliberately replace the skill references. Keep synthetic data labels and provenance. Rendering a new screenshot does not approve a product redesign.

The capture helper is reusable tooling. Its output should stay outside the repository; it owns an ephemeral loopback server and headless browser only. It uses existing repository Playwright and fixture code. Failure to find a build, package, browser or selector is explicit; resolve the actual mismatch rather than silently generating a fake reference image.

Hindsight knowledge search/list were attempted during creation but returned connection failures. No Hindsight page was treated as source evidence. Historical local notes helped select lifecycle and evidence-boundary questions; current code/docs/gate output supply the actual guidance here.
