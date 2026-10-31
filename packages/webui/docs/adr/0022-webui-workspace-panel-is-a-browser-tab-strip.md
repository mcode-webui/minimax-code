# The workspace panel is a browser tab strip

**Status:** Accepted and implemented.
**Date:** 2026-10-21.

The right-hand workspace panel becomes a browser. Its strip holds **tabs**; a tab is a stable slot
whose content can be replaced in place. A newly opened tab shows a **new tab page** — a launcher
offering the tool views (files, terminal, canvas, changes) and a URL box. Choosing a tool or
typing a URL replaces that tab's content: the tab is neither closed nor replaced, and the URL box
goes with the new tab page it belonged to.

A **web tab** is a tab whose content is a browser page. The host's isolated Chromium holds one
page per web tab. There is no persistent address bar; a web tab carries a toolbar instead (back,
forward, reload, and the URL shown read-only).

Two selections exist, and they are different things:

- The **run's selection** is the page the Agent acts on. A run is the WebUI Agent session's browser
  working context, keyed by that session, so one session drives one selection.
- The **tab the person is looking at** is the page the person sees and can type into.

The two coincide when the Agent opens a tab: the tab appears in the strip and becomes the active
one, and it is the run's selection at the same time. They come apart when the person browses. A
person who opens their own tab does not move the Agent off its page, and the Agent opening a tab
does not yank the person away from theirs. The person's pointer, key and text go to the tab they
are looking at; the Agent's actions go to the run's selection. When both name the same page — the
person clicked the Agent's tab — the two drive one page together, which is what ADR 0019 already
allows.

There is one exception, and it is a bootstrap rather than a co-write. A run with no selection cannot
act at all, so a person who opens a web tab **while the run has no selection** gives the run that
page. After that the two cells are independent: the run's selection is written by the Agent, and the
tab the person is looking at is written by the person.

The Agent can create its own selection. `open_tab` opens a page, makes it the run's selection, and
tells the client, so the tab appears in the strip and becomes the active one. The frame stream is per
target rather than per run, so each tab's picture is its own, and the person and the Agent can work
on different pages at the same time.

This amends [ADR 0019](./0019-webui-browser-use-surfaces-and-external-browser-bridge.md); see
**A8** there.

## Why the panel had to become a browser

The failure was a deadlock, and it was in the design rather than in a line of code.

The Agent's browser tools refuse every action when the run has selected nothing, and the only
party that could create that selection was the panel. So a person who asked the Agent to open a
browser and visit a page got `browser_target_unknown` for every action — including `open_tab`,
the one action that should have started it. The refusal was deliberate and remains right: a run
that has selected nothing is refused rather than handed a page nobody chose. What was missing was
the other half of the rule, which ADR 0019 already stated and the implementation never carried:
*both the user and the Agent can select a target*.

Underneath that, a page had no identity in the interface. The panel was a view of a run's selected
target, and that selection was invisible: a person changed it by clicking a chip inside the
browser panel, and the Agent could not change it at all. The selection was the one piece of
browser state with no name, no place in the layout, and no way to be operated by either party.

A browser tab is the missing piece. It names the page, it can be opened and closed, and both the
person and the Agent can open one.

## What the parts are called, and where they live

The strip is a browser's strip, and the words follow that — but **not the word "browser"**, which
already means the browser being driven. A surface is the isolated Chromium or the user's Edge or
Chrome; a target is one page of it. If the panel were also called a browser, one word would carry
two meanings in the same sentence.

| Thing | Called | Owned by | Lives in |
| --- | --- | --- | --- |
| The right column | the **workspace panel** | the workspace business | `client/features/workspace/ui/` |
| The row of tabs | the **tab strip** | the workspace business | `client/features/workspace/ui/` |
| A slot | a **tab** | the workspace business | `client/features/workspace/projection/` |
| A slot holding a workspace tool | a **tool tab** | the workspace business | as above |
| A slot holding a browser page | a **web tab** | the browser business | `client/features/browser/ui/` |
| The launcher a new tab opens with | the **new tab page** | the workspace business | `client/features/workspace/ui/` |
| The browser being driven | a **surface** | the browser business | `client/runtime/browser/` |

