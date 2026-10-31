# The Browser Core layer

**Status:** `implemented` throughout. Every row names the file that carries it, and every claim is
about the tree of this branch. Nothing here was measured on a probe host; the evidence is the source
and the suites named in each section.

## What this document owns

Browser Core is a workspace package, `@mavis/browser-core` (`packages/browser-core/`), that owns the
**semantics** of a browser action: element references, retained snapshots, action deadlines, effect
validation, and the navigation fence. It reaches a browser through a transport contract,
`BrowserTransport`, and knows nothing about any particular browser, browser panel, or authorization
switch.

The WebUI consumes it on **both** of its browser surfaces. This document is the authoritative
explanation of that layer. Other documents in this directory state the surface-specific consequences
and link back here; they do not restate the design.

| Concern | Owner | Where |
| --- | --- | --- |
| The action semantics | `@mavis/browser-core` | `packages/browser-core/src/` |
| The transport contract | `@mavis/browser-core` | `packages/browser-core/src/browser-transport.ts` |
| The isolated Chromium's transport | the WebUI | `packages/webui/src/runtime/browser/isolated-chromium/core-transport.ts` |
| The bridge's transport | the WebUI | `packages/webui/src/server/browser-bridge/core-transport.ts` |
| Which action may run | the WebUI's service and authorization | `packages/webui/src/runtime/browser/authorization.ts`, `browser-service.ts` |
| Which DevTools method the extension will send | the extension | `packages/browser-extension/src/cdp.ts` |

The split is the one that matters: **Browser Core decides what an action means, the WebUI decides
whether it may run, and the transport decides how the command travels.** A transport never decides an
action's meaning, and Browser Core never reads an authorization switch.

## Why the layer exists

Before this layer, the isolated-Chromium provider answered a restricted browser-tool action by
translating it into a raw DevTools method itself. That worked for the seven actions that are one CDP
call wide — `navigate`, `reload`, `back`, `forward`, `screenshot`, `get_dom` and `open_tab` — and
could not work for the other **21** of the 28. `click` and `type` take an opaque element reference,
and turning one into a coordinate needs the element map, the retained snapshot and the generation
check. The provider had no element map, so it **refused those actions rather than guessing where a
click should land** — including `inspect` and `query`, so the Agent could not even name an element
to click.

The refusal was honest but it was a capability gap, not a semantic one: the action vocabulary said
`click`, and the surface could not do it. With Browser Core in place, the same vocabulary is executed
by one implementation on both surfaces, and the difference between them is a difference of what the
browser can do — not of what the WebUI knows how to express.

The bridge was narrower still. It had its own action path, mapping five of the 28 restricted actions
— `navigate`, `reload`, `back`, `forward` and `get_dom` — onto one DevTools command each, and
refusing every other action rather than guessing at it. Its `back` and `forward` asked the tab for
its navigation history and **answered with the history**: the page never moved. So the same action
meant two different things on the two surfaces, and the external one meant something that was not
an action at all.

The TUI drives the same package (`packages/tui/src/runtime/browser/headless-chrome-provider.ts`), so
the two clients share one definition of what `click` means.

## The transport contract

`BrowserTransport` (`packages/browser-core/src/browser-transport.ts`) is the whole seam. A transport
supplies:

| Member | What it is for |
| --- | --- |
| `sessionId` | which page this transport addresses; the core uses it to tell one page's event from another's |
| `send` | one DevTools command |
| `evaluate` / `evaluateInAllFrames` | evaluating an expression in the page's own context |
| `onEvent` | subscribing to the page's DevTools events |
| `waitForEvent` | waiting for one event, or for a deadline |
| `start` / `stopLoading` / `resetConnection` / `close` | the page's lifecycle, as the core sees it |

Both adapters implement the same contract and differ in exactly the ways the two surfaces differ.

### The isolated Chromium's transport

`WebuiIsolatedChromiumCoreTransport` (`packages/webui/src/runtime/browser/isolated-chromium/core-transport.ts`)
drives a page over the CDP connection the provider already holds. It does **not** open a second
connection: two connections to one DevTools endpoint would mean two independent protocol views of the
same browser, and the core's generation would then disagree with the panel's about the same page.

Three behaviours are worth naming, because each is a decision rather than a default:

- **Events are filtered by session.** The connection carries the events of every page in the browser.
  A core that saw another page's navigation would raise its own generation and invalidate its
  references, so a page that never navigated would lose them because a sibling tab moved. A
  browser-level event (no session id) belongs to every page and is passed through.
- **Errors are renamed, not judged.** The core reads an interruption's code to decide what it means:
  `ABORTED` (a cancelled command did not happen), `BROWSER_OPERATION_TIMEOUT` (a timed-out one may
  still be running and is the only kind that may require a connection reset), and
  `BROWSER_TRANSPORT_CLOSED` (the transport is gone). The WebUI's own codes say the same three
  things, so the translation is a renaming. An error the translation does not recognise is passed
  through unchanged — a failure the core does not know about is an ordinary failure, and making it
  look like an interruption would reset a connection that is fine.
