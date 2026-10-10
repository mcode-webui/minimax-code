# MiniMax Code

This repository is a fork of the public MiniMax Code projection. It carries two
products on one runtime: the existing terminal client, and a WebUI client that is
under construction. The vocabulary below is the language both clients and the
runtime already use, plus the terms this work introduces.

## Language

### Layers and clients

**Harness layer**:
Everything below the interface layer: the session, turn, agent and model services
that execute work and persist it. It exposes an in-process API only; it has no
network interface.
_Avoid_: backend, core, engine

**Client**:
An interface implementation that sits on the harness layer and exposes sessions to
a person or a program. This repository ships three of them inside `packages/tui`:
the interactive terminal (TUI), `exec` (headless), and ACP.
_Avoid_: frontend, UI layer, app

**WebUI client**:
The fourth client: a browser interface served by `packages/webui`, running as a
peer of the TUI against the same harness layer.
_Avoid_: web CLI, web front end for the CLI, web version

### WebUI internal layers

Four layers inside `packages/webui`. The client/server split says where code runs;
these say who owns a responsibility.

**WebUI runtime**:
The Node-side module group that adapts public harness capabilities and owns every
process resource the service holds — OAuth core, leases and refresh timers,
quota, check-in, account login, the mcode-tools broker, the browser provider,
profile files and session transfer. It knows nothing about which session a browser
has selected.
_Avoid_: harness runtime, runtime host, backend — those name the harness side

**WebUI application**:
The browser-side owner of business orchestration and of the single write authority
for session and interaction records: recovery policy, request ownership, query
invalidation and progress derivation. Not a second execution runtime.
_Avoid_: client runtime, controller, store — the store is only one part of it

**Loopback server**:
The network ingress: authentication, envelope validation, dispatch, wire
projection, socket lifecycle and static assets. It holds no browser state.
_Avoid_: API server, backend, gateway

**Binding**:
A statically declared mapping from one wire operation to one runtime capability
method, replacing a hand-written forwarding closure. It is never discovered by
enumerating runtime methods, and no request body selects an arbitrary runtime
member.
_Avoid_: reflection, dispatch table, adapter — those name the behaviour it forbids

**Event channel**:
The single long-lived `watchEvents` subscription a WebUI application instance
owns, shared by every consumer in that instance. Distinct from a stream frame
channel, which `send`/`resume` and terminal keep separately.
_Avoid_: socket, connection, subscription

**Stream loop**:
The browser mechanism that reads a session's stream frames and manages resume and
cancellation. It performs the history, context and stream-state transforms it needs through
injected bundles rather than reaching into projection modules.
_Avoid_: stream handler, reader

### Sessions

**Session**:
A durable unit of work with one working directory and one selected model, persisted
in the data directory.
_Avoid_: conversation, chat, thread

**Turn**:
One submitted request inside a session, from submission to completion, including the
tool execution and interactions it requires.
_Avoid_: request, run, task

**Working directory**:
The directory a session is bound to. It is the execution boundary for file and Git
tools, is chosen explicitly when the session is created, and cannot be changed
afterwards.
_Avoid_: cwd, project path, root

**Stream frame**:
The unit the harness pushes to a client while a turn runs. One frame may carry a
whole message, a text chunk, a runtime event, an action delta, a status change or a
resynchronisation notice.
_Avoid_: chunk, delta, event

**Resynchronisation (resync)**:
The state where a client's cursor has fallen outside the range the harness still
holds, so the client must discard its incremental view and reload authoritative
history.
_Avoid_: replay, reflow

**Permission prompt**:
A harness request asking the client to authorise a tool call before it runs.
_Avoid_: approval, confirmation, consent

**Questionnaire**:
A structured question the harness asks mid-turn. The turn stays paused until the
client answers, dismisses it, or the session is aborted.
_Avoid_: survey, form, prompt

### Runtime ownership

**Runtime owner**:
One running harness instance, identified per process. A session's live execution,
stream subscriptions and pending interactions belong to the owner that created
them.
_Avoid_: daemon, server, backend instance

Not to be confused with the **WebUI runtime**, which is a module group inside the
WebUI service rather than a running instance. A process has one runtime owner and
one WebUI runtime; the words name different things.

**surface**:
The value a client declares to identify which interface it is, from the fixed set
the harness knows. It gates interaction capabilities and the cold-start execution
policy.
_Avoid_: client type, mode, channel

### Storage and repository

**Data directory**:
Where credentials, configuration and session history live. The CLI default is
`~/.minimax`; the WebUI client shares it.
_Avoid_: user data, profile dir

**Upstream**:
`MiniMax-AI/minimax-code`, the reviewed public projection of an internal monorepo.
This repository is a fork of it, and its history arrives through a three-way merge.
_Avoid_: origin, source repo, official repo
