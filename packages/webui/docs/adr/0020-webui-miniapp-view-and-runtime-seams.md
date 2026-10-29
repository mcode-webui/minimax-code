# WebUI Mini App view and its runtime seams

**Status:** Product direction accepted and implemented in the Mini App hosting stack.
**Date:** 2026-10-20, revised 2026-10-26.

The WebUI will host Mini Apps. A Mini App's page is rendered as an iframe the client loads
from a loopback origin that the WebUI service proxies. The Mini App's own page bridge — the
`window.mcode.miniapp.*` namespace a Mini App page uses to call its host — is provided by a
browser build of the desktop client's preload bridge, injected by that same proxy.

Both presentations belong to the client. **Inline**, the Mini App view occupies a tab inside the
WebUI workspace panel. **Standalone**, a browser tab is opened through a URL deep link; the tab runs
the full WebUI client, but the only content it shows is the Mini App view. The standalone view has no
in-page close control: the tab is the Mini App's own. The deep link selects a session and a Mini
App, and the service injects its runtime configuration into every page it serves, so a tab opened
this way is an ordinary client with the same credential as any other.

The Mini App page is a first-party plugin page. The desktop client hosts it in a native
`WebContentsView` and draws none of it; the browser and Electron are both Chromium, so the page
itself renders identically in the WebUI. Everything the port actually needs from the desktop
client is three capabilities, and each has a browser-side counterpart.

## What the browser cannot do, and what replaces it

1. **Injecting the loopback credential.** The desktop client injects the Host-issued credential
   into the Mini App's own requests with `session.webRequest.onBeforeSendHeaders`. A browser
   cannot add a header to an iframe navigation or to the page's subresources, so a Mini App
   reached directly is rejected by the guard. The WebUI service therefore proxies the Mini App's
   origin, and injects the credential there. The guard is carried over into this repository as part
   of this port, so the proxy injects into a contract that exists here rather than one it invents.
2. **Injecting the page bridge.** The desktop client injects the bridge with a preload
   (`contextBridge.exposeInMainWorld`). A parent page cannot script a cross-origin iframe, so the
   bridge cannot be installed from the client. The proxy rewrites the Mini App's HTML and injects
   a browser build of the same bridge. The bridge reaches the host over `postMessage` to the WebUI
   client, which already holds the client credential and the stream.
3. **Hosting the page.** The desktop client positions a native view with `setBounds`. The browser
   uses an iframe, whose placement is the document's own layout. This is strictly simpler: the
   coordinate protocol the desktop client needs to keep the native view aligned with the panel
   does not exist here.

The proxy must listen on its own loopback origin, separate from the WebUI's own origin. Serving a
Mini App from the WebUI's origin would make the iframe same-origin: it would then run in the
WebUI's renderer process, so a hung Mini App page would hang the whole client, and the page could
read the WebUI session token off its parent frame. A separate origin keeps the page in its own
process and keeps the client credential out of its reach. The Mini App view is therefore **not**
sandboxed; its isolation comes from origin separation, not from a sandbox attribute. That is the
opposite of the workspace file preview, which deliberately renders an untrusted document in a
sandboxed, opaque-origin iframe.

The bridge travels to the page through the proxy's HTML rewrite, and its calls travel from the page
to the client over `postMessage`. The client is the host of that conversation: it validates that the
message's source is the iframe it created and that its origin is that Mini App's origin. The obvious
alternative — the proxy exposing the bridge's endpoints on the Mini App's own origin, so the page can
`fetch` them same-origin — is rejected and recorded here so it is not re-proposed. The guard strips
the credential from the page's own requests before plugin code sees them, so those endpoints would
carry no identity of their own: any local process that computes the Mini App's deterministic port
could drive a host-authorised call through them, which is a strictly larger hole than the one the
guard closes. Closing it would need a second per-page secret, and the page and its host would then
hold two credentials instead of one.

## What is not carried over

- **Native window semantics.** The desktop client's detached presentation is a separate operating
  system window with always-on-top, click-through, transparent, frameless and skip-taskbar options
  and persisted window bounds. A browser tab cannot express any of them. The WebUI keeps the part
  that a browser can honour — the Mini App alone on screen, and a tab the user can drag to a second
  display — and drops the native window options.
