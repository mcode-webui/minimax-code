# Mini App runtime authoring API

This Skill ships an authoring snapshot, not a runtime package. The Host owns the implementation and
injects values through `start(context)`. Generated plugins do not install or import a Mini App SDK
from npm.

## Type-checking setup

For a new package, copy [miniapp-api.ts](miniapp-api.ts) beside the Node source, for example at
`miniapp/node/miniapp-api.ts`, and include it in the project's TypeScript configuration. TypeScript
source may use a relative type-only import:

```ts
import type { MiniAppContext, MiniAppModule } from './miniapp-api.js';

export const start: MiniAppModule['start'] = async (context: MiniAppContext) => {
  return { dispose: async () => {} };
};
```

JavaScript can follow [node-entry.mjs](node-entry.mjs), whose JSDoc import is erased at runtime.
Inspect the built Node artifact and verify that it contains no runtime SDK import or `require`.

## Injected context

- `pluginId` and `pluginRoot` identify the accepted package.
- `dataDir` is the Host-owned runtime data root already isolated for the plugin. Keep runtime state
  there, not in the workspace package or artifacts.
- `listen.host` and `listen.port` are the assigned loopback binding. Do not select or probe a port.
- `signal` cancels startup, requests, and background work.
- `logger` accepts stable event codes and non-sensitive structured fields.
- `hostConnector` exists only when manifest allowlisting and Host authorization both succeed.
- `agent` exists only when the manifest declares `agentAccess: ["session.run"]`; see
  [Agent](#agent).

Host Connector uses Node IPC internally; the public `context.hostConnector` API is unchanged.
`stdout` no longer carries the protocol, so ordinary output is not parsed as Connector messages.
Prefer `context.logger` for diagnostics. The Host collects only bounded stdout/stderr samples; keep
logs free of credentials and business content, limit their volume, and do not rely on complete log
retention.

Resolve `start(context)` only after the HTTP listener is accepting connections and all declared
routes are installed. Resolution is the process readiness signal; the plugin does not expose a
readiness route. Keep `start(context)` limited to installing routes and starting the server. Return
a `dispose()` lifecycle that closes HTTP, SSE/WebSocket connections, child processes, timers,
subscriptions, and persistence handles. The Node entry is the Host's direct root and must stay alive
while the board is available; it can proxy to a backend it owns. Do not fetch business data
synchronously in `start(context)`; register the request handlers and resolve readiness instead.

## Loopback authentication

The Host installs an authentication guard on `http.Server` inside the Node process before it loads
the entry, so plugin code needs no auth logic and never sees the credential. The Desktop page and
the managed MCP client send a per-run Host credential; every other request to the assigned port
receives `401` (WebSocket upgrades are closed) before any plugin handler runs. The credential header
is removed before a request reaches plugin code. After the plugin resolves `start(context)`, the
Host confirms that the guard answers on the assigned port and only then treats the board as ready.

The guard patches `http.Server.prototype`, so it covers every `node:http` server the process
creates, not only the one bound to `context.listen.port`. A second internal port the entry opens for
itself (for example an OAuth callback listener, or the entry calling back into its own assigned
port) is guarded the same way and returns `401` to any caller — including a third-party redirect —
that does not present the credential header. Route flows that must accept unauthenticated
third-party requests through the assigned port's own handler, or through a listener outside this
process, instead of a second in-process `node:http` server.

- Serve the assigned `context.listen` port with a `node:http` server (`createServer` directly or a
  framework built on it). Do not bind that port with `https`, `http2`, a raw `net` server, or a
  child process: the guard cannot protect those, so the board never becomes ready and startup fails
  with `READINESS_TIMEOUT`. A backend in another runtime must listen on its own internal port behind
  a proxy in the Node entry.
- The `/__mavis/` path prefix is reserved for the Host. Do not declare or handle routes under it.
- Build page requests from relative or same-origin URLs. Requests from a Service Worker, a popup, an
  external browser, or an ordinary Browser tab do not carry the credential and receive `401`; do not
  depend on them. Do not try to read, forward, or log authentication headers.
- A process restart issues a new credential. An already-open Desktop tab keeps its old credential
  and gets `401` until the user clicks Refresh or opens the board again; there is no push channel
  that updates it automatically. This is expected after a restart triggered without a follow-up open
  (for example, the Agent restarting the board without reopening it) or after the process crashes
  and gets reactivated; it is not a plugin bug.

## Data access methods

`hostConnector` is optional and does not prevent the Node service from using a CLI, HTTP API, SDK,
or authorized files. See [data-access.md](data-access.md) for method selection, child process
management, and verification in the actual runtime. The Host Connector rules below apply only to
calls using that method.

## Host Connector

Use `context.hostConnector` only in the Node runtime. `hostConnector.list()` is available before the
service accepts calls, so request handling may inspect the allowed inventory. `hostConnector.call()`
is available only after activation. Select a tool by its verified provider, name, and input schema.
Call `hostConnector.call()` only from an HTTP or other request handler after publication activation.
Do not perform business calls inside `start(context)`, construct or store tool refs, send them to
the Browser, or expose the Host bridge from a page route.

Refresh inventory after process startup or a stale-reference error. For `unknown_after_dispatch`,
reconcile by reading domain state before retrying a write. Check caught errors against the exported
`HostConnectorError` shape: `code`, `message`, `disposition`, `retryable`, optional `invocationId`,
and optional `diagnostic.issues`. For invalid arguments, use each issue's `path`, `constraint`, and
optional numeric `limit` together with the matching inventory `inputSchema` to correct the request.
Diagnostics never contain the rejected argument values. Do not depend on `instanceof` across a
process boundary.

### Decoding call results

`HostConnectorCallResult.value` is the raw provider result. The Host preserves its JSON shape; it
does not normalize service-specific payloads. Compare the observed value with the sanitized probe
[fixture](fixtures/host-connector-call-result.json), then copy
[host-connector-value.mjs](host-connector-value.mjs) beside the Node source when the value needs
transport decoding.

The fixture's single text-block array is a probe-observed provider shape, not a global Host
contract. The helper recognizes it only when the root is an array of exactly one object whose only
fields are `type: "text"` and a string `text`. Only after removing that shape once does it decode at
most four JSON-looking layers from the extracted root text. Direct strings are never decoded. Direct
objects, ordinary arrays, primitives, multiple content blocks, and all other `JsonValue` shapes pass
through unchanged. Do not recursively decode provider-owned object fields, including fields named
`content`, `text`, or `value`. Malformed JSON-looking extracted text and excessive JSON string
nesting are parse errors rather than empty data.

Keep transport decoding separate from the provider/domain parser. Treat zero parsed domain items as
success only when the decoded provider result explicitly represents an empty result according to the
response shape proven during the authoring probe. If the decoded provider result contains source
data but the domain parser produces zero items, fail the request as a parse error. Never infer an
explicit empty result merely from the parser returning an empty array.

The Browser calls narrow business routes exposed by the board's Node service. Credentials, Connector
clients, and Host transport never enter Client code.

## Agent

Call `context.agent.run({ text, sessionId?, model?, agent? }, { signal?, onEvent? })` from a request handler after
activation, never inside `start(context)`. It runs one turn with the session's Agent and its full
capabilities (files, shell, Skills, and MCP including this Mini App's own), and resolves when the
turn ends with `{ sessionId, turnId, model?, status, text?, error?, pendingQuestion? }`. Page-initiated runs
use the agent of the chat session the Mini App is open in; Node-initiated runs, and pages not opened
from a session, use the primary Agent unless `agent` is passed (see `agents()` below); continuing a
session keeps its agent. A page-initiated
session works in the project directory of its chat when that chat has one; otherwise, and for
Node-initiated runs, the Agent works in this Mini App's own Agent directory; a continued session
keeps its directory. A new session takes the model and thinking level of the chat it was created
from (the runtime default when the chat has none or the session is Node-created), and keeps them.
`run` / `answer` may pass `model` to switch the session's model first; the Host validates it the way
the composer validates a new session's model (the model must be one the user can see in `models()`)
and rejects an unusable one with `INVALID_ARGUMENTS`. A model whose BYOK credentials are missing is
accepted here, and the turn then ends with `status: 'error'`. Results and `turn.started`
carry the model the turn was dispatched with. `status` is `finished`,
`error`, or `aborted`; `text` is the final assistant reply. Pass the returned `sessionId` to
continue the same conversation; each Mini App can only continue its own sessions. Aborting `signal`
cancels the turn: a started run resolves with `status: "aborted"` once the Host confirmed the abort
and rejects with `AGENT_OUTCOME_UNKNOWN` when it could not; one not yet sent rejects with
`REQUEST_CANCELLED`.

For business prompt construction, controls, and application transport cleanup, follow
[agent-interaction.md](agent-interaction.md). This reference defines the Host API contract.

### Interaction

The Mini App renders the Agent's interaction itself. Two interactions block a turn, and each maps to
one event and one reply:

- `permission.requested` → `reply`: a tool call waits for approval. Decide it with `allowOnce` or
  `deny`; there is no `allowAlways`, because a Mini App does not write the user's global rules.
- `question.requested` → `answer`: the turn paused on a questionnaire (`ask_user`, a feature enable,
  or a Plan review). `request` is the same questionnaire the Host chat renders; the answer starts
  the continuation turn, which you observe like `run`.

A permission request waits only while someone can answer it: (a) the run that owns the session
passed `onEvent` (page or Node), or (b) the session is currently shown in a chat side panel through
a page's `open`. Otherwise it is denied, and the model is told that
nobody can answer it and should continue without the tool. Where the session was created does not
count: a session started from a chat does not wait on its own. Closing the side panel tab ends (b);
from then on the page or Node code must handle `permission.requested` itself or call `open` again. A
questionnaire nobody listens to ends the turn with `result.pendingQuestion`; continue with `answer`.
A run that passes `onEvent` must handle `permission.requested` itself, or it waits until `cancel`,
abort, or the page closes. The panel in (b) is reported closed when the Host window reloads or closes;
after a runtime restart or the deletion of the host chat, the page must `open` again. There is no timeout: a waiting run
is released by cancel or abort, process exit, or republish.

Node code cannot open a session in a chat side panel (it has no host chat). A page can open any
session this Mini App owns, whichever chat or Node run created it (`open` in
[client-api.md](client-api.md)); while that tab stays open, permission requests of the session wait
for it even when a Node run continues the session without `onEvent`.

- `context.agent.reply({ sessionId, requestId, decision })` decides a `permission.requested` while
  its run is still waiting; `decision` is `allowOnce` or `deny`. A request that is unknown or
  already settled rejects with `REQUEST_NOT_FOUND`.

  Node allows up to 16 outstanding `run` / `answer` / `models` / `agents` / `create` and Connector
  requests together, independently of the Host FIFO. Permission `reply` requests have a separate
  limit of 16, so a full ordinary request budget still permits replying. Exceeding either Agent
  request group's limit rejects with retryable `AGENT_UNAVAILABLE`; completion releases its slot.
  `create` takes no Host run slot but still uses the ordinary Node request budget.

- `context.agent.answer({ sessionId, requestId, answers, model? }, { signal?, onEvent? })` answers the
  questionnaire `requestId` from `question.requested` or `result.pendingQuestion`; both carry the
  questionnaire as `request`, so a run without `onEvent` can render it too. `answers` holds one
  `{ stepId, selectedOptionIds, selectedOther, otherText?, skipped? }` per step. It resolves like
  `run`; an unknown or already settled questionnaire rejects with `REQUEST_NOT_FOUND`, and an answer
  that was recorded but whose continuation turn was not observed rejects with
  `AGENT_OUTCOME_UNKNOWN`. Call it after the paused `run` resolves: that run still holds the
  session's single-run slot while `question.requested` is delivered, so an earlier `answer` rejects
  with `BUSY`. `answer({ model })` switches the session's model before the questionnaire lookup, so a
  `REQUEST_NOT_FOUND` answer still leaves the model switched.
- `context.agent.models()` returns the available model catalog `models[]` and the runtime `default`;
  Node has no `host` entry. `default` is a selection carrying the global variant / thinking, ready
  to pass as `model` to `run` / `answer`. To select a catalog entry `option`, construct
  `{ providerId: option.providerId, modelId: option.modelId }` and add a selected `variant` if
  needed. If the model supports thinking and the user selects an effort from
  `option.thinking.efforts`, pass `thinking: { effort }`. The catalog's
  `thinking: { efforts, default? }` describes capabilities; the request takes
  `thinking: { effort }`. Preserve `variant: ''`: it explicitly turns thinking off. `models()`
  rejects with `INVALID_ARGUMENTS` when the runtime has no usable default model.
- `context.agent.agents()` lists the agents the user has configured (`name`, `displayName`,
  `primary`). `create({ agent })` or a first `run({ agent })` starts the session as that agent
  instead of the default; `name` must come from this list, and the alias `main` is rejected. A
  session never changes its agent, so continuing with `agent` is `INVALID_ARGUMENTS` — create a new
  session to hand work to another agent. The plugin directory follows the chosen agent.
- `context.agent.create({ agent? })` creates a session (agent, this Mini App's Agent directory, the
  runtime default model) without running a turn and returns `{ sessionId }`; continue it with
  `run({ sessionId })`. It takes no run slot. A session created by a page bound to its chat can be
  continued here the same way once the page hands over its `sessionId`.

```ts
import type {
  MiniAppAgentClient,
  MiniAppAgentQuestionAnswer,
  MiniAppAgentQuestionnaire,
  MiniAppAgentRunEvent,
} from './miniapp-api.js';

// Your own UI round trips, for example an SSE push to the page and a POST back.
declare function askUser(request: MiniAppAgentQuestionnaire): Promise<MiniAppAgentQuestionAnswer[]>;
declare function confirmTool(toolName: string, reason: string): Promise<boolean>;

async function runWithQuestions(agent: MiniAppAgentClient, text: string) {
  const onEvent = (event: MiniAppAgentRunEvent) => {
    if (event.type !== 'permission.requested') return;
    // The run waits for this decision; the event names the session even on its first run.
    void confirmTool(event.toolName, event.reason)
      .then((allowed) =>
        agent.reply({
          sessionId: event.sessionId,
          requestId: event.requestId,
          decision: allowed ? 'allowOnce' : 'deny',
        }),
      )
      .catch(() => {}); // REQUEST_NOT_FOUND: the run was cancelled meanwhile.
  };
  let result = await agent.run({ text }, { onEvent });
  // Answer only after the run resolves: until then it holds the session's single-run slot.
  while (result.pendingQuestion) {
    const answers = await askUser(result.pendingQuestion.request);
    result = await agent.answer(
      { sessionId: result.sessionId, requestId: result.pendingQuestion.requestId, answers },
      { onEvent },
    );
  }
  return result;
}
```

`onEvent` receives progress events `{ type, sessionId, turnId, ... }`. Every event except
`run.queued` names its session, so `reply` works before the `run` that created the session returns.
Ignore any `type` you do not know; new types may be added.

- `run.queued` — all run slots are taken, so the call waits; `position` is its 1-based place in
  line. Sent once, before the turn starts: it has no `turnId`, and carries `sessionId` only when the
  call continues a session.
- `turn.started` — the Agent began the turn; `model` is the model it was dispatched with.
- `text.delta` — `text` is the next piece of the reply as it streams.
- `message.committed` — `text` is one complete assistant message; a turn can have several.
- `tool.started` — the Agent called the tool `name`.
- `tool.finished` — that tool returned; `ok` is `false` when it failed.
- `permission.requested` — the tool `toolName` waits for `reply`; carries `requestId`, `reason`, and
  `toolInput?`. When the Agent delegated to a child session, the child's asks arrive here with the
  child's own `sessionId` and `turnId`; `reply` with those and do not filter events by the root
  turn, or the run waits forever.
- `question.requested` — sent just before `turn.finished` when the turn paused; carries `requestId`,
  `mode` (`questionnaire`, `feature-enable`, or `plan`), and `request`, whose `steps` each have an
  `id`, a `question`, `selectionMode`, and `options`; `request.modePayload` holds the Plan review
  Markdown.
- `turn.finished` — always last; carries the same `status`, `text?`, and `error?` as the result.

At most `agentConcurrency` runs (default 4) per Mini App are in flight, and one per session.
Further `run` / `answer` calls wait in order, up to four times that many; aborting a waiting call's
`signal` rejects it with `REQUEST_CANCELLED`. `BUSY` (retryable) means the session already has a
run in flight (`reason: 'session_busy'`) or the queue is full (`reason: 'queue_full'`). Check
caught errors by `code`: `NOT_PERMITTED`, `BUSY`, `SESSION_NOT_FOUND`, `INVALID_ARGUMENTS`,
`AGENT_UNAVAILABLE`, `REQUEST_CANCELLED`, `AGENT_OUTCOME_UNKNOWN`, or `REQUEST_NOT_FOUND`, plus
`retryable`. `AGENT_OUTCOME_UNKNOWN` means the turn may have run; do not retry it automatically. It
is also used when a turn ended (its `turn.finished` was delivered) but the Host could not tell
whether a question is pending: inspect the session, then continue with `run({ sessionId })` or
`answer`. `AGENT_UNAVAILABLE` means nothing was started; a call from a Mini App process that has
since been replaced gets it with `retryable: true`. A service restart cancels in-flight runs.
