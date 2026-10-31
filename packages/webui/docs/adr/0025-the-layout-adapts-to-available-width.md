# The layout adapts to the width it has

**Status:** Accepted and implemented.
**Date:** 2026-10-27.

The WebUI's shell stops measuring the browser window and starts measuring **the space each part
actually has**. Every shape change answers to one **threshold contract** — a small set of named
widths that CSS and JavaScript share, so a number that decides a form in the stylesheet is the
same number the resize logic clamps against.

Two things answer to the window rather than to a container, and they are the two that span it: the
left rail, which below **640px** becomes an overlay drawer instead of a column, and the progress
panel's card, which is anchored to the window's right edge and closes itself below **1080px**
rather than sit on the text it is meant to report on.

The contract has one idea behind it:

> **The surface's width is a budget. The conversation column keeps a floor and the tool regions
> give way instead. A region that cannot have the width it wants changes form — a column into an
> overlay, a full label into an icon — and it never reserves layout width it is not using.**

That last clause is the one two earlier drafts of this decision got wrong, in opposite directions,
and the difference between them is what the rest of this document is about.

## Why the window is the wrong ruler

The report that started this was that dragging the right-hand workspace panel, or resizing the
window, made the interface squash. The squashing was real, and it had **three separate causes**
that had been read as one:

- The panel's drag floor was an absolute `360px` that did not subtract the width the conversation
  column needed, so a narrow window spent its width on the panel and left the conversation column
  nothing.
- The drag wrote the panel's size as an **inline style**, which outranked the `≤1080px` stylesheet
  rule that was supposed to cap the panel as an overlay. The panel could therefore cover more than
  half of a narrow window.
- The panel's width was clamped **only while the pointer was moving**. Narrowing the window after a
  drag never re-clamped it, so the squeeze it created stayed for the rest of the session.

Underneath all three sat one more fact: the conversation column had `min-width: 0` and no floor,
and so did most of its descendants. A flex child with `min-width: 0` is a declaration that its
content may be clipped to nothing, and in a column of such children the narrowest one decides how
much survives.

A viewport media query could not have found any of this. It measures the window, but the workspace
panel and the conversation column share the space **left over after the 240px rail** — a gap of one
rail's width between what the query measures and what the layout spends.

## The defects the earlier drafts of this decision introduced

The first version of this decision fixed those three causes and then introduced a fourth, which
the report that followed it described exactly: from 1024px the composer broke, the top buttons
overlapped the session title, and the progress panel on the right never changed.

The measurements behind that report are worth keeping, because each of the three symptoms had a
cause that was not the one it looked like.

**The composer's two rows were not the window's fault.** The progress panel was an absolutely
positioned float that *also* took a `312px` gutter out of the conversation column. A 74px card
claimed a full column's worth of reading space. At 1024px the surface was 772px, the reservation
took 312 of it, and the composer's card was left with 406px — comfortably enough for every control
on its row. But the composer's toolbar carried a container query whose threshold was 419px, a
number derived from the *column's* width rather than from what the row actually needed. The row
needed about 307px. So the toolbar wrapped at 406px, at widths where it had room, and the wrapping
grew worse as the window narrowed. The threshold was the column's width wearing the row's clothes.

**The overlapping buttons were two numbers describing one geometry.** The floating toolbar sat at
`left: max(0px, calc(var(--webui-rail-width) - 114px))` and the session title carried a second
literal to clear it. In the rail's drawer form the rail was translated off the screen and took no
width at all, but `--webui-rail-width` was still 240px — so the toolbar still sat where the rail's
column used to be, on top of a title that started at 12px. Thirteen pixels of overlap, and nothing
in the code said the two numbers were supposed to agree.

**The progress panel never changed because it was not a form at all.** It was a fixed-size card
anchored to the window's top-right corner, with a width that was `min(288px, 100% - 264px)` — a
percentage that resolved against a different box in each of the two places it was used, so the
reservation and the panel's actual width drifted apart as soon as the workspace panel opened. It
had one form at every width and no way to have another.

The common cause is not a missing breakpoint. It is that **the regions had no shared ruler**, so
each one was patched independently: the composer wrapped, the panel became an overlay, the
progress panel shrank. Three patches, three different questions, none of them about the space
actually available.

The second draft went further and turned the progress panel into a column of its own, which
answered a question nobody had asked: the panel is not a column, it is a card that reports on the
conversation and is read beside it. A third draft made it a drawer over the conversation, which
changed what it was for the sake of a width. What it actually needed was the one thing it already
had and had lost — a place of its own that the conversation keeps for it.

## The threshold contract

| Name | Width | What it decides |
| --- | --- | --- |
| `shellCompact` | 640px | Below it the left rail becomes an overlay drawer instead of a column |
| `conversationMin` | 320px | The conversation column's floor; it is never narrower |
| `surfaceSplit` | 680px | Below it the workspace panel is an overlay instead of a column beside the conversation |
| `panelMin` | 360px | The workspace panel's floor while it is a column |
| `panelOverlayMax` | 560px | The widest the workspace panel is as an overlay |
| `composerModelIcon` | 360px | Below it the model name becomes an icon |
| `composerPermissionIcon` | 272px | Below it the permission label becomes a shield |
| `progressPanelMinWidth` | 1080px | Below it the progress panel closes itself rather than cover the conversation |