- **The page-side window handle.** Dropped from the contract rather than emulated, because the
  reason is stronger than "the browser cannot". The shipped generation adds a third part to the
  bridge namespace — `window.mcode.miniapp.window` with `getState`, `update` and `focus`, a manifest
  `surface.window` whitelist of size, `frame`, `transparent`, `alwaysOnTop`, `clickThrough` and
  `skipTaskbar`, and a Chromium argv surface id — and that block is the page asking for its own
  native window, bounds and visibility. Beyond the browser's inability to express any of it, the
  block grants the page a say in *how it is presented*, and presentation is this client's decision.
  A Mini App appears in its own tab because the client opened one, never because the page asked.
- **Host-to-page injection.** The desktop client can inject into an embedded page: the agent cursor
  overlay and the comment bridge. A cross-origin Mini App page cannot be reached that way, so a
  Mini App page does not get them.
- **Moving one live page between presentations.** The desktop client moves the same
  `WebContents` into a window and back into the File Panel, so the page is one instance with one
  state. A browser tab is a separate document. A Mini App shown in two places is two documents:
  server-side state is shared, in-page state is not. The two presentations are therefore two client
  documents, and the service keeps the record of which one is live.

## The contract baseline

The Mini App contract in this repository was one generation behind the Mini App implementation
shipped in the desktop client: 54 lines here against 1267 there. This record takes the shipped
generation, minus the window block.

The mechanics are cheap, and the borrow is auditable rather than a blanket import of internal code.
The shipped file's only import is
`./questionnaire.js`, and this repository's copy of that file is byte-identical, so the borrowing is a
content edit to one existing file: no new path, no workspace dependency, no inventory regeneration.
`diff` shows the newer generation to be a strict superset of this repository's file from line 7
onward, and it is taken as one contiguous copy of the shipped leading part rather than as scattered
patches — but that part is not line-for-line identical to today's 54 lines. The shipped file opens
with a six-line type-only import, and it adds `detached` and `presentationRevision` to the tab
summary and `detach_failed` and `attach_failed` to the error codes, which moves
`MiniAppOpenResponse` and `MiniAppControlResponse` below the new start and page-open types. Nothing
here has a consumer for the response types whose shape changes — `MiniAppSurfaceTabSummary`,
`MiniAppListResponse`, `MiniAppOpenResponse` and `MiniAppControlResponse` are declared and unused —
so adding required fields and error codes breaks no call site.

What the borrowing brings:

- The split between starting a Mini App and opening its page: `MiniAppStartResponse`,
  `MiniAppPageOpenInput`, `MiniAppBackgroundOpenInput` and one `MiniAppOpenApi` with two overloads.
  This client needs it as soon as it prewarms a Mini App the way the desktop client does, and the
  runtime seam below depends on it.
- `detached` and `presentationRevision` on the tab summary, plus the `detach_failed` and
  `attach_failed` codes. In this client they are not dead fields: `detached` reports whether a
  standalone presentation is live, and the revision increments on each acquisition.
- `MINIAPP_LOOPBACK_TOKEN_HEADER`, the name of the credential the proxy injects.
- The composer block: the request, the reply, the bounded text limit and the one validator both ends
  of the bridge share.
- The agent block: every request and result shape, the nine run events, the failure codes and their
  mapping from the runtime's own codes, and the allowlist validators the shipped preload and broker
  run on both sides of the boundary.

What the borrowing leaves behind is the window block: the argv surface id, the `surface.window`
manifest whitelist, and the window state and patch contracts that the page's
`window.mcode.miniapp.window` handle (`getState`, `update`, `focus`, defined in the preload rather than
here) is built on — `MINIAPP_SURFACE_ID_ARGUMENT_PREFIX`, `MINIAPP_SURFACE_WINDOW_*`,
`MiniAppWindowState`, `MiniAppWindowPatch` and their parsers. It is the last contiguous
region of the file, so a future synchronization reads as one omitted tail rather than as a series of
local divergences. One private helper has to come out of that tail: `isPlainRecord` is declared
inside the window block but used nine times by the agent parsers above it, so it is kept at the seam
between the copied part and the omission, and it is the one local divergence to reconcile against a
future copy.

Two consequences follow for the layers around the contract. The manifest reader must accept the
three keys the newer generation declares and this repository's reader does not know: `surface.window`,
`agentAccess` and `agentConcurrency`. Its field sets are strict, so an unknown key fails the package
as `MANIFEST_SCHEMA_INVALID` — a package built for the shipped client is rejected before any of this
work can matter. Accepting is not supporting: `surface.window` is read and ignored here, because its
effect was just dropped from the contract, while the two agent fields are validated and preserved here
so the agent service can enforce them when it lands.

## The credential guard is carried over

