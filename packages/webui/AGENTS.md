# Agent guide — `@mavis/webui`

The root `AGENTS.md` still applies in full: branch naming, generated-file discipline, the
publication boundary, and the "documentation and commit messages in English" rule. This file adds
what is specific to this package.

`packages/webui` is the browser client and the loopback service in front of the process-local
harness layer (`@mavis/local-runtime-v2`). It is the fourth client of that host — it does not speak
ACP and does not drive the CLI. Architecture decisions live in `CONTEXT.md` and `docs/adr/` at the
repo root; the v1 scope and assembly checklist in `docs/webui-v1-scope.md`. `README.md` next to this
file covers the package boundaries and its own scripts.

The package is a leaf: no `exports` map, no other workspace package consumes it. It does not exist in
`upstream/main`, so splitting or renaming files inside it costs no three-way merge conflict — but it
does change `release/public-source.json`, which must be regenerated.

## Layout

```
src/
  client/             browser shell: entry, transport, contracts, runtime store, router
    components/       React components (the shell and every panel it renders)
    contracts/        capability ports and view types; transport.ts joins them into WebuiTransport
    infrastructure/   browser transport, event channel, storage and browser IO
    mechanisms/       stream lease and stream-loop algorithms without application policy
    bindings/          React subscriptions, application context, navigation and browser effects
    application/       business workflows, state owners and query/request coordination
    projection/       pure state and message projections — no React, no transport
    styles/           index.css, tokens.css, shell.css, transcript-widgets.css
    assets/           fonts, images, lottie
  runtime/            Node-side runtime: port, assembly, lifecycle, auth-session, commands/, harness/
  server/             loopback service: envelope, credentials, index, service, terminal
    operation/        operation registry, per-domain descriptors, handlers, dispatch
    projections/      server-side projections shared by handlers
  shared/             wire DTOs and constants
    contracts/        per-domain request/result types (session, messages, stream, goal,
                      interactions, queue, workspace, review, canvas, models, account,
                      usage-quota, terminal, version, personalization)
```

`client/` type-checks under `tsconfig.client.json`; `server/` and `runtime/` share
`tsconfig.server.json`; both include `shared/`. The dev launcher (`scripts/run-webui-server.mjs`)
runs the Node side through the repo-root `tsconfig.standalone.json` via `tsx`, not through either
package tsconfig. The browser bundle has its own metafile (`dist-webui/metafile.json`) and is
checked by `scripts/check-webui-boundary.mjs`.

`@mavis/shared` is a **different** workspace package (`packages/shared`), not `src/shared/` — the
server imports `@mavis/shared/daily-signin` and `@mavis/shared/runtime-boundary-env` from it.

## Core modules

### Client

