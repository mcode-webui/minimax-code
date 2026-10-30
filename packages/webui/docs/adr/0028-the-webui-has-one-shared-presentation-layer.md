# The WebUI has one shared presentation layer, and every surface is classified against it

**Status:** Accepted.
**Date:** 2026-10-30.

The WebUI groups its client code by business, and it has a shared presentation home,
`src/client/ui/`, that ADR 0016 deliberately retained. The client has shared tokens and some shared
presentation, while other controls, surfaces, feedback and motion are authored independently and can
drift. This ADR defines the criterion for what enters that home, the coverage of the whole package,
and the mechanism by which overlays coordinate. Extraction preserves existing appearance; it is not
a client re-skin or a Tailwind migration.

## Coverage and admission

The shared layer has four cooperating concerns — **foundations** (tokens, typography, icons, focus,
borders, layering, responsive widths, motion, reduced motion), **interaction primitives** (buttons,
fields, selection, disclosure, overlays, navigation semantics), **compositions and states** (field
groups, form parts, modal and non-modal surfaces, rows, cards, feedback, loading, empty and error
states, toolbars) and **structural patterns** (shell, content and settings pages, panels, headers,
columns, dividers, split panes, scroll affordances) — and eight families to classify: foundations;
controls and form composition; navigation and selection; overlays; structure; surfaces and content;
feedback and recovery; conversation and workspace interaction.

**Coverage is an adoption obligation, not a claim a gate can prove.** Module discovery is the guard:
every client UI source module — a file under a feature's `ui/`, the shell, or the shared `ui/` —
must map to one or more reviewed surface or concern entries, or carry an explicit non-surface
disposition. A module may hold several surfaces with different outcomes, and one surface may span
modules. The UI gate must fail on an unclassified new module, a stale entry or an invalid
disposition. It cannot detect a surface added inside an already classified module, nor prove that
every runtime state has been found; a change inside a classified module therefore requires review,
and completion is confirmed by a separate coverage review.

Every entry carries one disposition: an existing shared contract, a newly adopted contract, a
business-specific documented exception, or a pending contract decision. **Inventory complete is not
unification complete** — a pending disposition is a valid classification and a sign that the
programme is unfinished.

The admission criterion governs **shared implementations** — not tokens, not package-wide
accessibility and motion obligations, and not the duty to classify every surface. Otherwise the
two-business rule would license leaving a family unexamined. A control enters `src/client/ui/` when
two or more business callers use it with compatible semantics and states, it is business-independent
— no business policy, no business state, no wire operation, no write authority — and one owner can
write its states once. Two callers are an evidence threshold, not proof. The home is flat, and no
`*.public.tsx` marker is used there, because the dependency rules classify that directory as
businessless. The shared layer owns a control's applicable states and their appearance; the caller
owns layout, meaning and lifetime. A difference between callers becomes a named variant, stays with
the caller as layout, or leaves that caller outside the primitive with the reason recorded.

## Shared contracts

**Form composition.** The shared unit is a **field** — label, description, validation error and
control, connected by id and ARIA — plus shared form layout and action patterns. Native submission,
validation, pending and dirty state and business commands stay with the caller. A settings row and
a stacked provider form are two arrangements of the same field, not the same form.

**Structural patterns.** Three patterns are named. The **settings page** already exists and is used
today by the settings, review and browser businesses, which is evidence that a shared page frame
works in this client, though not that a generic one does. The **content page** — title and action
region, column and spacing, scroll only where its contract requires it — is a pattern to assess:
two actual pages must be able to share title and action semantics, column sizing against available
width, padding and scroll ownership, including narrow viewports, without changing keyboard order,
nested-scroll behaviour or business lifetimes, and shared visual values alone do not prove
compatibility. The **panel** — header slot, body, explicit scroll boundary — is a family. The
application shell, workspace and transcript keep their existing owners and layouts under ADR 0022
and ADR 0025, and the package-wide obligations below apply to them as well.