The shipped client guards the Mini App's own HTTP server from inside the Mini App's process: the
runner patches `http.Server.prototype.emit` before the plugin entry is imported, so any server the
plugin creates is covered. A request event must carry the exact loopback `Host` and a timing-safe
match of the credential header, or it is answered 401 with no body; `upgrade` and `connect` sockets
are destroyed instead. On success the header is removed from both `headers` and `rawHeaders`, so
plugin code never observes it. One reserved path is answered 204 by the guard itself, which is what
lets the readiness probe prove the guard is in the path rather than merely that a socket accepts:
readiness becomes "anonymous must be 401, credentialed must be 204" instead of a TCP connect.

This port carries that guard. The previous revision treated it as an option, on the grounds that
having no guard is not worse than having no Mini App service at all. That comparison holds only while
the service is off. The moment this client's row enables it, the exposure is new, and it is not
theoretical: the Mini App's port is deterministic — `49152 + sha256(pluginId)` across the range, with
a persisted preferred port first — so a local process can compute it rather than scan for it. A
credential is also the only thing that can distinguish the proxy's own requests from those of every
other local process, and the proxy is the only party that can inject it.

The cost is bounded and lands in the runtime: the guard, one credential per process generation
threaded through the runner's init message, the supervisor's launch credential so the proxy has
something to inject, and the readiness change above. The credential never reaches the page, and it
never reaches the client: the proxy holds it.

## Runtime seams

Three changes make the Mini App capability reachable from this client. None of them introduces
new domain behaviour; they expose what the runtime already owns.

- **The Mini App service is enabled for this client's runtime owner kind.**
  `resolveRuntimeMiniAppOptions` in `packages/local-runtime-v2/src/service/miniapp/composition.ts`
  returns no options unless the owner kind is `electron`, so in the WebUI process the Mini App
  supervisor is never initialized and `miniappAvailable` is false. That gate becomes a cell of the
  runtime owner policy instead of a kind comparison of its own. The policy table
  (`packages/local-runtime/src/runtime/runtime-owner-policy.ts`) already resolves once per host and
  already drives the other owner-derived service gates — `wiring.cronService`,
  `wiring.channelService`, `wiring.schedulerHost` — from that one descriptor; the Mini App gate
  is decided outside it, which is why a change to this client's row cannot reach it. The Mini App
  service becomes `wiring.miniAppService`, this client's row carries it, and both places that read
  the function — the service composition and the `miniappAvailable` capability flag — read the cell
  instead, so the flag can no longer disagree with the service.

  The cell carries one trap. Every row must state it as a literal: the existing
  `ownsElectronRuntimeCapabilities` predicate answers true for an owner that declared no kind, and a
  service enabled for an absent owner is a behaviour change no client asked for. This is also the one
  owner-derived gate where the Mini App service is stricter than cron or channels. The explicit
  Mini App options the function already accepts stay reachable for every row that carries the cell,
  because a test builds a runtime with them and no declared kind and expects the supervisor to exist;
  `resolveRuntimeMiniAppOptions` keeps that override and takes the cell as its other input. The owner
  policy's own suite pins the wiring key set and the count of cells where this client's row differs
  from `tui`, so both move with the cell.
- **The control plane enters the harness as a forwarding facade.** The desktop client keeps the
  Mini App control plane in its Electron main process, behind IPC channels that reach a utility
  broker; there is no Mini App method on `CliService` there or here. The runtime already owns the
  behaviour in
  `packages/local-runtime-v2/src/application/session/process-local-miniapp-application.ts`, which
  lists, opens and stops Mini Apps. Half of that already crosses: the management operation's `listApps`
  action resolves to this application's `list`, so the client receives rows with their runtime phase as
  soon as the service exists. Only `open` and `stop` still need a client action. The client entry is a
  forwarding method on `CliService` over that
  application, bound as a WebUI operation in the usual five places. The WebUI does not reimplement
  Mini App lifecycle logic in its server, and it does not reach around the facade into the
  application bag.

  Two additions to the application follow from the other decisions here. It needs a start that does
  not open a page: this client prewarms a Mini App without showing it, which the contract expresses as
  `openPage: false` and which the shipped client reaches through a start-if-cold path rather than
  through `open`. And it needs to hand the credential and origin to the
  server: `launch` is documented as server-only coordinates that must never be forwarded to a
  renderer, and this design honours that literally. The client receives the proxy's own view URL,
  including the runtime-selected surface path needed to load the page, but never the Mini App's
  origin or its credential. Everything that touches a Mini App's real origin stays on the server
  side of the facade.