| Module | Role | Use it by |
| --- | --- | --- |
| `client/main.tsx` | Build entry. Mounts the shell into `#webui-root` and constructs the transport **once** at module scope. | Importing nothing from it — it runs for side effects. |
| `client/contracts/` | The client-facing contracts: eight capability ports (`session-port`, `execution-port`, `interaction-port`, `workspace-port`, `settings-port`, `account-port`, `plugin-port`, `terminal-port`) plus the view types, joined by `contracts/transport.ts` into the `WebuiTransport` interface (every method optional — `undefined` means "this operation is not wired"). `contracts/transport.ts` declares no method of its own. | Importing types from here rather than from a component or the shell. |
| `client/infrastructure/transport.ts`, `client/infrastructure/event-channel.ts` | Request/response and independent-stream WebSocket IO; the application-owned `watchEvents` channel and reconnection. Components do not subscribe directly. | Constructed and owned by the application composition root. |
| `client/infrastructure/storage.ts` | Browser storage IO for unread, favorites, no-project, team-mode and composer history. | Application composition injects the storage adapter; preserve normalization and pruning rules as pure functions. |
| `client/mechanisms/stream-lease.ts`, `client/mechanisms/stream-loop.ts` | Lease algorithm and stream frame IO/control. Stream history/context transforms are injected; application turn coordination owns recovery policy. | Called by the turn coordinator, not by components. |
| `client/bindings/` | React subscriptions, application context, browser navigation, focus, scroll and other DOM effects. | Components use bindings for snapshots and named commands; a session binding mints the turn's generation-fenced stream sink inside `attachTurn` / `sendTurn`, so it hands out neither a store writer nor a sink factory. |
| `client/application/` | Business workflows, the canonical session store, turn/event/interaction coordinators, catalogs and request ownership. Composer submit workflows live in `composer-workflows.ts`. | Composition root wires transport, storage and the store. Named commands are the only component-facing write surface. |
| `client/application/session-store.ts` + `client/bindings/use-session-state.ts` | The framework-free canonical session/interaction store (`createWebuiSessionStore`, the writer and home-adoption types) and its React read binding (`useWebuiSessionStore`, `useWebuiSessionState`, `useWebuiSessionStream`, `useWebuiSessionSending`, `useWebuiSessionActivity`, `useWebuiSessionPermissions`). One map and one listener registry; there is no second complete session-store map. | Importing the binding from a component. The binding exposes named commands plus the `attachTurn` / `sendTurn` turn intents; the store writer and the attempt's sink never leave it. |
| `client/projection/stream-state.ts`, `client/mechanisms/stream-loop.ts` | Stream frame reduction (`reduceWebuiStreamFrame`) and send/resume loop (`runWebuiStreamLoop`, `buildWebuiStreamLoopSink`). The loop receives history/context and stream-state transforms as injected bundles (`WebuiStreamLoopDeps.projection`, `.streamState`). | Through application turn coordination; tests drive the pure reducer and loop directly. |
| `client/router.ts`, `client/bindings/navigation.ts` | `route(pathname)` maps paths; `navigation.ts:16` implements `readSessionIdFromHash` and the browser hash subscription. | Import route rules from `router.ts` and navigation state from its binding. |
| `client/slash-palette.ts`, `client/value-readers.ts`, `client/team-mode.ts`, `client/markdown.tsx`, `client/icons.tsx` | Slash-command UI palette, defensive readers for untrusted payload fields, team-mode helpers, markdown and icon renderers. Command field types belong in contracts, not this icon-bearing UI module. | Importing UI helpers directly; application/projection code must not use the palette for command types or classification. |

### Client / projection

Pure modules: no React import, no transport access. They turn server payloads into the view shapes
the components render, and they hold the state machines that are otherwise untestable without a DOM.

| Module | Role |
| --- | --- |
| `message-projection.ts`, `message-parts.ts` | Message → renderable parts (text, tool rows, attachments). |
| `transcript-projection.ts`, `tool-projection.ts` | Transcript grouping and tool-result shaping. |
| `questionnaire-state.ts`, `goal-state.ts`, `workspace-progress.ts` | Interaction, goal and workspace-progress derivations. |
| `composer-state.ts` | Pure composer intent, enter-key, path and recent-workspace state rules. Submission workflows and session ID extraction live in `application/composer-workflows.ts`. |
| `composer-history.ts` | Composer history normalization and pruning. Browser storage reads/writes go through the injected infrastructure adapter. |
| `action-requests.ts` | Request builders for actions (model selection and friends). |
| `effect-reducer.ts` | Pure event-effect reduction and command generation. Execution and refresh scheduling belong to the application event coordinator. |

### Server

