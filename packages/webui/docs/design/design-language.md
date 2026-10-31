# Design language

The WebUI's own design language: one token surface, one theme mechanism, one typographic stack, and
the layout conventions the shell follows. `src/client/styles/tokens.css` is the shipped authority for
every value; this document describes the structure around it and what `test/unit/webui-design-tokens.test.ts`
asserts.

## Token architecture

Three layers, all plain custom properties.

**1. Primitive ramps.** Ten-step ramps `--<hue>_25` … `--<hue>_1000` for `blue`, `cyan`, `gray`,
`green`, `orange`, `purple`, `red`, `yellow`, plus a single `--violet_500`, and the opacity ramps
`--opacity_black_1_*` and `--opacity_white_0_*`.

**2. Scale tokens.**

| Group | Tokens |
| --- | --- |
| Radius | `--radius_4` `_8` `_12` `_16` `_20` `_24` `_32` `_full` |
| Spacing | `--spacing_0` `_2` `_4` `_6` `_8` `_12` `_16` `_20` `_24` `_32` `_40` `_48` `_64` `_90` `_128` |
| Type size | `--size_12` `_14` `_16` `_20` `_24` `_32` `_40` `_48` `_64` |
| Line height | `--line_height_16` `_18` `_20` `_22` `_26` `_28` `_36` `_40` |
| Weight | `--weight_regular` `--weight_medium` |

**3. Semantic tokens.** 211 of them, named `<role>_<group>_<component>_<state>`:

- roles `bg`, `text`, `icon`, `border`, `utility`, `terminal`, `shadow`
- groups `default`, `grouped`, `interaction`, `label`, `status`
- states `default`, `hover`, `press`, `inactive`, `selected`, `focus`, `elevated`

Representative names: `bg_default_primary`, `bg_grouped_secondary`,
`bg_interaction_primary_hover`, `text_default_tertiary`, `text_label_danger_primary_press`,
`icon_interaction_accent_selected`, `border_status_warning`, `utility_popover`, `utility_scrim`,
`terminal_ansi_bright_magenta`, `shadow_default`.

## Theme mechanism

`:root` carries the ramps and the light values. `.light` and `.dark` each rebind the semantic tokens,
and neither block contains anything but custom properties, so either can be lifted whole. The
rebinding is a swap onto the ramps:

| Token | Light | Dark |
| --- | --- | --- |
| `--bg_default_primary` | `var(--gray_0)` | `var(--gray_1000)` |
| `--bg_default_secondary` | `var(--gray_75)` | `var(--gray_900)` |
| `--text_default_primary` | `var(--gray_1000)` | `var(--gray_100)` |
| `--text_default_secondary` | `var(--gray_500)` | `var(--gray_400)` |
| `--border_default` | `var(--opacity_black_1_8)` | `var(--opacity_white_0_8)` |
| `--utility_popover` | `var(--opacity_black_1_90)` | `var(--opacity_white_0_95)` |

Which of the two is applied comes from one derivation
(`client/features/settings/projection/settings-view.ts`); the preference is applied as a class on a
root element.

## Typography

The stack is declared in `tailwind.config.cjs`; no font file is bundled for it, so the browser
resolves system faces:

- **Sans**: `HarmonyOS Sans`, then `Segoe UI` / `SF Pro Display` and the system stack, with
  `HarmonyOS Sans SC` / `PingFang SC` for Chinese.
- **Mono**: `Hack`, then `ui-monospace` / `SFMono-Regular` / `SF Mono` / `Menlo` / `Consolas`.
- `shell.css` carries one local `ui-monospace` fallback chain for the terminal surface.

KaTeX is the only bundled font family (`src/client/assets/fonts/katex/`, 20 ttf + 20 woff + 20 woff2
+ `LICENSE.katex-fonts`), and it is bundled because `katex/dist/katex.min.css` needs it.

## Utility naming

The stylesheet is Tailwind, configured so token names become utility names: `bg-bg_default_primary`,
`text-text_default_primary`, `border-border_default`, `rounded-radius_8`, `size-size_14`,
`leading-line_height_20`, `gap-spacing_4`, `shadow-shadow_default`. Roughly a thousand token-derived
utilities appear in the compiled output alongside the ordinary layout utilities, so a component is
styled with the same names the token file declares.

## Layout

- Two columns: a left rail at roughly 18% of the width on a surface one step darker than the main
  one, and the main surface at the lightest step.
