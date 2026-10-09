# The WebUI separates harness capability integration from browser orchestration

`packages/webui` redraws its internal boundary into four layers, because a
client/server split describes where code runs but never assigns who owns harness
capabilities, who owns browser business orchestration, and who owns the process
resources the service holds:

- `src/runtime/` — harness capability adaptation and every Node-side process
  resource: the OAuth core and its leases, refresh timers and invalidation
  propagation, quota, check-in, account login, the mcode-tools broker, the browser
  provider, profile files, session transfer, and the harness adapters split out of
  the 905-line `createHarnessPortFromHost`.
- `src/client/application/` — browser business orchestration, the single writer
  authority for session and interaction records, recovery policy and request
  ownership.
- `src/shared/` — the only declaration point for cross-process protocol contracts.
- `src/server/` — network ingress, authentication, dispatch, wire projection and
  socket lifecycle, and nothing else.

The execution chain is React → browser application → browser transport → loopback
server → WebUI runtime → public harness. Browser-to-loopback is a cross-process
protocol; loopback-to-harness stays an in-process call, extending
[0002](0002-in-process-runtime-host-with-quarantined-cold-start.md). Modelling both
as one remote-service relationship would produce the wrong interfaces.

Two constraints are treated as non-negotiable. **There is no production feature
flag and no parallel dual subscription, dual reducer write or dual store** — a
migration window that runs both paths is itself a new source of duplicated state,
so each stage removes its old writer in the same change. **Symmetry with the
terminal client is not an acceptance criterion**: `packages/tui` already splits
`runtime/`, `application/` and `types/`, which makes the shape workable, but
directory, file-granularity and port-shape parity are explicitly excluded from
what counts as success here.

## Considered Options

- **One `runtime` layer between client, server and harness** — rejected: it adds no
  execution boundary and leaves the 1495 lines of `host.ts` and `assembly.ts`
  sharing a directory whose actual duty is network ingress.
- **Deferring extraction until responsibilities are fixed** — rejected as an
  endpoint: with no `client/application/`, the correct owner of business
  orchestration remains the React shell, so orchestration stays where the defect
  is.
- **Moving all orchestration server-side and letting the client receive snapshots**
  — rejected: it requires a snapshot subscription protocol, versioning and replay,
  per-browser selection context, slow-client handling and offline-interaction
  contracts. That is a protocol redesign, not a responsibility cleanup.
- **Stopping at contract separation, leaving orchestration in components** — rejected:
  it fixes the 37 client-to-server type references but leaves the duplicated writers
  and recovery entry points intact.

## Consequences

The implementation contract — file-by-file provenance, the typed operation
bindings that replace the duplicated forwarding closures, the frozen dependency
baseline, state ownership, and the staged migration with its rollback unit — lives
in `docs/webui/webui-runtime-layer-plan.md`. This record fixes the shape and the
constraints; the plan fixes the work.

Verification cannot come from the existing build checks. `scripts/lib/webui-boundary.mjs:133-138`
admits every input under `packages/webui/`, so it cannot see an internal edge at
all, and `import type` edges are erased from build output — which matters because
the server currently pulls browser contract declarations into the Node dependency
graph. Source-level AST checks covering type-only edges, re-exports and literal
dynamic imports become part of `scripts/verify.mjs`.

A new binding must constrain the operation's response type: `ResultBody` is unused
in the current `WebuiOperation` descriptor (`operation-contract.ts:20` versus
`:28`), so the descriptor never constrained responses. Bindings may not tighten an
existing validator to make themselves compile.