| Module | Role |
| --- | --- |
| `server/index.ts` | The loopback network entry: it re-exports `WebuiService`, the operation registry, credentials, the envelope and the wire DTOs, and holds no runtime implementation. It is the server build entry (`scripts/build-webui.mjs`). The dev launcher (`scripts/run-webui-server.mjs`) imports `createWebuiRuntimeHost` and `createHarnessPortFromHost` from `runtime/index.ts` and `WebuiService` from `src/server/index.ts` separately, assembles the host, constructs `new WebuiService(...)` and calls `service.start()`. |
| `server/service.ts` | `WebuiService` — HTTP/asset serving, the authenticated WebSocket upgrade, connection lifecycle, and the call into `operation/operation-dispatch.ts`. Construct it with `WebuiServiceOptions`; `start()` resolves `WebuiServiceInfo` (with `boundUrl`). |
| `server/envelope.ts` | Runtime envelope validation (`isWebuiFrame`). The frame shape, protocol version and error codes live in `shared/envelope.ts`; the envelope shape is an external contract. |
| `server/credentials.ts`, `runtime/auth-context.ts` | The loopback credential and the per-request auth context. |
| `runtime/port.ts` | `WebuiHarnessPort` — the boundary to the harness layer: the callable, `AsyncIterable` and cancellation types, plus one method per operation. The request/result DTOs it uses live in `shared/contracts/<domain>.ts`. |
| `runtime/harness/host-contract.ts`, `runtime/assembly.ts` | The runtime host handle (`WebuiRuntimeHostHandle`, `WebuiRuntimeCliService`) and the composition root that creates and wires the process resources. The per-domain adapters that implement the port from the host live under `runtime/harness/`; the launcher builds the host once with `createWebuiRuntimeHost` and derives the port with `createHarnessPortFromHost`. |
| `runtime/lifecycle.ts`, `runtime/auth-session.ts`, `runtime/account-login.ts` | Resource registration with close ordering and failure recovery; the sole OAuth core with its lease and refresh timer; account login. |
| `server/terminal.ts`, `runtime/usage-quota.ts`, `runtime/check-in.ts`, `runtime/runtime-environment.ts` | Terminal manager, quota client, check-in, runtime environment reporting. |
| `runtime/mcode-tools*.ts`, `runtime/profile-files.ts`, `runtime/workspace-archive.ts`, `runtime/session-transfer.ts` | The mcode-tools broker, profile files, workspace archive and session transfer. |

### Server / operation

The registry is one module per concern. Add code in the layer it belongs to, not in `operations.ts`.

| Module | Role |
| --- | --- |
| `operation/operation-contract.ts` | `WebuiOperation` and friends, `ValidationFailure`, and the three validation primitives (`invalidBody`, `requireRecord`, `requireNonEmptyString`). |
| `shared/operation-names.ts` | Every `*_OPERATION_NAME` constant. |
| `operation/<domain>.ts` | The operation descriptors (name + `validate`) grouped by domain: `session`, `workspace`, `messages`, `goal`, `interaction`, `questionnaire`, `queue`, `provider`, `plugin-management`, `permission-mode`, `personalization`, `agent-memory`, `user-profile`, `memory-settings`. |
| `operation/bind-handlers.ts` | `WEBUI_OPERATION_BINDINGS` — the statically declared operation→capability mapping — plus `createBindingEntries` and `DEDICATED_OPERATION_NAMES` for the thirteen operations that keep a hand-written handler. It consumes the port from `runtime/port.ts`. |
| `operation/operation-dispatch.ts` | `dispatchWebuiFrame` — one inbound frame → validate → look up → handle → response, stream, or error frame. |
| `operation/operations.ts` | `createOperationRegistry` (the single `registerOperation` call site) and `registerOperation`. Re-exports the descriptors, so importers keep one entry point. The registry order is observable on the wire; preserve it when adding/removing operations. The set of operations it registers is contractually the same as `WebuiHarnessPort`'s — `bind-handlers.ts` derives its `Pick` from the port, so a port method added or removed must reach this file in the same change, and `test/unit/webui-host-shape-invariant.test.ts` (added in batch C) fails loudly if the two diverge. |

## How a request travels

1. The browser calls a `WebuiTransport` method (the interface in `client/contracts/transport.ts`,
   implemented in `client/infrastructure/transport.ts`), which frames
   `{protocolVersion, kind: "request", requestId, operation, body}`.
2. `WebuiService` validates the frame and hands it to `dispatchWebuiFrame`.
3. The dispatcher looks the operation up in the registry; an unregistered name or a failed
   `validate` becomes an error frame with `invalidBody`.
4. The handler calls the matching `WebuiHarnessPort` method (`runtime/port.ts`), which the runtime
   adapter under `runtime/harness/` implements by delegating to the harness host.
5. The result becomes a response frame, or a stream of event frames for the operations that stream
   (`sendMessage`, `resumeSession`, `watchEvents`, `watchTerminal`).

Registry order is the `registerOperation` call order and is observable; keep it stable.

## Dependency rules

