# Research notes: the runtime and provider sites the tab model has to move

**Reference material for the workspace browser tab model programme — not a work item.**
Do not close this issue as a ticket.

Captured before implementation, from the source at the checkout that carried ADR 0022. These are
the sites the runtime half of the programme touches, and the fences that have to move with them.
Every line number was checked against that tree; the tree moves, so re-check before you edit.

Decision authority: ADR 0022
(`packages/webui/docs/adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md`).

## 1. The provider drives exactly one page, and three sites make that true

`packages/webui/src/runtime/browser/isolated-chromium/provider.ts`

| Site | What it does today | What has to change |
| --- | --- | --- |
| `:218-229` | Creates one page at launch, attaches to it, and sends `Page.enable` **only to that page's session** | Every page needs `Page.enable`, or a page that is not the launch page never receives the navigation events that raise its generation |
| `:251` | `listTargets` reports `generation: info.targetId === this.#pageTargetId ? this.#generation : 1` — every page that is not the launch page reports a constant `1` | The generation becomes a per-page value, and the report reads it from the page's own entry |
| `:532` | `#onEvent` raises the generation only when `event.sessionId === this.#pageSessionId` | The raise becomes per page, keyed by the event's own session |

The consequence if only the map changes and these three do not: **a second page's generation never
advances**, so a reference recorded against it never goes stale, so the fence that exists to make a
stale reference detectable is dead on every tab but the first. This is the single most likely way
to get the work "done" and still have it wrong.

The provider's other single-page assumptions, all of which follow the same `#pageTargetId`:
`sendCommand` (`:413`), `startImageStream` (`:266`), `sendInput` (`:317`).

## 2. The frame's target identity is in the envelope, not in the params

`packages/webui/src/runtime/browser/isolated-chromium/cdp-connection.ts:233-240` puts the
flattened target session on the event as `event.sessionId` — a **string** — and copies
`message.params` verbatim beside it.

`event.params.sessionId` is the **numeric screencast acknowledgement id**. The provider uses it
to acknowledge the frame (`provider.ts:548`), which is right, but it is not a target identity.

⇒ Routing a frame to a page uses the envelope's `event.sessionId`. Using `event.params.sessionId`
looks right and silently finds no page.

## 3. The service keeps one selection map and one frame-subscriber map

`packages/webui/src/runtime/browser/browser-service.ts`

| Site | What it holds today |
| --- | --- |
| `:171-174` | `#selected: Map<surface, Map<runId, selection>>` — the run's selection, per surface and per run |
| `:180` | `#frameSubscribers: Map<surface, Map<runId, …>>` — the frame subscribers, keyed by run |
| `:205` | `#selectionOf(surface, runId)` — the run's selection |
| `:232-242` | `selectionSurfaceOf(runId)` — the surface a run last selected on |
| `:493` | `selectTarget(target, runId)` — the only writer of a selection today |
| `:608-617` | `watchFrames` refuses with `browser_surface_not_authorized` before doing anything |
| `:655`, `:664`, `:733` | `#followSelection` moves the provider stream onto the run's selection; a frame that does not match it is dropped; `#frameMatchesSelection` compares all four identity fields |
| `:763-773` | `sendCommand` — the **host's** path, with no run, resolving the surface's current selection |
| `:796-830` | `sendCommandToSelection` — the run's path, refusing when the run has selected nothing |
| `:415-435` | `#stopProvider` — the host-wide teardown, when a surface's switch goes off |

Three cells exist, not two: the run's selection, the surface's current selection (the host's own
command path, with no run), and — after this programme — the tab the person is looking at, which
is **client state** and the runtime does not track it.

## 4. A new operation is not registered by adding a name

- `packages/webui/src/shared/capability-manifest.ts:141-149` — the browser family's `ready` list
  names the operations the family is ready for. A stream operation that is not on that list is not
  part of the family.
- `packages/webui/src/shared/operation-names.ts:50-57` — the operation name constants.
- `packages/webui/src/shared/operation-names.ts:458-461` — `watchBrowserFrames`'s request shape is
  `{ surface, runId? }`. Making the stream per target is a **change to this shape**, not a second
  operation beside it.
- `packages/webui/src/server/operation/handlers/browser.ts:112-123` — the command handler: a
  command with no `runId` resolves the **no-run** selection.
- `packages/webui/src/server/operation/operation-contract.ts` and the registry in
  `packages/webui/src/server/operation/operations.ts` — the registration sites.
- `packages/webui/src/runtime/port.ts` and `packages/webui/src/runtime/harness/browser.ts` — the
  port member and its binding.
- `packages/webui/src/client/platform/transport.ts:245-247` — the transport's request table.

## 5. There is no per-session lifecycle signal to release a session's pages

Searched `packages/webui/src/runtime` for `deleteSession`, `sessionClosed`, `session_close`,
`sessionDeleted`, `onSessionClosed` and `expireSession`: the only one is `deleteSession`, and it is
a **binding** with no browser-service edge
(`packages/webui/src/server/operation/binding-mechanism.ts:43`).

A session is not only removed by deletion. `archiveSession` removes one, and so does a transfer
away (`packages/webui/src/runtime/session-transfer.ts:108`). A release that covers only deletion
leaves a page behind for every archived session.

## 6. The tool adapter's gate, and the two actions it refuses

`packages/webui/src/runtime/browser/tool-adapter.ts:146-152` — the action is checked against the
restricted set, then the surface is resolved from the run's selection, and a run that has selected
nothing is refused with `browser_target_unknown` **before** the action is dispatched. The refusal
therefore reaches `open_tab`, which is the action that would create the selection the gate wants.

`packages/webui/src/shared/contracts/browser.ts:310-340` — `WEBUI_BROWSER_RESTRICTED_COMMANDS`
already contains `open_tab`, so the Agent's capability declaration does not change.

The bridge cannot open tabs: `packages/webui/src/server/browser-bridge/server.ts:821-834` maps
`navigate`, `reload`, `back`, `forward` and `get_dom`, and anything else is refused with
`browser_capability_denied` — "this action is not one it performs".

## 7. What the client writes and where

- `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx:193-196` — the panel
  re-reads the target list on mount and when the surface changes, and **never polls**.
- `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx:238-245` — the panel
  writes the run's selection when the person clicks a target.
- `packages/webui/src/client/features/browser/application/browser-commands.ts:282-290` — the
  panel's input is bound to the panel's own selected target.
- `packages/webui/src/client/features/browser/ui/BrowserPanel.public.tsx:207` — the surface
  chips: the only place a surface is chosen in the interface.
