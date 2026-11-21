# WebUI Mini App view and its runtime seams

**Status:** Product direction accepted and implemented in the Mini App hosting stack.
**Date:** 2026-10-20, revised 2026-10-26.

The WebUI will host Mini Apps. A Mini App's page is rendered as an iframe the client loads
from a loopback origin that the WebUI service proxies. The Mini App's own page bridge — the
`window.mcode.miniapp.*` namespace a Mini App page uses to call its host — is provided by a
browser bridge injected by that proxy.

Both presentations belong to the client. **Inline**, the Mini App view occupies a tab inside the
WebUI workspace panel. **Standalone**, a browser tab is opened through a URL deep link; the tab runs
the full WebUI client, but the only content it shows is the Mini App view. The standalone view has no
in-page close control: the tab is the Mini App's own. The deep link selects a session and a Mini
App when launched from a conversation; the primary rail also launches a plugin without a session
from the home page. The service injects its runtime configuration into every page it serves, so a tab opened
this way is an ordinary client with the same credential as any other.

## Browser hosting

The service proxies each Mini App's origin and injects the loopback credential into its requests.
A browser cannot add this header to an iframe navigation or its subresources. The proxy also
rewrites the page's HTML to inject the browser bridge. Bridge calls reach the client over
`postMessage`, and the iframe is positioned by the client layout.

The proxy must listen on its own origin, separate from the WebUI's own origin. Serving a
Mini App from the WebUI's origin would make the iframe same-origin: it would then run in the
WebUI's renderer process, so a hung Mini App page would hang the whole client, and the page could
read the WebUI session token off its parent frame. A separate origin keeps the page in its own
process and keeps the client credential out of its reach. The Mini App view is therefore **not**
sandboxed; its isolation comes from origin separation, not from a sandbox attribute. That is the
opposite of the workspace file preview, which deliberately renders an untrusted document in a
sandboxed, opaque-origin iframe.

The proxy's origin is the loopback interface by default. When the WebUI service is bound beyond
loopback ([0031](0031-the-webui-may-bind-beyond-loopback-and-a-non-loopback-request-presents-the-credential)),
the proxy follows that bind address so the framed document is reachable from the reader's machine
too, and it asks for the same per-start credential: the framed URL carries it once, the frame
response turns it into a cookie and redirects the document to a URL without it, and the Mini App's
own requests carry the cookie from then on. The proxy strips the credential from the path it
forwards, so the Mini App never sees it.

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

## Presentation boundaries

- **Native window semantics.** A browser tab cannot express operating-system window effects.
  The WebUI keeps the
  Mini App in the current tab and supports a browser-only floating presentation: the same iframe is
  positioned over the WebUI page, bounded by that page's viewport, and remains in the same document.
  It is not an operating system window and does not inherit native window options.
- **The page-side window handle.** Native `surface.window` manifest options and Chromium argv surface
  identifiers remain unsupported. The WebUI provides a browser-side window
  channel for `inline` and `window` presentation, viewport bounds and focus. A page can request the
  floating layout, but the host retains ownership of the presentation and clamps the requested
  geometry to the browser viewport. Its browser-side `transparent` patch clears the iframe surface
  and asks the injected page bridge to clear the Mini App document's `html` and `body` backgrounds;
  native manifest window options remain unsupported.
- **Host-to-page injection.** A cross-origin Mini App page cannot be reached by the host's
  agent cursor overlay or comment bridge.
- **Moving one live page between layouts.** Inline and floating browser layouts use the same iframe
  and the same page document. The shell owns that view outside the workspace panel so closing the
  panel, changing workspace tabs, navigating to another WebUI page or selecting another session
  does not release the floating frame. The service still owns the Mini App presentation lease; the
  browser shell only retains its viewport-level placement.

## The contract baseline

The Mini App contract includes:

- The split between starting a Mini App and opening its page: `MiniAppStartResponse`,
  `MiniAppPageOpenInput`, `MiniAppBackgroundOpenInput` and one `MiniAppOpenApi` with two overloads.
  The runtime seam below depends on this distinction.
- `detached` and `presentationRevision` on the tab summary, plus the `detach_failed` and
  `attach_failed` codes. In this client they are not dead fields: `detached` reports whether a
  standalone presentation is live, and the revision increments on each acquisition.
- `MINIAPP_LOOPBACK_TOKEN_HEADER`, the name of the credential the proxy injects.
- The composer block: the request, the reply, the bounded text limit and the one validator both ends
  of the bridge share.
- The agent block: every request and result shape, the nine run events, the failure codes and their
  mapping from the runtime's own codes, and the allowlist validators the preload and broker
  run on both sides of the boundary.