- **The page's lifecycle belongs to the provider.** `start` and `close` are no-ops: the page is
  already attached and enabled by the time the core sees it, and closing a page of this browser is the
  provider's decision, not the core's. `resetConnection` is also a no-op, because the isolated
  Chromium keeps one connection for the whole browser and replacing it would replace every page's.

### The bridge's transport

`WebuiBridgeCoreTransport` (`packages/webui/src/server/browser-bridge/core-transport.ts`) drives a tab
of the person's own browser, over the bridge's existing DevTools command channel. The bridge is not a
DevTools connection, and that shapes the adapter in two ways that have no counterpart on the isolated
side:

- **A command is a request and an answer, not a session.** The extension answers one `cdp` frame with
  one `cdp-result` frame, so there is no session to address: the transport sends to the tab it was
  made for. A command that names another session is refused rather than routed, because routing it to
  this tab would run it on the wrong page.
- **There is no event channel.** The extension does not forward DevTools events, and adding one would
  change the protocol the extension and the host are pinned to. `onEvent` returns an empty
  subscription and `waitForEvent` resolves with `undefined` once the deadline passes.

The navigation is therefore reported a different way. The extension **owns** the generation of a tab
and raises it on each committed top-level navigation, announcing the new generation in its `targets`
frame; the host sees the generation move, and a moved generation is a navigation. That is what
`synchronizeGeneration` (`packages/browser-core/src/browser-core.ts:251`) is for: it invalidates the
core's references after a navigation the core itself did not observe.

The two surfaces do not agree on the trigger, and the difference matters: the isolated Chromium's
generation rises when the main frame navigates, while the extension's rises when a top-level document
is **committed**. A navigation that never commits — one that is cancelled, or that fails — moves
neither. What both agree on is the moment that matters: a reference recorded before the document
behind the tab was replaced is stale afterwards, and must be refused rather than acted on.

The two generations are tracked separately and never read across. The provider's listener runs before
the core session's own listener, so it cannot read a value the core has already incremented, and
calling `synchronizeGeneration` from it would double-increment. The same event drives both, and
neither reads the other's counter.

## Who executes a restricted action

The restricted vocabulary is `WEBUI_BROWSER_RESTRICTED_COMMANDS`
(`packages/webui/src/shared/contracts/browser.ts:428`), 28 names. It is the WebUI's own gate: it says
which commands may be sent without Full CDP access, and `isBrowserCommandAllowed`
(`packages/webui/src/runtime/browser/authorization.ts:140`) reads it in
`WebuiBrowserService.sendCommand` (`packages/webui/src/runtime/browser/browser-service.ts:1117`).

It says nothing about **who executes** one. That is now Browser Core, on both surfaces:

| Surface | Path | Evidence |
| --- | --- | --- |
| Isolated Chromium | `provider.sendCommand` → `session.execute` | `packages/webui/src/runtime/browser/isolated-chromium/provider.ts:829` |
| Edge / Chrome (bridge) | bridge provider → `session.execute` | `packages/webui/src/server/browser-bridge/server.ts:843` |

Two actions are answered by the surface itself rather than by the core, because they are about the
run's pages rather than about one page:

| Action | Isolated Chromium | Bridge | Why |
| --- | --- | --- | --- |
| `open_tab` | the provider answers it | **refused** with `browser_capability_denied` | `chrome.debugger` cannot open a page in the person's browser |
| `return_to_previous_tab` | **refused** with `browser_capability_denied` | refused | it moves between the pages a **run** has open, and the run's pages are the service's record, not the provider's |

A refusal names the fact rather than pretending the page could not do it: the page is fine, and the
request is about something the page does not know.

## What the surfaces still cannot do

The two surfaces are not interchangeable, and the differences are properties of the browsers rather
than of the WebUI's knowledge.

### `upload_files` on the bridge

`upload_files` needs `DOM.setFileInputFiles`, and that method is **deliberately absent** from the
extension's allowlist (`packages/browser-extension/src/cdp.ts`). The extension's debugger could run
it; what it must not do is give the Agent a way to name an arbitrary local file in the user's real
browser. The privacy cost is higher than the capability is worth, so the method is not on the list
and the action therefore fails: the bridge's command path maps the extension's
`unsupported` refusal to `browser_capability_denied`, so the action is refused because its
**method** is not available, not because the action's name is special-cased.

This is a **capability difference, not a semantic difference**. The isolated Chromium performs the
same action with the same semantics; the bridge cannot. It is recorded in
`packages/webui/src/server/browser-bridge/core-transport.ts` at the top of the file.

