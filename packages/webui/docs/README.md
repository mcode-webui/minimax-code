# WebUI technical documentation

The reference set for `packages/webui`: a browser client and the loopback service in front of the
process-local harness layer. Every document here describes **the code as it stands**. Where a
statement and the tree disagree, the tree wins and the statement is a bug in this directory.

Nested directories group documents by subject. The files at this level are the ones that describe the
package as a whole: this index, the current gaps and open questions, and the release procedure.
Verification lives in its own directory and is listed in [State of the package](#state-of-the-package)
below.

## Authority order

1. **The source and its tests.** `packages/webui/src` and `packages/webui/test` (unit, integration,
   browser and gate suites) establish executable behavior. Verify documented behavior against them;
   an ADR or prose page does not override the current implementation.
2. **Decisions.** [`adr/`](adr/) records the rationale and intended constraints. Treat a decision as
   current only where the source still implements it; update or retire records when that intent changes.
3. **This directory.** Description, reference material and open items, kept aligned with the source.

`packages/webui/AGENTS.md` sits beside this directory and is the *operating* guide — commands, gates,
conventions and the edit order for common changes. Read it before changing code; read this directory
when you need to know what the system is. For structural work, read the architecture design and its
facets as directed there. The repository glossary is `CONTEXT.md` at the repository root.

## Architecture

| Document | Owns | Read it when |
| --- | --- | --- |
| [`architecture/design.md`](architecture/design.md) | The architecture design as a whole: system context, the constraints behind it, the four boundaries, the process model, ingress, the operation contract, the browser application, state ownership, the invariants a change must preserve | **Start here** for any structural work |
| [`architecture/layered-model.md`](architecture/layered-model.md) | The four execution boundaries and how a request travels from the browser to the harness | You need to know which layer a change belongs to |
| [`architecture/module-map.md`](architecture/module-map.md) | Where code lives: client roles and businesses, runtime, server, shared | You are looking for a module's home |
| [`architecture/boundaries.md`](architecture/boundaries.md) | The dependency and ownership rules, the role checks, and the generated artifacts | You are judging whether an import edge is legal |

## Client

| Document | Owns | Read it when |
| --- | --- | --- |
| [`client/ownership.md`](client/ownership.md) | Businesses, roles, application lifetime, interest leases, generation and freshness fences | You are changing client state, ownership or a business workflow |
| [`client/submission.md`](client/submission.md) | Creation origins, guarded adoption, the submission decision and completion vocabulary | You are touching send, queue, goal submission or session creation |
| [`client/composer.md`](client/composer.md) | The Composer's per-field contract | You are changing the input area or its state |
| [`client/floating-surfaces.md`](client/floating-surfaces.md) | The shared dropdown skeleton: the surface, the motion, the dismissal, the anchor and the placement rules | You are adding a menu, a panel, a list or a fly-out |
| [`client/transcript-rendering.md`](client/transcript-rendering.md) | Markdown rendering contracts: highlighting, line numbers, file references, math | You are changing transcript markdown |

## Runtime

| Document | Owns | Read it when |
| --- | --- | --- |
| [`runtime/boot.md`](runtime/boot.md) | Boot order, close order, the process resources, and the service entries | You are changing assembly, credentials, quota, terminal or shutdown |
| [`runtime/harness-boundary.md`](runtime/harness-boundary.md) | `WebuiHarnessPort`, the adapters, and the roster that must agree with the operation registry | You are adding or removing an operation |
| [`runtime/owner-identity.md`](runtime/owner-identity.md) | The `webui` runtime-owner row and what each differing cell means | You are changing how the client identifies itself to the harness |

## Design

| Document | Owns | Read it when |
| --- | --- | --- |
| [`design/design-language.md`](design/design-language.md) | Tokens, themes, typography, utility naming, layout, styling and asset rules | You are touching styles, marks or bundled assets |

## State of the package

| Document | Owns | Read it when |
| --- | --- | --- |
| [`verification/gates.md`](verification/gates.md) | The gates, what each proves, the evidence levels, and the comparison methods | You are about to claim work is verified |
| [`verification/browser-suite.md`](verification/browser-suite.md) | The built-client browser suite: fixture, determinism, server behaviour | You are changing or debugging `test/browser/` |
| [`known-gaps.md`](known-gaps.md) | Capabilities the WebUI does not have, verified against the tree | Something looks missing and you want to know whether it is known |
| [`browser-use/`](browser-use/) | The Browser Use validation evidence: the capability matrix, the bridge protocol, the extension admission rules, the pairing credentials, the target identity, the runtime authorization trace, and the review record | You are changing a browser contract, or you want to know what was measured and what is still open |
| [`open-questions.md`](open-questions.md) | Decisions deliberately left to the operator | You are about to pick a behaviour nobody has picked |
| [`releasing.md`](releasing.md) | The npm preview release of `@fectivnfy112358/minimax-code-web` | You are changing packaging or the publish workflow |

## Reference

| Document | Owns | Read it when |
| --- | --- | --- |
| [`reference/plugin-action-inventory.md`](reference/plugin-action-inventory.md) | The 29 plugin-management actions and their owning business. Read by `plugin-action-inventory.test.ts` | You are touching the plugin port, its actions or its callers |

## Decisions

[`adr/`](adr/) holds the architecture decision log. The numbering is the decision order, so the
highest number is the newest. ADR 0014 fixes the four internal boundaries; ADR 0016 (business-first
modules, application-owned lifetimes) and ADR 0017 (temporal ownership) describe the client as it
stands; ADR 0018 records the last ownership programme and the observation decision (whose evidence is
[`adr/observation-architecture.md`](adr/observation-architecture.md)). ADR 0010 sets the build
(esbuild artifact, Vite as dev server only); ADR 0011 lets the WebUI re-implement TUI projection
logic against a shared harness-event corpus. ADR 0019 records the accepted Browser Use surfaces and
the decisions and remaining design questions for Browser Use. ADR 0022 records the workspace panel as
a browser tab strip and the two selections it separates, and amends ADR 0019 with **A8**; between
them they are the decision record for that feature. ADR 0020 records the accepted Mini App view, the runtime seams it needs, the
desktop capabilities it deliberately drops, and the contract-baseline question it leaves open; it
is the sole decision record for Mini App hosting. ADR 0021 records the model picker as one popup
with two states, and the cascade it replaces. ADR 0024 records the client-side workspace boundary
for a diff body: a diff entry outside the workspace keeps its name and its counts and loses its
content, the boundary is lexical, and a diff whose workspace root the client does not know is not
withheld. A new decision takes the next free number.

| Retired | Was | Why it is not in the log | Where the live facts are |
| --- | --- | --- | --- |
| 0008 | The first version assembles the full tool capability set | Its claim that the first version ships the same tool capabilities as the terminal client is no longer true: the mcode-tools integration sits behind a beta feature and Browser Use is optional | [`runtime/boot.md`](runtime/boot.md), [`known-gaps.md`](known-gaps.md) |
| 0009 | A decision that the WebUI's design language is taken from another application | The design language is the WebUI's own and is documented as such | [`design/design-language.md`](design/design-language.md) |
| 0012 | The WebUI runs its own scheduled tasks until the runtime offers one | Reversed: the whole WebUI-owned scheduler was deleted on 2026-10-09 | [`known-gaps.md`](known-gaps.md) §7 |
| 0015 | The WebUI client is organized by business within its existing layers | Superseded by ADR 0016's business-first homes; the layer-first paths it describes did not survive | [`architecture/module-map.md`](architecture/module-map.md) |

A retired record stays in git history rather than in the log: a decision that is no longer in force
would otherwise read as current.

## Working in this repository

| Document | Owns | Read it when |
| --- | --- | --- |
| [`agents/issue-tracker.md`](agents/issue-tracker.md) | Where issues and specs live, and the `gh` conventions for them | You are filing, reading, labelling or closing an issue |
| [`agents/triage-labels.md`](agents/triage-labels.md) | The five triage roles and their label strings here | You are applying or reading a triage label |
| [`agents/domain.md`](agents/domain.md) | How the engineering skills consume this repo's glossary and decisions | You are exploring the codebase with a skill |

## Not here

- **Operating rules and commands** — `packages/webui/AGENTS.md`.
- **Decisions and their rationale** — [`adr/`](adr/), with the retired records listed in the Decisions section.
- **Browser-test harness details** — [`verification/browser-suite.md`](verification/browser-suite.md).
- **The repository glossary** — `CONTEXT.md` at the repository root.

## Retired documents

Planning, migration and audit documents for this package were removed once their work landed: each
had become a false statement about the current tree (a plan still saying "implementation has not
started" after the implementation shipped, a ledger still naming pre-migration paths), and repository
policy keeps review material and verification reports outside the tree. What survives is here, in
[`adr/`](adr/), and in git history — the `webui` branch's commits of 2026-09-21 through 2026-10-19.

Retired: the TUI-harness migration plan and its review brief, the runtime-layer plan, the client
identity plan, the business-reorganization and cohesion plans with their ledgers (substrate matrix,
composer disposition, contract re-file, baseline conformance), the architecture review plan, the
architecture spec, the decision record, the development board and its ticket manifest, the v1 scope,
the pending-decision list, the capability-gap investigation and the large-file decomposition plan.

The ownership refactor's acceptance-evidence report was removed for the same reason once it had been
superseded: it recorded one run's outputs and results, which is execution material rather than
durable guidance about the tree. What a reader needs from it — which gate proves what, and at which
evidence level — is [`verification/gates.md`](verification/gates.md).

Two generated indexes were retired with them, together with their generators and gates: the
exported-declaration surface (`pnpm check:webui-commands`) and the business-navigation table that
was written into `packages/webui/AGENTS.md` (`pnpm check:webui-business-navigation`). Neither was
read by any test or script — each only compared its own output with the committed copy. A symbol's
home is found by search or the language server, and the businesses are the directories under
`client/features/`.
