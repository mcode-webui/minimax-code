**Reference material for the WebUI Browser Use programme — not a work item.**

Captured before implementation, from the source at the current checkout. Path in the workspace: `.plan/browser-use/exploration/01-runtime-server.md` (gitignored, outside the published source projection).

---

# 01 — Runtime/Server seams for WebUI Browser Use

Investigation-only notes. No code is changed. Every claim below is anchored to a `file:line`
in the published source tree (verify against the current commit when implementing). Where
the ADR or development plan makes a claim, the claim is checked here against the actual
source and the result is stated.

The investigation scope covers only the runtime host assembly, the two composition roots
that start it, the loopback WebSocket admission path, the per-start credential, the
operation dispatcher (with `watchTerminal` as the stream lifecycle reference), the
runtime capability port, and the existing `browser`-named seams already present.

The runtime-side host-contract module
`packages/local-runtime-v2/src/local/host-contract.ts` is read only as far as the WebUI
forwards its options; full ownership of `browserAdapter` and `browserToolExposure` lives
in `@mavis/local-runtime-v2` and is out of scope.

---

## 1. `packages/webui/src/runtime/browser-provider.ts` — the provider adoption seam

The module declares the slot the WebUI exposes for a *host-supplied* browser provider.
The WebUI does not construct one; the host process supplies it. The whole module is
~60 lines and the contracts are small.

### Exported types (`browser-provider.ts:13-47`)

```ts
import type { CreateLocalRuntimeHostOptions } from "@mavis/local-runtime-v2/process-local";

export type WebuiBrowserAdapter = NonNullable<
  CreateLocalRuntimeHostOptions["browserAdapter"]
>;

export type WebuiBrowserToolExposure = NonNullable<
  CreateLocalRuntimeHostOptions["browserToolExposure"]
>;

export interface WebuiBrowserProvider {
  readonly adapter: WebuiBrowserAdapter;
  close(): void | Promise<void>;
}

export interface WebuiBrowserProviderBinding {
  readonly browserAdapter?: WebuiBrowserAdapter;
  readonly browserToolExposure?: WebuiBrowserToolExposure;
  readonly browserUseTooling: boolean;
  readonly closeBrowserProvider: () => void | Promise<void>;
}
```

### `adoptWebuiBrowserProvider` (`browser-provider.ts:49-58`)

```ts
export function adoptWebuiBrowserProvider(
  provider: WebuiBrowserProvider | undefined,
  exposure: WebuiBrowserToolExposure | undefined,
): WebuiBrowserProviderBinding {
  return {
    ...(provider ? { browserAdapter: provider.adapter } : {}),
    ...(exposure ? { browserToolExposure: exposure } : {}),
    browserUseTooling: provider !== undefined,
    closeBrowserProvider: () => provider?.close(),
  };
}
```

### What the contracts actually mean

- `WebuiBrowserProvider` is a two-field object the host hands the WebUI. The WebUI
  never declares the adapter shape; it forwards `CreateLocalRuntimeHostOptions`
  generics. In the runtime, the underlying shape is `LocalBrowserAdapter` /
  `LocalBrowserToolExposure` from `@mavis/agent-tools/desktop` (see
  `packages/local-runtime-v2/src/local/host-contract.ts:7,51-52,69-70`). Browser Use
  implementers must look in `@mavis/agent-tools/desktop` for the actual adapter
  contract; `WebuiBrowserProvider` is the *adoption slot*, not a redeclaration.
- `browserToolExposure` is the runtime's own "tool-schema exposure" object, distinct
  from the adapter. The two are passed into the binding *independently* — neither is
  required when the other is present, and an exposure without a provider, or a
  provider without an exposure, is legal. A future browser client must accept that
  the two are independent inputs.
- `browserUseTooling` is a *readiness statement*, not a request. The comment at
  `browser-provider.ts:39-41` is explicit: "`browserUseTooling` is a readiness
  *statement*, not a request: it is true exactly when a provider was adopted, which
  is what the harness reads." The current seam therefore conflates "provider was
  adopted" with "tooling is available". The development plan flags this as
  insufficient — provider presence is not a user authorization (development plan
  §3, ADR 0019 §"Browser Use remains a host-owned runtime capability"). There is
  no separate per-browser-surface authorization slot on the binding.

### Verdict on the plan's claim

Plan §3: "the current runtime derives browser-tool availability from provider
adoption, while `browserToolExposure` describes tool-schema exposure. Neither is,
by itself, an independent authorization check for the three browser surfaces or the
Full CDP capability." This holds:

- `browserUseTooling` is set to `provider !== undefined` (`browser-provider.ts:56`).
  There is no independent boolean input that maps to the three default-off
  authorizations or the Full CDP switch.
- The `configGetter` in `assembly.ts:316-330` reads the binding's
  `browserUseTooling` into `beta.browserUseTooling`, which the runtime then
  surfaces to its policy module
  (`packages/local-runtime-v2/src/service/browser-use/policy.ts:8-18`,
  `isBrowserUseToolingAvailable` uses `browserUseToolingEnabled === true` plus an
  optional `provider` and a separate `filePanelBrowserEnabled`). The WebUI-side
  seam has no notion of a per-surface switch or Full CDP.