**Not pinned by a test.** No suite covers `upload_files` on the bridge path — the vocabulary test
names the action, and nothing asserts the refusal. A future change to the allowlist would silently
widen this surface.

### Screenshots on the bridge

The bridge's `screenshot` works, and it works differently. `Page.captureScreenshot` is not on the
extension's allowlist either, for the same reason: a DevTools screenshot could capture **any** tab on
demand, including the ones the person is not looking at, while `chrome.tabs.captureVisibleTab` can
only capture the visible one.

So the bridge takes its pictures from the extension's own **pushed** stream of the tab in front —
which is exactly a picture of the tab the person is looking at — and passes it to the core through
the `captureScreenshot` hook (`packages/browser-core/src/browser-state.ts:119`). A tab that is **not**
in front therefore has no picture to give, and its screenshot is refused with
`browser_capability_denied` rather than answered with somebody else's page.

The seam is the point: the core asks for a picture, and the bridge answers it from the only source
that cannot see a tab the person is not looking at.

## The element reference

`inspect` returns an opaque reference of the form `browser-element:<generation>-<uuid>`. It is
opaque on purpose — the Agent does not get a coordinate, a selector or a node id it could carry
across a navigation.

The core owns the element map and the retained snapshot, and it enforces the reacquire rule rather
than leaving it to the caller:

| Situation | What happens |
| --- | --- |
| A reference is used against the page it was recorded on | accepted |
| A reference is used after that page navigated | refused with a stale-reference refusal — `STALE_ELEMENT_REF` or `STALE_SNAPSHOT`, depending on which check trips first |
| A reference is used against a page that did **not** navigate | still accepted |

The last row is the one that distinguishes a real fence from a blanket invalidation: a page that
did not move keeps its references even when a sibling page moved.

This is enforced by the host, not by a convention on the caller. `packages/webui/docs/browser-use/05-target-identity.md`
describes the generation counter that makes a stale reference detectable; the **command** path's fence
is the core's (`STALE_ELEMENT_REF`, `packages/browser-core/src/browser-action-targets.ts`), and it is
distinct from the **input** path's `browser_target_stale`.

## The failure vocabulary

Two error vocabularies meet here, and the boundary between them is deliberate.

| Where | Shape | Who reads it |
| --- | --- | --- |
| The core's transport layer | `ABORTED`, `BROWSER_OPERATION_TIMEOUT`, `BROWSER_TRANSPORT_CLOSED` | the core, to decide what an interruption means |
| The core's action layer | `STALE_ELEMENT_REF`, `STALE_SNAPSHOT`, and the other action errors | the Agent, to decide whether to inspect again or to pick another element |
| The WebUI's own codes | `browser_target_stale`, `browser_capability_denied`, `browser_provider_unavailable`, … | the service, the panel and the client's refusal branches |

The core's action errors are raised **as they are**, because the code they carry is what tells the
Agent whether to inspect again, to pick another element, or to try something else. Flattening them
into one failure would leave the Agent guessing.

The one place the vocabularies are translated is the **panel boundary**
(`packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx`): the core answers a
`success: false` result, and the panel turns it into the `browser_capability_denied` the client
already branches on. The provider itself returns the core's answer unchanged — the Agent's tool path
reads the `success` field, and the panel's toolbar expresses failure as an exception. Each path
consumes the expression that suits it.

## The evidence

| Suite | What it proves | Level |
| --- | --- | --- |
| `packages/webui/test/integration/browser-core-agent-actions.test.ts` | the Agent's `inspect` → `click` → `type` against a **real** Chromium through the core; a reference recorded before a navigation is refused, and one that is still current is accepted | real browser |
| `packages/webui/test/unit/browser-bridge-core-actions.test.ts` | the core's action path over the bridge; a stale reference is refused; a screenshot is answered with the picture the extension streams; a screenshot of a tab that is not in front is refused | wiring, with the extension as a test double |
| `packages/webui/test/unit/browser-restricted-commands.test.ts` | the restricted vocabulary cannot drift: it holds only actions the runtime's contract declares, it holds every action the runtime's aggregate tool accepts, and it lists each action once | pure behaviour |

All three are registered in `test/vitest-suites.json` under `suites.webui`.

**Not covered:** `upload_files` on the bridge path has no suite, as noted above.

## Related

| Concern | Document |
| --- | --- |
| What each surface offers, and the two bridge exceptions | [`01-capability-matrix.md`](01-capability-matrix.md) |
| The `cdp` frame and the extension's allowlist | [`02-bridge-protocol.md`](02-bridge-protocol.md) |
| The target identity and its generation | [`05-target-identity.md`](05-target-identity.md) |
| Each authorization switch traced to its enforcing place | [`06-runtime-authorization-trace.md`](06-runtime-authorization-trace.md) |
| The decisions this layer implements | [`../adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md`](../adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md) |