- **The presenter stays a host-owned port.** `MiniAppPresenter` is documented as the desktop
  client's native presenter and is absent outside it. The WebUI supplies the browser
  implementation: its `open` means the client should show that Mini App, and its `close` means the
  client stops showing it. The port's shape — open and close by session and plugin — is already
  platform-neutral, so the browser implementation fits it without changing the contract.

  The ordering matters more than it looks. The agent tool's own `open` action throws
  `OPEN_UNAVAILABLE` when the runtime has no presenter, while `list`, `init`, `publish`, `restart` and
  `stop` start working the moment the service cell is flipped. Enabling the service before the
  presenter exists would therefore ship a half-live capability: the agent could publish and start a
  Mini App that nothing can display. The presenter, the view it opens and the cell belong to one
  change.

## The agent capability is in scope

A Mini App page's agent calls are part of this port. They are also the largest piece of it, and the
one place where the work is not a client-side rewrite of something the runtime already does.

The acceptance standard here is parity with the desktop client's page: an installed Mini App must
render and work in this client as it does there. A page that probes the bridge when it loads must not
find a method missing, because the visible result is a dead panel rather than a graceful degradation.
That is why the composer alone is not a smaller first version of this decision — it is a different,
insufficient one.

The shipped client's agent path is a runtime capability this repository does not have: a Mini App
gateway that owns per-plugin arenas, queues and turn lineage; a session-ports layer through which a
plugin creates and drives host sessions; a projection that decides what a plugin may see of them; the
application facade that fronts all of it; and the child-side client that the plugin's own process
calls. None of those files exist here, and the plugin manifest fields that gate them —
`agentAccess` (only `session.run` today) and `agentConcurrency` — are rejected by this repository's
reader as unknown keys.

The connector's wire has to move with it, and the reason is not a preference. In this repository the
host connector *is* the child's stdout: the child's stdout is the request stream and its stdin the
response stream, framed as strict NDJSON. When the connector is disabled, a single byte on stdout
aborts the whole Mini App runtime as a protocol violation; when it is enabled, the same byte corrupts
a frame. The child does already have a parent channel — every Mini App is spawned with a fourth IPC
file descriptor, and the runner's own comment says what it is for: that channel controls lifecycle,
while the standard streams are reserved for the connector. The shipped runtime keeps the channel and
changes what rides on it: connector frames are multiplexed onto the same descriptor by message type,
the child's stdin is dropped entirely, and stdout and stderr become logs. An agent-enabled Mini App
logs — it runs turns, tools and model calls — so the two protocol families cannot keep sharing one
stream. Adding a second channel for agent calls alone while leaving tool calls on NDJSON would still
break the tool channel on the first log line, and it is a shape the shipped client never had, so
nothing upstream would ever confirm it works. The connector therefore moves onto the existing
channel for every Mini App, not only the agent-enabled ones: one channel carries both message
families, told apart by the message type, the child's stdin stops being used at all, and stdout and
stderr become logs. That is this record's decision rather than an assumption, and the
dual-transport alternative stands rejected for the reason just given.

What that costs, measured against the shipped package rather than estimated: roughly 2900 lines of
runtime service (gateway, session ports, contracts, projection, model selection), a rewrite of the
host connector from 1700-odd lines across four files into 2900 across six, the transport binding
itself, and a new application file. It is the single largest forward port in this record, and it
carries its own review: the connector is shared with tool calls, so a defect there is not confined to
Mini Apps.

One surface inside it has no counterpart that looks like the shipped one: a page's `open` call. It is
not a cosmetic button. In the shipped runtime the host chat's side panel is what makes a
Mini-App-created session's permission asks answerable — the gateway denies an approval for such a
session unless some host chat is currently showing it. This client has no side panel, and the workspace
panel cannot be one: it hosts the selected session's own resources, while the client renders one
selected session at a time, so a second transcript beside the first would need a second conversation
surface rather than one more tab kind.

The mapping is the session rail plus the standalone presentation. `open` selects that session through
the client's ordinary selection path; while it is the selected session the service reports the panel as
showing it, and switching away or closing it reports the panel as closed. `hostSessionId` is the
session whose workspace panel carries the inline view — or, for a standalone tab, the session its deep
link carried. The arrangement a person gets is not the shipped client's side-by-side chat and panel:
selecting the Mini App's session replaces the workspace panel, and with it the inline view. That is why
the standalone presentation belongs to this decision rather than following it — with the Mini App in its
own tab, the rail and the page are on screen at once, which is the nearest equivalent of the shipped
arrangement.