- The conversation surface is a vertical stack: generous space at the top, the centred brand welcome
  as the visual anchor, the composer low on the screen.
- The composer is a large-radius field (16–20px) with a near-invisible 1px border, a leading attach
  button, a trailing model selector, and a solid dark circular send button — the highest-contrast
  element on the screen.
- Below it, a one-step-darker capsule row carries the workspace picker and a local tag; below that, a
  row of outlined suggestion chips.
- The emphasis colour is the bright blue from the ramp, used sparingly: a link, the accent bar on a
  card, small badges.
- The model picker opens one popup with two states, and it is the only place a thinking level is
  set. The panel names the level in the accent blue above the model name, the model name opens the
  catalogue grouped by provider, and the level is a blue rail with a white thumb whose stops are the
  model's own. A white thumb on a blue rail is the only such control in the client, and it stays
  that way: a second control for the same state is a second thing to disagree with the first.
- Density is low: menu rows sit around 13–14px with 12–14px gaps, and the composer is surrounded by
  empty space.
- The settings pages share one skeleton: `client/ui/settings-layout.tsx` renders the page column
  (704px, centred), the section title, the grouped-surface card and the row, and every settings
  page — including the code-review page the settings panel shows — renders that frame instead of
  a copy of it. A settings page brings its own content, never its own frame.
- The 用量与模型 page names the account's plan, it does not name a product: the plan name, the
  model-source label and the 限额重置 section all follow the account's own answer
  (`features/settings/projection/usage-plan.ts` and `features/settings/ui/UsageResetCards.tsx`).
  A hard-coded plan name is a bug, not a default — the legacy "Token Plan" label belongs to the
  legacy `token_plan` subscription kind alone.
- The settings pages share their controls too, not only their frame: `features/settings/ui/settings-atoms.tsx`
  owns the page's button (`SettingsButton`, with a `compact` size for a row action) and its dialog
  (`SettingsDialog` — a scrim, a surface, a header and a scrolling body). A control that each page
  re-authors is a control that drifts, and the first drift of a border was four cards that read as
  four separate products inside one section.

### Responsive layout

The layout adapts to **the width it has**, not to the width of the window. The decision and its
reasoning are in [ADR 0025](../adr/0025-the-layout-adapts-to-available-width.md); this is the working
contract.

- **The surface's width is a budget.** The conversation column keeps a floor and the tool regions
  give way instead. A region that cannot have the width it wants changes form — a column into an
  overlay, a full label into an icon — and it never reserves layout width it is not using.
- **The stylesheet owns every form; a measurement selects which form applies.** The shell measures
  its main surface and reports the form; the stylesheet holds the rules for what each form looks
  like. JavaScript reports the measurement and clamps the number, and never decides what a form
  looks like — a resize handler that also decides whether a panel is a column or an overlay creates
  a second judge for the same question, and the two drift. Whether a panel is *open* is a
  different question from what it looks like: the progress panel's card is entirely the
  stylesheet's, and the client decides only whether the window has room for it.
- **A shape change is driven by the box the element is in.** A component that changes shape asks
  its own container how wide it is — the composer toolbar asks the composer card, the panel's file
  tree asks the panel, a page that is laid out inside the surface asks the surface. A viewport
  breakpoint measures the window, which is not what these elements spend.
- **An overlay reserves no width it is not using.** A floating panel that *also* takes a gutter out
  of its sibling is claiming space twice: it covers the content and narrows it. A drawer is out of
  the flow, a closed panel is zero wide, and a column takes the width it actually uses. The
  progress panel's card is the one float that keeps a gutter, and that gutter is the card's own
  room — which is why the card closes itself where there is none.
- **Two pieces of geometry that describe one relationship are derived from one number.** The rail's
  toggle and the session title were two literals for one gap; they are now two children of one
  row, so they cannot disagree.
- **A viewport-anchored overlay keeps its viewport breakpoints.** The settings modal is a `100vw`
  takeover and the model menu, the composer's menus and the provider form are fixed popups placed
  against the window: the viewport is the box they are placed against, so the viewport is the width
  they have.
- **A container confines the fixed-position descendants inside it.** A page that hosts a
  viewport-covering dialog cannot be a size container, because the dialog's scrim would be clipped
  to the page. Portalling that dialog out is what lets the page follow its own width.
- **The viewport-level breakpoints are the two that belong to the window itself.** Below 640px the
  left rail becomes an overlay drawer instead of a column, and below 1080px the progress panel's
  card closes itself rather than sit on the conversation. Nothing else in the client breaks on a
  viewport width.