The split threshold is **not a preference**. It is the sum of the floors it protects:

```
surfaceSplit = conversationMin + panelMin = 320 + 360 = 680
```

The two columns are flush against each other and separated by a hairline rather than by a gutter,
so there is no gutter to count.

`progressPanelMinWidth` is the one threshold that is not a sum. The conversation *could* spare the
card's gutter further down: it could give up width until it was at its own floor. The panel closes
itself instead, because the conversation is the thing the client is for and the panel is a report
on it.

A number that is a fact about the layout can be derived, and a derived number cannot drift from
the thing it was derived from. `test/unit/webui-layout-thresholds.test.ts` asserts the sum.

**A container or media query condition cannot use `var()`**, so the values appear as literals in
the stylesheet's query conditions and as constants in the module the resize logic imports, and a
unit test asserts that the two agree. A third copy of a number is not allowed to appear anywhere.
The thresholds are stated as the **smallest width at which the full form applies**, so the narrow
form's condition is one pixel below it — `360px` is written `max-width: 359px` — and the unit test
derives that complement from the threshold, so the two cannot drift apart.

## What each region does

### The rail

At 640px and above it is a 240px column (64px collapsed). Below 640px it becomes an overlay
drawer: it floats above the surface with a scrim, it does not take width from the conversation, and
it closes on Escape or on a press outside it. Its top is its own header now — the product's mark —
because the thing that used to float over that space has moved into the session header.

### The session header

One row: the rail's toggle, the search button, the session title, and the panel controls.

The toggle and the search button used to be an absolutely positioned strip of their own, floating
over the window, and the title carried a second literal to clear them. Two numbers describing one
geometry, and they disagreed. In a row there is nothing to disagree about: the title starts after
the buttons because the buttons are before it, and it gives way by truncating.

The header row belongs to the **conversation column**, not to the surface. The workspace panel
stands beside the conversation as a full-height column, and the header is the conversation's own
first row.

### The conversation column

Its floor is 320px. It is the reading surface, so it is the thing that keeps its space: when space
runs short, the tool regions give way, not the text.

It keeps one reservation: a `312px` gutter for the progress panel's card. The card is a float over
the column's right edge, and the gutter is where the card lands — without it the card would sit on
the text. The reservation is only ever made where the card can actually use it, and that is what
the panel's own threshold decides.

### The progress panel

It has one form: a card that floats over the conversation's right edge, anchored to the window,
288px wide, with the conversation keeping a `312px` gutter for it. It is an inspector with three
collapsible sections, read beside the conversation — not a column of its own and not a drawer over
it. Nothing about the layout changes that.

**What the layout decides about it is when it may be open.** The card's width is the window's
business, so the width that decides it is the window's too, and below `progressPanelMinWidth` the
conversation cannot spare the gutter that gives the card a place of its own. Rather than cover the
text it is meant to report on, the panel closes itself. It does not come back on its own when the
window widens: a card that has just been taken away from over the conversation does not return to
it unbidden, and the control opens it again by hand once there is room for it.

**The card and the gutter are one decision.** The stylesheet drops the gutter at the same width
the panel closes at, and the unit test asserts that the two read the same number. If they did
not, the card would open exactly where it has no place of its own.

**The progress panel and the workspace panel are mutually exclusive.** Opening one closes the
other; the one that is closed is not taking any width. This is already the projection's behaviour
(`workspace-panel-state.ts`), and the layout agrees with it.

### The workspace panel

It is a column beside the conversation only while the surface can hold both its 360px floor and the
conversation's 320px floor. Below that it is an overlay, and its width is capped rather than set by
a drag: an overlay does not spend the surface's width, so it does not need to be defended against
the conversation column. Its drag is clamped against the surface's width less the conversation's
floor, and it re-clamps when the window changes, because the window can change without the pointer
ever moving.

**The surface is measured, and the region is not.** The panel's form is a function of the space the
conversation and the panel would share — but measuring *that region* is measuring the panel's own
effect on the question: a column takes 288px out of the region it is measured against, so the region
reads smaller, the panel changes form, and the two chase each other. The surface's width does not
depend on the panel, so it is stable, and it is what is measured.

### The composer toolbar

**One row, always.** The toolbar used to wrap, and whether it wrapped was decided by a threshold
that had nothing to do with what the row needed. The row now cannot wrap, and the controls that
cannot fit give up their text instead, in a fixed order:

1. Below 360px the **model name** becomes an icon. It is the variable-length thing, and the
   trigger's tooltip carries the name.
2. Below 272px the **permission label** becomes a shield. Its tooltip and its accessible name keep
   saying which mode is in force, so nothing is lost that a reader would have had.

The order matters: the permission label is the fixed one and keeps its words as long as it can.

The composer is narrower than the column it sits in — it does not fill it — so the toolbar's own
width is its ruler, and it is the only thing that answers the question. The two thresholds above
are the widths the full forms actually need, measured from the controls themselves.

### The panel's own contents, and the pages

