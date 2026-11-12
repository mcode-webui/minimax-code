---
name: webui-development
description: Develop MiniMax Code packages/webui features, workflows, components and styles using its application ownership, loopback contracts and existing visual language. Use for WebUI implementation, structural refactoring and UI design in this repository; use dedicated audit or documentation workflows for gate-only audits and documentation-only synchronization.
---

# MiniMax WebUI development

Use the existing WebUI as the product and architecture reference. Deliver requested behavior through its
real application owners and preserve visual continuity unless a redesign is requested.

## Establish the current contract

Locate the repository from the working directory; reference paths are repository-relative. Read root
`AGENTS.md`, `packages/webui/AGENTS.md`, `packages/webui/docs/README.md` and `CONTEXT.md` — they are
authority over this skill, which is a map rather than a specification. Inspect HEAD and dirty files before
editing.

For the changed use case, identify its resource identity, state owner, command, binding, rendered surface
and verification seam, then trace one real caller before choosing a home. Directory names and a green
dependency gate do not prove ownership.

A reported symptom is diagnosed read-only first — greps, probes, decoded bundles — with findings stated
before a patch. This checkout is edited by other sessions at the same time; read
[working discipline](references/source-evidence.md) before touching a hot file.

## Read the repository document, not a copy of it

| Question | Document |
| --- | --- |
| Which layer or role owns this; what may import what | `packages/webui/docs/architecture/{module-map,boundaries,layered-model}.md`, `packages/webui/AGENTS.md` |
| Lifecycle, submission, streaming, settlement, history handoff | `packages/webui/docs/client/{ownership,submission,transcript-rendering,composer}.md` |
| Loopback operations, runtime assembly, capabilities, process resources | `packages/webui/docs/runtime/boot.md`, `AGENTS.md` |
| Which control, page surface or layout to render; tokens; motion families | `packages/webui/docs/design/design-language.md`, `packages/webui/docs/design/motion-inventory.json` |
| Gate commands and what each one rejects | `packages/webui/docs/verification/{gates,browser-suite}.md` |
| Browser actions and element references | `packages/webui/docs/browser-use/10-browser-core-integration.md` |

## This skill's own references

| Task | Read |
| --- | --- |
| Changing behavior through the real owner | [Business maintenance](references/business-maintenance.md) |
| What business code may not write, and why | [Guardrails](references/guardrails.md) |
| Split a module, or a cleanup whose bottom line is "behavior does not change" | [Structural refactors](references/module-refactor.md) |
| A display affordance: a glyph per file type, inline media, a link that renders itself | [Rendering surfaces](references/rendering-surfaces.md) |
| Settings tabs and sections, or typed filtering in a list or palette | [Registry-driven lists](references/list-surfaces.md) |
| Which checks to run, and the traps in running them | [Verification](references/verification.md) |
| CSS mechanics, media elements, measured geometry | [Visual implementation](references/visual-design.md) |
| Account quota, membership, credits or daily sign-in | [Account data](references/account-data.md) |
| Refresh this skill, or check what it did not investigate | [Source evidence](references/source-evidence.md) |

Load only the branches the task needs, and open the repository document a reference points at.

## Implement through existing seams

- Keep business state and submitted operations with their application owner: inject capability contracts,
  adapt browser effects in bindings, render snapshots and invoke named commands. Uncommitted forms and
  ephemeral presentation state stay local when that is their lifetime.
- Publish a narrow owner-role module for a real peer consumer. A `.public` suffix grants reachability, not
  authority to expose writers, teardown or another business's implementation.
- Render the shared presentation contracts in `client/ui/` instead of restating them. A business file that
  re-declares a control's class string, states, timing or pending behaviour is a contract change in the
  wrong place — [Guardrails](references/guardrails.md) states the boundary and the escape hatch.
- Keep file movement deliberate: this is a public source projection with an explicit inventory and
  upstream synchronization costs. Prefer a cohesive change in its current home over layout churn.

## Run only relevant verification

Select the smallest checks that cover the changed files and behavior; the gate map is
`packages/webui/docs/verification/gates.md`. Do not run aggregate gates or full suites by default, and do
not repeat a passing check for unchanged inputs. The latest direct user instruction overrides older
repository or skill wording that asks for broader verification. Report the checks run and the coverage
that remains; activation never authorizes publication, pushes, production changes or paid provider calls.

## Verify the flow, not just the unit

For a user-visible flow, build a scenario matrix from the real entry points before writing tests: empty
and populated, valid and invalid, loading and error, cancel/retry/recovery, selection changes,
refresh/resume, concurrent activity. Exercise the actual control for interaction claims — an injected
demo object, direct service call or helper invocation cannot stand in for a click.

Keep every claim at its evidence level: SSR markup proves content, a built-browser spec proves rendering
and interaction, a loopback test proves wire delivery, and none of them proves a real account or another
platform. Name the mocks, skips and untested boundaries in the report.

For layout or usability claims, run the built client and read computed geometry, stacking, focus,
scrolling and both themes; a passing build or a single screenshot is not usability evidence. For a
critical cross-layer path, add a narrow break-link or mutation control when practical, restore it
afterwards, and preserve valid existing tests — remove one only when behavior is retired or replacement
evidence is recorded.
