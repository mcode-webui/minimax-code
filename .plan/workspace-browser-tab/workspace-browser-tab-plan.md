# WebUI Workspace Browser Tab Model — Development Plan

**Status:** **Delivered.** All thirteen issues of the board are implemented on
`feat/workspace-browser-tab`, one commit each, and the WebUI gates in §7 pass. The product
decisions are recorded in ADR 0022 and in amendment A8 of ADR 0019, and ADR 0022 now says it is
implemented.
**Date:** 2026-10-21
**Delivered:** 2026-10-22
**Decision authority:** [ADR 0022](../../packages/webui/docs/adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md)
and [ADR 0019 A8](../../packages/webui/docs/adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md)
**Reference material:** [`packages/webui/docs/browser-use/`](../../packages/webui/docs/browser-use/) —
`05-target-identity.md` carries the rules as `required`, `07-review-findings.md` carries round 11,
which is what this plan closes.

This plan is workspace material, and it **is** tracked: the previous programme's plan was left out
of the repository, and an implementer working in a git worktree could not see it. This one is
tracked, so the ticket bodies and ADR 0022 are the decision and this is the programme's record of
it.

## 1. Outcome

The right-hand workspace panel becomes a browser, and the Agent can use it without a person
setting it up first.

A person asks the Agent to open a browser and visit a page. Today every action fails with
`browser_target_unknown`, including the one that should have started it. After this plan:

- The Agent's `open_tab` opens a page, makes it the run's selection, and the tab appears in the
  person's tab strip and becomes the tab they are looking at.
- The panel is a **per-session browser tab strip**. A tab is a stable slot whose content can be
  replaced in place: a new tab page (a launcher with the tool tiles and a URL box), a tool view
  (files, terminal, canvas, changes), or a web page.
- The URL box exists only inside the new tab page. A web tab carries a toolbar instead: back,
  forward, reload, and the URL shown read-only.
- The person and the Agent can work on **different pages at the same time**. The run's selection
  and the tab the person is looking at are two cells with one writer each, and the image stream is
  per target rather than per run.

## 2. Scope

### Included

- The isolated Chromium provider becomes multi-page: one page per web tab, with per-target
  sessions, per-target screencasts and per-target generation accounting.
- The browser service owns the session's web tabs, publishes them to the client as a snapshot, and
  hands the client a per-target image stream.
- The Agent's tool adapter gains the bootstrap path: `open_tab` is the one action a run with no
  selection may perform, and it creates the selection it then acts on.
- The workspace tab model changes from a discriminated union keyed by kind to a stable id plus a
  mutable content descriptor; the strip renders web tabs with the page's title and a default glyph.
- The new tab page: the tool tiles and the URL box, and the transitions between them.
- A web tab's toolbar: back, forward, reload, and the URL shown read-only.
- The release of a session's browser pages when the session goes away.
- Automated coverage: unit tests for every layer, and real-browser acceptance for the Agent's path
  — the gap the acceptance record has carried since the first pass.

### Excluded

- **The external browsers in the panel.** The embedded panel is the **isolated browser's view**,
  permanently. The external browsers are driven in the user's own Edge and Chrome windows, where
  the person sees them and where they are operated, so the panel is not where they are reached and
  never becomes a place where a surface is chosen. The surface concept stays in the runtime — a
  switched-on Edge or Chrome still authorizes the Agent's commands — but the strip is the isolated
  browser's.
- **The browser tool tab.** The tab that stands for the isolated surface today — the surface
  switcher, the target list, the live picture and the input forwarding — is **deleted**, not kept
  alongside the web tabs. Its picture and its input are a web tab's, its target list is the strip's
  tabs, and the switcher was the panel's way of reaching browsers that are driven elsewhere. How
  the Agent picks which of the user's already-open Edge or Chrome tabs to drive is therefore not
  settled by this slice, and the panel is not the place for it.
- **A persistent address bar.** The URL box lives in the new tab page, so a person changes the page
  they are on by opening a new tab. Back and forward cover the common case.
