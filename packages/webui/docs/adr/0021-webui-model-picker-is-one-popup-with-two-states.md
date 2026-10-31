# The model picker is one popup with two states

**Status:** Accepted.
**Date:** 2026-10-20.

The composer's model picker opens one popup. It has two states: the **panel**, which shows the model
in use and its thinking scale, and the **list**, which shows the catalogue grouped by provider. The
model name in the panel opens the list; the back arrow in the list returns to the panel. Nothing
opens a second popup.

This replaces a two-column cascade: a model list, and a fly-out beside the hovered row carrying
the settings for that row.

## Why the cascade had to go

The cascade's failure was not cosmetic, and it was not a styling problem.

The menu and the fly-out were two `WebuiDropdown` popups, and the shared skeleton gives each one its
own document-level dismissal listener. The fly-out's content is portalled to the document body, so
the wrapper's `contains(target)` test was always false for a pointerdown that landed on a model row:
the fly-out read every such press as "a press outside" and retracted itself. The retraction rebuilt
the DOM, and the click that followed landed on whatever had taken the row's place — or on nothing.
The user saw a control that did nothing, and the only thing that brought the catalogue back was a
reload.

Two more symptoms came from the same shape:

- **The panel flickered.** Every hover of a row unmounted and remounted the fly-out, replaying its
  120ms exit and 140ms entry; the panel's position was re-derived from its own measured size, so a
  list whose content changed moved the surface under the pointer.
- **The chip fell back to the literal "Model" and stopped opening.** The composer rendered the
  catalogue the models owner had *selected*, and gated it on a scope it kept of its own. Those are
  two facts about different things. When they disagreed — after a session switch, or while the
  catalogue was being re-read — the list came out empty, the chip printed its fallback, and the
  trigger went inert because an empty list disabled it.

## What replaced it, and why each piece

- **One popup, two states.** A single popup has one dismissal, one Escape ladder and one place the
  list can be. The states swap content rather than opening beside each other, so a row cannot be
  covered by a surface that claims the press first.
- **The list is a snapshot taken when the popup opens.** The catalogue is re-read in the background
  while the user is in the panel. A live list would re-order under the pointer; the snapshot makes
  one visit of the popup correspond to one fixed set of rows.
- **The panel owns the thinking level, and the composer has no brain.** A two-state model (off/on)
  and a depth scale (low/medium/high) are different shapes, and the slider covers both: a switch's
  two positions are a two-stop scale. The level is set where the model it belongs to is on screen,
  so there is one control for one state.
- **The scale is the model's own.** The stops come from the runtime's `effortOptions`, so the
  control cannot offer a level the model does not have. A model with no thinking shows a disabled
  slider rather than a control that vanishes.
- **A level change is ONE write.** The cascade's thinking control committed twice — once as a
  settings change and once as a selection — and two answers to one press arrive in the order the
  runtime felt like answering them.
- **The catalogue a session shows is that session's own entry.** The models owner now exposes the
  catalogue of the session asked for, and keeps the last good answer while the next read is in
  flight. A catalogue that empties itself mid-reload is a catalogue the user cannot click.

## What was dropped, and why it was safe to drop

- **The favourites shortlist and the search box.** Both moved rows under the pointer: a shortlist
  that is re-ordered by the act of starring a model re-orders the list being starred in, and a
  filter that rebuilds the list on every keystroke moves the row a click was aimed at. The
  catalogue's own order is the one order nothing else can disturb.
- **The composer's brain trigger.** The level moved into the panel, and a second control for the
  same state is a second thing to disagree with the first.
- **The fly-out's own window picker.** The context window is still a capability, and it is still
  selectable: it is now a row under the model name in the panel, shown only for a model that has
  windows to choose from.

## Constraints this decision puts on later work

- A surface that needs its own popup gets its own popup. It does not get a second popup inside the
  picker's popup, and it does not get a hover-driven surface: the cascade's hover intent is
  retired with it.
- The thinking level is set in the panel and named on the chip. A new surface that wants to set it
  goes through the same `selectModel` write, and it does not add a third control for it.
- The picker's list is the catalogue in the catalogue's order. Anything that reorders it — a
  shortlist, a filter, a ranking — has to justify itself against the pointer, and the default is
  that it does not.