---

## 2. `packages/webui/src/runtime/assembly.ts` — adoption + lifecycle ownership

### How the provider is adopted

`assembly.ts:186-212` declares `CreateWebuiRuntimeHostOptions`, which includes:

```ts
readonly browserProvider?: WebuiBrowserProvider;
readonly browserToolExposure?: WebuiBrowserToolExposure;
```

`createWebuiRuntimeHost` (`assembly.ts:230-477`) runs in this order:

1. `adoptWebuiBrowserProvider(options.browserProvider, options.browserToolExposure)`
   at `assembly.ts:260-263`. Result is a `WebuiBrowserProviderBinding`.
2. The binding's `closeBrowserProvider` is wired into the lifecycle at
   `assembly.ts:265-269`:

```ts
const lifecycle = createWebuiRuntimeLifecycle({
  disposeAuth: authSession.dispose,
  disposeMcodeTools: () => mcodeTools?.dispose(),
  closeBrowserProvider: browser.closeBrowserProvider,
});
```

3. The binding's `browserAdapter`, `browserToolExposure`, and `browserUseTooling`
   are plumbed into the forwarded harness options at `assembly.ts:297-337`:

```ts
configGetter: () => ({
  ...currentConfig,
  beta: {
    ...currentConfig.beta,
    mcodeTools: mcodeTools.ready,
    browserUseTooling: browser.browserUseTooling,
  },
}),
...(browser.browserAdapter ? { browserAdapter: browser.browserAdapter } : {}),
...(browser.browserToolExposure
  ? { browserToolExposure: browser.browserToolExposure }
  : {}),
```

The `WebuiForwardedRuntimeHostOptions` (`assembly.ts:142-156`) is the runtime's own
`CreateLocalRuntimeHostOptions` with a `Pick<...>` over `browserAdapter` and
`browserToolExposure` only, so the forwarded shape cannot drift from the runtime
type.

### Who owns closing the provider

`packages/webui/src/runtime/lifecycle.ts` is the single close owner. Its
`WebuiRuntimeResourceOwners` interface declares `closeBrowserProvider?` as an
optional slot (`lifecycle.ts:21-22`). The close order is fixed:

- `close()` (`lifecycle.ts:50-77`) runs, in order: `disposeAuth` →
  bound host close → `disposeMcodeTools` → `closeBrowserProvider?`.
  Failures are collected and raised as one error or an `AggregateError`.
- `closeAcquiredResources()` (`lifecycle.ts:78-97`) runs the same three non-host
  steps in the same order when the factory threw before returning a host.

