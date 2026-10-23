# Module map

One facet of the architecture design: [`design.md`](design.md) is the whole. This document is only
where code lives. Locations, not command ownership. The businesses are the directories under
`client/features/`; a symbol's exact home and signature come from the source or the language server.

## Client — roles

| Directory | Role | Rule of use |
| --- | --- | --- |
| `client/main.tsx` | Build entry | Mounts the shell into `#webui-root` and constructs the transport once at module scope. Import nothing from it; it runs for side effects. |
| `client/contracts/` | The contracts no single business owns: `transport.ts` (joins the per-business ports into `WebuiTransport`; every method optional — `undefined` means "not wired") and `value-readers.ts` (defensive readers for untrusted payload fields) | Import a business's own port or view type from that business's `contracts/`, never from a component or the shell. |
| `client/application/` | Composition root and shared application modules: `create-application.ts`, `session-store.ts`, `state.ts`, `snapshot-store.ts`, `selectors.ts`, `port-slices.ts`, `version-cell.ts`, `identity-epochs.ts`, `task-session-workflows.ts` | The composition root constructs owners, wires capabilities and publishes them; nothing else may. |
| `client/conversation/` | The conversation substrate's mechanisms: `stream-lease.ts`, `stream-loop.ts`, `request-freshness.ts`, `session-scope.ts`, `transcript-history.ts`, `transcript-request-ownership.ts`, `stream-instrumentation.ts` | Called by application owners, not by components. |
| `client/platform/` | Browser IO: `transport.ts`, `event-channel.ts`, `storage.ts`, `wire.ts`, `connection-health.ts`, `browser-dom.ts`, `team-mode.ts`, `no-project.ts`, `session-import.ts`, `session-transfer-{target,download}.ts` | Adapters only; they decide no business rule. |
| `client/bindings/` | React subscriptions and browser effects: `application-context.tsx`, `browser-capabilities.tsx`, `browser-effects.ts`, `composer-store.ts`, `event-channel-adapter.ts`, `navigation.ts`, `port-slices-context.tsx`, `use-connection-health.ts`, `use-query-state.tsx`, `use-session-state.ts`, `version-cells.ts` | Components read snapshots and invoke named commands here; they receive neither a store writer nor a sink factory. |
| `client/projection/common/` | Pure derivations no single business owns: `router.ts`, `event-kinds.ts`, `event-parsers.ts`, `context-menu.ts`, `diff-workspace-boundary.ts`, `flyout-position.ts`, `overlay-geometry.ts`, `outside-close.ts`, `paths.ts`, `unread-badge.ts`, `goal-message.ts` | No React, no transport, no browser global. Business-owned projections live in `client/features/<business>/projection/`. |
| `client/shell/` | Page composition and the shell frame: `WebuiClientFoundationApp.tsx`, `ArchonPage.tsx`, `ArchonShell.tsx`, `ConversationSurface.tsx`, `ConnectionStatus.tsx`, `StartupFallback.tsx`, `WebuiErrorBoundary.tsx`, `WebuiZoneBoundary.tsx`, `NotFound.tsx`, `icons.tsx`, and the `use-*` shell hooks | Compose and present; create no owners, write no application state. |
| `client/ui/` | Presentation primitives shared across businesses: `ContextMenu.tsx`, `ToggleSwitch.tsx`, `activity-phrase.ts`, `settings-glyphs.tsx`, `settings-layout.tsx` (the settings page skeleton: page, section, card, row, divider) | Reaches no business at all. |
| `client/styles/` | `index.css` (the single compiled entry), `tokens.css`, `shell.css` | See `../design/design-language.md`. |
| `client/assets/` | Fonts, images, Lottie | See `../design/design-language.md`. |

## Client — businesses

Each business is one directory under `client/features/<business>/` holding up to five roles:
`contracts/` (its published surface), `application/` (its owners and workflows), `projection/` (its
pure derivations), `bindings/` (its React subscriptions), `ui/` (its presentation). Not every
business populates every role — a business with no screen has no `ui/`, and empty directories are
not created. `ls packages/webui/src/client/features` is the list.

The current businesses are `account`, `composer`, `goal`, `interactions`, `models`, `plugins`,
`review`, `sessions`, `settings`, `shell`, `terminal`, `transcript`, `turn` and `workspace`. What a
business is — and what it is not — is in `../client/ownership.md`.

## Runtime