Native window options are not supported. The browser window channel provides `getState`, `update`
and `focus` for inline and viewport-bounded floating presentations.

Two consequences follow for the layers around the contract. The manifest reader must accept the
three keys: `surface.window`,
`agentAccess` and `agentConcurrency`. Its field sets are strict, so an unknown key fails the package
as `MANIFEST_SCHEMA_INVALID`. Accepting is not supporting: `surface.window` is read and ignored here, because its
effect was just dropped from the contract, while the two agent fields are validated and preserved here
so the agent service can enforce them when it lands.

## The credential guard

The runner guards the Mini App's HTTP server inside its process. It patches
`http.Server.prototype.emit` before the plugin entry is imported, so any server the
plugin creates is covered. A request event must carry the exact loopback `Host` and a timing-safe
match of the credential header, or it is answered 401 with no body; `upgrade` and `connect` sockets
are destroyed instead. On success the header is removed from both `headers` and `rawHeaders`, so
plugin code never observes it. One reserved path is answered 204 by the guard itself, which is what
lets the readiness probe prove the guard is in the path rather than merely that a socket accepts:
readiness becomes "anonymous must be 401, credentialed must be 204" instead of a TCP connect.

This decision carries that guard. The previous revision treated it as an option, on the grounds that
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
  previously gated options on owner kind. The gate becomes a cell of the
  runtime owner policy instead of a kind comparison of its own. The policy table
  (`packages/local-runtime/src/runtime/runtime-owner-policy.ts`) already resolves once per host and
  already drives the other owner-derived service gates — `wiring.cronService`,
  `wiring.channelService`, `wiring.schedulerHost` — from that one descriptor; the Mini App gate
  is decided outside it, which is why a change to this client's row cannot reach it. The Mini App
  service becomes `wiring.miniAppService`, this client's row carries it, and both places that read
  the function — the service composition and the `miniappAvailable` capability flag — read the cell
  instead, so the flag can no longer disagree with the service.

  Every row must state the cell as a literal: an owner that declared no kind must not implicitly
  enable the service. This is also the one
  owner-derived gate where the Mini App service is stricter than cron or channels. The explicit
  Mini App options the function already accepts stay reachable for every row that carries the cell,
  because a test builds a runtime with them and no declared kind and expects the supervisor to exist;
  `resolveRuntimeMiniAppOptions` keeps that override and takes the cell as its other input. The owner
  policy's own suite pins the wiring key set and the count of cells where this client's row differs
  from `tui`, so both move with the cell.
- **The control plane enters the harness as a forwarding facade.** The runtime already owns the
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
  `openPage: false`. It also needs to hand the credential and origin to the
  server: `launch` is documented as server-only coordinates that must never be forwarded to a
  renderer, and this design honours that literally. The client receives the proxy's own view URL,
  including the runtime-selected surface path needed to load the page, but never the Mini App's
  origin or its credential. Everything that touches a Mini App's real origin stays on the server
  side of the facade.
- **The presenter stays a host-owned port.** The WebUI supplies the browser
  implementation: its `open` means the client should show that Mini App, and its `close` means the
  client stops showing it. The port's shape — open and close by session and plugin — is already
  platform-neutral, so the browser implementation fits it without changing the contract.

  The ordering matters more than it looks. The agent tool's own `open` action throws
  `OPEN_UNAVAILABLE` when the runtime has no presenter, while `list`, `init`, `publish`, `restart` and
  `stop` start working the moment the service cell is flipped. Enabling the service before the
  presenter exists would therefore ship a half-live capability: the agent could publish and start a
  Mini App that nothing can display. The presenter, the view it opens and the cell belong to one
  change.
- **The agent's Mini App tool follows the cell and the surface, not the profile name.** The service
  cell says the host owns the capability; it does not by itself put the tool in a model's tool
  table. The tool is contributed by the host extension
  (`packages/agent-extension/src/miniapp.ts`), which the host registers only when the service
  exists, and its per-turn predicate decides whether the tool appears. That predicate used to
  accept the `interactive` surface alone, which read the Agent profile's surface as if it named
  what the host can show. It names who is talking instead: WebUI sessions run on the `cli` surface,
  so the tool never reached this client's agent even though the cell was on and the presenter was
  there. The predicate now accepts a surface that may drive a Mini App — `interactive` or `cli` — and
  excludes the delegated child surface, which must not open a panel on the person's behalf. The rule
  lives with the capability (`isMiniAppCapabilitySurface`); the tool gate reads it, and the Mini App
  skill scope reads it together with the host declaration, so a host without the cell offers
  neither. `packages/local-runtime-v2/test/unit/miniapp/miniapp-agent-capability.test.ts` pins the
  two facts together.

