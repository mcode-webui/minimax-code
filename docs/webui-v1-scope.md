# WebUI first version scope

What the first version covers, what it deliberately leaves out, and the wiring and
assembly it needs. The reasoning behind the decisions lives in [`docs/adr/`](adr/).

## In scope

- Session list over the shared history in `~/.minimax`, and read-only browsing of
  past sessions
- Creating a session with an explicitly chosen working directory
- Sending a message and rendering the streamed reply
- Permission prompts and questionnaires
- Aborting a turn, and surfacing queue state instead of hiding it
- Model selection and switching
- Session usage display
- Reconnecting with a cursor, and resynchronising when the cursor has fallen out of
  range
- Loopback-only access: bind `127.0.0.1`, validate Host and Origin, require a
  per-start credential, expose an operation allowlist with runtime validation
- The full tool capability set: local tools, mcode-tools and Browser Use
  ([ADR 0008](adr/0008-first-version-assembles-the-full-tool-capability-set.md))

## Out of scope for the first version

- Account, provider, plugin, cron and update panels. States that need them are
  reported as messages, not as configuration interfaces.
- Terminal rendering, terminal image preview, check-in
- Remote or LAN access — see
  [ADR 0004](adr/0004-own-websocket-transport-with-minimal-envelope-and-local-access-control.md)
- A queue editing interface
- Taking over turns owned by another runtime owner
- Automatic resume of persisted jobs at cold start — see
  [ADR 0002](adr/0002-in-process-runtime-host-with-quarantined-cold-start.md)

## Behaviour boundaries

- Shared history is readable, but live execution belongs to the runtime owner that
  created it. The WebUI cannot attach to a turn the terminal client is running, and
  cannot answer that process's permission or questionnaire requests.
- Closing a browser connection unsubscribes: it aborts that connection's event
  signal and returns the stream iterator. It does not abort the turn. Only an
  explicit stop calls `abortSession`, and only removing an unstarted queued message
  uses the queue entries.
- `[DONE]` marks the end of a stream, not the success of the turn.
- Concurrency is per session: several sessions can run at once, but the runtime's
  admission and queue rules still apply within one session.
- A session's working directory is chosen at creation and cannot be changed
  afterwards; moving means creating a new session.

## Visual language

The WebUI reuses the desktop application's design tokens, typography and layout
conventions rather than designing its own. See
[`webui-visual-language.md`](webui-visual-language.md) and
[ADR 0009](adr/0009-webui-reuses-the-desktop-visual-language.md).

## Wiring: additive edits to existing files

| File | Change |
| --- | --- |
| `pnpm-workspace.yaml` | add `packages/webui` |
| `release/extraction.json` | add `packages/webui` to `packageRoots` |
| `tsconfig.standalone.json` | regenerate with the existing script; never hand-edit `paths` |
| `test/vitest-suites.json` | add a `webui` suite listing the real test files |
| `package.json` | add the WebUI build, type check, boundary and test scripts |
| `scripts/verify.mjs` | add the WebUI gates in order, in the shared verifier rather than the workflow file |
| `release/public-source.json` | regenerate with `node scripts/source-inventory.mjs --write` after reviewing the added paths |
| `release/dependency-licenses.json` and the lockfile | update for the WebUI's new dependencies |
| `scripts/build-webui.mjs`, `scripts/check-webui-boundary.mjs` | new: separate build and boundary check producing `dist-webui/` with its own metafile ([ADR 0010](adr/0010-webui-ships-an-esbuild-artifact-with-vite-as-a-development-server.md)) |

`scripts/build.mjs` keeps its four CLI entry points; the WebUI is not added to them.
The standalone TypeScript config type-checks the CLI entry points only, so the
WebUI needs its own configuration for browser and server code.

## What the WebUI boundary check must assert

- The server and client entry points both appear in the WebUI metafile
- No retired source paths in the graph (`packages/local-runtime/src/http/`,
  `packages/local-runtime-v2/src/http/`, and the rest of the retired set)
- No dependency on the terminal renderer (`packages/tui/src/tui/`)
- No forbidden internal addresses, credentials or private host implementations
- No server-side call back into the CLI
- Only the process-local and `cli-service` entries plus allowed public workspace
  exports

## Assembly checklist: from process start to first reply

1. **Resolve the data directory.** Use the CLI default `~/.minimax`; do not create a
   WebUI-specific one. Establish this process's own runtime owner identity, and do
   not claim it can take over another process's owner.
2. **Resolve service configuration.** Read configuration, version, model
   configuration, permission mode and the WebUI's default workspace. The default
   workspace must not be the service process's working directory.
3. **Assemble credentials for the selected model.** Managed MiniMax login needs an
   auth context getter with refresh and invalidation; a MiniMax API key or a BYOK
   provider needs its key and base URL. Model execution cannot bypass credential
   resolution, with or without a login interface.
4. **Declare interaction capabilities.** At minimum questionnaire reply, permission
   prompt and elicitation, set explicitly in the WebUI's own host assembly. Do not
   add a `webui` value to `surface`.
5. **Assemble the tool capabilities in scope.** For mcode-tools: the beta switch,
   the short-lived token broker, the command path, and release on shutdown. For
   Browser Use: the adapter, optional tool exposure, beta configuration, asset
   registration, questionnaire admission binding and provider lifecycle. Neither is
   driven by a config flag alone.
6. **Create the process-local host** with the supported owner combination:
   `runtimeOwnerKind: 'cli'`, `capabilityProfile: 'cli'`,
   `capabilities.cliEmbedded: true`, `runtimeMode: 'clean'`,
   `startupExecutionPolicy: 'quarantined'`.
7. **Wait for host ready and take `host.cliService`.** The field is optional in the
   host contract, so check it rather than assuming every host provides it.
8. **Create sessions** with an explicit, existing, absolute `workspaceDir`. Reject a
   request without one at the transport layer instead of letting the runtime fall
   back to an implicit workspace.
9. **Subscribe to global events per connection.** One `AbortController` per
   WebSocket, passed to `watchEvents`, for session status, permission and
   questionnaire events.
10. **Send and stream.** Call `sendMessage` with the connection's signal and
    translate the returned async iterable into WebSocket frames using the mixed
    frame semantics of `SessionStreamFrameView`: heartbeat, whole messages, chunks,
    runtime events, action deltas, terminal states and the end marker are not one
    uniform text delta.
11. **Handle reconnect.** Record the cursor only after a whole frame group has been
    processed. Resume with the cursor or message id. On a resynchronisation notice,
    reload authoritative history and establish a new subscription.
12. **Handle stop and interactions.** Explicit stop calls `abortSession`; prompts use
    `replyPermission`, `replyQuestionnaire` and `dismissQuestionnaire`. Closing a
    connection does none of these.
13. **Shut down in order.** Stop accepting new WebSocket operations, end each
    connection's event signal and frame sources, then close the host, owner, OAuth
    watch, browser provider, logging and observability within bounds. A page
    unsubscribe never shuts down the host; SIGTERM does.