| Module | Role |
| --- | --- |
| `runtime/index.ts` | The runtime's public entry: `createWebuiRuntimeHost`, `createHarnessPortFromHost`, the terminal manager and the runtime's types. |
| `runtime/assembly.ts` | The composition root. Creates and wires the process resources, forwards the runtime-owner options, and enriches the host handle with the credential-backed slots. Creates no OAuth state machine, no close ordering. |
| `runtime/lifecycle.ts` | Resource registration, close ordering and startup-failure recovery. Wraps `apiHost.close` so runtime and capability owners close exactly once. |
| `runtime/port.ts` | `WebuiHarnessPort` — the boundary to the harness: the callable, `AsyncIterable` and cancellation types plus one method per operation. It declares no wire DTO; those live in `shared/contracts/<domain>.ts`. |
| `runtime/harness/` | The per-domain adapters that implement the port by delegating to the host handle: `host-contract.ts` (`WebuiRuntimeHostHandle`, `WebuiRuntimeCliService`), `adapter.ts` (`createHarnessPortFromHost`), plus `account`, `execution`, `interactions`, `models-plugins`, `requirements`, `sessions`, `settings`, `workspace`. |
| `runtime/auth-session.ts`, `runtime/auth-context.ts` | The one OAuth core with its lease and refresh timer, and the per-request auth context. |
| `runtime/account-login.ts`, `runtime/check-in.ts`, `runtime/usage-quota.ts`, `runtime/usage-quota-projection.ts`, `runtime/reset-card-projection.ts`, `runtime/signing.ts` | Account login, daily check-in, the account-billing client (the quota, the credit fallback and the reset cards) and its two pure projections, request signing. |
| `runtime/terminal.ts` | The terminal process manager. One per WebUI service, not a host-wide singleton. |
| `runtime/mcode-tools.ts`, `runtime/mcode-tools-environment.ts`, `runtime/mcode-tools-entry.ts` | The mcode-tools broker, the child-process environment projection and the embedded entry loader. |
| `runtime/workspace-archive.ts` + `runtime/workspace-archive/` | Archive listing and extraction: `zip-adapter.ts` and `tar-adapter.ts` over `archive-policy.ts`, `archive-listing.ts`, `archive-filesystem.ts`, `archive-types.ts`. |
| `runtime/session-transfer.ts`, `runtime/profile-files.ts` | Session import/export and profile file reads. |
| `runtime/commands/` | The six WebUI slash commands: `descriptors.ts` (help, new, compact, status, usage, model) and `runner.ts`. |
| `runtime/runtime-environment.ts` | Reflects the installed client's region/build scope into the process environment before the host is built. |
| `runtime/browser-provider.ts` | The browser (Browser Use) provider and its adoption rule. |

## Server

| Module | Role |
| --- | --- |
| `server/index.ts` | The loopback network entry and the server build entry (`scripts/build-webui.mjs`). Re-exports the service, the registry, credentials, the envelope and the wire DTOs; holds no runtime implementation. |
| `server/service.ts` | `WebuiService` — HTTP/asset serving, the authenticated WebSocket upgrade, connection lifecycle and the call into dispatch. `new WebuiService(options)`, `start()` resolves `WebuiServiceInfo` with `boundUrl`. |
| `server/http-server.ts`, `server/websocket-server.ts`, `server/access-policy.ts`, `server/frame-handler.ts` | Transport, host/origin policy, frame handling. |
| `server/http/` | `router.ts`, `client-assets.ts`, `workspace-file.ts`, `session-transfer.ts`, `responses.ts`. |
| `server/credentials.ts`, `server/envelope.ts` | The loopback credential and runtime envelope validation (`isWebuiFrame`). The frame shape, protocol version and error codes live in `shared/envelope.ts`. |
| `server/projections/` | Server-side projections shared by handlers: `context-snapshot.ts`, `model-provider.ts`, `usage.ts`, `index.ts`. |

## Server — operations

| Module | Role |
| --- | --- |
| `server/operation/operation-contract.ts` | `WebuiOperation`, `ValidationFailure` and the validation primitives (`invalidBody`, `requireRecord`, `requireNonEmptyString`). |
| `server/operation/<domain>.ts` | The operation descriptors (name + `validate`) grouped by domain. |
| `server/operation/bind-handlers.ts` | `WEBUI_OPERATION_BINDINGS` — the statically declared operation→capability mapping — plus `createBindingEntries` and `DEDICATED_OPERATION_NAMES`. |
| `server/operation/binding-mechanism.ts` | The binding machinery around `OperationSpec`. |
| `server/operation/handlers/` | The thirteen operations that keep a hand-written handler: `account`, `commands`, `messages`, `stream`, `terminal`, `workspace`. |
| `server/operation/operation-dispatch.ts` | `dispatchWebuiFrame` — one inbound frame → validate → look up → handle → response, stream or error frame. |
| `server/operation/operations.ts` | `createOperationRegistry`, the single `registerOperation` call site, and the registry order. |

The binding roster and the compiler enforcement that keeps it in step with the port are in
`../runtime/harness-boundary.md`.

## Shared

| Module | Role |
| --- | --- |
| `shared/contracts/<domain>.ts` | The request/result DTOs both sides of the boundary share — account, account-billing (the credit fallback and the reset cards), canvas, commands, goal, interactions, messages, models, personalization, queue, review, session, stream, terminal, usage-quota, version, workspace. |
| `shared/envelope.ts` | Frame shape, protocol version, error codes. |
| `shared/operation-names.ts` | Every `*_OPERATION_NAME` constant and the `OperationSpec` map that unary request types are derived from. |
| `shared/plugin-management.ts` | `WebuiPluginManagementAction` and the plugin wire shapes. |
| `shared/session-transfer-format.ts` | The session-transfer file format. |

`@mavis/shared` is a **different** workspace package (`packages/shared`), not `src/shared/`. The
server and the browser import its public subpaths, including `daily-signin`, protocol and runtime
boundary contracts.