**Motion.** Motion becomes package-wide foundations: duration and easing tokens, named transition
families — feedback, surface enter and exit, disclosure, loading — and a reduced-motion policy.
Existing durations and keyframes are inventoried against the named families; compatible effects
adopt shared values or transitions, and justified distinct effects remain documented. A timing value
that JavaScript and CSS both read has one source.

**Accessibility.** Every keyboard-focusable element has a visible focus indicator when focused, and
every control for which an accessible name applies has one; every dialog is labelled; every error is
perceivable and associated with the relevant control or operation, and a dynamic error is announced
without duplication. Decorative and intentionally hidden elements stay out of the accessibility tree.
These are obligations on every surface, not shared components, and they are not gated by the
admission criterion. Focus treatment needs a package-wide contract and rendered keyboard
verification: a rule that suppresses an outline does not by itself prove that focus is invisible, and
an idle-state screenshot cannot see a missing indicator.

**Adoption.** A contract is adopted by rendering its component, never by spelling its classes. A class name
carries no variant, no size default, no `type="button"` and no required accessible name, and it lets a caller
re-derive the recipe the contract owns; the classes remain an implementation detail of `client/ui/`. A migration
that renames classes is not a migration of the caller, and a gate fails when a `.tsx` file outside the shared home
names a shared control's class. A caller that cannot use the component records why, at the call site and in the
inventory. The base class of a control states structure only: geometry belongs to a named size, because a floor in
the base is a hazard once the caller has to remember it.

## Overlay coordination

**Here *overlay* means a floating layer above the page** — a popup, a menu, a dialog or a
tooltip, and nothing else. The word used to carry a second meaning, the durable pin the
browser stores for a session or a project; that sense is now **pin** everywhere (see
§ Further Notes · One word, one thing).

The client's overlays are not one topology — some portal into `document.body`, some render inline
inside the app tree, and some files render both — and several features run independent Escape
listeners, so the client needs one coordination order rather than one per surface.

**Managed membership.** A surface is managed when it participates in coordinated dismissal, focus or
stacking. A surface that uses the shared `Dropdown` is managed through Dropdown's contract whatever
the caller calls it; a surface that only borrows `role="dialog"` for labelling is not thereby
managed. Every participating surface either uses the managed contract or carries a reviewed,
inventoried exception stating its interaction boundary, and an exception is not evidence that
nesting it inside a managed surface is safe.

**The coordinator.** One presentation-scoped coordinator, `client/ui/overlay-coordinator.tsx`, owns
registration, lifetime and routing. Its provider is instantiated once per client document by shell
composition. Registration is ephemeral and the caller remains authoritative: the coordinator
registers presentation facts and requests actions. Routing is a pure function —
`decideOverlayAction(layers, event): OverlayDecision` in
`client/projection/common/overlay-order.ts` — over descriptors carrying id, parent id, order,
active state and dismissal policy, and event facts carrying the event kind and the ids of layers the
press landed inside, never DOM nodes. The result names one layer and one route; the layer's
registered callback then resolves that route into `handle`, `request-close`, `block` or
`ignore`, and it does not route the same event to another layer. The DOM capability the
coordinator needs — capture-phase listeners, focus, the portal host, inert operations — belongs to
`client/platform/browser-dom.ts`.

**Escape.** One document-level listener routes an Escape to the topmost active managed layer. One
event selects at most one active layer, and an `ignore` result does not automatically route that
event to an ancestor; a non-modal layer that deliberately lets a key reach its own content says so in
its own contract, which is not a reroute to another overlay. The coordinator issues at most one
action per event, ignores IME composition and repeated keydown, and leaves native behavior alone when
no managed layer claims the key. A layer that answers `handle` is how a popup steps from its list to
its panel without closing, and `block` is how a non-dismissible modal consumes the attempt without
the Escape reaching an ancestor.

**Outside pointer.** One capture-phase pointerdown dispatcher evaluates the topmost interactive layer
against its registered surface, trigger and additional inside regions, including registered
descendant portals. A press inside the top layer or its descendants does not dismiss it; a press
outside a dismissible top layer requests the dismissal of that layer only; a press outside a
non-dismissible modal is consumed rather than dismissing an ancestor, and that modal's background
protection prevents the subsequent activation as well. A non-modal layer lets the original event
continue and the coordinator never synthesizes a second event — but a closing layer must not
intercept the click that follows its own dismissal, so a leaving layer is non-interactive. The
pointerdown → pointerup → click sequence is tested.