- **The thresholds are one contract**, shared by the stylesheet and the resize logic:

  | Name | Width | Decides |
  | --- | --- | --- |
  | `shellCompact` | 640px | the rail's form |
  | `conversationMin` | 320px | the conversation column's floor |
  | `surfaceSplit` | 680px | the workspace panel's form |
  | `panelMin` | 360px | the workspace panel's floor |
  | `panelOverlayMax` | 560px | the workspace panel's overlay width |
  | `composerModelIcon` | 360px | the composer toolbar's model name → icon |
  | `composerPermissionIcon` | 272px | the composer toolbar's permission label → shield |
  | `progressPanelMinWidth` | 1080px | whether the progress panel may be open |

- **A split threshold is a sum, not a preference.** `surfaceSplit` is
  `conversationMin + panelMin`. A derived number cannot drift from the thing it was derived from,
  and a unit test asserts the sum. `progressPanelMinWidth` is the one threshold that is not a sum:
  the conversation could spare the card's gutter further down, but the panel closes itself instead,
  because the conversation is the thing the client is for.
- **A threshold is the smallest width at which the full form applies.** The narrow form's condition
  is therefore written one pixel below it — `360px` is `max-width: 359px` — and the unit test
  derives that complement from the threshold, so the two cannot drift apart.
- **A query condition cannot use `var()`.** The thresholds are literals in the query conditions and
  constants in `client/ui/layout-thresholds.ts`, and a unit test asserts the two agree. A threshold
  that appears only in a stylesheet is invisible to the code that has to clamp against it.
- **A column needs a floor.** `min-width: 0` on a flex child means its content may be clipped to
  nothing. It is legitimate where a parent's floor already guarantees the space, and it is the
  defect this contract removes where the column has no floor of its own.
- **The zones degrade differently.** The conversation region keeps its text readable — it truncates
  and wraps and never loses its floor. The tool regions keep their controls reachable — they
  scroll, collapse into an icon, or become a drawer. One rule for both would produce an
  unreadable reading surface or an unusable tool surface.

## Styling rules

- **One stylesheet.** `src/client/styles/index.css` is the only compiled entry; every other
  stylesheet is `@import`ed into it, including per-business CSS from `features/<business>/ui/`. Do
  not add a second `<link>` in `index.html`.
- **Business-owned styles live with the business**: `features/<business>/ui/<business>.css`. Shared
  shell and token authority stays in `client/styles/`.
- **Two stacked generations keep the *effective* declaration**, not the later block, and rules that
  differ in at-rule context (`@media`, `@container`) are conditional overrides, not duplicates. The
  compiled stylesheet's hash is expected to move when shadowed declarations are dropped.
- **CSS is compiled by `pnpm build:webui`** (or `pnpm --filter @mavis/webui build:styles` alone)
  through Tailwind + `postcss-import`; the dev server consumes the same artifact.
- **Math is rendered from marked tokens, never by scanning the DOM.** `features/transcript/ui/markdown.tsx`
  registers a marked extension that emits `katex.renderToString(...)` for `$…$` and `$$…$$`.
  `katex/contrib/auto-render` must not be introduced, and the KaTeX stylesheet must keep arriving
  through the single compiled entry rather than a second link.

## Shared controls

- **The WebUI has one shared presentation layer** at `src/client/ui/`, and ADR 0016 retained it
  deliberately. [ADR 0028](../adr/0028-the-webui-has-one-shared-presentation-layer.md) decides its
  shape and its coverage of the whole package.
- **The client is covered, not just a few controls.** Every client UI source module is classified
  against eight families — foundations; controls and form composition; navigation and selection;
  overlays; structure; surfaces and content; feedback and recovery; conversation and workspace
  interaction — and each entry carries a disposition: an existing shared contract, a newly
  adopted contract, a documented business exception, or a pending contract decision. A module may
  map to several entries with different dispositions. The machine-readable inventory lives with the
  UI gate; the family contracts live here.
- **A control enters the shared layer by contract, not by list**: two or more business callers with
  compatible semantics and states, business-independent, and one owner for its states.
- **The shared layer owns a control's applicable states; the caller owns its layout.** A difference
  between callers becomes a named variant, stays with the caller as layout, or leaves that caller
  outside the primitive with the reason recorded.
- **Each adopted control publishes its contract here**: what the primitive owns, what a caller
  states, and which differences are named variants.