## The agent capability is in scope

A Mini App page's agent calls are part of this decision. They are also the largest piece of it, and the
one place where the work is not a client-side rewrite of something the runtime already does.

An installed Mini App must render and work in this client. A page that probes the bridge when it loads must not
find a method missing, because the visible result is a dead panel rather than a graceful degradation.
That is why the composer alone is not a smaller first version of this decision — it is a different,
insufficient one.

This repository now has the Agent gateway, session ports, application facade and child-side
`context.agent` client. The manifest accepts independent `session.run` and `session.read` grants.
`session.read` currently lists visible user conversations and reads a session summary (including its
latest assistant text); the published observer API is still not implemented. The manifest's
`surface.window` block remains compatibility-only: it does not create a native window or enable its
window flags. The WebUI's browser-side window channel separately supports an in-tab floating iframe.

The connector's wire has to move with it, and the reason is not a preference. In this repository the
host connector *is* the child's stdout: the child's stdout is the request stream and its stdin the
response stream, framed as strict NDJSON. When the connector is disabled, a single byte on stdout
aborts the whole Mini App runtime as a protocol violation; when it is enabled, the same byte corrupts
a frame. The child does already have a parent channel — every Mini App is spawned with a fourth IPC
file descriptor, and the runner's own comment says what it is for: that channel controls lifecycle,
while the standard streams are reserved for the connector. Connector frames are multiplexed onto the
same descriptor by message type,
the child's stdin is dropped entirely, and stdout and stderr become logs. An agent-enabled Mini App
logs — it runs turns, tools and model calls — so the two protocol families cannot keep sharing one
stream. Adding a second channel for agent calls alone while leaving tool calls on NDJSON would still
break the tool channel on the first log line. The connector therefore moves onto the existing
channel for every Mini App, not only the agent-enabled ones: one channel carries both message
families, told apart by the message type, the child's stdin stops being used at all, and stdout and
stderr become logs. That is this record's decision rather than an assumption, and the
dual-transport alternative stands rejected for the reason just given.

The connector is shared with tool calls, so a defect there is not confined to Mini Apps.

A page's `open` call must make a Mini-App-created session's permission asks answerable: the gateway
denies an approval unless a host conversation is showing the session. The workspace
panel cannot be one: it hosts the selected session's own resources, while the client renders one
selected session at a time, so a second transcript beside the first would need a second conversation
surface rather than one more tab kind.

The mapping is the session rail plus the standalone presentation. `open` selects that session through
the client's ordinary selection path; while it is the selected session the service reports the panel as
showing it, and switching away or closing it reports the panel as closed. `hostSessionId` is the
session whose workspace panel carries the inline view — or, for a standalone tab, the session its deep
link carried. Selecting the Mini App's session replaces the workspace panel and its inline view.
The standalone presentation keeps the Mini App available in its own tab.

## Where the inline view lives

The workspace panel's tab content is a closed union: a tab is a stable client id plus a content
record, and the record's kind fixes the renderer. A Mini App becomes one more member —
`{kind: 'miniapp', sessionId, pluginId}` — and the cost is the union's six touch points: the content
union and its kind table, the command that opens a tab with a payload, the reducer case, the render
branch, the tab strip's glyph, and the tile on the launcher page. That last one is the entry point:
the "add a tab" surface is a page of tiles, and the tile leads to the plugin's picker.

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
in-page state is gone. The tab should state that consequence.

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
`/miniapp?plugin=&session=`, with `session` optional for a launch from the home page, which the service maps to the same document, so the runtime-configuration
injection applies unchanged and the tab is an ordinary client. The shell needs one new concept to
serve it: a presentation mode in which the full client renders only the Mini App view.

The inline tab and the primary rail produce the link that opens a Mini App in its own browser tab.
The primary rail needs no selected conversation and creates no conversation as a launch side effect. The standalone
view offers no control back to the inline one — that would be the in-page close control it deliberately
does not have — so returning is closing the tab, which releases the lease.