**Modality, focus and ordering.** A managed modal renders into a managed host outside the app root,
registers its logical parent, and makes the application background and the managed layers outside its
own subtree inert while it is active; a nested modal additionally inerts its parent until it closes,
prior inert values are restored when layers close, and a managed modal may not silently fall back to
inline rendering inside an inert root. Opening a modal moves focus to its designated initial target,
or to the labelled dialog surface, and while it is active keyboard focus remains within that modal
and its registered descendant overlays. Focus restoration is decided by dismissal reason and the
actual post-transition focus: an Escape or an explicit close requests restoration after closure and
the inertness update; an outside pointer normally does not restore, so the clicked control receives
focus; when the opener is gone, the caller supplies a fallback in the active parent or a logical
successor. Focus that has deliberately moved is never overridden, and a teardown that is not a real
close restores nothing. A layer closing with an exit animation stops receiving dismissal events
immediately, but a closing modal keeps its background protected until it is safe to expose the
background, and reopening during the exit cancels the stale cleanup.

Managed overlays share a base band; order inside that band is assigned by the coordinator from active
parentage and presentation order, not by a fixed species order — a dropdown inside a dialog is above
its parent, and a confirmation is a nested modal rather than a permanently superior kind. Each
modal's scrim sits immediately below its surface, and an interactive announcement may not bypass an
active modal's focus containment. The visual values live with the shared styling authority and the
ordering lives with the coordinator, so no numeric scale is maintained twice.

**Migration.** The first slice is one complete nested path — the memory manager dialog with its menu
and its confirmation, together with `Dropdown` gaining coordinator registration — migrated
atomically. During coexistence, `Dropdown` gains an explicit managed path for the complete migrated
subtree while legacy instances keep their existing behavior until their own paths migrate; the
compatibility path is removed once the inventory is complete, and no global single-listener
behavior is claimed during that period. The model picker's internal ladder and the user menu follow
with their existing semantics; the rest migrate by inventory. Until a path is migrated, coexistence
is a known limitation, and the one-dispatcher invariant is not enabled for a mixed path.

## Rendering integrity after extraction

Extracting a control into the shared layer must not change what a surface renders or how it lays
out. Every migrated surface is compared against its pre-migration state on the states it enumerates,
in both themes, and the comparison must show that:

- **no element is squeezed** — a control does not shrink below the size its content needs, and a
  shared control carries no fixed width or height that a caller's layout cannot satisfy;
- **nothing is deformed or reflowed** — a control keeps its geometry, the column around it keeps its
  width, and neighbouring elements do not shift;
- **nothing is truncated or clipped** — text and content that was visible before the migration is
  still visible, and a control that must not clip says so rather than silently overflowing or
  hiding it;
- **data still renders** — lists, counts, names, timestamps, diffs, badges and empty states appear as
  before, and a shared control that renders a data-driven collection renders every item it is given.

Because a shared control is reused across surfaces, the comparison is per surface and per enumerated
state, and a surface's states include the **content extremes it can actually show**: an empty
collection, one item, the maximum number of items, and the longest label or name it can display. A
baseline captured with short content does not prove that the layout survives real content, so a
migration verified only against representative content is not verified.

Geometry assertions accompany the screenshots and are independent of them: an element is present, is
not zero-sized, lies inside its container and the viewport, and its content is not clipped. A pixel
difference of zero can still hide a squeezed element, and a screenshot cannot see a missing focus
indicator. The verification is therefore three lines — the screenshot comparison, the geometry
assertions and the accessibility scan — and none of the three proves the others.

## Adoption and verification

Business commands, lifetimes and state stay with the business that owns them. A migrated surface may
not introduce a second implementation of a contract the shared layer owns; the existing
`IconButton` and `SettingsButton` are evaluated and adapted rather than copied.

