# Business-code maintenance

Use this procedure when changing WebUI behavior. Paths beginning with `src/` are relative to
`packages/webui/`. Repository documents are authority: `docs/architecture/module-map.md` for roles and
homes, `docs/design/design-language.md` for presentation, `docs/client/` for lifecycle, `docs/runtime/` for
the host boundary. [Guardrails](guardrails.md) is the list a diff must not violate;
[module-refactor.md](module-refactor.md) covers structural work and [list-surfaces.md](list-surfaces.md)
covers settings and filterable lists.

## Locate the change before editing

1. Name the user-visible behavior and an observable completion condition. For a bug, separate intended from
   current behavior; for a refactor, name the contracts to preserve.
2. Trace the surface or public caller to its binding, command, owner and capability using real importers
   and tests, not filenames. Identify who stores the truth, who may mutate it, and what its lifetime is.
3. Before the first behavioral edit, know the owner, the command and the affected consumers. A style-only
   edit does not need to invent an application workflow; a substantial change states its intended homes.

## Put the responsibility in its home

Each business keeps five roles: `contracts/` (its published surface), `application/` (owners and
workflows), `projection/` (pure derivations), `bindings/` (React subscriptions and browser effects) and
`ui/` (presentation). Directory-to-role rules, the shared homes (`client/ui`, `shell`, `application`,
`platform`, `conversation`, `projection/common`) and what each may import are in
`packages/webui/docs/architecture/module-map.md` and `boundaries.md`; the dependency gate enforces them.

Add a business only when it has distinct resource or policy ownership that no existing business can hold.
Create the role directories it needs — there is no registration list to edit — and keep the existing layout
stable unless moving responsibility is part of the task.

## Modify an existing feature

Change the rule where it is owned: owner/command for behavior, projection for pure shaping, binding for
browser adaptation, component or CSS for presentation. Extend an existing command instead of adding a
second path with independent state.

Preserve the command's real contract — success, refusal and failure values, absent-capability handling,
captured input, invalidation obligations — and update every producer, consumer, adapter and fixture if it
must change. For async work, capture the operation's resource, tab and session identity before awaiting,
and check selection, request generation, freshness, owner incarnation, deletion and disposal through the
established primitives rather than a view-local counter.

Remove an old path only after its consumers have moved, and never let a refresh bypass cache policy with a
direct fetch or a generic store clear. Inspect the touched leaf's implementation: application-level
disposal does not prove its owners fence pending work. Then run the checks in [verification.md](verification.md).

## Add a component or a new behavior

For presentation only, reuse the business's read model and commands, keep uncommitted forms and ephemeral
display state local, and choose tokens and states from `docs/design/design-language.md`. A business file
that restates a shared control's class string, states or timing is [guardrails](guardrails.md)' first
presentation row.

For new behavior, start from the command and resource contract, then implement the owner, wire the injected
capability, update the binding and render it. Define pending, empty, error, unavailable and completion
behaviour; register new owners on the real construction/start/release/dispose path; check that the
operation survives the view unmounting or the selection changing.

## Change a cross-business use case

Decide which business owns each decision and which owner writes each result. Inject a peer's published
command or read contract through existing composition: the initiating owner decides when to call it, the
peer keeps its writer and teardown. When a cohesive operation genuinely spans owners, use a named
application use case that coordinates their commands — not a central service collecting their stores.

If a consumer would have to reconstruct another owner's admission, freshness, transition or cleanup
protocol, the responsibility belongs behind the owning command.

## Maintain runtime code

`src/runtime/` maps host capabilities to the client: `port.ts` declares the boundary and
`harness/<domain>.ts` implements it, DTOs stay in `shared/contracts/`, and validators and dispatch stay
server-owned. `assembly.ts` wires process resources and must not accumulate domain state machines;
`lifecycle.ts` owns close ordering and startup-failure recovery. Read `docs/runtime/boot.md` for changed
host policy, retain the `webui` identity and current startup contracts, and test new cleanup on both
successful shutdown and failure after partial acquisition.

## Ready for delivery

Confirm one authoritative command/write path for the requested outcome, correct homes for new files, peer
APIs that expose only intended authority, and accounted async/resource cleanup. Run the declared checks
once for the actual inputs, record remaining boundaries, and update the behavior-owning doc. Keep
implementation, fixture evidence and live-platform verification distinct in the report.