The allowed direction, top to bottom:

```
components/  →  projection/  →  client/contracts/  →  shared/
server/      →  runtime/port.ts  ↔  runtime/  →  shared/
```

`shared/` imports neither execution side, and the browser never imports `server/` or `runtime/`.
`pnpm check:webui-dependency` enforces this direction over the source (including `import type` edges).

- **Never import `packages/tui`.** ADR 0003: read it as the specification, compose the equivalent
  here.
- No client module may appear in the server bundle, and no server module in the client bundle —
  `check:webui-boundary` enforces this from the build graph.
- A module has exactly one path. Do not leave a one-line `export * from` shim behind when a file
  moves: repoint every importer (including relative `../` specifiers, which a naive grep misses) and
  delete the shim.
- Application modules own business RPCs and writable state. Components must not call transport methods for business workflows or receive a generic store writer.
- Storage and DOM access belong in `client/infrastructure/` or `client/bindings/`; application and projection modules receive capabilities or values instead of reading browser globals.
- No new module may import the shell, and no two modules may own the same Map/state.

`runtime/mcode-tools-entry.ts` has one declared `non-literal-dynamic-import` allowance in
`scripts/lib/webui-dependency-baseline.json`. The runtime URL targets the generated embedded
artifact, which has no source-tree path for the resolver. `pnpm check:webui-dependency` reports
this separately as an unresolvable boundary; review the allowance against
`scripts/lib/mcode-tools-artifact.mjs` and its output path when that loader or packaging changes.
This is a documented exception, not evidence that every dependency or host-IO boundary passes.

## Conventions

- **Every operation needs a validator.** `registerOperation` fails closed when one is missing; a
  handler without a validator must not reach the registry.
- **Keep validators strict.** `webui-service.test.ts` asserts the `invalidBody` **code** only, so a
  changed message or a relaxed predicate is invisible to the suite. Pin message text with
  `assert.deepEqual` when you touch a validator, and compare old and new implementations with a
  throwaway probe rather than trusting the suite.
- **`verbatimModuleSyntax` is on.** Type-only imports need the `type` modifier; type re-exports need
  `export type`.
- **No DOM test framework.** Do not add jsdom, happy-dom, `@testing-library/*`, or a devDependency to
  build a DOM environment, and do not change `vitest.oss.config.mjs` (`environment: "node"` is shared
  by every suite). Interaction coverage takes two shapes: extract the transitions into exported pure
  functions and test those, and assert every render branch through `renderToStaticMarkup`. The wiring
  SSR cannot reach goes in the report's untested-boundary section.
- **Never write an assertion whose whole content is that a testid string exists** — it survives every
  mutation and reads as manufactured coverage.
- **CSS:** keep the two stacked generations' *effective* declaration, not the later block; never
  deduplicate rules that differ in at-rule context (`@media`, `@container`) — those are conditional
  overrides. `webui-design-tokens.test.ts` hard-asserts that named component classes appear in the
  compiled stylesheet, so a class no markup references can still be pinned by a test.
- **New Vitest file → register it** in the `webui` group of `test/vitest-suites.json`. It is an
  explicit list, not a glob; an unregistered file never runs.
- **New or moved file → regenerate the inventory**: `node scripts/source-inventory.mjs --write`.
  Content-only edits do not need it.
- Work material (briefs, reports, probes, logs) stays **outside** the repo, in
  `~/my_data/project/my_project/minimax-code-webui-work/`. The inventory scans the working tree, so
  scratch inside the repo silently becomes a publication problem.

## Common changes

### Adding a data operation

Edit in this order so each layer compiles against the previous one:

1. `shared/contracts/<domain>.ts` — the request/result wire DTOs (for example `Webui…Request` /
   `Webui…Result`), in the domain file that owns the capability.
2. `runtime/port.ts` — the method on `WebuiHarnessPort`, typed with those DTOs.
3. `runtime/harness/host-contract.ts` — the method on `WebuiRuntimeHostHandle`, delegating to the host
   object (`cliService`).
4. `runtime/harness/<domain>.ts` — the domain adapter that implements the `WebuiHarnessPort` method by
   calling the host handle.