- **Favicons.** A web tab shows the page's title and a default glyph.
- **A history or recommendation area in the new tab page.** That is browsing history, a separate
  store.
- **An Agent action that closes a tab.** The Agent opens tabs; the person closes them.
- **The full dual-driving experience.** A person browsing while the Agent works is *possible* after
  this plan — separate targets, separate streams — but the strip's affordances for it are not part
  of this slice.

## 3. Current implementation baseline

These are source observations, not claims about what the product does.

| Observation | Where |
| --- | --- |
| The provider drives exactly one page and refuses every other target | `isolated-chromium/provider.ts:405` (commands), `:266` (image stream), `:317` (input) |
| `open_tab` creates a page through `Target.createTarget` and returns it, with no session attached and no way to address it | `isolated-chromium/provider.ts:473` |
| The provider attaches to one page at launch and tracks one session id and one generation | `isolated-chromium/provider.ts:218-229` |
| The frame handler and the screencast flag are per provider, not per page | `isolated-chromium/provider.ts:550`; the fields it reads them from are at `:150-155` |
| The tool adapter resolves the surface from the run's selection and refuses without one | `runtime/browser/tool-adapter.ts:146` |
| The refusal reaches `open_tab`, because the action is checked before the surface is resolved | `runtime/browser/tool-adapter.ts:146-152` |
| The service keys selections by surface and then by run | `runtime/browser/browser-service.ts:171-174`, `:205` |
| `sendCommandToSelection` requires an existing selection for every command | `runtime/browser/browser-service.ts:793` |
| The frame stream is per run and follows the run's selection; frames that do not match it are dropped | `runtime/browser/browser-service.ts:588`, `:655`, `:664`, `:733` |
| The provider's teardown is host-wide: the surface's switch being turned off, or `service.close()` | `runtime/browser/browser-service.ts:415-435`, `:906-911` |
| The runtime has no per-session lifecycle signal to release a session's resources | searched `packages/webui/src/runtime` for `deleteSession`, `sessionClosed`, `session_close`, `sessionDeleted`, `onSessionClosed`, `expireSession` |
| The panel re-reads the target list on mount and when the surface changes, and never polls | `client/features/browser/ui/BrowserPanelHost.public.tsx:193-196` |
| The panel writes the run's selection when the person clicks a target | `client/features/browser/ui/BrowserPanelHost.public.tsx:238-245` |
| The panel's input is bound to the panel's own selected target | `client/features/browser/application/browser-commands.ts:282-290` |
| A workspace tab's id is derived from its kind, so the browser kind is one tab per session and directory | `client/features/workspace/projection/workspace-panel-state.ts:251` |
| The tab kinds are a fixed enumeration, and the add menu is a separate ordered list | `client/features/workspace/projection/workspace-panel-state.ts:102-133` |
| The browser panel is mounted by the workspace business as one tab's content, and its kind is the `browser` entry of that enumeration | `client/features/workspace/ui/WorkspacePanels.tsx:25`, `:593` |
| The browser panel is the only place a surface is chosen: it carries the chips that pick between the isolated Chromium and the external browsers, and the target list of the external ones | `client/features/browser/ui/BrowserPanel.public.tsx:207` |
| `sendBrowserCommand` is wired end to end and has no client caller; the provider implements `navigate`, `reload`, `back`, `forward` and `open_tab` | `client/platform/transport.ts:245`, `isolated-chromium/provider.ts:429-476` |
| The client has no browser chrome: no address bar, no back/forward, no reload | searched `packages/webui/src/client` for `address`, `omnibox`, `back`, `forward`, `reload` in UI components |
| The target state already carries a title and a url, and the provider reports both | `shared/contracts/browser.ts:190-196`, `isolated-chromium/provider.ts:232-259` |
| `open_tab` is already in the restricted command set, so the Agent's capability declaration does not change | `shared/contracts/browser.ts:310-340` |