### The components

| Component | Name | Business | Layer |
| --- | --- | --- | --- |
| The strip, the tool tiles and the launcher | `WebuiWorkspaceTabStrip` | workspace | bindings |
| A web tab's host — binds a tab to a target, shows the picture and the toolbar, forwards input | `BrowserPanelHost.public.tsx` | browser | bindings, published |
| A web tab's content | `BrowserPanel.public.tsx` | browser | bindings, published |

The two published browser components **keep their names**. A rename would break the Desktop fork's
imports and would show up as a conflict at the next source synchronisation, and the rule in this
repository is to change content rather than layout. What they now *are* is recorded here and in
the browser-use documents: a web tab's host and its content.

### The layer and the boundary

The strip is the **workspace** business's, because it is the session's column and it holds the
workspace's own tools. The web tab's content is the **browser** business's, published, and the
workspace mounts it — the same direction the workspace already uses to mount the browser's panel.
That is the only direction between them: the workspace mounts a published browser component and
calls the browser's port to open a page. It never reaches into the browser's state.

The browser business is **not** aggregated into the workspace business, and the workspace business
is **not** aggregated into the browser one. The browser business is a capability the Agent uses; it
does not belong to a workspace, and it has to work in a session with no workspace at all. Merging
them would leave a browser with nowhere to live, and would make the browser a thing a workspace
owns rather than a thing the Agent drives.

## What replaced it, and why each piece

- **A tab is a slot with mutable content, not a kind.** The workspace's tab shape changes from a
  discriminated union keyed by kind to a stable id plus a content descriptor. A tab that shows the
  new tab page and the same tab that later shows a web page are one tab, and the strip does not
  flicker when the content changes. The kinds themselves become the content descriptors.
- **The tab's id belongs to the client.** The id is assigned when the tab is opened and does not
  change when its content does. The runtime's target identity is a *binding* the tab holds, not the
  tab's identity: a page that navigates keeps its target id and gains a generation, and the tab that
  holds it is still the same tab.
- **The new tab page is a launcher, not a menu.** Four tiles — changes, terminal, canvas and files —
  and a URL box. Choosing one replaces the current tab's content. A menu that opened a second
  surface could not be a tab's content; a launcher can. The `browser` kind is not one of the four:
  it is deleted, and the tab it used to be is replaced by the web tabs.
- **The URL box belongs to the new tab page.** There is no persistent address bar. A web tab carries
  a toolbar instead: back, forward, reload, home to return to the new tab page in the same tab, and
  the URL shown read-only. Back and forward are disabled when the page has no entry in that
  direction. A person who wants another URL opens a new tab and types it there.
- **Every web tab goes through the same switch.** The person's launcher path reads the same surface
  switch as the Agent's path, and a tab on a surface whose switch is off does not open.
- **A web tab is titled by the page and glyphed by default.** The title is the one the provider
  already reports for the target; the icon is a default glyph. Fetching a site's icon is a separate
  piece of work and is not part of this.
- **The isolated provider holds one page per web tab.** The provider drove exactly one page and
  refused every other target, so `open_tab` created a page nobody could drive — a tab in the list
  that did nothing when chosen. Per-target sessions, per-target screencasts and per-target
  generations make a web tab a page that can actually be worked on.
- **The Agent opens tabs.** `open_tab` is the action that gives a run its first selection and the
  action that moves it to another one. A run that has selected nothing is still refused every
  other action, so the bootstrap stays explicit rather than becoming a default.
- **The frame stream is per target.** The run's selection and the person's tab are separate cells,
  so the pictures have to be separate too. One stream per target keeps the fence intact: a frame
  is delivered only to the tab that asked for it, and the generation check still decides whether
  the page behind it is the one on screen.
