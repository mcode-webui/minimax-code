# Architecture design

The design of `packages/webui`: a browser client for the process-local harness layer and the loopback
service that serves it. Every statement here is derived from the source; where a statement and the
tree disagree, the tree wins.

Read this first, then the three facets: [`layered-model.md`](layered-model.md) (the execution
boundaries and how a request travels), [`module-map.md`](module-map.md) (where code lives),
[`boundaries.md`](boundaries.md) (the rules the two gates enforce and the artifacts they guard). The
decisions behind the design are in [`../adr/`](../adr/).

Paths written without a leading directory in this document are relative to `packages/webui/`; a
basename standing after a full path is that path's sibling.

## 1. System context

The harness layer (`packages/local-runtime`, `packages/local-runtime-v2`) runs an agent session in
process and exposes it as an `AsyncIterable`/`AbortSignal` API with no RPC envelope, no correlation
id and no client identity of its own (`src/shared/envelope.ts`). The WebUI sits on top of that API:

- **A browser application** (`src/client/`) that renders the session and talks to the local service.
- **A loopback service** (`src/server/`) that authenticates, validates, dispatches and projects.
- **A runtime adapter** (`src/runtime/`) that adapts the harness to the service and owns every
  Node-side process resource.
- **Shared wire contracts** (`src/shared/`) that both sides type-check against.

It is a peer client of the terminal client: it builds on `@mavis/local-runtime-v2` directly, imports
nothing from `packages/tui` (ADR 0003) and does not drive the CLI binary (ADR 0001).

## 2. Constraints that shape everything

| Decision | What it forces here |
| --- | --- |
| ADR 0001, ADR 0003 — a peer client, not a wrapper | The WebUI declares its own port, its own wire and its own browser state. The TUI is readable as a specification, never as a dependency |
| ADR 0002 — quarantined cold start | The host is built with `startupExecutionPolicy: "quarantined"` unconditionally, not per surface |
| ADR 0004 — own transport, loopback only | A thin WebSocket envelope, per-start credential, host/origin admission; the service refuses to bind a non-loopback address at construction |
| ADR 0005 — artifacts build separately | `dist-webui/` has its own two entries and its own metafile; the CLI bundle never contains the server |
| ADR 0006 — one data directory | `~/.minimax` is shared with the CLI; the harness host is a scripted stand-in where a live `CliSession` would not be deterministic |
| ADR 0007 — additive changes | `release/public-source.json` lists every file; a new file is a publication decision, and moving a file costs a conflict at the next upstream sync |
| ADR 0010 — esbuild artifact, Vite as dev server | The shipped artefact is an esbuild build with its own metafile (the input the boundary check reads); Vite serves the dev client only, never the published one |
| ADR 0011 — shared harness-event corpus | The WebUI may re-implement TUI projection logic locally; each re-implementation pairs with a corpus-backed regression test that the harness protocol change can update in the same cycle |
| ADR 0013 — editable harness code | `runtimeOwnerKind: "webui"` is a declared identity with its own policy row |
| ADR 0014 — four internal boundaries | Capability and orchestration are split inside both the client and the runtime; see §3 |
| ADR 0016, ADR 0017 — business-first ownership, temporal ownership | Businesses own resources; lifetimes, generations and freshness are the application's concern, not a component's; see §8 and §9 |
| ADR 0018 — measured observation | State moves on evidence: the client reconciles its own stream state because the server alternative was measured and rejected (see §9) |
| The browser's semantics live in a peer package | `@mavis/browser-core` owns what a browser action means and reaches a browser through a `BrowserTransport`. The WebUI supplies one adapter per surface and keeps the authorization decisions. `src/client/` and `src/shared/` never import it — see §3 |

## 3. The four execution boundaries

| Boundary | Owns | Never |
| --- | --- | --- |
| `src/client/` | Browser orchestration, business state, presentation, browser IO | Speaks to the harness, holds a Node resource |
| `src/server/` | Network ingress: admission, envelope validation, dispatch, wire projection, socket lifecycle, static assets | Holds browser state, imports a runtime implementation |
| `src/runtime/` | Harness capability adaptation, and every Node-side process resource | Decides which target a run has selected (`see below` — the runtime owns that cell, and the person cannot write it) |
| `src/shared/` | Cross-process wire contracts and shared constants | Imports either execution side |