Enforcement is a bounded ratchet over inventoried and migrated scopes, with reviewed exceptions: no
element selector on a raw form control in an in-scope file; feature styles may not redefine
primitive-owned appearance or states, while supported caller-owned layout goes through the documented
layout interface; no retired legacy class still declared; and no prohibited inline control recipe,
where an expression the UI gate cannot classify also fails unless a reviewed exception covers it.
Its rules must have negative fixtures, and each rule's scope must be named so that a stylesheet
serving both migrated and unmigrated surfaces is not caught wholesale.

Accessibility is verified by an automated scan plus rendered checks. The client adopts a
browser-side accessibility rule engine (`axe-core`) with the browser suite, so that every migrated
surface is scanned in its enumerated rendered states, in both themes, including open overlays and
their portal host; the rule set and the dependency version are pinned. A **new unexcepted violation
fails the browser accessibility check**. A narrow reviewed exception is permitted only when it names
the rule, the affected surface and state, a stable target or other bounded identity, the reason, the
owner and the removal condition; new matching findings outside that target fail, and a stale
exception is rejected once the finding disappears. An exception records known debt or a justified
false positive; it does not make the surface accessible. A clean scan does not establish
accessibility, because the result depends on the enabled rules, the rendered state and the scan
scope; an incomplete finding requires a recorded manual review and disposition, and an unresolved
applicable finding prevents claiming that state's accessibility review complete. Content the scan
cannot inspect, such as an iframe's document, is reported as a boundary rather than implied covered.
Keyboard reachability, focus containment and return, motion, announcement order and real interaction
are verified by rendered checks, not by the scanner.

Evidence has two lines and neither is complete. The UI gate must fail on the scoped patterns it
checks; it does not detect every cascade override, and a class selector can still restyle a raw
control. The repository's screenshot baselines are a bounded oracle — before and after comparisons in
both themes, within the existing pixel budget, for the states a surface enumerates. A comparison
does not prove the cascade, and it does not prove that the layout survived the extraction — the
rendering integrity rules above are checked separately.

## Consequences and follow-up

- The client uses shared control, form, surface, motion, structural and accessibility contracts
  where applicable, with documented business-specific exceptions.
- The pilot is the first adoption slice, not the programme: the Models provider form, the Settings
  usage page and the Plugin MCP server form, each preceded by a control inventory. Later surfaces are
  candidates, not authorized replacements, and an empty pending list is a necessary but not
  sufficient condition for completion: the adopted contracts and the accessibility obligations need
  their own verification.
- Detailed contracts, the per-family inventory, the overlay truth table and the adoption order live in
  `docs/design/design-language.md`; the machine-readable inventory lives with the UI gate that
  reads it.
- Moving motion timing is a deliberate and visible change, accepted on its own evidence, separately
  from the rule that static appearance is preserved.

## One word, one thing

*Overlay* means a floating layer above the page, and nothing else. The word used to
carry a second meaning — the durable pin the browser stores for a session or a
project — and the two senses lived in the same code: the rail's pin state was
called `use-session-rail-overlays`, while every popup in the client is an overlay in
the sense this record uses.

**The decision: the floating-layer sense keeps the word, and the pinned sense is
called a pin.**

The evidence for the choice is in the client, not in taste:

- the floating-layer sense is carried by the geometry and placement modules every
  popup uses (`dropdown-placement.ts`, `overlay-order.ts`, `overlay-coordinator.tsx`);
- the pinned sense was already called a pin wherever it was *named* rather than
  *typed*: `rail-menu.ts` reads `pinned`, `session-workflows.ts` emits
  `{ kind: "pinned" }`, and the UI says 置顶;
- so the word "overlay" was the outlier for pins, not the rule.

The rename is carried through the code: `use-session-rail-pins.ts` and its types and
methods (`WebuiSessionPinKind`, `WebuiRailPinStorage`, `readSessionPins`,
`toggleSessionPins`), the shell hook that calls them and the platform storage adapter
that satisfies them. The persisted keys are unchanged — they are the contract with
earlier builds, not this record's to rename.

**Avoided synonyms** for the pinned sense: overlay, bookmark, favourite, star, dock.
"Pinned" is the word in the rail, the menu and the workflow event, and a second word
for it would put the collision back.