- **Closing a web tab closes its page.** A tab the person closes does not leave a page behind in the
  Chromium, and the runtime's page set follows the strip.

## What changed, and why the change was safe

Two of the earlier rules were narrowed rather than dropped, and one surface went away.

- **"The panel never switches the target itself."** The panel is a writer now: activating a tab
  and choosing a launcher tile are panel actions. The argument behind that rule — that a second
  writer on the run's selection would make the run's choice stop being authoritative — still
  holds, and it still holds: the panel writes what a tab shows, and it does not write the run's
  selection, except in the one bootstrap case above.
- **"The panel follows the target of the active run."** The panel follows the *person's* tab. The
  run's selection is a different cell with a different writer, and the two may name different
  pages at the same time.
- **The single Browser panel.** There is one strip per session, and it holds many tabs. The browser
  tool tab that stood for the isolated surface is deleted rather than kept alongside: its picture and
  its input are a web tab's, its target list is the strip's tabs, and what was left — the surface
  switcher — has no surface to switch between.
- **The surface switcher goes with it.** The isolated Chromium is the only surface a web tab names,
  because the panel is the isolated browser's view. The chips that chose between surfaces were
  there for the external browsers, and the external browsers are driven in their own windows — so
  the chips have nothing left to choose, and the panel never becomes a place where a browser is
  picked.

## Constraints this decision puts on later work

- **The embedded panel is the isolated browser's view, and that is all it is.** The external browsers
  are driven in the user's own Edge and Chrome windows, where the person sees them and where they
  are operated; the panel is not where they are reached, so it does not need to be a place where a
  surface is chosen. The surface concept stays in the runtime — a switched-on Edge or Chrome still
  authorizes the Agent's commands — but the strip is the isolated browser's, and a web tab in it is
  a page of that browser. That is why the surface switcher goes: not because this slice has one
  surface, but because the panel was never the place the other browsers live.
- **A web tab on an external surface, when the bridge grows one, binds a tab rather than creating
  it.** The extension drives the browser through its debugger and cannot open a page in it, so the
  Agent cannot open a tab in the user's Edge; it acts on a tab that is already open. That is a
  different rule from the isolated browser's, and it is not this decision's to make.
- **The per-target frame stream is what makes two drivers possible.** It is also the prerequisite
  for a person browsing while the Agent works on another page. It is a change to the request shape
  of the existing frame operation, not a second operation beside it.
- **The strip is per session.** A second session has its own strip, and a tab opened in one
  session is not in another's.
- **The tool views keep their own ownership.** The strip belongs to the workspace business; a web
  tab's page, title and URL belong to the browser business. The strip renders them; it does not
  own them.
- **The generation fence moves with the page.** A target keeps its four-field identity and a
  navigation still raises the generation, but the provider's accounting of that generation is
  per page rather than per browser, because the fence has to be live on every web tab and not only
  on the one the browser was launched with. A page that never advances its generation is a page
  whose recorded references never go stale, which is the failure the fence exists to prevent.
- **The host's own command path is a third cell.** A browser command that carries no run resolves
  the surface's current selection rather than a run's. It is neither the person's tab nor the
  Agent's page, and this decision does not merge it with either.
- **The tab the person is looking at is client state.** The runtime tracks the run's selection and
  publishes the tabs; it does not track which of them the person is looking at. That is what lets
  the person browse without moving the Agent, and it is why the person and the Agent can name
  different pages without the runtime having to arbitrate between them.

## What this decision does not settle

- What a tab shows when the page behind it is closed.
- How the strip should present the person browsing alongside the Agent. That a person may browse
  while the Agent works, on separate targets, is settled above; how the strip makes it visible — and
  whether the Agent's tab is marked as such — is not.
- How the Agent picks which of the user's already-open Edge or Chrome tabs to drive. The panel is
  not the place for that choice, so the rule has to come from somewhere else.
