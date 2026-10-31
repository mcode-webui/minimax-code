---
name: webui-docs-sync
description: Synchronize WebUI documentation, its AGENTS.md and the webui-development skill with current source, tests and approved decisions, including development guidance and component design standards. Use for documentation or skill drift and existing plan-status updates; not for implementing product changes or choosing a new architecture direction.
---

# WebUI documentation sync

Keep the WebUI documentation and development skill useful as guides to the checked-out implementation and approved development direction. Make documentation and skill-instruction changes only unless the user separately asks for product-code or tooling work.

## Workflow

1. **Establish the checkout and scope.** Read repository `AGENTS.md` and `CONTRIBUTING.md`, inspect `git status`, and preserve unrelated edits. Follow the publication rules for this public projection: review every added or moved path, and regenerate `release/public-source.json` for file-set changes. Content-only edits to existing documents do not require inventory regeneration.
2. **Load the WebUI map.** Read `packages/webui/AGENTS.md`, `packages/webui/docs/README.md` and [webui-development](../webui-development/SKILL.md). Follow their indexes to the relevant architecture, client, runtime, design, verification, gap, ADR, and skill references. Read `packages/webui/docs/agents/domain.md` and the relevant `CONTEXT.md` entries when domain terms or decisions are involved.
3. **Scan the full documentation set.** Enumerate `packages/webui/docs/**/*.md`, `packages/webui/AGENTS.md` and `.agents/skills/webui-development/**/*.md`, then search across them for duplicated claims, old paths, removed capabilities, stale command names, counts, dates, baselines, test evidence, and contradictory wording. Include development guidance, component recipes, design-token choices and existing approved plan status. Use the indexes to find related pages, but do not limit the scan to pages directly named by the request.
4. **Check claims against the current tree.** Trace architecture and lifecycle claims to their implementations; check contracts against their producers and consumers; check gate claims against scripts, package commands, suite declarations, and the tests that exercise them. Use documentation and prior decision memory as navigation and historical context, not as proof of current behavior. When project decision memory is available, inspect relevant entries and verify them against the checkout.
5. **Separate current behavior from decision history.** Keep dated rationale recognizable as historical. Update stale status and implementation claims when the decision remains relevant. When a decision is no longer in force, follow the WebUI documentation index's retirement rule instead of leaving a superseded decision presented as current. If the code and an ADR conflict in a way that requires a new product or architecture decision, surface the conflict rather than silently choosing one in prose.
6. **Make the smallest complete documentation update.** Edit every affected document that owns or duplicates the changed fact, including the index, operating guide and development skill references identified below. Update the skill's entrypoint routing when its references or applicability change. Prefer one authoritative explanation with links over repeated copies. Preserve source paths and verification boundaries precisely; distinguish unit, assembled, loopback, built-browser, native-host, platform, and live-service evidence.
7. **Validate the documentation change.** Run `git diff --check`; verify relative links and referenced paths in the changed pages; search again for the stale claim across both package docs and the development skill. For skill changes, follow the available skill-creator validation workflow and check entrypoint routing. Verify named design tokens against `tokens.css`, utilities against `tailwind.config.cjs`, and component recipes against their actual TSX/CSS. Do not run product tests for prose-only edits unless the repository provides a documentation-specific check or the change affects executable examples. Do not assume a documentation-only CI profile applies to `packages/webui` or `.agents/skills`; check the current classifier and verification rules. If adding, moving, or deleting files, regenerate and check the source inventory.

## Synchronize development guidance and design standards

Treat `.agents/skills/webui-development/` as part of the maintained guidance, not a frozen source-reading snapshot. For each consequential correction, check whether a future agent following that skill would still make the right implementation or styling decision. Update the affected references in the same synchronization pass.

| Changed fact or decision | Development skill references to inspect | Evidence to read |
| --- | --- | --- |
| How to modify business code, place components, coordinate owners or maintain runtime resources | `references/business-maintenance.md`, relevant `SKILL.md` routing | Current owner/caller paths, operating rules, lifecycle implementations and approved decisions |
| Business homes, dependency direction, public surfaces | `references/architecture.md`, relevant `SKILL.md` guidance | Real importers, owner modules and dependency-rule implementation |
| State ownership, submission, resource identity or lifetime | `references/ownership.md` | Commands, producers/consumers, leaf-owner implementations and corresponding tests |
| Wire contracts, capability availability or runtime resources | `references/runtime.md` | Operation declarations/registration, bindings, adapters and close paths |
| Tokens, typography, spacing, radii, shared controls or interaction states | `references/component-design-system.md` | `src/client/styles/tokens.css`, `tailwind.config.cjs`, reused TSX primitives and effective component CSS |
| Theme application, layout, CSS compilation, assets or visual acceptance | `references/visual-design.md` | Theme effects, stylesheet imports, compiler configuration, affected surfaces and available rendered evidence |
| Verification commands, test conventions or delivery requirements | `references/verification.md` | Package scripts, suite declarations, gate scripts and current operating instructions |
| Source anchors, baseline limitations or reference-refresh instructions | `references/source-evidence.md` | The particular claim's current evidence; preserve dated execution records as dated records |

Paths in the evidence column beginning with `src/` are relative to `packages/webui/`.

Keep component standards immediately actionable: an agent adding or restyling a component should find semantic token choices, type/spacing/radius scales, reusable controls and state treatments without reconstructing them from page screenshots. Update a recipe when its underlying implementation changes; distinguish observed implementation, recommended defaults and approved future requirements. Do not generalize a legacy declaration or one component's dimensions into a universal rule.

For development planning, update existing approved scope, sequencing, prerequisites, open decisions and implementation status where the repository records them. Keep planned, implemented and runtime-verified states distinct. Source establishes what exists; an approved plan establishes intended work. Do not mark an unmet requirement complete because guidance now describes it, or silently rewrite an approved direction to match the implementation. Propose or request a decision when reconciliation requires choosing new scope or behavior; this sync does not authorize a new plan, product implementation or restoration of retired planning documents.

Screenshots are optional supporting evidence. Do not regenerate the visual catalog merely because token or prose guidance changed. If an affected screenshot is retained as a current reference, either refresh it through an authorized capture workflow and inspect the result, or identify its dated scope. Keep capture scripts unchanged unless tooling work is separately requested.

## Completion report

Summarize the documents and development-skill references reviewed and changed, the source or test evidence used for consequential corrections, and the checks actually run. State whether development guidance, component design standards or existing plan status needed updates; if none did, say what was checked. Mark unverified runtime or platform behavior explicitly. Do not describe a static source inspection as runtime verification.