- **A control is adopted by rendering its component, never by spelling its classes.** A class name
  carries no variant, no size default, no `type="button"` and no required accessible name, and it lets
  a caller re-derive the recipe the contract owns. `client/ui/` owns the class strings; a caller
  outside it that names one fails a gate. A caller that cannot use the component records why, at the
  call site and in the inventory. A control's base class states structure only — geometry belongs to a
  named size, because a floor in the base becomes a silent hazard the day a caller has to remember it.
- **The pilot starts with three surfaces**: the Models provider form, the Settings usage page and the
  Plugin MCP server form. Each is preceded by a control inventory, and that inventory is a
  deliverable, not an afterthought. Later surfaces are candidates, not authorized replacements, and
  an empty pending list is necessary but not sufficient for completion — the adopted contracts
  need their own verification.
- **Overlays coordinate through one coordinator.** `client/ui/overlay-coordinator.tsx` owns
  registration, lifetime and routing. The pure decision lives in
  `client/projection/common/overlay-order.ts` as `decideOverlayAction(layers, event)`, which selects
  one layer and one route; that layer's registered callback resolves the route into `handle`,
  `request-close`, `block` or `ignore`, without routing the same event to another layer. The
  outside-close truth table in `projection/common/outside-close.ts` and the placement geometry in
  `projection/common/` stay where they are until their callers migrate. The full rules — managed
  membership, the managed host, inertness, focus return by dismissal reason, ordering and the
  migration slice — are stated in ADR 0028; the per-surface inventory lives here.
- **Rendering integrity is checked, not assumed.** Extracting a control must not squeeze,
  deform, truncate or reflow anything, and data-driven content must still render. Each migrated
  surface is compared against its pre-migration state in both themes, over states that include the
  content extremes it can actually show — empty, one item, the maximum, and the longest label —
  because a baseline captured with short content does not prove the layout survives real content.
  Geometry assertions travel with the screenshots and are independent of them. The rules are in ADR
  0028.
- **Accessibility is checked, not asserted.** The browser suite runs `axe-core` over the enumerated
  rendered states of every migrated surface, in both themes, including open overlays and their
  portal host. New unexcepted violations fail; a narrow reviewed exception names the rule, the
  surface and state, the reason, the owner and the removal condition. A clean scan is not a
  finding of accessibility — focus, keyboard reachability, motion and announcement order are
  verified by rendered interaction checks.

## Adopted contracts

`client/ui/` holds the contracts a caller adopts by rendering its component. Each one owns a control's
applicable states and their appearance; the caller owns layout, meaning and lifetime.

### The button contract

`WebuiButton` renders a `<button>`; `WebuiIconButton` renders an icon-only button and takes the
accessible name as its `label`; `WebuiButtonLink` renders an `<a>` that looks like a button, for the
callers that navigate rather than act.

A **variant** is a whole appearance: the fill, the border, the label colour and the states that belong
to that appearance. A **size** is the geometry. They compose, and the size states no width — a
caller's layout decides how wide the control may be.

| Variant | Appearance | Paired size |
| --- | --- | --- |
| `secondary` | the filled grey action | `regular`, `compact`, `header` |
| `surface` | the fill of the surface it sits on | `panel`, `dialog` |
| `primary` | the filled call to action | `regular`, `header` |
| `muted` | the filled-but-quiet save | `regular` |
| `danger` | the destructive action | `regular`, `compact` |
| `plain` | a button the surface already styles | `regular` |
| `outline` | a hairline ring, primary label | `inline`, `inline-dense`, `inline-tiny` |
| `outline-secondary` | a hairline ring, quieter label | `inline-dense`, `inline-tiny` |
| `outline-highlight` | a hairline ring, quieter label that comes forward on hover | `inline` |
| `quiet-highlight` | no ring, quieter label that comes forward on hover | `inline`, `inline-tiny` |
| `quiet-secondary` | no ring, quieter label | `inline`, `inline-dense`, `inline-tiny` |
| `quiet-subtle` | no ring, quietest label | `inline-tiny` |
| `accent` | the filled call to action with the accent fill | `action` |
| `grouped` | the grouped pill | `pill` |

The `accent` and `grouped` appearances used to be declared by the interactions business as
`.webui-button-primary` and `.webui-button-secondary`, and the account, transcript, composer, workspace
and shell businesses rendered both. Two businesses writing the same call to action differently is the
drift ADR 0028 exists to stop, so the two appearances became the shared contract's, and the class
strings that named them are gone.

