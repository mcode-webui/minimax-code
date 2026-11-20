# Guardrails

The rules whose violation is a defect even when every gate is green. Each row exists because the tempting
shortcut moves a decision out of its owner, or creates a second definition of a contract that already has
one. `packages/webui/docs/architecture/` and `docs/design/design-language.md` own the reasoning; this file
is the short list to check a diff against.

Some rows are enforced by a gate and some only by review. "The battery passed" is not permission for the
second kind — the gates that do exist are named in `docs/verification/gates.md`.

## Ownership and structure

| Do not | Use instead |
| --- | --- |
| Fetch business data or write generic stores directly from a mounted UI | The owner's command and a subscribed read model |
| Create a business owner, a permanent business event route or independent polling inside a presentation component | Existing application/session composition and observation ownership |
| Copy session or resource truth into a second mutable map | The canonical owner plus projections or identity-keyed resources |
| Import another business's private implementation, including a peer's `application/` module | A narrow published contract, or values derived from its published owner |
| Hand a peer generic writers or teardown through a `.public` module | A named intent or command that keeps ownership with the peer |
| Import React, DOM, storage or a concrete transport into `application/` or `projection/` | Injected values and capabilities, with browser effects adapted in `bindings/` |
| Cross browser→Node, server→runtime, or import TUI implementation | `shared/contracts/` DTOs and the harness port/adapter |
| Turn page/view detach into a host abort or PTY destruction | Separate observation cleanup from explicit execution and process commands |
| Hide a failed or absent capability behind empty/default-success data | The typed outcome or error, with disabled or error UI |
| Add a gate exception, drop supported behavior or relax validation to pass a check | Fix the ownership or contract violation; keep explicit failures explicit |
| Hand-edit generated catalogs, inventories or a tsconfig path map | Regenerate the reviewed artifact and update the real importers |

## Presentation

| Do not | Use instead |
| --- | --- |
| Name a shared class string in a feature `.tsx` (`webui-mavis-button*`, `webui-field*`, `webui-feedback*`, `webui-motion*`, …) | Render the component from `client/ui/` |
| Re-declare a shared control's states in a feature stylesheet | Report the missing variant; the contract grows it |
| Write a local duration, easing, `@keyframes`, inline motion style, `animate-*`/`duration-*`/`ease-*` utility, interaction transform or `scroll-behavior: smooth` | `WebuiMotion`/`WebuiMotionSlot`/`WebuiDisclosure`; `bindings/browser-effects.ts` for programmatic scrolling |
| Hand-roll `role="button"` on a `div`, or a dialog, popup or floating layer outside the coordinator | `WebuiButton`, `WebuiDialog`, `WebuiDropdown`, then classify the layer in `scripts/lib/webui-overlay-inventory.json` |
| Author `role="alert"`, `role="status"`, `role="log"`, `role="progressbar"` or `aria-live` yourself | The `Feedback*` family; the per-file announcement budget is a ratchet |
| Write pulse keyframes or a bespoke skeleton animation | `WebuiSkeleton` / `FeedbackSkeleton` — one pulse, one reduced-motion policy |
| Draw an interface glyph as inline SVG paths, CSS shapes, pseudo-elements or text characters (`→`, `✓`, `+`) | A Tabler glyph through the shared wrapper |
| Read `document` or `window` in a `client/ui/` or feature-`ui/` module | `useWebuiBrowserCapabilities().dom`, or a binding |
| Use native `<details>` for a disclosure, SVG `<animate*>`, or the Web Animations API | `WebuiDisclosure`, `WebuiMotion` |
| Disable a control by hand while its command runs, or draw a local spinner | `loading` / `loadingLabel`, or a promise-returning `onClick` — the control owns its pending state |
| Rename a raw-element selector to a shared class string so the ratchet passes | Adopt the component; the renaming is a separate recorded job |
| Add a one-off palette, font, gradient, shadow or radius | Semantic tokens and the existing scales |

## The escape hatch

A difference only one caller has is that caller's layout — width, margin, placement, arrangement,
truncation. Anything beyond that follows this order:

1. **Two or more callers need the same appearance** → a named variant or size on the shared contract, added
   in `src/client/ui/` and documented in `packages/webui/docs/design/design-language.md`. A caller never
   keeps a private copy of the recipe while the contract grows a variant.
2. **One-off the shared layer genuinely cannot express** → a `business-exception` entry in
   `scripts/lib/webui-presentation-inventory.json` with its reason and revisit condition, plus a comment at
   the call site.
3. **A new floating layer** → an entry in `scripts/lib/webui-overlay-inventory.json`: `managed` when it
   registers with `client/ui/overlay-coordinator.tsx`, `borrows-role` when it only uses `role="dialog"` for
   labelling, `exception` with its interaction boundary stated when it cannot join.
4. **A new effect** → a `distinct` entry with its reason in `packages/webui/docs/design/motion-inventory.json`.
   The approval for a feature-owned effect comes from a decision record, not from the gate.