## Where the inline view lives

The workspace panel's tab content is a closed union: a tab is a stable client id plus a content
record, and the record's kind fixes the renderer. A Mini App becomes one more member —
`{kind: 'miniapp', sessionId, pluginId}` — and the cost is the union's six touch points: the content
union and its kind table, the command that opens a tab with a payload, the reducer case, the render
branch, the tab strip's glyph, and the tile on the launcher page. That last one is the entry point:
this client's "add a tab" surface already is a page of tiles, which is the counterpart of the desktop
client's File Panel "+", and the tile leads to the plugin's picker.

The tile opens a page of its own, `{kind: 'miniapp-picker', sessionId}`, and the choice made in it
replaces that page with the view. So the tile is an ordinary tool tile — it turns the tab it is on
into the tool page, the way every other tile turns it into its view — and the Mini App's entry is
two members of the union rather than one. Which Mini App a tab shows is still the runtime's listing
to answer, and the tab that shows it is still the tab the person asked in.

Two properties of that picker are worth stating. Its rows and the plugin catalogue's apps area are the
same rows: the existing `listApps` action already resolves to the runtime's Mini App listing, phases
included, and answers an empty list today only because the service is gated off. So the catalogue is
missing a surface and a launch action, not data. And the capacity answer is real: three Mini Apps run
at once, so opening a fourth has to name the running ones and let the user stop one.

The plugin catalogue is the other half of the entry, and it belongs to this version: a person installs a
Mini App as a plugin, so the surface that installs plugins has to show what is installed. That area
owns the list and the lifecycle — install, uninstall, enable, disable, stop, and the open action — while
the workspace panel owns the display. Rows there carry runtime phases, so the same surface names what
is running without a second query.

The view component itself belongs to the Mini App business, which publishes it through a
`*.public.tsx` module — the same crossing the browser panel uses to mount a live-stream view in the
panel. The panel stays the layout owner and learns nothing about Mini App state.

Two behaviours follow from the panel's own rules rather than from this decision. The panel's state is
per session and refuses to exist without one, so a Mini App tab belongs to a session, and closing the
panel hides the tab without destroying its place in the state. The iframe does unmount, though, and
with it the page: a tab is a presentation, while the runtime is plugin-scoped. Reopening the panel
points the tab at the same origin again, so the Mini App's server-side state is intact and its
in-page state is gone. That is the same consequence as moving a page between presentations on the
desktop client, and it should be stated in the tab rather than discovered.

## The client's Mini App is one business

Everything this client knows about Mini Apps is one business: the view, the picker, the apps list, the
presentation lease and the host side of the bridge. It qualifies on the same grounds every other
business here does — it has a lifetime of its own per session, state of its own (which Mini Apps are
open, what phase each one is in, which presentation lease is live, which bridge requests are pending),
several surfaces, and a protocol of its own. Splitting it would put per-session Mini App state and a
`postMessage` protocol inside the plugin catalogue, whose lifetime is installing and enabling packages,
or inside the workspace panel, whose lifetime is layout.

Three crossings, each one line wide:

- The workspace panel mounts the published view for its `miniapp` tab kind, the way it mounts the
  browser panel host today.
- The plugin catalogue mounts the published apps list for its apps area and holds no Mini App state of
  its own.
- The business dispatches the workspace panel's own tab command to open a view; it never reaches into
  the panel's state.

Two properties keep that boundary honest. A tab's existence stays in the workspace panel state, because
that is layout, while the Mini App business owns the runtime and bridge facts about that tab, because
that is capability. And the view URL is produced by the service and returned by the open operation: the
client never assembles a Mini App origin and never carries its credential, which is the rule the
workspace file preview already follows.

## The standalone presentation

The client router resolves exactly two outcomes today — `/` and `/archon` both to the client, anything
else to 404 — and the session travels in the `#session=` hash. A standalone Mini App is
`/miniapp?plugin=&session=`, which the service maps to the same document, so the runtime-configuration
injection applies unchanged and the tab is an ordinary client. The shell needs one new concept to
serve it: a presentation mode in which the full client renders only the Mini App view. That is a
smaller change than the desktop client's, which has to move a native view; here it is which component
the shell mounts.

The link that opens it is produced by the inline tab, which carries the action that moves this Mini App
into its own browser tab; nothing else can produce a deep link a person would not type. The standalone
view offers no control back to the inline one — that would be the in-page close control it deliberately
does not have — so returning is closing the tab, which releases the lease.