## 4. Architecture and ownership constraints

1. **One writer per cell, with one bootstrap.** The run's selection is written by the Agent, through
   the runtime. The tab the person is looking at is written by the person, through the strip. Neither
   writes the other's cell — with one exception, a bootstrap rather than a co-write: a person who
   opens a web tab while the run has no selection gives the run that page, because a run with no
   selection cannot act at all.
2. **The two cells point at different pages more often than at the same one.** The Agent's actions
   go to the run's selection; the person's pointer, key and text input go to the tab they are
   looking at. When the two cells name the same page — the person clicked the Agent's tab — the
   person and the Agent drive one page together, which is what ADR 0019 already allows.
3. **The generation fence does not move.** A target keeps its four-field identity, a navigation
   raises the generation, and a frame or an input recorded against an older generation is still
   refused. The change is that the fence is now evaluated per target rather than per run.
4. **The isolated Chromium is the only surface a web tab names.** The bridge has no `open_tab`, and
   adding one is extension work that this slice does not do.
5. **The URL box belongs to the new tab page.** A web tab shows the URL read-only and carries
   back/forward/reload.
6. **The strip is per session.** A second session has its own strip, and a tab opened in one session
   is not in another's.
7. **Business boundaries hold.** The strip is the workspace business's; a web tab's page, title and
   url are the browser business's. The workspace business mounts the browser business's published
   surface and does not construct its state.
8. **The tool views keep their owners.** Files, terminal, canvas and changes stay where they are; the
   strip arranges them.
9. **The refusal stays a refusal.** A run with no selection is still refused every action except
   `open_tab`. The bootstrap is an explicit action, not a default.
10. **The names follow the model, and "browser" is not one of them.** The strip is a **tab strip**;
    a slot is a **tab**; one holding a workspace tool is a **tool tab**; one holding a page is a
    **web tab**; the launcher is the **new tab page**. "Browser" keeps its existing meaning — the
    browser being driven, a surface — because one word cannot carry both that and the strip.
11. **The strip is the workspace business's, and the web tab is the browser business's.** The strip
    and the launcher are `client/features/workspace/ui/` (bindings layer); the web tab's host and
    content are the browser business's published `ui/`. The only direction between the two is the
    one the workspace already uses: it mounts a published browser component and calls the
    browser's port. It never reaches into the browser's state.
12. **Neither business is aggregated into the other.** The browser business is a capability the
    Agent uses and has to work without a workspace; merging it into the workspace would leave a
    browser with nowhere to live.

## 5. Work packages

### WP0 — The provider holds one page per web tab

- Replace the provider's single page with a per-target map: target id → session id and generation.
- Resolve the session by target in `sendCommand`, `sendInput`, `startImageStream` and
  `stopImageStream`, and keep the generation check per target.
- Make the screencast and the frame callback per target. The page is found by the **envelope's**
  session id — `event.sessionId`, the flattened target session the connection puts on the event
  (`cdp-connection.ts:237`) — not by `event.params.sessionId`, which is the numeric screencast
  acknowledgement id and not a target.
- `open_tab` creates the page, attaches to it, registers it and returns its identity, so the page
  it creates is a page that can be addressed.
- **The generation has to become per page, and three sites decide that today.**
  `provider.ts:251` reports generation `1` for every page that is not the one the browser was
  launched with, so a second page's generation never moves; `provider.ts:229` sends `Page.enable`
  only to the launch page's session, so a second page never receives the navigation events that
  would raise it; and `provider.ts:532` raises the generation only for the launch page's session.
  All three follow the provider's single `#generation` and single `#pageSessionId`, and all three
  have to follow the per-target map. A page whose generation never advances is a page whose
  recorded references never go stale — the failure the fence exists to prevent — so the fence has
  to be live on every web tab, not only on the first.
- The generation announcement carries the target that changed, and it is already per target in
  shape (`WebuiBrowserTargetChange`); the service's registry advance stays as it is.