The provider is therefore closed *after* the harness host and *after* the
mcode-tools broker. The plan's WP2 (`lifecycle cleanup for Chromium processes,
profile directories, stream pumps and pending input`) must fit inside
`provider.close()` — the host does not know what those resources are. Failures
inside `close()` are caught and folded into the aggregate.

### Lifecycle order observed by `assembly.ts`

- Pre-host failure path (`assembly.ts:272-296`): if `authSession.start()` or
  `prepareWebuiMcodeToolsIntegration` throws, `lifecycle.closeAcquiredResources()`
  is called to release the capability owners. The provider's `closeBrowserProvider`
  is therefore invoked even if the host never came up.
- Factory failure path (`assembly.ts:359-380`): if `factory(forwardedOptions)`
  throws after auth/mcode-tools succeeded, `lifecycle.closeAcquiredResources()`
  is again called before the error is re-thrown. The comment at
  `assembly.ts:362-365` is explicit: "the capability owners were already acquired
  above, so release them on this path as well; otherwise a broker socket or
  Browser profile survives a failed WebUI start."
- Post-host failure path (`assembly.ts:385-398`): if `mcodeTools.ensureCommandPath()`
  throws, the wrapped `host.apiHost.close()` runs `lifecycle.close()`, which runs
  the same full order once.

Implementers adding a browser provider must guarantee `close()` is idempotent
because the same wrapped close can run from both the post-host failure path and
the eventual `service.close()`.

---

## 3. Composition roots — where a provider would have to be supplied

There are exactly two composition roots that build a `WebuiRuntimeHost`. Both are
read here verbatim because they are the only places a Browser Use provider can
enter the WebUI today.

### Development root — `scripts/run-webui-server.mjs`

```js
// run-webui-server.mjs:42-59
const assembled = await createWebuiRuntimeHost({
  dataDir,
  appVersion: "webui-dev",
});
const port = createHarnessPortFromHost(assembled.host);
const terminal = new WebuiTerminalManager();
const service = new WebuiService({
  port,
  operations: createOperationRegistry(port, terminal),
  terminal,
  tcpPort,
  dev: true,
  clientDir,
});
```

Notes:

- `createWebuiRuntimeHost` is called with only `dataDir` and `appVersion`. No
  `browserProvider`, no `browserToolExposure`. The provider adoption seam
  therefore resolves to the all-undefined branch of
  `adoptWebuiBrowserProvider`, which yields `browserUseTooling: false`.
- The launcher reaches the assembly through `../packages/webui/src/runtime/index.ts`
  (`run-webui-server.mjs:30-32`), so any change to the runtime exports is reflected
  here without copying them.
- `WebuiService` is constructed with `dev: true`. This is the development-mode
  admission bypass; see §4 below.
- `tcpPort` defaults to `8787` (`run-webui-server.mjs:37`).

### Packaged production root — `release/webui-npm/bin/mcode-webui.mjs`

```js
// mcode-webui.mjs:28-39
const assembled = await createWebuiRuntimeHost({ dataDir, appVersion: version });
const port = createHarnessPortFromHost(assembled.host);
const terminal = new WebuiTerminalManager();
const service = new WebuiService({
  port,
  operations: createOperationRegistry(port, terminal),
  terminal,
  host: "127.0.0.1",
  tcpPort,
  dev: true,
  clientDir: path.join(packageRoot, "client"),
});
```

Notes:

- Imports come from `../server/server.js` and `../server/runtime.js` — the bundled
  server/runtime entry points, *not* the workspace source. The packaging layout
  therefore has the runtime factory available as a single named import, ready
  to receive `browserProvider` and `browserToolExposure`.
- The packaged entry **also** calls `createWebuiRuntimeHost({ dataDir, appVersion })`
  without `browserProvider`. It passes `host: "127.0.0.1"` explicitly (the
  development root leaves the default in place) and the same `dev: true`. The
  comment at `mcode-webui.mjs:52-54` acknowledges the dev-mode consequence:
  "dev mode keeps the per-start credential off, so the shell page and its assets
  load without a query token."
- The composition root also closes in two steps (`mcode-webui.mjs:41-48`):
  `await service.close(); await assembled.host.apiHost.close();`. The lifecycle
  order (`service.close` → `host.apiHost.close`) is the same as the development
  root; the difference is just the explicit second call.

### What this means for the plan

Both roots must supply a provider consistently. Validating only
`scripts/run-webui-server.mjs` does *not* prove the shipped WebUI path. Both roots
currently run with `dev: true`; both must adopt the same provider (or both must
not) for the production behavior to match the development behavior. A Browser
Use implementer must add the same option to both call sites, with the same
gating, because `WebuiService` cannot itself reach back into the assembly to
construct a provider — the assembly runs first and produces `host`.

The plan's WP2 acceptance ("the real provider path is exercised; a fake provider
alone is insufficient for this exit") follows directly from this: the test must
go through `createWebuiRuntimeHost` with a real provider, not by stubbing the
adapter inside the harness port.

---

## 4. `packages/webui/src/server/access-policy.ts` — admission rules

### Loopback Host check (`access-policy.ts:99-106`)

```ts
export function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}
```

`isLoopbackBindAddress` (`access-policy.ts:108-117`) accepts loopback IPv6 zone IDs
(`%lo0`) by stripping the zone before re-checking. LAN and `0.0.0.0` are refused
at construction (`service.ts:199-202`).

### Allowed Origins (`access-policy.ts:119-135`)

```ts
export function isAllowedOrigin(origin: string, host: string, port?: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return false;
  if (port === undefined) return true;
  const portNumber = parsed.port
    ? Number(parsed.port)
    : defaultPortForProtocol(protocol);
  return portNumber === port && parsed.hostname === host;
}
```

This rejects everything except `http(s)://127.0.0.1` and `http(s)://localhost`.
A `chrome-extension://` Origin fails the protocol gate before the hostname is
even checked. The plan's directive ("do not broaden the existing origin check
to accept arbitrary extension origins") is already enforced by this code; the
generic WebUI origin policy does not need to change.

### HTTP admission — `admitHttpRequest` (`access-policy.ts:26-45`)

Checks the loopback `Host` header and the `Origin` header. The credential check
is intentionally left to the router (`http/router.ts:44-48`) because that
function needs the parsed request URL. Note: the HTTP credential check is
applied *after* admission but *before* route dispatch.

### WebSocket upgrade admission — `admitWebSocketUpgrade` (`access-policy.ts:51-81`)

```ts
export function admitWebSocketUpgrade(
  request: IncomingMessage,
  url: URL,
  socket: Duplex,
  context: WebuiAdmissionContext,
): boolean {
  const urlHost = url.hostname.toLowerCase();
  const requestHost = (request.headers.host ?? "").toLowerCase();
  const requestOrigin = (request.headers.origin ?? "").toLowerCase();
  if (!requestHost || !isLoopbackHost(requestHost.split(":")[0] ?? "")) {
    rejectUpgrade(socket, 403, "Forbidden Host");
    return false;
  }
  if (urlHost !== "127.0.0.1" && urlHost !== "localhost") {
    rejectUpgrade(socket, 403, "Forbidden Host");
    return false;
  }
  if (
    requestOrigin &&
    !isAllowedOrigin(requestOrigin, context.host, context.tcpPort())
  ) {
    rejectUpgrade(socket, 403, "Forbidden Origin");
    return false;
  }
  const presented = url.searchParams.get("token");
  if (!context.dev && !credentialMatches(context.credential, presented)) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return false;
  }
  return true;
}
```

