# The harness boundary

`runtime/port.ts` declares `WebuiHarnessPort`: the callable, `AsyncIterable` and cancellation types
plus one method per operation, typed with the DTOs in `shared/contracts/<domain>.ts`. The adapters
under `runtime/harness/` implement it from `WebuiRuntimeHostHandle`; `createHarnessPortFromHost`
derives the port from the handle.

## The roster must agree with the registry

The port's method set is contractually the same as the set of registered operations.
`server/operation/bind-handlers.ts` derives its `Pick` from the port, so a port method added or
removed must reach the registry in the same change. That agreement is enforced by the compiler
rather than by an assertion:

- every port fake must implement every member — `FullPort` in
  `test/unit/webui-host-shape-invariant.test.ts`, `ScriptedHarnessPort` in
  `test/unit/webui-service.test.ts`;
- the binding count is pinned separately (`createBindingEntries(port).size`).

Drop a port member without dropping its binding, or add one without reaching the registry, and
`pnpm typecheck:webui` stops compiling. The current roster is pinned in
`test/unit/webui-operation-binding.test.ts`: **99** bindings and **18** dedicated handlers, covering
**117** operation names. A new operation breaks all three counts, so bump them in the same change —
after checking that the roster really grew.

The eighteen operations that keep a hand-written handler live in `server/operation/handlers/`
(`account`, `browser`, `commands`, `messages`, `miniapp`, `miniapp-agent`, `stream`, `terminal`,
`workspace`). They are the ones that cannot be expressed as a single capability call — a shaped
response, a second runtime surface of their own, or a capability the host may not have.

## Host types and wire projections

`runtime/assembly.ts` assigns the actual host without a whole-host assertion.
`runtime/harness/host-contract.ts` derives requests and results from the public `CliService`
methods; private runtime type names do not need new exports. The harness adapters reconstruct
host inputs and convert results into independently owned WebUI wire DTOs.

Canvas input decoding exhaustively covers the inferred mutation union. Semantic result readers
retain the inferred host types, so changing a source field reaches the compiler at its reader.
Opaque extension records and methods whose upstream result is explicitly `unknown` retain
bounded runtime conversion. `webui-host-contract-derivation.test.ts` pins that remaining set and
requires zero request or result assignability mismatches.

## What the browser can ask for

Every operation has a descriptor in `server/operation/<domain>.ts`, a binding in
`server/operation/bind-handlers.ts`, and an entry in the registry that
`../architecture/layered-model.md` describes. The wire frames they arrive in are described there too.
A capability the host does not offer is not an error: each capability port method is optional, and
`undefined` means "this operation is not wired".

## Published host event names

`scripts/host-event-catalogue.mjs` reads host producer declarations with the TypeScript checker
and generates `shared/contracts/host-event-types.generated.ts`. This is a WebUI adapter artefact;
the generator does not modify host sources or redefine the WebUI DTOs.
`pnpm --filter @mavis/webui gen:host-events` refreshes it after a reviewed producer change.
Server typecheck checks freshness.
The production session-fact decoder then requires every catalogue fact to have an applied route or
an explicit unhandled rationale. A generated new name without that decision fails compilation.