- **Done when**: two pages on one surface can each be driven, streamed and input into
  independently, and a navigation on one does not disturb the other's generation.

### WP1 — The runtime owns the web tabs and publishes them

- The service keeps the session's web tabs and the run's selection beside it, and publishes a
  **snapshot** of the web tabs — id, target identity, title, url, and which one is the run's
  selection. A snapshot rather than a delta: the list is small, and a snapshot is idempotent, so a
  reconnect reconciles instead of drifting.
- A new stream operation carries the snapshot, modelled on `watchBrowserFrames`.
- **The frame stream becomes per target, and that is a change to an existing operation's request
  shape, not a second operation beside it.** `watchBrowserFrames` takes `{ surface, runId? }`
  (`shared/operation-names.ts:458`); a per-target stream takes the target instead. The operation
  names, the request and response shapes, the server handler, the transport and the client's
  subscription all change together, and a client that still sends a run id is asking for the run's
  selection.
- **A new operation is not registered by adding a name.** The browser family's readiness is declared
  in `shared/capability-manifest.ts:141-149`, where the `browser.ready` list names the operations
  the family is ready for; a stream operation that is not on that list is not part of the family.
  The name also has to reach the operation registry, the server's handler table, the transport's
  request table and the port.
- The image stream is **per target**: the client asks for the target it is showing, and the frames
  that arrive are fenced to that target alone. The run's selection no longer decides what the person
  sees.
- **The release of a session's pages needs an edge that does not exist yet.** `deleteSession` is a
  binding with no browser-service edge (`server/operation/binding-mechanism.ts:43`), so it is
  not the hook it looks like. And a session is not only removed by deletion: archiving it
  (`archiveSession`) and transferring it away (`runtime/session-transfer.ts:108`) both remove a
  session. A release that only covers deletion leaves a page behind for every archived session,
  so the release has to be keyed on the session's end rather than on one operation.
- **Done when**: the client receives the session's web tabs, can watch any one of them, and a
  session that ends leaves no page behind.

### WP2 — The Agent opens tabs

- The tool adapter gains the bootstrap: a run with no selection may perform `open_tab`, and nothing
  else.
- `open_tab` asks the service to open a page, which observes the new target, makes it the run's
  selection and publishes the new snapshot. The action is refused with
  `browser_surface_not_authorized` when the surface's switch is off, and with
  `browser_capability_denied` when the surface cannot open a tab — the bridge's case.
- Every other action of a run with no selection still fails with `browser_target_unknown`.
- **Done when**: a cold run's `open_tab` produces a page the same run can then navigate, and the
  page appears in the client's strip.

### WP3 — The workspace tab model and the strip

- **The strip is a new component: `WebuiWorkspaceTabStrip`**, in
  `client/features/workspace/ui/` (the bindings layer). `WorkspacePanels.tsx` is already 59kb and
  the strip, the launcher and the toolbar are one more thing in it; they are one piece of work, and
  they are not the same piece as the file tree or the diff.
- The tab shape changes from a discriminated union keyed by kind to a stable id plus a content
  descriptor. The kinds become the content descriptors: the new tab page, the tool views, and the
  web page.
- **The `browser` kind is removed from the enumeration.** It becomes a web tab, and the surface
  switcher it carried goes with it — the isolated Chromium is the only surface a web tab can name,
  so there is nothing to switch between.
- The id is no longer derived from the content, so two web tabs in one session are two tabs. The
  "the same file opens one tab" behaviour moves from the id to a content check.
- **The kind being fixed is load-bearing in more places than the id derivation.** In
  `workspace-panel-state.ts`: `:287-289` drops every other files tab, so there is at most one files
  tab per session and that singleton has to be re-thought; `:279` and `:283` give the workspace
  review and the turn review the **same** id, so one overwrites the other and the two can no longer
  share a slot; `:155-157` derives the label from the kind and the review source; and `:299-303`
  narrows the tab shape on `kind === "review"`. In `WorkspacePanels.tsx` the strip's rendering
  narrows on `activeTab?.kind` in 28 places, and the file results and the review
  summary are cached **by tab id** while their effects depend on `[activeTab?.id]` — with a stable
  id and a changing content, those effects do not re-run and read a stale entry. Every one of those
  sites has to be re-thought against a mutable content, not swept through a rename.