The inline sizes state no height: their callers sized the control by its label, its padding and its
border, and a stated height would squeeze the ringed ones by the two pixels their border takes.

### The other contracts

- **The menu row** — `WebuiMenuItem` and `WebuiMenuSeparator` own a `role="menuitem"` row's label, its
  icon slot, its trailing slot and its disabled state.
- **The field** — `WebuiField` owns the label, the description, the validation error and the wiring
  between them: the control is named by `for`, described by `aria-describedby` and marked invalid by
  `aria-invalid`. `WebuiFormLayout` and `WebuiFormActions` own the arrangement of a form.
- **The feedback family** — `FeedbackEmpty`, `FeedbackError`, `FeedbackSkeleton`, `FeedbackProgress`,
  `FeedbackBusy`, `FeedbackAnnouncement` and `FeedbackLiveRegion` own the announcement. The family is
  the only place in the client that authors `role="alert"`, `role="status"`, `role="progressbar"` or
  `aria-live`; a surface whose state *is* the thing being announced uses `FeedbackLiveRegion`, and a
  message with no visual form uses `FeedbackAnnouncement`.

## The eight families

`pnpm check:webui-presentation` classifies every client UI module against these eight families and
requires at least one per entry. The inventory holds the classification; the contract below is what a
module in each family owes. A module may belong to several families, and its disposition — an existing
shared contract, a newly adopted contract, a documented business exception or a pending contract
decision — is recorded separately from its families.

| Family | Covers | Contract |
| --- | --- | --- |
| foundations | tokens, typography, icons, focus, borders, layering, responsive widths, motion | Carries no business policy and no state. A value it states is stated once, and everything else reads it rather than restating it. |
| controls and form composition | buttons, fields, selection controls, disclosure, toggles, form layout and actions | The control owns its applicable states — default, hover, press, focus, disabled — and their appearance; the caller owns layout, meaning and lifetime. A field is label, description, validation error and control connected by id and ARIA. Native submission, validation, pending and dirty state, and business commands stay with the caller. |
| navigation and selection | rails, lists, rows, tabs, pickers, palettes, menus | States what is selected or where it leads, never what the destination holds. Selection is announced, not only coloured, and every item is keyboard reachable with a visible focus indicator. |
| overlays | popups, menus, dialogs, tooltips | A floating layer above the page — and nothing else; a pinned session is a **pin**, never an overlay. A managed overlay participates in coordinated dismissal, focus or stacking and therefore registers with `client/ui/overlay-coordinator.tsx` instead of running its own Escape listener; a surface that only borrows `role="dialog"` for labelling is not thereby managed. |
| structure | the shell, pages, panels, headers, columns, dividers, split panes, scroll affordances | Owns the frame — header slot, body, explicit scroll boundary — and never the content's lifetime. The panel is a family; the content page is a pattern to assess against two actual pages, and shared visual values alone do not prove it. |
| surfaces and content | the settings pages, catalogues, settings rows, previews, usage views | Owns the surface's own data, its states and its business composition, and names the states it can show. The content extremes — empty, one item, the maximum and the longest label — are part of what it must render. |
| feedback and recovery | banners, notices, empty states, errors, skeletons, busy and progress indicators, status | Says one thing per surface: an empty collection says it is empty; an error is perceivable and associated with the control or operation it belongs to; progress shows real progress where progress exists; a busy indicator is distinguishable from a progress bar; a dynamic message is announced once. |
| conversation and workspace interaction | the transcript, the composer, the workspace panels and the turn controls they render | Keeps its ADR 0022 and ADR 0025 owners and layouts; the package-wide obligations — focus, accessible name, motion, contrast — apply here exactly as they do elsewhere. |

## Assets

- `client/assets/img/` holds the marks and illustrations the shell, the settings pages and the
  account panel use; `client/assets/lottie/` the animated ones; `client/assets/fonts/` the bundled
  font family.
- Assets and styles in this package are authored here and reviewed as part of this repository's
  licence audit (`LICENSE-STATUS.md`, `release/dependency-licenses.json`).
- A new or renamed asset must reach `release/public-source.json` (`node scripts/source-inventory.mjs
  --write`, then `pnpm check:source`), and any new third-party asset needs its licence recorded in
  `release/dependency-licenses.json`. When an asset is added, keep a source→destination filename
  manifest beside it: a count is not a check, since two images can share a byte count.