The page is independent of the session named by its route: a confirmed missing session is reported as
ended while the Mini App still shows. If session lookup fails for another reason, the page reports
that the state is unresolved rather than claiming the session ended or dropping the presentation.
A runtime that stops while the tab is open clears the view and reports the stop reason; it does not
restart the Mini App, because the tab may be unattended and a retry would start work the user did not
ask for. A retry is a user action.

### The standalone presentation is a lease

Because the two presentations are two client documents that share nothing but the service, the service
holds the record of which one is live. A standalone client declares its plugin, its session and its
presentation when it connects, and the record is released when that client's socket closes. If the
watch connection drops unexpectedly while the document is still open, the client reconnects with
backoff and declares a new lease; this restores presentation ownership but never starts the Mini App
runtime. Closing the tab stops the watcher and releases the lease. The inline view reads the record,
which is what lets it show that a Mini App is already open elsewhere and offer to switch instead of
opening a second tab.

That record is also what gives `detached` and `presentationRevision` meaning in this client, rather
than leaving them as fields this port always answers with `false` and `0`. `detached` is "a standalone
lease exists for this plugin"; the revision increments each time a lease is acquired, which is the
same property it has on the desktop client — a fast detach and attach that a poll would otherwise miss.

## The proxy is one listener per Mini App

A Mini App's page refers to its own origin by absolute path — the scaffold serves `/dashboard`, and a
real page also fetches `/api/…`, its assets and relative URLs for the rest. A single proxy origin with
a per-Mini-App path prefix would rewrite exactly the URLs the page asks for, and patching them back
means intercepting `fetch`, `XMLHttpRequest` and every absolute URL in the document. The proxy is
therefore one loopback listener per running Mini App: paths are forwarded unchanged to the Mini App's
origin, the credential is injected on the way out, the document is rewritten on the way back to carry
the bridge, and WebSocket upgrades are forwarded under the same rules. At most three Mini Apps run at
once, so at most three listeners exist, which is also how the runtime already gives each Mini App a
port of its own. That listener's port is allocated per plugin rather than in order of opening, for the
same reason the runtime's own is deterministic: the page's origin is what keys its `localStorage` and
`IndexedDB`, so a port that moved between runs would silently discard the page's own state.

## One owner per Mini App across clients

The WebUI and the desktop client share a data directory (ADR 0006), and a Mini App's port is derived
from its plugin id, so without a rule both clients compute the same first port and the second one
starts a second process over the same plugin data. This record decides ownership rather than
arbitration: **one client owns a Mini App at a time, and the other refuses to start it.**

Ownership is per plugin, not global, so one client can own one Mini App while the other owns a
different one. The owner is whatever starts the runtime first, recorded in the shared data directory
with a liveness proof that the operating system releases when the owner dies, rather than a timestamp
alone — a stale record must be reclaimable, and a live one must not be taken by mistake.

That proof is an exclusively bound endpoint per Mini App, in its own plugin data directory: a socket
file on POSIX and a named pipe on Windows, named from the plugin id the way the OAuth lease endpoint is
named from its data directory (`packages/oauth-lease-protocol/src/endpoints.ts`). Binding is the
ownership: a second bind fails while the owner lives, the operating system releases it when the owner
dies, and the record beside it states which client holds it and since when. The endpoint is never
unlinked before binding — unlinking first would steal a live owner's endpoint, which is the mistake the
OAuth lease server is entitled to make with its own path and this record is not.

The shipped desktop client writes no such record, so the record cannot be the only signal. For anything
already running, including that client, the signal is the Mini App's own port: the client probes the
derived port before starting, and a listener that answers an unauthenticated request the way the guard
does means the Mini App is already up somewhere. The client then refuses with the same message instead
of spawning a process that cannot bind, or worse, one that can.

The user-visible result is a row and a picker entry that say another client is running this Mini App,
with the open action disabled. The consequence is accepted and stated rather than hidden: a Mini App
running in the desktop client cannot be shown in the WebUI, because the credential that reaches it
never leaves the process that minted it. What the rule buys is the opposite guarantee — only one process
per Mini App ever writes its plugin data.

## Delivery order

The order is fixed by three dependencies rather than by preference. The contract arrives first,
because the bridge and the operations are typed against it. The guard arrives before the proxy
injects anything, because a proxy that injects a credential into a service with no guard proves
nothing. The service cell, the presenter and the view land in one change, for the half-live reason
above. The plugin catalogue's apps area rides with that change rather than after it: it is the surface
that shows what is installed and what is running, so without it the view has nothing to be opened from. The agent capability follows the view: it is the only part that can be reviewed against a
working page, since a plugin's agent calls are only observable from a page this client can display.

