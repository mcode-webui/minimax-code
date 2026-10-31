# WebUI tests follow user workflows and state evidence honestly

**Status:** Accepted; implementation is pending.
**Date:** 2026-10-22.

The WebUI test strategy will cover the complete user-reachable product surface across focused unit,
browser and integration suites. It will connect representative critical workflows from the input
controls through the built browser client, loopback service, production runtime path and isolated
session storage, using deterministic local model stubs by default. External providers, accounts,
OAuth flows and paid model calls are excluded from default gates. Existing browser and integration
tests remain part of the strategy: each is inventoried and kept, corrected, strengthened, or retired
only on evidence.

## Decision

1. **Cover every user-reachable surface and operation.** The inventory includes all WebUI pages,
   controls, menus, dialogs, keyboard and pointer interactions, navigation, session operations,
   settings and workspace panels. Coverage is organized as one representative end-to-end journey
   plus focused workflows for feature areas; it is not limited to the examples in this ADR.
2. **Exercise important state transitions.** For each applicable operation, cover normal completion,
   loading, empty or unavailable states, refusal or error, cancellation and retry, concurrency or
   queueing, and refresh or session-switch restoration. Do not multiply every state across unrelated
   features; select combinations where a real ownership or lifecycle boundary can fail.
3. **Use three complementary evidence layers.**
   - Unit and contract tests pin pure state transitions, validation, serialization and protocol
     contracts.
   - Browser tests run the built client in Chromium and verify real DOM behavior, geometry and
     representative screenshots for stable layouts.
   - Integration tests exercise actual WebUI boundaries and the production runtime/session-store
     path. Deterministic local stubs may stand in for nondeterministic model output, while browser
     interaction, streaming, persistence and rendering continue through real application code.
4. **Use isolated synthetic state.** Tests use temporary workspaces and session stores, synthetic
   files and local origins. They do not read, mutate or commit user sessions or account data.
5. **Keep external live-service checks separate.** Online providers, OAuth, paid model execution,
   and account-backed services do not run in default CI. Existing environment-gated real Chrome,
   Edge, packaged-client and external bridge checks remain separate and must identify the boundary
   they prove.
6. **Audit before expanding.** Inventory current tests by user operation, evidence layer, path
   exercised, and observable assertion. Detect stale expectations, omitted suite registration,
   test fixtures that bypass the behavior under test, assertions that do not detect a broken outcome,
   skipped cases, and misleading green gates. A skipped or environment-gated test is reported as
   unproven for that run, never counted as executed coverage. Use targeted break-link or mutation
   checks on critical edges.
7. **Preserve valid tests.** Existing tests are retained where their contract remains valid. Drifted
   tests are corrected; weak but useful tests are strengthened; redundant tests may be consolidated
   only when equivalent coverage is demonstrated. A test is removed only when its behavior is
   retired or its coverage is replaced and the reason is recorded. Synthetic browser tests remain
   useful for deterministic presentation and interaction coverage and are not mislabeled as runtime
   integration evidence.
8. **Repair issues found by the full requested gates.** Run `pnpm test:webui` and
   `pnpm test:webui-browser`; repair reproducible product regressions, test drift and false-green
   conditions found in those runs. Report environment failures separately and do not reinterpret
   them as product behavior.
9. **Record durable policy here and operational details in verification docs.** This ADR owns the
   strategy and trade-offs. `docs/verification/gates.md` and `docs/verification/browser-suite.md`
   will be synchronized with the implemented gate structure and evidence boundaries. A glossary
   change is unnecessary unless implementation exposes a genuinely new domain term.

## Mandatory workflow scenarios

The main workflow must exercise these user-visible paths end to end, with assertions at each
meaningful transition and on the final persisted/rendered result:

- Send a message from the composer and receive a streamed Agent reply, including its reasoning
  events, ordered transcript messages and review/diff card where applicable.
- Start `/plan` and `/goal` flows through the composer, observe their state and resulting session or
  goal behavior.
- Use `@` references and attach a file; verify the selected reference or attachment reaches the
  runtime request with the intended identity/content metadata.
- Queue another message while a response is streaming; verify ordering and eventual delivery.
- Exercise Agent Ask User, submit the answer, and verify the same turn continues.
- Refresh during or after a response and switch sessions; verify transcript order, stream recovery,
  and session identity remain correct.
- Copy/fork a conversation into a new session and verify the new session's identity and content.
- Observe environment, progress and todo changes from a running Agent in the right-side panel.
- Operate the embedded browser controls and navigation while an Agent response and todo updates are
  in progress; assert both browser state and progress-panel state update in the correct session.

These are minimum shared-flow requirements. The surface inventory adds all other reachable
operations and applicable state branches, including sessions and rail, model selection, permissions,
settings, account, plugins and MCP, terminal, file/workspace tabs, browser controls, menus, keyboard
shortcuts, errors, cancellation and empty/unavailable states.

## Why this approach

Pure tests are fast and precise but cannot prove that browser input reaches the runtime or that a
refreshed session restores the right transcript. Browser tests prove layout and real browser
interaction, but a browser fixture that supplies its own messages cannot prove runtime behavior.
Integration tests bridge that gap when they use the real client/service/runtime/session-store path;
a local model stub makes those tests deterministic while preserving the application boundaries
under test. Live-provider tests add cost and external variability, so they are opt-in evidence rather
than a prerequisite for every change.

Keeping current tests and auditing them avoids throwing away established regression evidence. The
test inventory makes their actual reach explicit, so suites with similar names are not assumed to
prove the same thing and synthetic data cannot silently stand in for a real runtime path.

## Consequences

- New test files must be registered in `test/vitest-suites.json` when they use Vitest.
- Every added, moved or deleted file, including test files, screenshots and this plan, must be
  reflected by `node scripts/source-inventory.mjs --write` and verified with `pnpm check:source`.
- Critical end-to-end coverage must assert observable effects across boundaries, not merely the
  presence of selectors, test IDs, or expected fixture strings.
- Browser tests use the repository's Playwright harness and built client; representative screenshot
  baselines are committed for stable layouts, generated and checked on the Linux CI browser
  environment, and supplement DOM and geometry assertions where visual layout is the behavior under
  test. Build the client before running this gate.
- Integration reports identify which boundaries are real and which leaf dependency is stubbed.
- Report executed, skipped and environment-blocked cases per gate; skip status is not a pass for the
  behavior that case was intended to prove.
- CI retains quick deterministic gates and separates slower or environment-dependent browser/host
  checks according to the existing verification architecture.
- The implementation plan will maintain a surface-to-test map and a record of existing tests kept,
  corrected, strengthened, consolidated or replaced, along with the evidence for each disposition.

## Deferred implementation detail

The exact file-by-file test map, gate split, screenshot baseline locations and scenario ownership are
implementation details to be established from the current test inventory. They do not change the
decisions above. The implementation must not start until the `.plan` document is reviewed for
coverage, repository-policy compatibility and unresolved choices.
