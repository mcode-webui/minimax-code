# Security and state rules

## Process and Browser boundary

- Node owns data access through CLIs, APIs, SDKs, files, and Connectors, as well as persistence.
  Client owns presentation and user interaction.
- Keep credentials, authorization headers, Connector inventory, opaque tool refs, internal ports,
  and Host objects out of HTML, Client JavaScript, logs, SSE/WebSocket payloads, and error
  responses.
- Bind only `context.listen` and expose only declared surface and MCP routes.
- The Host guards the assigned port at the `http.Server` layer: only the Desktop page and managed MCP
  client carry its per-run credential, and all other callers get `401`. Serve the port with a
  `node:http` server, keep the `/__mavis/` path prefix free, and do not add another authorization
  scheme that expects the Host's credential. See
  [runtime-api.md](runtime-api.md#loopback-authentication).
- Validate request parameters and responses. Do not expose arbitrary command, URL, Connector,
  or filesystem proxies.

## One mutation path

Route every business mutation through one Node domain service:

```text
HTTP / MCP / background command -> validate -> domain service -> durable commit -> SSE or WS event
```

Page requests, MCP tools, and background refreshes share that service. Commit first and broadcast
second. A failed broadcast does not roll back committed state; reconnecting pages recover by reading
the current snapshot. Use stable idempotency keys and reconcile an unknown Connector write outcome
before retrying.

Store durable state under the injected `dataDir`. Keep artifacts reproducible. Browser storage may
hold view preferences such as filters, sort order, and expanded rows, but not Connector or domain
data.

## Update and recovery

The `miniapp` tool's `publish` action stages, validates, and atomically adopts or updates the candidate from the
current Session workspace. It does not install dependencies or build source. A failed publish keeps
the last accepted package metadata, but a failure after the old service stops leaves the service
failed or stopped; the Host does not roll back or restart the old service automatically. Fix
candidate-owned diagnostics and publish again, or explicitly restart the accepted package; use
`inspect` to confirm the result. `restart` never reads or adopts workspace changes.
