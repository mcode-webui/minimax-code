# Layered model

One facet of the architecture design: [`design.md`](design.md) is the whole. This document covers the
execution boundaries and the path a request takes.

`packages/webui` is a browser client for the process-local harness layer. It is a browser
application plus the loopback service that serves it and forwards to the harness in process. It does
not import `packages/tui` (ADR 0003) and does not drive the CLI binary (ADR 0001); it builds on
`@mavis/local-runtime-v2` directly, as the terminal client does.

## Execution chain

```
React component
  → browser application owner           (client/features/*/application, client/application)
  → browser transport                   (client/platform/transport.ts)
  ── WebSocket, authenticated ──        (cross-process; server/http-server, websocket-server)
  → loopback server: validate → dispatch (server/service.ts, server/operation/)
  → WebUI runtime adapter               (runtime/harness/)
  → harness host handle                 (in-process; @mavis/local-runtime-v2)
```

Four boundaries are held apart, each with its own owner (ADR 0014, ADR 0016):

| Boundary | Owns | Does not |
| --- | --- | --- |
| `src/client/` | Browser orchestration, business state, presentation, browser IO | Speak to the harness, hold Node resources |
| `src/server/` | Network ingress: authentication, envelope validation, dispatch, wire projection, socket lifecycle, static assets, and the external browser bridge | Hold browser state or import runtime implementations |
| `src/runtime/` | Harness capability adaptation and every Node-side process resource | Know which session a browser has selected |
| `src/shared/` | Cross-process wire contracts and shared constants | Import either execution side |

`src/client/` type-checks under `tsconfig.client.json`; `src/server/`, `src/runtime/` and `src/shared/`
under `tsconfig.server.json`. The browser bundle has its own metafile (`dist-webui/metafile.json`),
checked by `scripts/check-webui-boundary.mjs`. The dev launcher runs the Node side through the
repository's `tsconfig.standalone.json` via `tsx`, not through either package config.

## The browser's own boundary

The browser runtime sits inside `src/runtime/` and the browser bridge inside `src/server/`, and both
reach the browser through `@mavis/browser-core` — a workspace package, not a WebUI layer.

```
Agent tool or panel
  → browser service                      (runtime/browser/browser-service.ts)
  → provider: isolated Chromium or bridge (runtime/browser/isolated-chromium/, server/browser-bridge/)
  → Browser Core session                 (@mavis/browser-core)
  → BrowserTransport adapter             (core-transport.ts, one per surface)
  → the browser
```

The split is the one that keeps the layers honest: **Browser Core decides what an action means, the
WebUI decides whether it may run, and the transport decides how the command travels.** The core
reads no authorization switch and the transport judges no action. `@mavis/browser-core` is a
dependency of the `runtime/` and `server/` layers only; `src/client/` and `src/shared/` never import
it, which is why the restricted command vocabulary is duplicated in
`src/shared/contracts/browser.ts` rather than read from the core.

See [`../browser-use/10-browser-core-integration.md`](../browser-use/10-browser-core-integration.md).

## How a request travels

1. The browser calls a `WebuiTransport` method (interface in `client/contracts/transport.ts`,
   implementation in `client/platform/transport.ts`), which frames
   `{protocolVersion, kind: "request", requestId, operation, body}`.
2. `WebuiService` validates the frame and hands it to `dispatchWebuiFrame`.
3. The dispatcher looks the operation up in the registry; an unregistered name or a failed `validate`
   becomes an error frame with `invalidBody`.
4. The handler calls the matching `WebuiHarnessPort` method (`runtime/port.ts`), which the adapter
   under `runtime/harness/` implements by delegating to the harness host.
5. The result becomes a response frame, or a stream of event frames for the operations that stream
   (`sendMessage`, `resumeSession`, `watchEvents`, `watchTerminal`).

The registry order is the `registerOperation` call order and is observable on the wire; keep it
stable. `runtime/harness-boundary.md` states the rules the port and the registry must agree on.

Where each layer's modules live is [`module-map.md`](module-map.md); the import and ownership rules
that hold these boundaries are [`boundaries.md`](boundaries.md).