The page is independent of the session named by its route: a confirmed missing session is reported as
ended while the Mini App still shows. If session lookup fails for another reason, the page reports
that the state is unresolved rather than claiming the session ended or dropping the presentation.
An absent session is reported as `none`; no session lookup or ended-session notice is needed.
A runtime that stops while the tab is open clears the view and reports the stop reason; it does not
restart the Mini App, because the tab may be unattended and a retry would start work the user did not
ask for. A retry is a user action.
A failed start leaves an actionable “not opened” state in the mounted view, alongside the
attempt's error toast. Dismissing the toast does not remove the state or its explicit retry
control. Only an `OWNED_ELSEWHERE` refusal tells the user to close the other client's app;
a generic preparation failure does not establish ownership. Retry uses the normal open
operation, never a takeover, and polling does not restart a failed presentation. If
another tab holds the presentation lease, the failed inline view only reads until the
lease releases, then reveals the retry control. Stop or lease failures do not create
this failed-start state.


### The standalone presentation is a lease

Because the two presentations are two client documents that share nothing but the service, the service
holds the record of which one is live. A standalone client declares its plugin, its optional session and its
presentation when it connects, and the record is released when that client's socket closes. If the
watch connection drops unexpectedly while the document is still open, the client reconnects with
backoff and declares a new lease; this restores presentation ownership but never starts the Mini App
runtime. Closing the tab stops the watcher and releases the lease. The inline view reads the record,
which is what lets it show that a Mini App is already open elsewhere and offer to switch instead of
opening a second tab.

That record is also what gives `detached` and `presentationRevision` meaning in this client, rather
than leaving them as fields this client always answers with `false` and `0`. `detached` is "a standalone
lease exists for this plugin"; the revision increments each time a lease is acquired, so a fast detach
and attach cannot be missed by a poll.

The primary rail reads the catalogue on opening, on focus or visibility return, and every two seconds
while the panel is open and the document is visible. Start, stop and package mutations require a read
begun after the mutation settles, so an older in-flight catalogue response cannot leave the row in its
previous runtime state. The close control follows the stop promise through the shared pending feedback;
a refused stop is reported through the shared toast while the runtime state remains authoritative.

## The proxy is one listener for every Mini App

A Mini App's page refers to its own origin by absolute path — the scaffold serves `/dashboard`, and a
real page also fetches `/api/…`, its assets and relative URLs for the rest. The proxy is therefore one
listener that every Mini App is served on, and the Mini Apps are told apart by the path they are served
under (`/<pluginId>/…`) rather than by the port they answer on. The credential is injected on the way
out, the document is rewritten on the way back to carry the bridge, and WebSocket upgrades are
forwarded under the same rules.

The prefix is a routing address, and the document is what carries it. A request under a prefix
loses it on the way out, so the Mini App still serves the paths it wrote; a request that names no prefix
— the root-absolute paths a page asks for — is answered by the Mini App that page belongs to, which the
page says itself: the injected bridge stamps the Mini App's name on the requests it makes, and the
browser's `Referer` names the document a subresource came from. The document's own root-absolute URLs
are rewritten onto the prefix, because a page's module graph is the case that needs it: a script loaded
at the root imports its siblings at the root as well, where the shared port cannot say whose they are.
What the page's script asks for at runtime is left alone, and the stamp is additive, so the request the
page made unchanged still reaches its Mini App.

The listener is published on one fixed port, because a Mini App that arrives in the store must not ask
the deployment for another firewall rule and another port forward.

The cost of one origin is that the Mini Apps share it: their `localStorage` and `IndexedDB` are one
store and their cookies are one jar. The bridge namespaces the storage per Mini App and the proxy
namespaces the cookies per Mini App, so two Mini Apps do not read each other's state.

## One owner per Mini App across clients

Clients can share a data directory (ADR 0006), and a Mini App's port is derived
from its plugin id, so without a rule two clients compute the same first port and the second one
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

Not every client writes such a record, so the record cannot be the only signal. For anything
already running, the signal is the Mini App's own port: the client probes the
derived port before starting, and a listener that answers an unauthenticated request the way the guard
does means the Mini App is already up somewhere. The client then refuses with the same message instead
of spawning a process that cannot bind, or worse, one that can.

The user-visible result is a row and a picker entry that say another client is running this Mini App,
with the open action disabled. The consequence is accepted and stated rather than hidden: a Mini App
running in another client cannot be shown in the WebUI, because the credential that reaches it
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
page's own scripts run, so the proxy injects a script tag for it at the start of the head, or after the
opening `<body>` tag when a page has no head, or ahead of the document when it has neither, and restates
the `Content-Length` because the body it sends is not the body it received. Everything else — paths,
methods, status codes, the page's own headers — passes through unchanged.

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

## Implementation and verification

The browser view, proxy, agent bridge and lifecycle are implemented under
`packages/webui/src/client/features/miniapp/` and `packages/webui/src/server/`. The corresponding
browser and unit tests live under `packages/webui/test/`.
