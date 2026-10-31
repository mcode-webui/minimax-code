# Business-code maintenance

Use this procedure when changing WebUI behavior or structure. Paths beginning with `src/` are relative to `packages/webui/`. Current repository/package instructions remain authoritative; [architecture.md](architecture.md) maps owners and import rules, [ownership.md](ownership.md) defines temporal contracts, and [runtime.md](runtime.md) covers wire and host details.

## Locate the change before editing

1. Identify the user-visible behavior being changed and an observable completion condition. For a bug, distinguish intended behavior from current behavior; for a refactor, name the behavior/contracts to preserve.
2. Trace the existing surface or public caller to its binding, command, owner and capability. Search real importers and tests, not only filenames or documentation. Identify who stores the truth, who may mutate it, and what lifetime it has.
3. Choose the change type below. State the intended homes briefly for a substantial change; ordinary local choices do not need a separate approval round. If the requested change conflicts with an approved decision or changes scope, resolve that decision before the dependent edits.

Before the first behavioral edit, know the owner/command, response-affecting identity and affected consumers. A style-only edit need not invent an application workflow.

## Put each responsibility in its home

| Responsibility being added | Home | Placement decision |
| --- | --- | --- |
| Business component | `src/client/features/<business>/ui/<Component>.tsx` | Choose the business owning its behavior/resource, not whichever page happens to host it |
| Business component CSS | Same business's `ui/<business>.css` | Follow [component design system](component-design-system.md); imports flow through `styles/index.css` |
| Business decision, workflow, command or resource owner | Same business's `application/` | Receive capabilities; own operation outcomes and invalidation |
| Capability/command/read-model declaration | Same business's `contracts/` | Expose the narrow contract the consumer needs |
| Pure policy or view derivation | Same business's `projection/` | Classify policy-bearing basenames in `PROJECTION_DOMAIN` when required |
| React subscription or browser effect | Same business's `bindings/`, or the established shared binding | Adapt to React/browser; business decisions remain in the owner |
| Business-independent presentation primitive | `src/client/ui/` | Extract for actual reuse; it must not depend on a business |
| Composition of existing business surfaces | `src/client/shell/` | Compose already-owned surfaces and commands |
| Named application-wide use case or owner wiring | `src/client/application/` | Coordinate existing owners without duplicating their mutable truth |
| Browser IO adapter | `src/client/platform/` | Adapt browser APIs or concrete transport; inject capabilities into application code |
| Shared lifecycle mechanism | `src/client/conversation/` | Generalize only mechanics with real shared consumers; keep business interpretation out |

Add a new business only when it has distinct resource/policy ownership that existing businesses cannot cohesively own. Create needed role directories only; there is no feature registration list to invent. Keep existing layout stable unless moving responsibility is part of the task.

## Modify an existing feature

1. Change the rule where it is owned: owner/command for business behavior, projection for pure shaping, binding for browser adaptation, component/CSS for presentation. Extend existing commands rather than adding a second path with independent state.
2. Preserve the command's actual contract: success/refusal/failure values, absent-capability handling, captured input and invalidation obligations. If the contract must change, inspect and update every producer, consumer, adapter and fixture that depends on it.
3. For async behavior, capture the operation's resource/tab/session identity before awaiting. Check selection, request generation, freshness, owner incarnation, deletion and disposal where they affect this operation. Reuse established primitives rather than adding a view-local request counter to conceal an owner issue.
4. Connect the rendered consumer to the same owner snapshot and named command. Remove an old path only after its consumers have moved; preserve unrelated user changes. A component refresh must not bypass cache policy with a direct fetch or a generic store clear.
5. Exercise the changed outcome and affected ordering/lifetime cases, then run applicable gates from [verification.md](verification.md). Finish with behavior and evidence, not merely a list of edited files.

Inspect the touched leaf's real implementation: application-level disposal does not prove all its owners fence pending work. Repair a gap required by the task explicitly; do not assume a guide's architectural intent is already universal behavior.

## Add a component or new business behavior

For a presentation-only component, reuse its business's read model/commands and existing shared controls. Keep uncommitted forms and ephemeral display state local when appropriate. Select tokens, geometry and interaction states from [component-design-system.md](component-design-system.md) before styling.

For new business behavior, start from its command and resource contract, then implement the owner, wire the injected capability, add/update the binding and render it. Do not create directories or abstractions for stages that are unnecessary. When remote capability is needed, complete the operation path in [runtime.md](runtime.md); when an existing capability suffices, reuse it.

Define pending, empty, error, unavailable and completion behavior as applicable. Register new owners/resources with the actual construction/start/release/dispose path. Check operation survival when the view unmounts or selection changes. Add public exports only for identified consumers, and register new tests/files using the repository's suite and source-inventory rules.

## Change a cross-business use case

