---
name: webui-gate-audit
description: Audit whether scripts/ WebUI verification gates still match the current architecture, source, tests, package scripts, and CI. Use for read-only reviews of gate currency, scope, consistency, and coverage; not for product architecture implementation.
---

# WebUI gate audit

Review the repository's WebUI gates against the checked-out implementation. The deliverable is a source-grounded assessment of which rules are current and useful, which are stale or misaligned, what architecture they cover, and where their guarantees stop.

## Operating scope

- Treat an audit request as read-only unless the user separately asks for repairs. Preserve the existing worktree state.
- Inspect a gate's implementation before running it. Run only checks that are read-only and do not require generating or rewriting artifacts; inspect generated-artifact-dependent checks without rebuilding unless asked.
- Do not run tests, builds, formatters, generators, or `pnpm verify` as part of a read-only audit unless the user explicitly requests execution. Report what was inspected separately from what was executed.
- Do not infer a gate's effect from its name, a green historical report, or documentation alone. Current code and current test registration are the evidence.

## Audit workflow

1. **Establish the checkout.** Confirm repository root and inspect `git status --short`. Read the root `AGENTS.md`, `CONTRIBUTING.md`, `packages/webui/AGENTS.md`, and `packages/webui/docs/README.md`. Preserve unrelated changes and keep review material outside the repository.

2. **Load current architecture authority.** Follow the WebUI documentation index to the architecture design and relevant boundary/ownership/runtime documents and ADRs. Read the verification gate guide. When repository Hindsight is available, search and read relevant decision pages; treat them as historical context and verify every relied-on claim in the current tree. If Hindsight is unavailable, continue from current source and say so only if material.

3. **Inventory the gate chain.** Search all of `scripts/` for WebUI-specific checkers, shared rule modules, constants, baselines, generators, and verification helpers. Trace registrations through `package.json`, `scripts/verify.mjs`, CI workflows, `test/vitest-suites.json`, and the tests that exercise each rule. Include related typecheck, build, package, browser, and source-inventory gates when they form part of the WebUI verification chain. Distinguish executable gates from retired tools mentioned only as history.

4. **Trace claims into implementation.** For each gate, follow the CLI entry to the rule implementation and identify its actual input: source AST/import graph, compiler program, build output/metafile, package artifact, registered tests, or another input. Record ordering and generated-artifact dependencies. Check that tests reach the production rule and cover meaningful allowed and rejected cases; do not equate a test name or fixture assertion with coverage of the intended invariant.

5. **Compare the rules with architecture.** Keep separate dimensions separate: execution layer/dependency direction, role and business ownership, publication visibility, lifecycle/state ownership, runtime/wire boundaries, and packaging/publication. Check whether path classification matches current layout; whether the evaluated rule matches the declared matrix; whether exceptions are narrow, fingerprinted or stale-checked; whether same-layer edges, aliases, type-only imports, dynamic imports, generated inputs, and indirect workspace imports are treated as intended. Inspect the evaluator rather than hand-reading a matrix when behavior depends on code.

6. **Classify findings.** Use these labels where helpful:
   - **STALE** — a path, command, exception, or claim no longer exists or describes a retired state.
   - **MISATTRIBUTED** — a real guarantee is assigned to the wrong gate or evidence layer.
   - **DRIFT** — the implemented rule conflicts with current architecture decisions or source layout.
   - **GAP** — an architecture invariant has no effective enforcement or meaningful acceptance evidence.
   - **OVERLAP** — multiple gates duplicate a rule without a clear purpose or source of truth.
   - **UNVERIFIED** — the evidence needed to decide is unavailable or was not executed.

7. **State the guarantee boundary.** Explain what the complete gate chain constrains and what remains behavioral, platform-specific, live-service, or dependent on manual review. Static dependency compliance does not by itself prove complete use-case ownership, correct resource lifetime, race handling, or product equivalence. Do not upgrade source inspection or unit evidence into browser, native, cloud, or cross-platform acceptance.

## Evidence and reporting

- Cite every material finding with verified `path:line` references from the current checkout. Prefer concise evidence chains such as command registration → checker → rule → rule test.
- Separate **confirmed**, **inferred**, and **unresolved** conclusions. Note if artifact-dependent checks were inspected but not executed.
- Report the scope searched, gates inspected, any read-only checks actually run and their results, prioritized findings, and a concise judgment of whether the chain provides the requested level of architecture consistency.
- Do not propose arbitrary gate additions based on file counts or directory aesthetics. Tie every recommendation to a specific architecture invariant and a demonstrable failure mode.
- Keep the audit read-only. If the user asks to fix documentation or gate code, make only that authorized scope change after presenting or recording the concrete evidence; validate the changed scope and preserve all unrelated work.