- The strip renders a web tab with the page's title and a default glyph, and keeps the tool tabs
  rendering as they do.
- The panel's input follows the **person's** tab: the pointer, key and text a person produces go to
  the target the tab they are looking at holds, not to the run's selection. Today those are the same
  cell, so the path barely changes; after the split they are not, and an input that followed the
  run's selection would type into a page the person is not looking at.
- The strip stays per session.
- **Done when**: one session can hold two web tabs, both visible in the strip, and switching between
  them does not disturb the other; and a person typing in one tab does not type into the other.

### WP4 — The new tab page and the web tab's chrome

- The new tab page is a launcher: the tool tiles and the URL box. Choosing a tile replaces the
  current tab's content; typing a URL in the box replaces it with a web page, which is a request to
  the runtime to open a page. The launcher is a component of the strip — `WebuiNewTabPage`, in the
  same file — and the URL box is a plain input: opening a page is the browser business's command,
  reached through its port, not through a second published component.
- The strip's "+" is the opener, and it opens a fresh tab showing the new tab page. The add
  menu is not replaced by a launcher over the same button; it becomes the launcher's tiles, and the
  button's meaning changes from "add a tool tab" to "add a tab". A person who wants another URL
  presses "+" again and gets a fresh new tab page, because the one they used is now a web page and
  has no URL box.
- The tool tiles are the add menu's entries today, minus the browser: changes, terminal, canvas,
  files. The browser is not a launcher tile: its kind is deleted, and a web tab is opened by typing
  a URL or by the Agent. The changes
  tile keeps its current requirements — it needs a session and a working directory.
- A web tab carries a toolbar: back, forward, reload, and the URL read-only. These use the
  `sendBrowserCommand` path, which is already wired and has no client caller.
- The person opening a web tab does **not** move the run's selection, unless the run has no
  selection at all — in which case the new page becomes it, so that a person who opened a page and
  then asked the Agent about it gets that page. That bootstrap is decided at the moment the page is
  opened, from the run's selection at that moment; it is not a standing rule that the person's tab
  and the run's selection are the same.
- **Done when**: a person can open a web tab from the launcher, type a URL into it, navigate it
  back and forward, and the Agent's own page is unaffected.

### WP5 — Acceptance

- Real-browser acceptance for the Agent's path: a real isolated Chromium, the Agent's tool opening a
  real tab, the client's strip gaining the tab, the picture updating, and the person taking over.
- Unit coverage for every layer: the provider's per-target behaviour, the service's snapshot and
  release, the adapter's bootstrap, the strip's state machine, and the launcher.
- The acceptance record is rewritten from the new run, and the gap it carried — that the Agent's
  tools had never been driven against a real browser — is closed.
- The run's records go to this plan's own completion directory,
  `.plan/workspace-browser-tab/complete/`, and the suite that writes them names that path in
  `packages/webui/test/browser/acceptance-record.ts`. A second plan's records must not land on top
  of this one's.
- **Done when**: the acceptance record carries a real-browser row for the Agent's path.

## 6. Acceptance matrix