Identify which business owns each decision and which owner writes each result. Inject a peer's published command/intent/read contract through existing composition. The initiating owner can choose when to call it; the peer keeps its writer and teardown.

Use an explicitly named application use case when a cohesive operation genuinely spans owners, as task/session creation does. It coordinates their commands and committed outcome rather than collecting their stores into another central service. A `.public` marker makes a module reachable subject to other rules; it does not make every export appropriate or grant cross-business write authority.

Check both import legality and the caller's knowledge: if a consumer must reconstruct another owner's admission, freshness, state-transition or cleanup protocol, move that responsibility behind the owning command rather than distributing the protocol across callers.

## Refactor without changing behavior

Define the ownership/dependency improvement first. Keep behavior-preserving movement distinguishable from contract/behavior corrections so each has reviewable evidence. Change cohesive responsibilities rather than splitting by arbitrary file size.

For a move, repoint all resolved importers, including relative and type-only edges; remove obsolete forwarding shims and review inventory changes. Compare behavior at the public command/consumer seam. Use AST, wire or effective-CSS comparisons when those contracts need preservation, as described in [verification.md](verification.md). Passing import checks alone does not establish preserved behavior or improved cohesion.

## Maintain WebUI runtime code

Choose the actual responsibility before editing `src/runtime/`:

| Runtime change | Edit and preserve |
| --- | --- |
| Map a host capability to WebUI | `runtime/port.ts` plus matching `runtime/harness/<domain>.ts`; DTOs stay in `shared/contracts/`, validators/dispatch stay server-owned |
| Add/change a wire operation | Canonical spec → descriptor/validation → binding or dedicated handler → registry → port/adapter → client slice/command and affected tests; follow [runtime.md](runtime.md) |
| Construct a process resource | `runtime/assembly.ts` wires it; its module encapsulates behavior; `runtime/lifecycle.ts` or the established resource owner handles close/startup failure |
| Change credentials/login/tools/browser-provider lifetime | Inspect acquisition, refresh/watch, successful close and partial-startup failure together; retain errors and ensure each acquired resource is released |
| Change terminals | Preserve service-owned PTYs and independent browser watches/xterm attachments; only explicit process disposal or service shutdown ends the process |
| Change host events or readiness | Trace actual producer and decoder, regenerate host-event catalog when needed, and update capability prerequisites/consumers without inventing support |

Read `docs/runtime/boot.md` and `owner-identity.md` for changed host policy. Retain `webui` identity and current startup/permission/questionnaire contracts. Assembly wires dependencies; it must not accumulate domain state machines or become a duplicate harness. Server admission, framing and browser selection state do not move into runtime for convenience.

Test new cleanup on both successful shutdown and failure after partial acquisition. Verify changed capability mapping through real loopback with a controlled leaf when appropriate; production-host/native changes need their corresponding seam. Do not spend on a live provider or claim another platform without authorization/evidence.

## Prohibited shortcuts

| Do not | Use instead |
| --- | --- |
| Fetch business data or write generic stores directly from UI | Owner command and subscribed read model |
| Create business owners, permanent business event routes or independent business polling in a mounted presentation | Existing application/session composition and observation ownership |
| Copy session/resource truth into a second mutable map | Canonical owner plus projections or identity-keyed resources |
| Import another business's private implementation | Narrow owned contract or deliberate published surface |
| Hand a peer generic writers or teardown through a public module | Named business intent/command with retained ownership |
| Import React/DOM/storage/concrete transport into pure application/projection code | Inject values/capabilities and adapt browser effects in their proper homes |
| Cross browser→Node, server→runtime implementation, or import TUI implementation | Browser contracts, shared DTOs and the harness port/adapter |
| Turn page/view detach into host abort or PTY destruction | Separate observation cleanup from explicit execution/process commands |
| Add gate exceptions, drop supported behavior, or relax validation/admission just to pass checks | Fix the actual ownership/contract violation; preserve explicit failures |
| Hide failed or absent capability behind empty/default-success data | Existing typed outcome/error and appropriate disabled/error UI |
| Add a new palette, control family or stylesheet entry for a local component | Existing semantic tokens, recipes and stylesheet ownership |
| Hand-edit generated catalogs/inventory or preserve old paths with forwarding barrels | Regenerate reviewed artifacts and update real importers |

Apply these to the task's affected behavior; they do not authorize an unrelated cleanup sweep.

## Ready for delivery

Confirm that the requested outcome has one authoritative command/write path, new files have correct homes, peer APIs expose only intended authority, and affected async/resource cleanup is accounted for. Run relevant declared checks once for the actual inputs and record remaining boundaries. Update the behavior-owning docs and affected development guidance; use `webui-docs-sync` for a broader synchronization when needed. Keep implementation, source inspection, fixture/browser evidence and live/platform verification distinct.