Order of rejection: loopback `Host` → loopback URL host → `Origin` → token.
Note the `dev: true` bypass on the token check (`access-policy.ts:76`). Both
composition roots pass `dev: true` today, so generic WebUI token checks are
currently disabled.

### Where the WebSocket upgrade is admitted — `websocket-server.ts:43-75`

```ts
handleUpgrade = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void => {
  if (!this.context.isAccepting()) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = parseWebSocketUrl(request.url);
  if (!url) {
    rejectUpgrade(socket, 400, "Bad Request");
    return;
  }
  if (
    !admitWebSocketUpgrade(request, url, socket, {
      host: this.context.host,
      tcpPort: this.context.boundTcpPort,
      credential: this.context.credential,
      dev: this.context.dev,
    })
  ) {
    return;
  }
  this.server.handleUpgrade(request, socket, head, (ws) => {
    this.server.emit("connection", ws, request);
  });
};
```

The hook used by the HTTP server is set in `service.ts:236-237`:

```ts
this.httpServer.on("upgrade", this.wsServer.handleUpgrade);
```

A Browser Use implementer who needs a *separate* extension admission path has
two options:

1. **Path branch inside `WebuiWebSocketServer.handleUpgrade`.** The current code
   dispatches every upgrade through the single admission function. A dedicated
   extension path would need to short-circuit before `admitWebSocketUpgrade` —
   for example, by inspecting `url.pathname` and dispatching to an
   extension-specific admission that also checks identity, pairing credential,
   protocol version, message sizes, and per-browser switch state. The decision
   point is `websocket-server.ts:62-71`. The plan's WP3 requires pairing
   credentials to remain enforced when `dev: true`; `admitWebSocketUpgrade`'s
   `dev` bypass is exactly the bypass that must not apply to extensions.
2. **Independent `WebSocketServer` instance.** The HTTP server only routes
   `upgrade` events; a second `WebSocketServer({noServer: true})` bound to the
   same HTTP server with its own `upgrade` listener could admit a separate
   `/extension` path. This requires a URL-path branch in the upgrade hook
   above and a second `WebuiWebSocketServer`-like wrapper.

Neither option exists today. The existing infrastructure enforces the
single-origin/loopback/credential model; the extension admission is not yet
written. Implementers must decide which path to take.

---

## 5. `packages/webui/src/server/credentials.ts` — per-start token

Full file is ~40 lines. Two facts:

- `createWebuiCredential` (`credentials.ts:19-21`) generates the token with
  Node's `randomUUID()`. The token is created in `WebuiService`'s constructor
  (`service.ts:207`) when no override is provided.
- `credentialMatches` (`credentials.ts:28-36`) uses `timingSafeEqual` over the
  UTF-8 bytes of the two strings; the length check is explicit to keep the
  timing constant.

Implication for Browser Use: the per-start WebUI token cannot serve as a
persistent browser pairing credential. It changes on every service start
(`credentials.ts:19-21` plus the fact that the service is constructed fresh on
each `npm start`/`mcode-webui.mjs` invocation). The development plan and ADR
agree: the extension bridge requires its own credential lifecycle, persisted
in OS secure storage (WebUI side) and extension local storage (extension
side), unrelated to the per-start token.

---

## 6. WebSocket operation path, streams, and cancellation

The path goes: `ws.on("message")` → `frame-handler.ts:handleInboundFrame` →
`operation-dispatch.ts:dispatchWebuiFrame` → handler → response/event/error
frames.

### Frame ingress (`frame-handler.ts:24-73`)

- Binary frames are rejected with `WebuiErrorCode.invalidEnvelope`
  (`frame-handler.ts:30-40`, "binary frames are not accepted"). This is the
  reason an image-frame transport that wants to carry binary JPEG/PNG bytes
  cannot use the *same* WebSocket as the JSON envelope without changing this
  gate. Two options a Browser Use implementer would have to add: (a) lift the
  binary ban and define a new envelope shape that distinguishes binary image
  frames from JSON control frames, or (b) keep image frames on a *separate*
  WebSocket connection (the plan's WP3 already requires a dedicated extension
  admission path, which is one natural place for this).
- Frames above `maxMessageBytes` (`service.ts:46`: `WEBUI_MAX_MESSAGE_BYTES =
  256 * 1024`, configurable via `WebuiServiceOptions.maxMessageBytes`) are
  rejected with `WebuiErrorCode.payloadTooLarge`
  (`frame-handler.ts:42-52`). `ws.WebSocketServer({maxPayload: maxMessageBytes})`
  is set in `websocket-server.ts:36-39` — note that `maxPayload` is a ws
  library setting; frames larger than this are dropped before
  `handleInboundFrame` runs.