| Case | Surface | What has to be observed |
| --- | --- | --- |
| The Agent opens a tab | isolated | A page exists, the run's selection points at it, and the client's strip shows it **and makes it the active tab** |
| The Agent navigates after opening | isolated | The page is at the requested url and the picture follows |
| The Agent acts on a page it did not open | isolated | The action runs on the run's selection, and a stale reference is still refused |
| A person opens a tab while the Agent works | isolated | The Agent's page and the person's page are different, and each shows its own picture |
| A person opens a tab while the run has no selection | isolated | The run's selection becomes the person's page, so the Agent can act on it |
| A person types into their own tab while the Agent works | isolated | The input reaches the person's page, not the Agent's |
| A person types a url in the launcher | isolated | The tab becomes that page, and the url is shown read-only in the toolbar |
| A person closes a web tab | isolated | The page is released, and the runtime's page set follows the strip |
| Back and forward | isolated | The page moves through its own history, and the generation follows |
| The surface's switch is off | isolated | The Agent's `open_tab` **and** the person's launcher path are both refused with `browser_surface_not_authorized` |
| A run with no selection acts | isolated | Every action except `open_tab` is refused with `browser_target_unknown` |
| A session ends — deleted, archived or transferred away | isolated | Its pages are released and no page is left behind |
| A second web tab in one session | isolated | Both are addressable, and the strip shows both |
| A page navigates | isolated | Its generation advances, and a reference recorded against the old generation is refused — on **every** tab, not only the first |

## 7. Verification plan

The gates are run **once, at the end of the whole slice** — this is one block of work, and running the
repository's gates per work package would spend the time on gates that cannot pass until the slice
is finished.

| Gate | Command | Covers |
| --- | --- | --- |
| Types | `pnpm typecheck:webui` | The contract changes across runtime, server and client |
| Unit and gate tests | `pnpm test:webui` | Every layer's unit coverage, plus the dependency and source gates in the suite |
| Dependency direction | `pnpm check:webui-dependency` | The new cross-business import (the workspace business mounting the browser business's published page) |
| Build and boundary | `pnpm build:webui` then `pnpm check:webui-boundary` | The bundle, and that the new operation is wired |
| Source projection | `node scripts/source-inventory.mjs --write` then `pnpm check:source` | The new files in the published inventory |
| Real browser | `pnpm test:webui-browser` | The Playwright suites, including the new Agent-path acceptance |

The repository's full gate is not run: this slice touches the WebUI only, and the repository-level
gates cover ground this change does not move.

## 8. Delivery order and dependencies

```
WP0 (provider) ──┐
                 ├── WP2 (Agent opens tabs) ──┐
WP1 (runtime) ───┘                          ├── WP4 (launcher and chrome) ── WP5 (acceptance)
                 └── WP3 (tab model) ────────┘
```

WP0 and WP1 are the runtime half and can be built in either order; WP2 needs both, because the
bootstrap asks the service to open a page. WP3 is the client half and can be built against the
contracts alone. WP4 needs WP3's content model. WP5 needs the whole slice.

## 9. Completion definition

The slice is done when:

- A person asks the Agent to open a browser and visit a page, and it happens.
- The tab appears in the person's strip, and the person can take it over.
- The person can open a second tab and use it while the Agent works in the first.
- Every rule ADR 0022 pins is `implemented` in [`05-target-identity.md`](../../packages/webui/docs/browser-use/05-target-identity.md),
  and round 11 of the review findings is closed.
- The acceptance record carries a real-browser row for the Agent's path, and the gap it has carried
  since the first pass is gone.
- The WebUI gates in §7 pass.

## 10. Execution board and handoff

**The board exists.** It is [`.plan/workspace-browser-tab/board/`](board/) — the specification, one
ticket per issue, and the handoff — and the same work is tracked as GitHub issues #199 (the
specification) and #200 to #212 (one per issue) on `mcode-webui/minimax-code`. The previous
programme's board is [`.plan/browser-use/board/`](../browser-use/board/) and belongs to the
extension and bridge work; this slice is a different body of work with a different boundary.

The rules the previous programme's board followed apply here:

- A ticket may not depend on this plan alone: everything an implementer needs goes into the ticket
  body and into ADR 0022. The plan is tracked now, but the decision is still ADR 0022's.
- If implementation evidence contradicts ADR 0022, amend the ADR first, then re-scope the ticket.
- The first ticket is the technical validation one: the provider's per-target behaviour and the
  service's snapshot are what every later ticket is written against.
