# Floating surfaces

Every floating popup in the client — a menu, a panel, a list, a fly-out — is one
object with one surface, one motion and one dismissal rule. This document is
that contract: what the shared skeleton owns, what a caller states, and what a
feature's own stylesheet is no longer allowed to say.

The code is `client/ui/Dropdown.tsx` (the skeleton), `client/styles/dropdown.css`
(the surface) and `client/projection/common/dropdown-placement.ts` (the
arithmetic).

## What the skeleton owns

`WebuiDropdown` owns three things, and it owns them for every popup in the
client:

- **The surface.** The background, the border, the radius, the shadow and the
  motion are stated once, in `client/styles/dropdown.css`. A feature's
  stylesheet says only what is specific to what the popup holds.
- **The dismissal.** A press outside the popup closes it, and so does Escape —
  which also returns the focus to the control that opened it. The press is read
  at `pointerdown`, not at `click`, so the popup is on its way out before the
  click reaches whatever the user aimed at.
- **The placement.** The popup is rendered into the portal and positioned in
  viewport coordinates, measured against its anchor.

The last one is not decoration. A popup that positions itself with `absolute`
is clipped by every scrolling ancestor between it and its trigger, and it moves
with the page while the trigger does not. Measuring the trigger and placing the
popup in viewport coordinates is what makes one placement rule work everywhere.

## What a caller states

```tsx
<WebuiDropdown
  open={open}
  onOpen={...}
  onClose={...}
  trigger={(triggerProps) => <button {...triggerProps} />}
  role="menu" | "listbox" | "dialog" | "presentation"
  side="bottom" | "top" | "right" | "left"
  align="start" | "end" | "center"
  width="content" | "match" | "anchor"
  collision="none" | "clamp" | "flip"
  offset={4}
  className="..."          // the popup's own content classes
  wrapperClassName="..."   // the trigger's own layout classes
  popupDataAttributes={{...}}
>
  ...
</WebuiDropdown>
```

`side` says which edge of the anchor the popup hangs from. `align` says which
point of that edge it lines up with — horizontally on a vertical side,
vertically on a horizontal one. `width` says whether the popup is its own
width, at least the anchor's width, or exactly the anchor's width. `collision`
says what happens when the popup does not fit: nothing, a clamp into the
viewport, or a flip to the other side.

The caller keeps its own open state. The skeleton never opens or closes on its
own; it renders the open state, and keeps the popup mounted long enough for the
exit animation to play.

## The anchor

The anchor is a rectangle in viewport space, and there are three ways to name
one:

| Named by | Use it when | How |
| --- | --- | --- |
| The trigger | The popup hangs off a button | Nothing to do — the trigger is the anchor |
| An element | The popup hangs off something that is not the trigger | `anchorElementRef` |
| A resolver | The anchor is not an element at all | `anchorRect` |

The resolver is asked **at measure time**, not remembered at render time: a row
in a list that the list is free to remount would leave a captured element
pointing at a detached node. A resolver is how a popup is anchored to a point
on the canvas, to a row in a virtualised list, or to anything whose position is
not an element's.

## The placement rule

The built-in rules cover the common shapes. A surface whose geometry is
genuinely its own — a context menu that opens at the pointer, a gauge panel
that hangs above its ring and never opens downwards, a cascade fly-out that
reads left to right — states the rule itself:

```tsx
<WebuiDropdown
  placement={({ anchor, surface, viewport }) => ({
    left: ...,
    top: ...,
  })}
/>
```

The rule is a pure function and it belongs in a projection module, where it
can be tested against real numbers instead of a screenshot. The arithmetic
that is common to every popup lives in
`client/projection/common/dropdown-placement.ts`; a rule that is specific to
one surface lives with that surface.

A rule that decides WHICH side the popup opens on has to be given the popup's
measured size and the viewport, and it has to make the decision itself. A
caller that guesses the side beforehand is guessing about a number it does not
have — the popup's height — and a wrong guess puts the panel on the wrong side
of its anchor, running off the bottom of the screen. A rule that answers with
the side it chose also tells the motion which way to slide.

A rule that draws the popup outside the viewport has not placed it. Whatever
the rule does, the popup ends up inside the viewport, and the popup's own box
says how it scrolls when it cannot fit.