- JSON parse failures are rejected with `invalidEnvelope` (`frame-handler.ts:53-66`).

### Dispatch (`operation-dispatch.ts:30-162`)

`dispatchWebuiFrame`:

1. Validates the envelope (`judgeWebuiFrame`).
2. Rejects non-`request` kinds.
3. Returns `shuttingDown` when `accepting` is `false`.
4. Looks up the registry; missing operation → `unknownOperation` with the
   operation name (`operation-dispatch.ts:68-78`). The terminal operations
   rely on this: when no `terminal` is supplied, they are not registered and
   a `watchTerminal` request becomes `unknown_operation` instead of crashing
   (`operations.ts:103-108, 135-142`).
5. Calls `entry.operation.validate(parsed.body)`; failure → error frame
   with the validator's code.
6. Calls `entry.handle(context, validated.body)` with
   `{ requestId, signal }`. The signal is per-connection
   (`websocket-server.ts:101-108, 119`):

```ts
const connectionController = new AbortController();
this.connectionSignals.set(ws, connectionController);
...
signalFor: () => this.connectionSignals.get(ws)?.signal,
```

The signal aborts when the WebSocket closes (`websocket-server.ts:104-113`)
or when `closeConnections()` runs during shutdown
(`websocket-server.ts:135`). Every handler therefore receives a per-connection
`AbortSignal` it can plumb into its source.

7. Two result shapes: `{ body }` for unary responses, `{ stream }` for
   streams. Stream results go through the pump at
   `operation-dispatch.ts:96-150` (see next subsection).

### Stream lifecycle — `watchTerminal` as the canonical reference

The terminal handler at `operation/handlers/terminal.ts:78-89` is the
canonical "stream over an AsyncIterable with an AbortSignal" pattern:

```ts
const watchTerminal: DedicatedHandler<typeof watchTerminalOperation> = (
  context,
  body,
) => ({
  stream: {
    ok: true,
    source: terminal.watch(
      String((body as Record<string, unknown>).terminalId),
      context.signal,
    ) as unknown as AsyncIterable<Record<string, unknown>>,
  },
});
```

`terminal.watch` (in `WebuiTerminalProcessPort`, `port.ts:596-603`) takes
the `AbortSignal` and yields `{ terminalId, data, exited }` records. The
implementation lives in `WebuiTerminalManager.watch` (referenced from
`runtime/index.ts:27`); not opened here, but the contract is that the source
honors `AbortSignal` so the dispatcher can drive cancellation.

### Stream pump — `operation-dispatch.ts:108-150`

```ts
const iterator = toAsyncIterator(result.stream.source as ...);
const signal = getSignal();
let finalised = false;
const finalise = async (): Promise<void> => {
  if (finalised) return;
  finalised = true;
  await iterator.return?.();
};
const close = () => void finalise();
signal?.addEventListener("abort", close, { once: true });
if (entry.operation.acknowledgesStream)
  sendFrame(ws, responseFrame(parsed.requestId, { stream: true }));
try {
  while (!signal?.aborted) {
    const next = await iterator.next();
    if (next.done || signal?.aborted) break;
    sendFrame(ws, eventFrame(parsed.requestId, next.value));
  }
} finally {
  signal?.removeEventListener("abort", close);
  await finalise();
}
```

Key properties an image-frame transport must reproduce:

- **Cancellation.** Both the per-connection `signal.aborted` and the explicit
  `iterator.return?.()` are wired. A disconnect on the client side aborts
  the controller (`websocket-server.ts:104-113`), which in turn aborts the
  handler's signal, which breaks the pump and finally calls `iterator.return`.
  The `finalised` gate guarantees `return()` is invoked at most once.
- **No back-pressure.** `sendFrame` (`operation-dispatch.ts:176-182`) is
  `ws.send(JSON.stringify(frame))`; it does not await the socket's internal
  back-pressure, nor does the pump drop frames if the socket buffer fills.
  Image frames at high frame rate will queue in the Node send buffer. A
  Browser Use implementer must add back-pressure policy — either at the
  handler level (skip frames if `ws.bufferedAmount` exceeds a threshold),
  or by throttling at the source, or by switching to binary WebSocket
  frames with their own size governance.
- **Acknowledge-frame opt-in.** `entry.operation.acknowledgesStream` controls
  whether a `{ stream: true }` response is sent before pumping. The terminal
  stream keeps the original wire shape (no ack); only `watchEvents` opts in
  (`operation-contract.ts:33-40`). Image streams probably want the same
  shape as the terminal stream — no ack — but the implementer must decide.
- **Frame size.** Each event becomes one JSON frame
  (`{protocolVersion, kind:"event", requestId, body}`). At the default
  `WEBUI_MAX_MESSAGE_BYTES = 256 * 1024`, a base64-encoded JPEG or PNG image
  will routinely exceed the limit; this is the reason an image-frame
  transport needs a separate channel or a different encoding contract.