### The proxy makes the document framable

The page is framed by this client, on a different origin, so a page must not be able to refuse. The proxy
therefore drops `X-Frame-Options` from every response it forwards and removes the `frame-ancestors`
directive from a page's own CSP while leaving its other directives alone — the Mini App's origin is a
separate origin from the client's, so the rest of its policy governs a document that cannot reach the
client anyway. Nothing is added: no header the page did not ask for, no CSP of the proxy's own.

The document is the one response the proxy rewrites. The page bridge has to be in the document before the
page's own scripts run, so the proxy injects a script tag for it before `</head>`, or after the opening
`<body>` tag when a page has no head, or ahead of the document when it has neither, and restates the
`Content-Length` because the body it sends is not the body it received. Everything else — paths, methods,
status codes, the page's own headers — passes through unchanged.

## Bridge request and error behavior

The bridge preserves the page's `requestId` through the `postMessage` request, the host operation
and the response or event, so concurrent calls settle only the promise that started them. The host
validates the source frame and its origin before it accepts a request. Malformed payloads answer
`invalid_request`; a duplicate in-flight request id answers `busy`; a page without a host session
answers `not_permitted`; and a runtime without the Agent capability answers `runtime_unavailable`.
For supported calls, the service's documented failure code is preserved. If transport fails after a
turn or call may have taken effect, the bridge answers `result_unknown` rather than inviting an unsafe
retry. The shared contract and runtime Agent contract define the accepted failure codes and the
`busy` reasons (`packages/shared/src/miniapp-surface.ts` and
`packages/local-runtime-v2/src/service/miniapp/agent/contracts.ts`).

## Research findings

- The desktop client hosts a Mini App in a native view and moves that same view into its own
  window; returning it to the panel is described in the desktop client's own code as returning it
  to the File Panel host (`app/dist/main/modules/browser/embedded-browser-manager.js`,
  `detachMiniAppTab` and `attachMiniAppTab`).
- The desktop client injects the loopback credential at the session layer, scoped to the managed
  tab's own origin (`app/dist/main/modules/browser/miniapp-loopback-auth.js`).
- The desktop client injects the page bridge with an Electron preload, and the bridge's own
  namespace is `window.mcode.miniapp` with a message, an agent and a window part
  (`app/dist/main/modules/browser/miniapp-preload.js`).
- The shipped client guards the Mini App's HTTP server in the Mini App's own process, before
  plugin code observes a request
  (`app/node_modules/@mavis/local-runtime-v2/src/service/miniapp/process/node-runtime/host-runner.ts`).
- The desktop client's Mini App control plane is Electron main-process IPC over a utility broker,
  and none of it is on `CliService`
  (`app/dist/main/ipc/miniApp.ipc.js`, `app/dist/main/modules/local-runtime/utility/miniapp-broker.js`).
- This client injects its runtime configuration into every page it serves, so a tab opened by
  deep link is an ordinary client (`packages/webui/src/server/http/client-assets.ts`).
- This client already renders one foreign document in an iframe, under the opposite isolation
  choice: a sandboxed, opaque origin (`packages/webui/src/client/features/workspace/ui/WorkspaceHtmlPreview.tsx`,
  `packages/webui/src/server/http/workspace-file.ts`).
- The runtime owner policy is resolved once per host into a descriptor that the harness reads its
  cells from, and the Mini App gate is decided outside that descriptor. The same repository
  documents the Mini App, greeting and context-inspector gates as owner-kind branches that no
  change to this client's row reaches
  (`packages/local-runtime-v2/src/services.ts`,
  `packages/local-runtime-v2/src/service/llm-context-inspector/initialize.ts`,
  `packages/webui/docs/known-gaps.md` §2).
- The shipped contract is a strict superset of this repository's: `diff` reproduces the 54 lines here
  as its first 54, its only import is `./questionnaire.js` which is byte-identical here, and its build
  output carries no `require` at all.
- The shipped guard patches `http.Server.prototype.emit` before the plugin entry is imported, covers
  `request`, `checkContinue`, `checkExpectation` and destroys `upgrade` and `connect` sockets, strips
  its own header from `headers` and `rawHeaders` on success, and answers one reserved health path with
  204 so readiness proves the guard is in the path. The shipped readiness probe is
  "anonymous must be 401, credentialed must be 204"; this repository's is a TCP connect
  (`.../service/miniapp/process/node-runtime/node-runtime.ts`, `host-runner.ts`).