That last cell names two things, and under
[ADR 0022](../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md) they are two cells with one
writer each: the person writes the tab they are looking at through the strip, and the Agent writes
the target its run has selected. The run's selection is the runtime's cell and the Agent writes it
through the runtime; the tab in front is the client's and the person writes it. The runtime holds the
selection — `runtime/browser/browser-service.ts` — and the client only reads it, out of the mark it
publishes on the target list. The one write that crosses is the bootstrap, and it is the runtime's to
make: `openWebTab` is told who opened the page and applies it only when the run has no selection.

`src/client/` compiles under `tsconfig.client.json`; `src/server/`, `src/runtime/` and `src/shared/`
under `tsconfig.server.json`. `scripts/build-webui.mjs` builds separate client and server outputs,
then combines their metafile inputs for `pnpm check:webui-boundary`. That boundary gate checks the
combined build graph's allowed inputs and required entries; it does not retain per-output input
membership. `pnpm check:webui-dependency` enforces client/server import direction from source,
including type-only imports, while `pnpm typecheck:webui` checks the package's TypeScript programs.

### The browser's own boundary

The browser reaches a real browser through `@mavis/browser-core`, a **peer** package rather than one
of the four layers. The core owns the semantics of a browser action — element references, retained
snapshots, action deadlines, effect validation — and reaches a browser through a `BrowserTransport`
contract. The WebUI supplies one adapter per surface:

```
Agent tool or panel
  → browser service                       runtime/browser/browser-service.ts
  → provider                              runtime/browser/isolated-chromium/provider.ts
                                          server/browser-bridge/server.ts
  → Browser Core session                  @mavis/browser-core
  → BrowserTransport adapter              core-transport.ts, one per surface
  → the browser
```

The division is the one that keeps the layers honest. **The core decides what an action means; the
WebUI decides whether it may run; the transport decides how the command travels.** The core reads no
authorization switch, and a transport never judges an action's meaning.

`src/client/` and `src/shared/` never import `@mavis/browser-core`, and the dependency gate enforces
it. The consequence is that the restricted command vocabulary is stated twice — once in
`src/shared/contracts/browser.ts`, where the shared layer can reach it, and once in the core — and a
test asserts the two cannot drift. See
[`../browser-use/10-browser-core-integration.md`](../browser-use/10-browser-core-integration.md).

The request path, end to end:

```
React component
  → business application owner            client/features/*/application, client/application
  → WebuiTransport method                 client/platform/transport.ts
  → WebSocket request envelope            client/platform/wire.ts
  ── loopback, admitted ──                server/access-policy.ts, server/websocket-server.ts
  → validate → dispatch                   server/frame-handler.ts, server/operation/operation-dispatch.ts
  → operation entry                       server/operation/operations.ts
  → capability method                     runtime/port.ts
  → adapter                               runtime/harness/*
  → harness host handle                   @mavis/local-runtime-v2, in process
```

## 4. Process model

The service **is** the runtime lifecycle: `WebuiService` owns a harness port, binds loopback, runs the
wire with access control, and on `close()` stops accepting, tears down connections and closes the port.
There is one host per service process, and no second host can be built for a page.