The file tree inside the workspace panel is a fixed-basis column of its own. In a panel narrower
than the tree, the tree is what fills the panel and the document is what disappears, so the panel's
own width is its ruler and the tree folds before the content it serves does.

A page laid out *inside* the surface follows the surface's width: the plugin management page's grid
answers to the width it has, which is not the window's width and which changes when the navigation
rail does.

A **viewport-anchored overlay** is a different case, and its viewport breakpoints are correct
rather than misjudged: the settings modal is a `100vw` takeover, the model menu and the composer's
own menus are fixed popups placed against the window, and the provider form is a fixed dialog. The
viewport is the box those are placed against, so the viewport is the width they have.

**A page that hosts a viewport-covering dialog cannot be a size container.** A container confines
the fixed-position descendants inside it, so a dialog meant to cover the whole viewport would be
clipped to the page that holds it. The plugin page's own dialog is portalled out of the page for
exactly that reason, and the page can then be a container. The settings modal's nested dialogs are
not portalled, which is one more reason it keeps the viewport breakpoints it has.

### Why the skeleton is measured rather than queried

The skeleton's forms could have been container queries on the main surface, and that was the first
design. It was withdrawn for a reason the tree states plainly: `container-type: inline-size`
applies **layout containment**, which makes the element a containing block for its fixed-position
descendants and gives it a stacking context of its own.

The shell contains modal overlays that are deliberately **not** portaled — the rewind-preview and
fork dialogs in the transcript and the plugin catalogue's backdrop are rendered inline and cover
the viewport with `position: fixed; inset: 0`. A size container on an ancestor of those would
silently confine a viewport-covering modal to the content column. Trading a squeeze for a modal
that does not cover is not a trade.

So the shell measures its surface and reports the form instead. The measurement is one
`ResizeObserver` on the surface, and the same observer's number is what the panel's width is
clamped against — one observer, one number, one answer.

**JavaScript never decides what a form looks like.** A resize handler that also decides whether a
panel is a column or an overlay creates a second judge for the same question, and the two drift.
What JavaScript may do is report a measurement and clamp a number into the range the stylesheet
already permits.

## Degradation is not symmetric, and it is not reversible

**The zones are treated differently, on purpose.** The conversation region is a reading region, so
its text stays readable: it truncates and it wraps, and it never loses its floor. The tool regions
are operating regions, so their controls stay reachable: they scroll, they collapse into an icon,
they become a drawer. One rule for both would either produce an unreadable reading surface or an
unusable tool surface.

**Automatic degradation overwrites a manual width, and does not restore it.** When the window
narrows far enough that the panel's width no longer fits, the panel gives the width back and the
conversation column takes it. The width the person set is gone; widening the window again does not
bring it back. Restoring it would mean the panel silently reclaims the space the conversation is
now using, which is the same squeeze in a later form. The panel's width is session state and is not
persisted.

**The phone tier keeps the work, not the chrome.** Below 640px the client keeps the conversation,
the composer and the ability to send, and the workspace panel opens as an overlay — the same
expanded form the panel already has, so no new gesture vocabulary is introduced.

## Constraints this decision puts on later work

- **A region reserves no width it is not using.** The progress panel's card is a float, and the
  conversation keeps a gutter for it — but that gutter is the card's own room, and the card closes
  itself where there is no room for it. An overlay that takes a gutter out of a sibling and then
  covers it anyway is the defect this decision removes, and a unit test guards against it coming
  back.
- **A new component that needs another shape at a narrow width asks its own container.** It does not
  add a viewport breakpoint. The viewport-level thresholds in the client are the two that belong to
  the window itself — the rail's 640px and the progress panel's 1080px — and adding a third has to
  be argued against that rule.
- **Two pieces of geometry that describe one relationship must be derived from one number.** The
  rail's toggle and the session title were two literals for one gap; they are now two children of
  one row.
- **`min-width: 0` is a statement that content may be clipped.** It is legitimate on a child whose
  parent guarantees a floor and illegitimate on a column that has none. A column without a floor is
  the defect this decision removes.
- **A drag that writes an inline size must clamp against the space its sibling needs**, and must
  re-clamp when that space changes.
- **The thresholds live in one module and are asserted against the stylesheet.** A number that
  appears only in a query condition is invisible to the code that has to agree with it.
- **A form change and a number change are separate decisions.** The stylesheet says which form the
  panel is in; the resize logic says how wide it is.

## What this decision does not settle

- **What the collapsed rail contains.** The rail's collapsed state is 64px wide and renders no
  navigation at all. It is a known gap, recorded in [`known-gaps.md`](../known-gaps.md); this
  decision keeps the collapsed state as it is and changes only when the rail changes form.
- **Whether the rail can be resized.** The grip on the rail's edge is decoration; it carries no
  pointer handling. Making it real is a separate feature.
- **How the panel remembers anything.** The panel's tab state is per session and lives in the
  projection store; its width is session state. This decision changes neither.
- **Whether the progress panel should be draggable.** It is a fixed 288px card, because it is an
  inspector with three collapsible sections rather than a workspace. Making it draggable is a
  separate decision with its own floor.