- The credential is minted per process generation and threaded through the runner's init message; the
  supervisor exposes it as a launch credential, and the application's `launch` object is documented as
  server-only: "Never forward this object to a renderer"
  (`packages/local-runtime-v2/src/application/session/process-local-application-contract.ts`).
- The application exposes only `list`, `open` and `stop` here; the shipped generation adds a
  read-only `credential` and returns the credential with `open`.
- The shipped runtime's agent path is a whole absent directory here —
  `.../service/miniapp/agent/` (contracts, gateway, session ports, projection, model selection,
  roughly 2900 lines without tests) — plus `process-local-miniapp-agent-application.ts`, and the
  plugin manifest fields that gate it.
- Every Mini App is a separate child process: the node runtime spawns one with a fourth IPC file
  descriptor, and at most three run at once. In this repository that descriptor carries lifecycle
  messages only (`miniapp:ready`, `miniapp:error`, `miniapp:stopped`, stop and parent-loss
  handling) and the runner states in its own comment that the standard streams are reserved for the
  connector wire; the connector reads the child's stdout and writes its stdin as strict NDJSON, and
  the runtime aborts on any stdout byte while the connector is disabled
  (`packages/local-runtime-v2/src/service/miniapp/process/node-runtime/host-runner.ts`,
  `node-runtime.ts`). The shipped runtime uses the same descriptor for both, distinguished by
  message type, drops the child's stdin, and logs stdout and stderr instead.
- The shipped manifest reader allows `agentAccess`, `agentConcurrency` and `surface.window`; this
  repository's allows none of the three and fails unknown keys as `MANIFEST_SCHEMA_INVALID`
  (`packages/local-runtime-v2/src/service/plugin-system/plugin/package/miniapp/validation.ts`).
- A runtime can be built with explicit Mini App options and no declared owner kind, and the supervisor
  is expected to exist, so the explicit-options override survives the wiring-cell change
  (`packages/local-runtime-v2/src/services.test.ts`).
- The owner policy's suite pins the wiring key set and the count of cells where this client's row
  differs from `tui` (`packages/local-runtime/test/unit/runtime-owner-policy.test.ts`).
- The workspace panel's tab content is a closed union, the open-tab command admits three kinds today,
  the panel's state is per session and refuses to exist without one, and another business mounts into
  the panel only through a `*.public.tsx` module
  (`packages/webui/src/client/features/workspace/projection/workspace-panel-state.ts`,
  `packages/webui/src/client/features/workspace/contracts/panel-command.ts`,
  `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx`).
- The client router resolves `/` and `/archon` and nothing else, and carries the session in a hash
  (`packages/webui/src/client/projection/common/router.ts`); the service maps those paths to the same
  document (`packages/webui/src/server/http/router.ts`).
- The server holds no outbound HTTP client, no HTML rewriting except the runtime-configuration
  injection into `index.html`, and no response-header policy except the workspace file route's
  `Content-Security-Policy: sandbox` (`packages/webui/src/server/http/`).
- The plugin business lists Mini Apps already and has no surface to open one: the listing area exists
  in the workflow and is reachable only programmatically, and its `listApps` action already resolves to
  the runtime Mini App application's `list`, so rows arrive with a runtime phase the moment the service
  exists — the empty answer today is the gate, not the query
  (`packages/webui/src/client/features/plugins/application/plugin-workflows.ts`,
  `packages/local-runtime-v2/src/application/cli-management-application.ts`). Plugin install,
  uninstall, enable and disable are existing management actions, so installing a Mini App adds no
  plumbing.
- Only one thing rides the child's standard streams today: the host connector's three frames
  (`connector.list`, `connector.call`, `connector.cancel`), which give a Mini App access to
  host-provided tools under host-held credentials with an allowlist, a schema-checked call and an
  audited result. stderr is already logs — a bounded tail feeds startup-failure diagnostics — and a
  byte on stdout aborts the runtime whenever the connector is disabled
  (`packages/local-runtime-v2/src/service/miniapp/process/host-connector/host-connector.ts`,
  `process/node-runtime/node-runtime.ts`, `node-runtime-startup-error.ts`).
- The Mini App service here carries no tests of its own: `packages/local-runtime-v2/src/service/miniapp`
  holds no `*.test.ts` file and `test/vitest-suites.json` registers no Mini App suite, while the
  shipped package carries its connector, gateway and session-port suites with it. A forward port
  therefore arrives with a regression net to adopt and register rather than with a gap to fill.