**Boot** (`runtime/assembly.ts`, order is the code's order): resolve the shared data directory; reflect
the client's region and build scope into the process environment before the host exists; create the one
OAuth core with its lease and refresh timer; adopt the browser provider; prepare the mcode-tools
integration when asked; build the host through the forwarded options (`runtimeOwnerKind: "webui"`,
`runtimeMode: "clean"`, quarantined cold start, `cliEmbedded`/`questionnaireReply`/`permissionPrompt`/
`elicitation` all true, `enableLiveMcp: true`, and a `configGetter` that re-reads config on every
access); wrap the host's close; install the mcode-tools command path; enrich the host handle with the
credential-backed slots consumers need; derive the harness port.

**Shutdown** (`runtime/lifecycle.ts`, one owner, idempotent): auth teardown, harness host, mcode-tools
broker, browser provider. Every failure is collected and rethrown as one error or an `AggregateError`.
A startup failure after a resource was acquired runs the same owners minus the host.

**The page is not the process.** Closing a browser connection or hiding a view ends that client's
delivery only; the service's own shutdown is what closes the runtime. This is the design, not an
oversight: the harness turn belongs to the host, and a browser can reconnect to it.

## 5. Ingress and admission

**Admission is separate from dispatch** (`server/access-policy.ts`, `server/http/router.ts`). A HTTP
request is admitted by loopback `Host` (and `Origin` when present) and then by the per-start
credential; a WebSocket upgrade is admitted by loopback `Host`, the URL host (`127.0.0.1` or
`localhost`), `Origin`, and the `token` query parameter. `WEBUI_DEV=1` (or `dev: true`) drops the
credential requirement so a developer can open the served page in a plain browser; host and origin
discipline stay. `WEBUI_DEV` has no path back to off within a process. The option wins over the
environment variable, so a test that pins `dev: false` cannot be widened by a stray variable.

**Binding is guarded, not documented.** `WebuiService`'s constructor throws unless the bind address is
`127.0.0.1`, `localhost`, `::1` or `[::1]` (IPv6 zone ids stripped first), so a LAN or wildcard bind
surfaces at boot rather than at the first upgrade. Remote access needs its own decision (ADR 0004),
not a different address.

**Routes.** The HTTP surface is small on purpose: `GET /session-transfer` (export a `.mcode` session
file), `POST /session-import`, `/workspace-file` (GET and HEAD, byte range, token-checked), and the
static client (`/`, `/index.html`, `/archon`, `/client.js`, `/styles.css`, `/assets/*`, `/fonts/*`,
injected with `__WEBUI_CONFIG__`). File download and upload are HTTP because they are not a socket
shape; everything else is an operation on the socket.

**Frames** (`src/shared/envelope.ts`). Four kinds — `request`, `response`, `error`, `event` — each
carrying `protocolVersion` and `requestId`. Client frames are requests only. The service emits stable
error codes (`protocol_mismatch`, `invalid_envelope`, `payload_too_large`, `unknown_operation`,
`invalid_body`, `runtime_rejected`, `harness_error`, `shutting_down`) and clients branch on the code,
never on the message. `protocolVersion` is `1`, is bumped when the envelope changes shape, and is
returned by `version` so a browser can refuse a service it does not match.

**The frame path** (`server/frame-handler.ts` → `operation-dispatch.ts`): binary frames are rejected,
the message is capped at `WEBUI_MAX_MESSAGE_BYTES` (256 KiB), JSON is parsed, the envelope is checked,
non-request frames from a client are rejected, a shutting-down service answers `shutting_down`, an
unknown operation answers `unknown_operation`, and `OperationSpec.validate` produces either the body
the handler receives or the error frame the client sees. A thrown `WebuiErrorCode` is preserved and
anything else becomes `harness_error`.

**Streams.** An operation entry either returns a body (one `response` frame) or a stream. The stream
pump acknowledges before pulling only when the operation opts in with `acknowledgesStream`, then emits
one `event` frame per pulled value, and finalises exactly once: the abort listener finishes an iterator
parked on a `next()` that will never settle (a disconnected client), while the `finally` covers the
case where the pull does settle — one idempotent gate, so a live subscription is never closed twice.
The connection set is swept by a 15 s heartbeat (`WEBUI_WEBSOCKET_HEARTBEAT_INTERVAL_MS`), and `close()`
force-terminates the sockets before closing the listener, so the close handshake cannot hang.

## 6. The operation contract

One declaration, three consumers, and a compiler that keeps them agreeing:

1. **`src/shared/operation-names.ts`** is the single declaration point: the canonical name constants
   and the `OperationSpec` map binding each name to its validated request type and its actual wire
   response body type. It lives in `shared/` and imports only shared contracts.
2. **`src/server/operation/<domain>.ts`** holds the descriptors and their `validate`.
3. **`src/server/operation/bind-handlers.ts`** holds a statically declared one-to-one mapping from a
   wire operation to one capability method. Nothing enumerates capability methods and no request body
   can choose a member: group, method and operation name are fixed in the declaration, and the argument
   tuple and the result mapper are checked against that method's parameters and the operation's
   response type. No `any`, no assertion, no non-null assertion — a wrong group, method, tuple or
   mapper fails to compile. The eighteen operations that shape a response, degrade when a capability
   is absent, or carry a stream, terminal or command shape keep hand-written handlers in
   `src/server/operation/handlers/`.
4. **`src/runtime/port.ts`** declares `WebuiHarnessPort`: one method per operation, typed with the
   `shared/contracts/<domain>.ts` DTOs, and implemented under `src/runtime/harness/` by
   `createHarnessPortFromHost`. `bind-handlers.ts` derives its `Pick` from the port, so the roster and
   the registry cannot drift: the counts are pinned by tests (99 bindings and 18 dedicated handlers,
   covering 117 operation names), and a change that adds or drops one stops `pnpm typecheck:webui`
   compiling until the roster moves as a unit.

**Optionality is the capability model.** Every port method is optional and `undefined` means "this
operation is not wired" — a host that offers no terminal, no quota or no plugin surface is a supported
configuration, and the client renders the affected area conditionally instead of failing. The
implementation boundary is the one place that is complete: `createWebuiTransport` returns
`Required<WebuiTransport>`, so the wire table and the capability contract cannot drift apart.

**Registry order is wire-observable.** `createOperationRegistry(port, terminalPort)` registers every
entry in declaration order, and the service binds the map it was handed rather than projecting the port
member by member. An operation missing from it fails the inbound lookup with the same error a
cold-started runtime produces, so the failure mode is a missing capability, not a crash.

## 7. The harness boundary and owner identity

`runtime/port.ts` is the only seam between the WebUI's network side and the harness. `runtime/harness/`
implements it in small adapters (sessions, execution, interactions, workspace, settings,
models-plugins, account) plus two derived methods that are runtime logic reading several capabilities:
`runCommand` (the slash-command interpreter) and `importSessionTransferWorkflow`. Exposing them as port
methods is what keeps `server/` depending on `runtime-port` instead of importing runtime code.

The host assignment in `runtime/assembly.ts` is checked against the actual runtime factory return type.
`runtime/harness/host-contract.ts` derives host requests and results from public `CliService` methods;
the adapters convert those results into independently owned WebUI DTOs at
`runtime/harness/result-conversion.ts`. Methods whose upstream result is explicitly `unknown` still
need bounded runtime conversion; `test/unit/webui-host-contract-derivation.test.ts` pins that set and
requires zero request or result assignability mismatches. See
[`../runtime/harness-boundary.md`](../runtime/harness-boundary.md).

The WebUI declares its own harness identity: `runtimeOwnerKind: "webui"` resolves a dedicated policy
row in the harness, thirteen cells different from the terminal client's. The row enables scheduler-host
and cron capabilities, marks the runtime unrestricted, enables the memory feature and feature bundle,
and disables terminal control sequences. The WebUI is a scheduler host for those capabilities: the
`scheduling` business lists, creates, edits and deletes scheduled tasks, runs one on demand and reads
its run history, and the runtime's Cron service is what arms and fires them. When the Desktop is
running at the same time, the shared database decides which host acts on a given slot; the panel
reports whether this client holds a task rather than naming the other host
([ADR 0027](../adr/0027-the-webui-is-a-scheduler-host-for-scheduled-tasks.md)). Identity is not
access control: enabling memory, cron or Computer Use for a browser client gives an agent in that
browser the ability to act on this machine, which is why the service binds loopback and admits by
host, origin and credential (ADR 0004).

## 8. The browser application

**One application per page, explicitly started.** `client/main.tsx` is the composition root: it builds
one transport once at module scope (stable identity across renders), cuts the port slices, and hands the
shell an application instance through context. `client/application/create-application.ts` constructs
every owner **dormant**; `start()` installs permanent routes, hydrates persisted state and opens
ingress; `dispose()` is idempotent and a disposed instance cannot restart. That split is what makes the
assembly testable without React and without the network, and it is why the application — not a
component — owns the lifecycle.

**One event ingress.** The application opens exactly one long-lived `watchEvents` channel
(`client/platform/event-channel.ts`, with reconnect on close, on visibility and on `online`) and its
event coordinator is the sole consumer. Stream frames for `sendMessage`/`resumeSession` and the
terminal watch are separate sockets by design: they are per-request, and one of them can be detached
without touching the ingress.

**Wire mechanics and the domain table are split.** `client/platform/wire.ts` owns request sockets,
the unary deadline (30 s), `[DONE]` stream settlement, the terminal watch and the settle-on-detach rule.
Browser input opts into a shared unary connection to avoid a WebSocket handshake for every gesture;
each request retains its own identity, decoder and deadline. The connection closes after one second
without pending requests, and failed inputs are never replayed. Other operations keep their own sockets;
`client/platform/transport.ts` is the table mapping a capability method to the operation it travels as,
naming every operation through the canonical constants rather than string literals. Detaching a delivery
settles the call instead of failing it, because the host accepted the request long ago and a deliberate
detach must not look like a dropped connection.

**The seam is narrowed, not just re-filed.** `client/application/port-slices.ts` cuts fifteen slices
from the sixteen business ports, each from an explicit key list, so a business receives the members it
may use and cannot see out of its slice. Optionality is carried verbatim: an unwired operation stays
`undefined` in the slice exactly as it was on the composed transport. `WebuiClientFoundationApp` composes
screens and constructs no owners; the shell forwards no transport member.

**Businesses own resources; roles own kinds of code.** A business is one cohesive area of behaviour with
its own resource identity, policies and published commands — the directories under `client/features/`
are the list. Owning a screen is not part of the definition: `terminal` owns the catalogue of terminals
this client knows about, the commands that create, write to, resize and dispose one, and the watch
registry, while the workspace surface renders them; `review` owns the turn-changeset and
working-tree-snapshot families, which the transcript, workspace and settings surfaces read; `browser`
owns the per-target browser state — a page, its title and URL, and the page the person is looking at —
while `workspace` owns the session's tab strip that renders it. The run's selection is the runtime's,
and the browser business reads it rather than owning it; and `turn` has no `ui/` at all, yet is a
business, because its attach-to-settle lifecycle and generation-fenced identity outlive any
surface. The process behind a terminal is the service's, not the business's
(§11). Each business directory holds up to five roles (`contracts/`, `application/`, `projection/`,
`bindings/`, `ui/`); the role decides what a file may do, and the dependency check enforces the layer a
role belongs to. Details: [`../client/ownership.md`](../client/ownership.md).

## 9. State and temporal ownership

The client — not the server — owns its stream state and reconciles it. That is a measured decision, not
an omission: a server snapshot-plus-deltas design was prototyped and compared against the client's
policy, and it reached consistency only by inventing capabilities the host does not have
([`../adr/observation-architecture.md`](../adr/observation-architecture.md)).

Four mechanisms hold the resulting concurrency down, each with one home:

- **Interest leases** (`client/conversation/session-scope.ts`): a session or resource is held by
  selected-view, secondary-consumer, delivery-attempt and command-settlement claims, released
  independently. Navigation releases its own claim only; accepted delivery and mutation obligations keep
  their rights until completion, supersession, explicit detach or recorded failure.
- **Generation fences** (`client/conversation/stream-lease.ts`, `stream-loop.ts`): exactly one stream
  lease is live per session, one generation higher than the last, and every write a stream attempt makes
  is fenced against the generation it claimed — a superseded attempt cannot write.
- **Incarnation and freshness** (`client/application/identity-epochs.ts`,
  `client/conversation/request-freshness.ts`): a result commits only to its own live owner incarnation,
  and an invalidation is repaired only by a result that covers its freshness revision, so an earlier
  read cannot clear a later dirty revision.
- **Keyed resources vs selected slots**: a resource query is stored under a key covering every
  response-affecting input, including opaque credential and configuration generations, so two answers
  cannot overwrite each other; a selected destination is its own cell with its own identity and
  generation, so a slow answer for an earlier selection is refused at the new one.

**Delivery detach is not execution abort.** Hiding or closing a view, or closing the browser connection,
ends observation; only an explicit stop calls `abortSession`, and only an unstarted queued item is
removable.

## 10. Session creation and submission

Every way a session can be created — ordinary send, goal, installed plugin, session rail — reaches one
application use case (`client/application/task-session-workflows.ts`), which decides the workspace rule,
the created identity, the guarded adoption and the committed navigation. The vocabulary is one intent,
one decision, one completion, and a refusal is a **value** rather than a rejection, so the refusal path
is not the exception path. Adoption moves state only onto a destination that is still the live one:
single-flight creation per home, selection only while the navigation claim is current, a destination
with its own state wins, a purged destination is never resurrected, a superseded source is refused as
`stale-source`, and a failed creation leaves the draft and the history intact.
Details: [`../client/submission.md`](../client/submission.md).

## 11. Process resources

Owned by the runtime assembly, released by the lifecycle: the OAuth core with its lease and refresh
timer, account login, daily check-in, usage quota and its pure projection, request signing, the runtime
environment scope, the mcode-tools broker with the child environment and the embedded entry, the
browser provider, profile files, the workspace-archive adapters, session transfer, the terminal process
manager (one per service, disposed in `close()`), and the six slash commands. Boot order, close order and
the failure paths are in [`../runtime/boot.md`](../runtime/boot.md).

Two ownership facts worth stating here because they are easy to get wrong:

- **The terminal manager belongs to the service, not to a browser surface.** Hiding a tab or closing the
  page releases delivery and the xterm attachment; the process survives until explicit disposal.
- **The page never closes the runtime.** A reconnect re-attaches to the same host; only the service's
  shutdown ends it.

The **browser bridge** is a resource of the other kind: it is not created by the runtime assembly but
supplied to the service (`server/service.ts`), and the service closes it (`server/service.ts:308`).
It is a `server/` resource that drives a browser, which is why it may import `@mavis/browser-core`
while `src/client/` and `src/shared/` may not.

## 12. Invariants

A change that breaks one of these is a design change, not a refactor:

1. **Import direction is decided by layer, and the layer by the directory.** `pnpm check:webui-dependency`
   enforces it, including `import type` edges the build erases.
2. **A business is reachable only through its published surface.** A peer imports that business's
   `contracts/` or an explicitly published `.public.ts` / `.public.tsx` module. Other
   `application/`, `projection/`, `bindings/` and `ui/` modules remain private; the dependency check
   enforces the rule and rejects a public marker that re-exports foreign implementation.
3. **One module, one path.** A moved file gets every importer repointed — including relative `../`
   specifiers — and no `export * from` shim is left behind.
4. **Presentation holds no write authority.** A component dispatches a command to the application owner
   that holds the slice; it never receives a generic store writer and never calls transport methods for a
   business workflow.
5. **No browser global, storage or DOM access outside `client/platform/` and the bindings that adapt it.**
   Application and projection modules receive capabilities or values.
6. **The roster and the registry move together.** A port member without a binding, or a binding without a
   registry entry, must not compile; the pinned counts move in the same change.
7. **Registry order is stable.** It is observable on the wire: append, do not reorder.
8. **Optional means unsupported.** An unwired operation stays `undefined` through the port, the slice and
   the component, which renders the affected area conditionally.
9. **`shared/` reaches neither execution side**, and `packages/tui` is never imported.
9a. **The browser's semantics live in one place.** The meaning of a browser action belongs to
    `@mavis/browser-core`, and both surfaces execute it through a `BrowserTransport`. A provider that
    re-implements an action's meaning is a second definition of what the action does, and the two
    will drift. The WebUI keeps the **authorization** decision — the core reads no switch.
9b. **A transport carries a command; it does not judge one.** A `BrowserTransport` adapter decides
    *how* a command reaches a page or tab. It never decides what the command means, and it never
    decides whether the command may run.
10. **One writer per piece of state.** No two modules own the same map, and the writable session record
    has one owner.
11. **One writer per browser cell, and the two cells are separate.** The run's selection is written by
    the Agent through the runtime; the tab the person is looking at is written by the person through
    the strip; neither party writes the other's cell. The panel shows, streams and binds input to the
    viewed page, and the toolbar reports the runtime's mark without offering to change it. There is
    one bootstrap: a person who opens a web tab while the run has no selection gives the run that page,
    because a run with no selection cannot act at all — and the runtime decides it, from the selection
    it owns at the moment the page appears (`runtime/browser/browser-service.ts` — `openWebTab`).
    See §8 for the businesses that own each side.
