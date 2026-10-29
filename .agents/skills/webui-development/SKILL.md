---
name: webui-development
description: Develop MiniMax Code packages/webui features, workflows, components and styles using its application ownership, loopback contracts and existing visual language. Use for WebUI implementation, structural refactoring and UI design in this repository; use dedicated audit or documentation workflows for gate-only audits and documentation-only synchronization.
---

# MiniMax WebUI development

Use the existing WebUI as the product and architecture reference. Deliver requested behavior through its real application owners and preserve visual continuity unless a redesign is requested.

## Establish the current contract

Locate the repository from the working directory; the original checkout is `/home/fectivnfy/my_data/project/my_project/minimax-code`. Reference paths are repository-relative. Read root `AGENTS.md`, `packages/webui/AGENTS.md`, `packages/webui/docs/README.md`, and relevant terms in `CONTEXT.md`. Inspect HEAD and dirty files before editing. This skill is a source-grounded map, refreshed 2026-10-26, not an authority over current instructions, source or tests.

For the changed use case, identify its resource identity, state owner, command, binding, rendered surface and verification seam. Trace one real caller through implementation before choosing a home. Directory names and passing dependency gates alone do not prove ownership. If an explicitly approved design conflicts with the tree, surface that conflict before redesigning it.

For business-code changes, follow [Business maintenance](references/business-maintenance.md): choose the change type, locate the owner, implement through its command and lifecycle, and verify the affected consumer. It includes component placement, prohibited shortcuts and runtime maintenance.

## Load the relevant reference

| Task | Read |
| --- | --- |
| Find code, choose an owner, judge imports, structural refactor | [Architecture and source map](references/architecture.md) |
| Browser actions, element references, the external browser bridge | [Architecture and source map](references/architecture.md) and [Loopback and runtime](references/runtime.md) — the semantics live in `@mavis/browser-core`; start from `packages/webui/docs/browser-use/10-browser-core-integration.md` |
| Session creation, send/queue/retry, streaming, async reads, disposal | [Ownership and lifecycle](references/ownership.md) |
| Wire operations, runtime assembly, capabilities, process resources | [Loopback and runtime](references/runtime.md) |
| Add a component or modify component styles/icons | Read [Component design system](references/component-design-system.md) first: token selection, scales, component recipes, Tabler icon usage and state rules |
| Theme, assets, layout, CSS compilation or visual verification | [Visual development](references/visual-design.md); screenshots there are optional context, not the design specification |
| Tests, build, packaging, verification claims or delivery | [Verification and delivery](references/verification.md) |
| Refresh the skill or check the investigation's limits | [Source evidence and refresh](references/source-evidence.md) |

Load the branches the task needs. Repository documents linked there provide detail; verify the particular implementation rather than treating a copied rule as proof.

## Implement through existing seams

- Keep business state and submitted operations with their application owner. Inject capability contracts; bindings subscribe and adapt browser effects; UI renders snapshots and invokes named commands. Local uncommitted forms and ephemeral presentation state can remain local when that is their established lifetime.
- Publish a narrow owner-role module or contract for a real peer consumer. A `.public` suffix grants reachability, not authority to expose writers, teardown or another business's implementation.
- Reuse request/freshness and session-interest mechanisms when results outlive selection or mounting. Capture operation identity before awaiting; preserve navigation, deletion, incarnation and newer-input fences.
- For UI work, apply the component design system: semantic color roles, shared type/spacing/radius scales, existing control recipes, the Tabler icon library and complete interaction states. Reuse an existing primitive when available; do not draw interface icons yourself. Keep business-private styles with their business. Inspect the result in both themes; screenshots assist verification, while source tokens and component contracts define the design.
- Keep file movement deliberate: this is a public source projection with an explicit inventory and upstream synchronization costs. Prefer a cohesive change in its current home over layout churn.

## Run only relevant verification

Follow the current `packages/webui/AGENTS.md` gate map and select the smallest checks that cover the
changed files and affected behavior. Do not run aggregate gates or full WebUI suites by default. The
latest direct user instruction overrides older repository or skill wording that asks for broader
verification; run a full gate only when the user explicitly requests it. Report the checks run and
the coverage that remains. Activation never authorizes publication, Git pushes, production changes
or paid/live-provider calls by itself.

## Verify complete business flows and usability

For a user-visible WebUI flow, build a source-grounded scenario matrix before writing tests. Trace
each user-reachable entry point and primary control through its real owner, command, service or
transport, runtime consumer, persisted state, and final rendered result where those layers apply.
Include material state combinations such as empty/populated, valid/invalid, loading/error, cancel/
retry/recovery, selection changes, refresh/resume, and concurrent activity. Cover every flow in the
approved plan or request; do not stop at the named examples if the current UI exposes more actions.

Prefer tests that prove a user outcome over tests that mirror implementation details. Exercise the
actual browser control for interaction claims: click the button, submit the form, change the tab,
select the option, or use the keyboard path the user uses. An injected demo object, direct service
call, reducer assertion or helper invocation cannot stand in for that interaction. Keep useful unit
tests for local contracts, but label their evidence boundary accurately.

For end-to-end or integration claims, preserve the real WebUI client/input and production service /
transport / runtime adapter / persistence path through an observable rendered or persisted outcome.
Use isolated temporary workspaces and stores, synthetic files and local origins. Deterministic local
model stubs may control output and timing; they must not replace the path under test. Explicitly
identify mocks, stubs, skips, environment gates, and any live/native boundary that remains untested.

For layout and usability claims, run the built Chromium client and inspect the actual rendered DOM,
computed geometry, responsive or constrained viewport behavior, overlay placement/stacking, focus
and keyboard operation, scrolling, and representative screenshots for the states affected. A passing
build, selector count or screenshot alone does not prove usability. Assert that dialogs remain
overlays, controls stay visible and reachable, labels align with fields, and actions produce the
expected user-visible result. Review screenshot diffs before accepting Linux CI baselines.

For critical cross-layer paths, add a narrow break-link or mutation negative control when practical:
the target flow should fail if input is dropped, a stream is not projected, persisted state is not
restored, a runtime update is not rendered, or a browser control does not reach its service. Restore
only the mutation introduced for that check and rerun the target flow. Preserve valid existing tests;
remove one only when behavior is retired or replacement evidence is demonstrated and recorded.
