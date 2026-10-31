**Parent specification for the workspace browser tab model programme — not an executable work item.**
The executable work items are the tickets listed under [Ticket board](#ticket-board) at the bottom of
this issue. Each ticket cites this issue as its parent.

Decision authority: [ADR 0022](https://github.com/mcode-webui/minimax-code/blob/webui/packages/webui/docs/adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md)
in the repository (`packages/webui/docs/adr/0022-…md`), and
[ADR 0019 amendment A8](https://github.com/mcode-webui/minimax-code/blob/webui/packages/webui/docs/adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md)
for the change to the panel's role. ADR 0022 is the decision record for this feature; this issue
and the tickets must not restate or reopen its decisions.

Development plan: `.plan/workspace-browser-tab/workspace-browser-tab-plan.md` in the working
checkout. The plan is workspace material and is deliberately not part of the published source
projection.

## Problem Statement

A person asks the Agent to open a browser and visit a page, and every action fails with
`browser_target_unknown` — including the one action that should have started it.

The Agent's browser tools refuse every action when the run has selected nothing, and the only party
that could create that selection was the browser panel, so the person had to open the panel and
click a target before the Agent could do anything at all. The refusal itself is right and stays: a
run that has selected nothing is refused rather than handed a page nobody chose. What is missing is
the other half of the rule ADR 0019 already stated — *both the user and the Agent can select a
target*.

Underneath that sits a second problem. **A page has no identity in the interface.** The right-hand
column is a tabbed panel whose tabs are a fixed enumeration of kinds, and the browser is one of
those kinds: a tab that shows a surface's target list, a live image of one page, and forwards
input to it. A person changes the Agent's target by clicking a chip inside that tab; the Agent
cannot change it at all. The selection is the one piece of browser state with no name, no place in
the layout, and no way to be operated by either party.

That also makes the panel a poor browser. It cannot hold a second page, it cannot show a page the
person found themselves, and it cannot be driven by a person and the Agent at the same time: the
person's browsing and the Agent's work compete for one selection.

## Solution

The right-hand column becomes a browser.

Its strip holds **tabs**, and a tab is a stable slot whose content can be replaced in place. A
newly opened tab shows a **new tab page** — a launcher offering the tool views (changes, terminal,
canvas, files) and a URL box — and choosing either replaces that tab's content. A **web tab** is a
tab whose content is a browser page: the isolated Chromium holds one page per web tab. There is no
persistent address bar; a web tab carries a toolbar instead (back, forward, reload, and the URL
shown read-only).

Two selections exist, and they are different things. The **run's selection** is the page the Agent
acts on. The **tab the person is looking at** is the page the person sees and can type into. The
Agent opens its own tabs: `open_tab` creates a page, makes it the run's selection and tells the
client, so the tab appears in the strip and becomes the active one. A person browsing does not move
the Agent off its page, and the image stream is per target rather than per run, so each tab's
picture is its own. The one exception is a bootstrap: a person who opens a web tab while the run
has no selection gives the run that page, because a run with no selection cannot act at all.

The browser tool tab is deleted rather than kept alongside. The embedded panel is the **isolated
browser's view**, permanently: the external browsers are driven in the user's own Edge and Chrome
windows, where the person sees them, so the panel is not where a surface is chosen and the surface
switcher goes with it.

## User Stories

1. As a WebUI user, I want the Agent to open a browser by itself, so that "open a browser and go to
   this page" works without me setting anything up first.
2. As a WebUI user, I want the Agent's new tab to appear in my panel, so that I can see what it is
   doing without hunting for it.
3. As a WebUI user, I want the panel to be a browser with a tab strip, so that I can open a second
   page without losing the first.
4. As a WebUI user, I want a new tab to offer me the workspace's tools and a place to type a
   web address, so that one place does both.
5. As a WebUI user, I want the address box to live inside the new tab page, so that a page shows its
   address and a tool does not pretend to have one.
6. As a WebUI user, I want to browse in my own tab while the Agent works in another, so that my
   looking around does not move the Agent's work.
7. As a WebUI user, I want to type into the page I am looking at, so that my typing goes where I
   am pointing, not where the Agent happens to be.
8. As a WebUI user, I want the Agent's actions to stay on the Agent's page, so that the Agent never
   clicks in a page I opened.
9. As a WebUI user, I want to open a page myself and then ask the Agent about it, so that the Agent
   reads the page I am looking at.
10. As a WebUI user, I want a web tab to show the page's title, so that I can tell my tabs apart.
11. As a WebUI user, I want to go back and forward in a web tab, so that I can undo my own
    navigation without losing the page.
12. As a WebUI user, I want a closed tab to close its page, so that the browser does not accumulate
    pages nobody is watching.
13. As a WebUI user, I want the Agent's browser to be authorized by the same switch as mine, so
    that turning the browser off turns it off for both of us.
14. As a WebUI user, I want a run that cannot act to be refused clearly, so that I know the Agent is
    blocked rather than idle.
15. As a WebUI user, I want Edge and Chrome to keep working in their own windows, so that losing
    the panel's surface switcher does not take my logged-in browser away.
16. As a maintainer, I want the page's generation to advance on every tab, so that a stale
    reference is refused on the second page as well as the first.
17. As a maintainer, I want the frame stream keyed by target, so that a tab's picture is its own and
    two tabs cannot show each other's pages.
18. As a maintainer, I want a session's pages released when the session ends, so that no page is
    left running for a session that is gone.
19. As a maintainer, I want the tab's identity to be the client's, so that two web tabs in one
    session are two tabs and a page that navigates is still the same tab.
20. As a maintainer, I want the browser business to stay separate from the workspace business, so
    that a browser with no workspace still has somewhere to live.
21. As a maintainer, I want the Agent's browser path exercised against a real browser, so that the
    claim that the panel and the Agent share a page is an observation and not a design.

## Implementation Decisions

These are the decisions the implementation must honour. ADR 0022 holds the rationale; this list is
the operational summary, not a second decision record.

- **A tab is a stable id plus a mutable content.** The tab shape changes from a discriminated
  union keyed by kind to an id and a content descriptor. The kinds become the content descriptors.
- **The client assigns the tab id.** The runtime's target identity is a binding the tab holds, not
  the tab's identity: a page that navigates keeps its target id and gains a generation, and the tab
  that holds it is still the same tab.
- **The new tab page is a launcher with four tiles and a URL box.** Choosing a tile replaces the
  current tab's content; typing a URL opens a page through the browser's port. The `browser` kind
  is deleted.
- **The URL box exists only inside the new tab page.** A web tab carries a toolbar — back, forward,
  reload, and the URL shown read-only — instead.
- **Every web tab goes through the same surface switch**, the person's launcher path and the
  Agent's path alike.
- **A web tab is titled by the page and glyphed by default.** The title is the one the provider
  already reports; fetching a site's icon is out of scope.
- **The isolated provider holds one page per web tab**, with per-target sessions, per-target
  screencasts and per-target generations.
- **The Agent opens tabs.** `open_tab` is the action that gives a run its first selection and the
  action that moves it to another one. Every other action of a run with no selection is still
  refused with `browser_target_unknown`.
- **The run's selection and the tab the person is looking at are separate cells.** The person's
  input follows their tab; the Agent's actions follow the run's selection. The one bootstrap is a
  person opening a web tab while the run has no selection.
- **The frame stream is per target.** This is a change to the existing frame operation's request
  shape, not a second operation beside it, and the fence is unchanged: a frame reaches only the tab
  that asked for it, and the generation check still decides whether the page behind it is the one on
  screen.
- **The runtime publishes the web tabs as a snapshot**, not as deltas: the list is small, and a
  snapshot is idempotent, so a reconnect reconciles instead of drifting.
- **The strip is per session.** A second session has its own strip.
- **The strip is the workspace business's and the web tab is the browser business's.** The only
  direction between them is the one the workspace already uses: it mounts a published browser
  component and calls the browser's port. It never reaches into the browser's state.
- **Neither business is aggregated into the other.** The browser business is a capability the Agent
  uses and has to work without a workspace.
- **The browser tool tab and its surface switcher are deleted.** The embedded panel is the isolated
  browser's view; the external browsers are driven in the user's own windows.
- **A closed web tab closes its page**, and a session's pages are released when the session ends —
  deleted, archived, or transferred away.

## Testing Decisions

- **Test observable behaviour, not implementation detail.** A test asserts what a person or the
  Agent can observe, never that a testid string exists.
- **Use the highest seam available.** Contract and validator behaviour is covered by unit tests;
  assembled runtime and server behaviour by the application-level suites; the built client by the
  built-client browser suite.
- **No DOM test framework.** Interaction coverage extracts the transitions into pure functions and
  asserts render branches through static markup rendering.
- **Every new test file is registered.** A new Vitest file must be listed in the repository's
  declared suite groups or it never runs, and a new source path must be recorded in the frozen path
  metadata fixture.
- **A fake provider is not acceptance.** The isolated Chromium path must be exercised against the
  real provider.
- **The Agent's path is part of the definition of done.** A real browser, the Agent's tool opening
  a real tab, the strip gaining it, the picture updating, and the person taking over. The gap this
  programme closes is that the Agent's browser tools had never been driven against a real browser.
- **The generation fence is adversarial coverage.** A navigation on a page that is not the launch
  page must advance that page's generation and refuse the stale reference. A fence that only works
  on the first page is a fence that does not work.

## Out of Scope

- The external browsers inside the embedded panel. Edge and Chrome are driven in the user's own
  windows; the panel is the isolated browser's view.
- The Agent choosing which of the user's already-open Edge or Chrome tabs to drive. The extension
  drives the browser through its debugger and cannot open a page in it, so a web tab there would
  bind a tab the extension reports rather than create one — a different rule, and not this
  programme's.
- A persistent address bar, a browser-wide history or a recommendation area in the new tab page.
- Favicons.
- An Agent action that closes a tab. The Agent opens tabs; the person closes them.
- The strip's affordances for a person browsing alongside the Agent. That a person may browse while
  the Agent works, on separate targets, is settled; how the strip shows it is not.
- Any change to the browser authorization switches, which already exist and are already surfaced
  in Settings.

## Further Notes

- The development plan that produced this board is workspace material, deliberately outside the
  published source projection. The board and the plan must not drift apart: an amendment belongs in
  the plan first, and the affected tickets are updated to match.
- Research notes captured before implementation, for the implementers:
  [#197 runtime and provider sites](https://github.com/mcode-webui/minimax-code/issues/197),
  [#198 the client's tab model and the sites a mutable content breaks](https://github.com/mcode-webui/minimax-code/issues/198).
- Ticket 01 is the technical validation work package. It blocks every other ticket, because the
  per-page generation accounting, the per-target frame stream, the operation registration and the
  tab-model sites are what the later tickets are written against.
- If a technical finding requires a product change, ADR 0022 is updated first, then the affected
  tickets are re-scoped.

## Ticket board

| Ticket | Title | Blocked by |
| --- | --- | --- |
| 200 | 01 — Validate the tab model's technical contracts and pin the capability matrix | — |
| 201 | 02 — The isolated provider holds one page per web tab | 200 |
| 202 | 03 — `open_tab` creates a page that can be addressed | 201 |
| 203 | 04 — The runtime owns the session's web tabs and publishes them | 200, 201, 202 |
| 204 | 05 — The image stream becomes per target | 203 |
| 205 | 06 — A session's pages are released when the session ends | 203 |
| 206 | 07 — The Agent opens tabs and gives a run its first selection | 202, 203 |
| 207 | 08 — The workspace tab shape becomes a stable id and a mutable content | 200 |
| 208 | 09 — The strip renders web tabs, and the browser tool tab is deleted | 207, 203 |
| 209 | 10 — The new tab page: the tool tiles and the URL box | 208, 206 |
| 210 | 11 — The web tab's toolbar: back, forward, reload and the URL | 208, 204 |
| 211 | 12 — The run's selection and the tab the person is looking at | 204, 206, 210 |
| 212 | 13 — Real-browser acceptance, and the documentation caught up | 211 |