## The motion

The shared motion is a **slide and a fade**: the surface slides in from the
edge it opens on, and it never scales.

The entrance used to scale the popup (`scale(.98)`) as well. That is what a
reader saw as *the text moving*: every label inside the popup was drawn at 98%
for the length of the animation and then drawn at 100% again, so the words
squashed and straightened themselves under the eye. A slide moves the popup and
its text together, which reads as one panel arriving; a scale redraws the text,
which reads as the text flinching. So the slide stays and the scale goes.

The slide follows the side the popup actually opened on, which the skeleton
writes into `data-webui-dropdown-side`: a panel that opens below its trigger
comes down from above it, and a panel that opens above it comes up from below.
One shared slide cannot be right for both, and getting it wrong is what makes a
popup look like it is falling.

Because a transform does not resize anything, the skeleton's measurement is the
popup's **layout box** (`offsetWidth`/`offsetHeight`), not the painted
rectangle (`getBoundingClientRect()`). The painted rectangle reports the box as
it is drawn, so a popup that is mid-animation measures smaller than it is, and
the placement is then computed against a size the popup does not have — an
error that never corrects itself, because the size observer does not fire for a
transform.

## The popup's own class

A popup's own class styles its content. It does not place it.

The shared layer owns the placement: the popup is `position: fixed`, and the
placement writes its `top`/`left`. A popup class that declares a position wins
the cascade over that rule, and the popup stops being placed at all — it falls
back into the page flow, a viewport below the reader, with the placement's
coordinates added to it as an offset. The panel was on screen the whole time,
off screen, and the button that opens it did nothing.

So a popup class may declare its box, its padding, its typography and its
scroll — never `position`, `top`, `left`, `right`, `bottom` or `z-index`. A
class that styles a CHILD of the popup (a submenu, a row) may place that
child; that is a different element.

## A popup with no trigger

Not every popup is opened by a button. A list that follows the caret in a
textarea, a menu that opens at the pointer and a fly-out that follows the row a
pointer is over have no trigger to hang from.

The skeleton has a shape for that: omit `trigger`. The popup still gets the
surface, the motion and the dismissal, and the wrapper gets no box of its own
(`display: contents`), so it takes no room in its parent's layout.

A triggerless popup has no `aria-expanded` to report and no focus to return to
on Escape. It also has to say what a press *inside* it is: a list that follows
the caret must not close when the caret moves, and the region it belongs to is
named with `dismissRegionRef`. The composer's mention list and command palette
name the composer's whole region; a press in the text, in the attachments or on
the send button is the user still working.

## A fly-out that opens on hover

A hover fly-out is not a dropdown: there is no trigger to toggle and no outside
press to dismiss it, because it has to stay open while the pointer is on it. It
is still the same *surface*, so it carries `.webui-dropdown-surface` and gets
the same look and the same motion. It keeps its own positioning: it hangs off
a menu row, inside the menu.

## What a feature's stylesheet may say

A popup's own stylesheet describes **the content**: its width, its rows, its
padding, its scroll behaviour.

It does not say:

- `position`, `top`, `left`, `right`, `bottom` — the popup is placed in
  viewport coordinates, and an offset here fights the measured placement
  instead of describing the panel. `right` and `bottom` in particular do not
  merely lose: with a viewport-sized panel they win over a measured `left` and
  put the popup back against the window edge.
- `z-index` — the shared layer owns the layer.
- `border`, `border-radius`, `background`, `box-shadow`, `animation` — the
  shared surface owns the surface. A feature that re-declares them is a second
  surface wearing the first one's name.
- A second outside-press or Escape listener — the skeleton dismisses, and a
  second listener dismisses twice.

## The layer

The shared popup is at `z-index: 120` in the document root, which is above the
in-shell bands and below the portal-rendered modals. A popup that used to live
inside a stacking context — the composer's overlay, the session column — now
escapes it, which is how the context-usage panel came to clear the rail
instead of being clipped by it.

## Testing

The arithmetic is a pure function and is tested as one:
`test/unit/dropdown-placement.test.ts`. The skeleton's markup is pinned by
`test/unit/webui-dropdown.test.tsx`. The dismissal itself needs a real
document and is pinned by the browser suite.