### Operation registry wiring (`operation/operations.ts`)

`createOperationRegistry(port, terminal?)` (`operations.ts:69-230`) builds the
Map of registered operations. The pattern a Browser Use implementer must
follow for any new dedicated handler:

- Terminal handlers are conditionally registered at
  `operations.ts:135-142` only when the `terminal` argument is supplied.
  The `unknown_operation` fallback in the dispatcher means an absent
  `terminal` does not crash; it returns an error frame. The same shape
  applies to a `browserExtension` adapter argument: present it conditionally,
  register six `browser*` operations when present, fail closed when absent.
- The handler maps are produced by `createXxxHandlerEntries(port)` factories
  (`operations.ts:74-82`). Operations are explicitly enumerated in a fixed
  order at `operations.ts:88-228` so the wire order is stable. Browser Use
  operations must be added in this list.

### Per-connection lifecycle — `websocket-server.ts`

- Connections are tracked in `this.connections: Set<WebSocket>`
  (`websocket-server.ts:30`).
- Heartbeat: 15s default (`service.ts:92`,
  `WEBUI_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 15_000`). The heartbeat `unref`s
  its timer (`websocket-server.ts:99`) so it does not block process exit.
- `closeConnections()` (`websocket-server.ts:129-144`) terminates every
  connection on shutdown before `server.close()` runs, aborting each
  per-connection signal so in-flight streams finalize.

---

## 7. `packages/webui/src/runtime/port.ts` — the runtime capability port

`WebuiHarnessPort` (`port.ts:132-565`) is a flat interface with ~80 methods,
each one matching a `WebuiHarnessPort` member on the harness port that
`createHarnessPortFromHost` projects from the runtime host. Capability
groupings:

- Session CRUD, history, turns, diff, rewind, edit
  (`listSessions`, `createSession`, `forkSession`, `rewindSession`, …).
- Messages and turns (`getMessages`, `sendMessage`, `resumeSession`,
  `watchEvents`).
- Permissions/questionnaire (`listPendingPermissions`,
  `replyPermission`, `replyQuestionnaire`, `dismissQuestionnaire`).
- Queue, abort, models, skills.
- Workspace (`listWorkspaceFileTree`, `readWorkspaceFile`,
  `getWorkspaceEnvironment`, `mutateWorkspaceGit`, workspace review,
  `readCanvas`/`applyCanvas`, `readWorkspaceArchive`,
  `extractWorkspaceArchive`).
- Plugin management, permission mode (`pluginManagement`, `getPermissionMode`,
  `setPermissionMode`).
- Personalization (`getGlobalInstructions`, `setGlobalInstructions`,
  `getAgentMemory`, `setAgentMemory`, `getUserProfile`, `setUserProfile`,
  `getMemorySettings`, `setMemorySettings`).
- Provider configuration (`listUserModelProviders`, …,
  `revealModelProviderApiKey`, `startCodexOAuthLogin`, `cancelCodexOAuthLogin`,
  `refreshModels`, `runCommand`).
- Account/quota/billing (`getSigninPanel`, `claimSignin`,
  `beginAccountLogin`, `getAccountLoginStatus`, `cancelAccountLogin`,
  `signOutAccount`, `getUsageQuota`, `getCreditFallback`,
  `setCreditFallback`, `listResetCards`, `useResetCard`,
  `queryResetCardFlows`, `getAccountUsageSummary`, `getAccountProfile`,
  `getAccountStatus`).
- `requestCompaction`, `invalidateAuth`, `readHostPrerequisites`,
  `pluginManagement`, `runCommand`, `close`.