5. `shared/operation-names.ts` — the `*_OPERATION_NAME` constant.
6. `server/operation/<domain>.ts` — the descriptor (validator + `WebuiOperation`).
7. `server/operation/bind-handlers.ts` — the binding, or the dedicated handler for the thirteen operations that keep one.
   so a missing handler is a compile error.
8. `server/operation/operations.ts` — the `registerOperation` call, in the position the order needs.
9. `client/contracts/<capability>-port.ts` — the method on the right capability port (optional, like
   its neighbours); it reaches `WebuiTransport` through `client/contracts/transport.ts`.
10. `client/infrastructure/transport.ts` — the implementation, then wire it through the application owner to the binding or workflow that needs it.
11. `test/unit/webui-service.test.ts` — extend `ScriptedHarnessPort`. Since batch A,
    `pnpm typecheck:webui` includes `tsconfig.test.json`, so a missing or
    wrongly-typed stub surfaces as a `Type ... is missing the following properties from type 'WebuiHarnessPort'`
    compile error, not a runtime failure. Keep the stubs exhaustive: a forgotten member
    `Partial<WebuiHarnessPort>` would defeat the type-checked-port guarantee batch C relies on.
12. `runtime/assembly.ts` — only when the implementation needs a session-scoped dependency (oauth
    lease client, quota client). Build it once and spread it onto the object **returned** as `host`:
    the dev launcher rebuilds the port from `createHarnessPortFromHost(assembled.host)` while unit
    tests use `assembled.harnessPort`, so enriching only the inner port keeps every gate green and
    breaks the live server with `runtime host does not expose the <method> client`.

### Splitting or moving a module

Move bodies verbatim; change only import specifiers and the `export` keyword. Verify by comparing
function bodies between the old and new revisions with the repo's own TypeScript compiler API — a
hand-rolled brace matcher silently skips declarations whose parameter types contain a nested `)`
(e.g. `raw: import("ws").RawData`) or whose name is a `#`-private, and then reports "no differences"
for a file it barely compared. Normalise relative import depth (`./x.js` vs `../x.js`) but keep the
target module in the comparison.

### Changing CSS

Rebuild, then compare the **effective** declarations, not the bytes:

```bash
pnpm build:webui
node ~/my_data/project/my_project/minimax-code-webui-work/w0-baseline/css-snapshot.mjs --check
```

The compiled stylesheet's hash is expected to move when shadowed declarations are dropped; the
snapshot reporting zero differences is the equivalence claim.

## Commands

### Run it

```bash
# Dev server (harness-backed, serves the built client) — http://127.0.0.1:8787/
pnpm --filter @mavis/webui dev:server      # WEBUI_SERVER_PORT overrides 8787
pnpm dev:webui                             # Vite dev server for client iteration

# Build the client bundle + stylesheet the dev server serves
pnpm build:webui
```

The client is served from the built `dist-webui/client/`, so client changes need `pnpm build:webui`
before a reload shows them; the server process needs a restart to pick up server changes. A server
you expect to keep browsing must not be tied to an agent session — start it detached.

### Gates

Run these before handing work back; `pnpm verify` runs the same set as CI.

```bash
pnpm typecheck:webui        # server + client tsconfigs
pnpm test:webui             # the webui Vitest group
pnpm check:webui-dependency # source-level dependency direction — sees `import type` edges; runs before the build
pnpm build:webui            # prints server/client input counts — a new file must raise them
pnpm check:webui-boundary   # nothing outside the allowed entries entered the graph
node scripts/source-inventory.mjs --write && pnpm check:source
git diff --check
```

`pnpm build:webui` printing the input counts is the cheapest proof that a new module is actually in
the build graph: a file that exists while the counts do not move has been written but never wired.

`pnpm check:webui-dependency` reads the source, so it sees the `import type` edges and the dependency
*direction* that `check:webui-boundary` cannot: the metafile check reads build output, where type-only
edges are already erased and an input's presence says nothing about which way it points. Its frozen
exception baseline is `scripts/lib/webui-dependency-baseline.json`; every entry must shrink as its
migration stage lands, and the gate fails on both a NEW violation and a baseline entry that is no
longer violated.