**No browser capability exists.** A grep over `port.ts` finds the string
"browser" only inside a comment at `port.ts:128` ("the browser needs a stable
wire shape…"). There is no `listBrowserTargets`, no `selectBrowserTarget`,
no `forwardBrowserInput`, no `watchBrowserStream`, no
`getBrowserCapabilities`. Any browser capability the WebUI needs must be
added to this interface and to `createHarnessPortFromHost` so it ends up on
the port the service binds to.

The closest analogue is `WebuiTerminalProcessPort` (`port.ts:579-606`),
which is a separate narrow port the WebUI service receives alongside the
harness port. The terminal operations are registered conditionally based on
its presence (`operations.ts:135-142`). A browser capability port can follow
the same pattern: a separate `WebuiBrowserProcessPort` (or a richer port if
the design requires more than the terminal exposes) handed into
`createOperationRegistry`, with `createBrowserHandlerEntries(port)` building
the handlers.

The plan's WP1 will need to add browser DTOs to `shared/contracts/` (which
is the right layer — see §1 of the plan's "Architecture and ownership
constraints"). The runtime capability has to land in `port.ts` and be
projected from the host by `harness/adapter.ts`.

---

## 8. Existing `browser` references in `src/runtime` and `src/server`

Each match below is read and characterized.

### `packages/webui/src/runtime/`

| File | Lines | What it does |
| --- | --- | --- |
| `runtime/browser-provider.ts` | 1-58 | Full file — the adoption seam, §1. |
| `runtime/lifecycle.ts` | 8-22, 70, 91 | The browser provider is one of three close owners; close order is auth → host → mcode-tools → browser. |
| `runtime/assembly.ts` | 12, 113-128, 154-155, 186-198, 260-269, 327, 333-336 | Re-exports adoption types, plumbs `browserAdapter`/`browserToolExposure` into forwarded options and `beta.browserUseTooling` into the runtime config getter. |
| `runtime/index.ts` | 18-20 | Re-exports `WebuiBrowserAdapter`, `WebuiBrowserProvider`, `WebuiBrowserToolExposure` so the composition roots can name them. |
| `runtime/terminal.ts` | — | No browser references. |
| `runtime/auth-session.ts` | 14, 68 | Comments only ("browser session", "in the browser"). |
| `runtime/account-login.ts` | 8, 11 | Comments only ("without leaving the browser", "browser needs"). |
| `runtime/check-in.ts` | 35, 99 | Comments + a `browser_name: "mcode"` field in a telemetry payload (`check-in.ts:99`). Not related to Browser Use. |
| `runtime/usage-quota.ts` | 864 | `browser_name: "mcode"` payload field — same telemetry context. |
| `runtime/harness/host-contract.ts` | 615 | Comment about a "login completed in the browser". |
| `runtime/harness/result-conversion.ts` | 9, 86 | Comments only. |
| `runtime/profile-files.ts` | 46 | Comment: "a browser-side program has no node globals." |
| `runtime/runtime-environment.ts` | 17 | Comment: "The runtime's send path is fine; the runtime it hosts was [crashing] in browser builds." |
| `runtime/workspace-archive.ts` | 114 | Comment about "a browser … chosen by the view". |
| `runtime/workspace-archive/archive-filesystem.ts` | 31 | Comment: "The relative path arrives from the browser". |
| `runtime/workspace-archive/archive-policy.ts` | 69 | Comment: "Mirrored rather than imported because that module is browser-side and this is [Node-side]". |

The string `browser` in `src/runtime` therefore refers to *Browser Use* only
in three files: `browser-provider.ts`, `lifecycle.ts`, and `assembly.ts`.
Every other match is incidental commentary about the Web browser client or
about Node-vs-browser globals.

### `packages/webui/src/server/`

| File | Lines | What it does |
| --- | --- | --- |
| `server/service.ts` | 16 | "This file holds no OAuth, broker or browser provider." — comment is true; no actual browser logic. |
| `server/service.ts` | 147 | "plain browser without scraping a per-start token" — describes the `dev` mode. |
| `server/credentials.ts` | 3, 6 | "a neighbouring browser on the same loopback interface" — refers to the Web browser client, not Browser Use. |
| `server/operation/operation-dispatch.ts` | 20 | "the runtime's stable code was discarded on its way to the browser" — Web browser client. |
| `server/operation/binding-mechanism.ts` | 308 | "the browser as 'this host cannot answer this operation'" — Web browser client. |
| `server/operation/workspace.ts` | 282 | "a browser cannot name an absolute path" — Web browser client (input validation). |
| `server/operation/common.ts` | 23 | "A browser cannot produce an absolute path" — Web browser client. |
| `server/operation/handlers/workspace.ts` | 4 | Same theme. |
| `server/operation/session.ts` | 239 | "The browser project picker cannot" — Web browser client. |
| `server/http/session-transfer.ts` | 55 | "keeps it out of the browser's heap" — Web browser client. |
| `server/http/workspace-file.ts` | 16 | "Media preview and HTML preview both need a URL the browser streams" — Web browser client. |
| `server/projections/model-provider.ts` | 12, 151 | "payload the browser believes" — Web browser client. |
| `server/projections/index.ts` | 7 | "browser builds the permission and questionnaire" — Web browser client. |

**There is no Browser Use code in `src/server`.** Every match concerns the
Web browser client. The runtime host's browser provider surfaces in the
server only as the harness's optional `browserAdapter` and
`browserToolExposure`, which are not currently consumed by any operation
handler.

---

## Plan claims verified against source

| Plan claim | Source | Holds? |
| --- | --- | --- |
| "the current runtime derives browser-tool availability from provider adoption" | `browser-provider.ts:56` (`browserUseTooling: provider !== undefined`); `assembly.ts:316-330` reads it into `beta.browserUseTooling` | Yes. |
| "`browserToolExposure` describes tool-schema exposure" | `browser-provider.ts:25-27` (`WebuiBrowserToolExposure = NonNullable<CreateLocalRuntimeHostOptions["browserToolExposure"]>`); the two are forwarded independently | Yes. |
| "Neither is, by itself, an independent authorization check for the three browser surfaces or the Full CDP capability" | No boolean input on `WebuiBrowserProviderBinding` distinguishes the three surfaces or Full CDP | Yes. |
| "Both currently run with `dev: true`" | `run-webui-server.mjs:57` and `mcode-webui.mjs:37` both pass `dev: true` | Yes. |
| "Neither `scripts/run-webui-server.mjs` nor the packaged production entry `release/webui-npm/bin/mcode-webui.mjs` supplies a browser provider" | Both call `createWebuiRuntimeHost({ dataDir, appVersion })` without `browserProvider` | Yes. |
| "`packages/webui/src/server/access-policy.ts` admits loopback HTTP(S) origins and the WebUI's per-start token. It rejects extension origins" | `isAllowedOrigin` (lines 119-135) accepts only `http:`/`https:`; `chrome-extension://` fails the protocol gate | Yes (the protocol gate is the rejection mechanism, not the hostname gate). |
| "`src/server/credentials.ts` creates that token per service start, so it cannot meet persistent browser pairing by itself" | `createWebuiCredential` (lines 19-21) uses `randomUUID()`; constructed once in `WebuiService` (`service.ts:207`) | Yes. |
| "The WebSocket operation path supports cancellable streams" | Per-connection `AbortController` (`websocket-server.ts:101-108`), `iterator.return?.()` idempotent gate (`operation-dispatch.ts:124-129`) | Yes. |
| "`watchTerminal` and `src/server/operation/handlers/terminal.ts` provide a lifecycle pattern for a stream, but image frames may require a purpose-built transport shape and back-pressure policy" | `terminal.ts:78-89` pattern; `sendFrame` (`operation-dispatch.ts:176-182`) does not await socket back-pressure; `WEBUI_MAX_MESSAGE_BYTES = 256 * 1024` (`service.ts:46`) | Yes — and the binary frame ban at `frame-handler.ts:30-40` confirms a different transport shape is required for image data. |

## Gaps the plan must create (not extend)

- **Per-browser authorization boolean.** The `WebuiBrowserProviderBinding` does
  not have one. The plan must add a slot for "which surfaces are authorized"
  on the assembly options and on the binding.
- **Full CDP gate.** Likewise absent. The plan must add a slot on the binding
  (or a sibling option) that gates full-CDP commands independently of provider
  presence and per-surface authorization.
- **Extension identity + pairing credential lifecycle.** No `WebuiCredential`-like
  object for the extension bridge exists. No OS-credential-store adapter exists
  on the WebUI side. The implementer must create both.
- **Extension admission path.** The current `WebuiWebSocketServer.handleUpgrade`
  dispatches every upgrade through the single `admitWebSocketUpgrade` function
  with the `dev`-mode bypass on the token check (`access-policy.ts:76`). A
  dedicated extension admission that ignores `dev` and validates pairing
  credentials + browser identity + protocol version + per-browser switch state
  does not exist.
- **Image transport.** No binary frame support; `WEBUI_MAX_MESSAGE_BYTES =
  256 * 1024`; `sendFrame` does not await back-pressure. A Browser Use
  implementer must design a transport — either a separate extension WebSocket
  carrying binary frames, or a new envelope shape on the existing channel —
  with explicit back-pressure policy.
- **Capabilities port member.** `WebuiHarnessPort` has no browser methods. The
  plan must add methods or a parallel port and the
  `createHarnessPortFromHost` projection that materializes them.

---

## Open questions / risks

- **WebSocket message-size cap is per-frame and per-direction.** The WS
  library's `maxPayload` (`websocket-server.ts:36-39`) caps inbound frames;
  the WebUI does not have an explicit outbound frame cap, but `ws.send` will
  queue until the OS socket buffer is full. For 30 fps JPEG at 1280×720 this
  is a real bottleneck; the implementer must measure before settling on a
  transport.
- **No extension storage adapter is visible in `packages/webui/src/server/`
  or `src/runtime/`.** The plan assumes OS secure credential storage; the
  current code has no dependency or interface for it. A WP0 task must add
  this and verify availability on every supported OS.
- **`isLoopbackBindAddress` accepts `[::1]` but `admitWebSocketUpgrade` only
  accepts `127.0.0.1` / `localhost` as the URL host.** If a packaged entry
  binds `[::1]`, a client using `ws://localhost:...` will still connect,
  but a client using `ws://[::1]:...` will fail at `access-policy.ts:64`.
  Today both composition roots use `127.0.0.1`, so this is moot, but a
  Browser Use implementer should not change the bind host without revisiting
  this.
- **Per-connection abort signal is shared across all in-flight operations.**
  A `sendMessage` stream and a `watchTerminal` stream on the same socket
  both bind to the same `connectionSignals.get(ws)?.signal`. A disconnect
  cancels both. For a separate extension socket, the same pattern is
  desirable — one connection, one abort, all per-extension streams
  finalize together.
- **The runtime `beta.browserUseTooling` is set from the binding's
  `browserUseTooling` flag (`assembly.ts:327`).** A future implementation
  must not silently widen this to `true` when the user has not authorized
  any browser surface. The plan's WP0 must address this.
