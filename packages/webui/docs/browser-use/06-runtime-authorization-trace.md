# Runtime authorization trace

The panel forwards input over a reusable authenticated WebSocket, with a separate request identity
and deadline for every command. Reusing the connection does not cache authorization: the runtime
checks the current surface authorization and target generation for each input before delivery.
The first pointer move or wheel event is forwarded immediately; subsequent events within a 60 Hz
interval coalesce, retaining the newest position and accumulating scroll deltas. The provider still
serializes input per target. The panel installs its wheel listener directly on the image with
`passive: false`, so forwarding a wheel event also prevents scrolling the enclosing WebUI document.
Capture, image transport and display add latency beyond input submission;
neither a process-local harness nor a loopback connection guarantees a few milliseconds to visible paint.

**Status:** This document mixes three kinds of statement, labelled inline:

| Label | Means | Backed by |
| --- | --- | --- |
| `implemented` | The source enforces this today; the row names the file and line. | The cited file in this repository |
| `required` | A rule the contracts pin with **no** enforcing code at that point. | `packages/webui/src/shared/contracts/browser.ts` |
| `not yet measured` | An open question. Not a denial and not a promise. | Nothing |

This document traces each of the four authorization switches to the places it has to be enforced, and
records what is standing at each of those places in the tree as of this writing. The five enforcement
points are recorded per-row rather than in a footnote — a reader deciding whether a capability is gated
must not have to infer it from the absence of a section.

**Read the rows, not this document's history.** Several points below were traced against an earlier tree
that had no browser runtime at all, and those rows have since been corrected against the source. What
changed, and what is still open, is recorded in
[`07-review-findings.md`](07-review-findings.md).

## The four switches

`WebuiBrowserAuthorization`, `packages/webui/src/shared/contracts/browser.ts:60`. All four default to
off — `WEBUI_BROWSER_AUTHORIZATION_DEFAULT` at line 72 is a frozen object with `isolatedChromium`,
`edge`, `chrome` and `fullCdp` all `false`.

| Switch | Authorizes | Never authorizes |
| --- | --- | --- |
| `isolatedChromium` | launching and using the isolated browser this process owns | anything about Edge or Chrome |
| `edge` | the Edge bridged surface | anything about Chrome, or a browser permission the user has not granted |
| `chrome` | the Chrome bridged surface | anything about Edge, or a browser permission the user has not granted |
| `fullCdp` | arbitrary DevTools commands on an **already-authorized** surface | a surface. It widens; it never opens |

`isWebuiBrowserSurfaceAuthorized` (`browser.ts:125`) is the surface check: it maps a surface to its switch
and is exhaustive over the three surfaces.

**`implemented` — the gate exists.** `packages/webui/src/runtime/browser/authorization.ts` centralizes
the decision:

| Element | Source | Behaviour |
| --- | --- | --- |
| `isBrowserSurfaceUsable(authorization, surface)` | `authorization.ts:110` | Whether the surface may be used at all. Deliberately does not consider Full CDP. |
| `isBrowserCommandAllowed(authorization, command, restrictedCommands)` | `authorization.ts:140` | Whether a command is in the restricted set, or the Full CDP switch is on. |
| `normalizeBrowserAuthorization(raw)` | `authorization.ts:76` | Normalises anything missing to **off**, so a partial host answer is never a grant. |
| `browserSwitchForSurface(surface)` | `authorization.ts:42` | Maps a surface to its switch; `full-cdp` maps to the global switch. |

`isBrowserSurfaceUsable` **is** called, by the browser service, and is the enforcement point for the
panel paths. `isBrowserCommandAllowed` **also** has a caller — `WebuiBrowserService.sendCommand`
(`browser-service.ts:1406`) — which is enforcement point 5 below.

## Two provider paths exist

There are two, and they are not the same thing. Confusing them is how the original trace concluded that
no provider existed at all.

**The host-supplied seam** — a provider object passed in by the composition root:

| Element | Location | What it does |
| --- | --- | --- |
| `WebuiBrowserProvider` | `packages/webui/src/runtime/browser-provider.ts:29` | A supplied `adapter`, an optional tool exposure, and `close()` |
| `adoptWebuiBrowserProvider` | `packages/webui/src/runtime/browser-provider.ts:49` | Binds a host-supplied provider in; sets `browserUseTooling: provider !== undefined` |
| Adoption in the assembly | `packages/webui/src/runtime/assembly.ts:260` | Calls `adoptWebuiBrowserProvider(options.browserProvider, options.browserToolExposure)` |
| Release | `packages/webui/src/runtime/lifecycle.ts:22` | `closeBrowserProvider` releases it in the close order |

`browserUseTooling` is a **readiness statement**, not an authorization decision. It is true exactly
when a provider object exists, and says nothing about which switch is on. Both composition roots now
pass a `browserProvider` — the WebUI's own tool adapter, built over the browser service — so the
adoption seam receives one. The switches are still read on the service's own path, not here.

**The owned browser service** — the one this trace is about. `createBrowserAdapter`
(`packages/webui/src/runtime/harness/browser.ts:172`) builds a `WebuiBrowserService` from the host's
configuration capability and hands its `WebuiBrowserPort` to the operation registry. The service
constructs its own `WebuiIsolatedChromiumProvider` lazily, and only when the `isolatedChromium` switch
is on. Unlike the seam above, this one **does** read a switch before it acts — which is why points 1
and 2 below are partly implemented.

## Trace: switch → enforcing place

Six enforcement points. "Required check" is the rule; "Code today" is what exists at that place.
The first five read a switch; the sixth reads what the surface can do.

### 1. A tab's live image stream

| | |
| --- | --- |
| Required check | The surface switch is on, and the target identity — including generation — matches what the tab is showing |
| Refusal | `browser_surface_not_authorized`, `browser_target_stale` |
| Code today | **`implemented`.** `WebuiBrowserService.watchFrames` refuses with `browser_surface_not_authorized` before doing anything, and the stream is registered as the `watchBrowserFrames` operation (`shared/operation-names.ts`, `server/operation/browser.ts`). Frames are fenced: `#frameMatchesTarget` (`browser-service.ts:1098`) compares surface, browserId, targetId **and generation**, and the stream loop drops anything that does not match (`browser-service.ts:944`) |
| Not measured | No probe or integration run observed a frame being dropped for a superseded generation — verified by reading the source, and by a real browser observing *delivery* rather than a drop (`isolated-chromium-two-pages.test.ts` gives two pages their own pictures and asserts neither receives the other's) |
| What does exist | `WebuiBrowserImageFrame` and the bridge's `WebuiBrowserBridgeImageFrame`, which carry the target identity including generation so a client *can* drop a frame for a page it is no longer showing ([`05-target-identity.md`](05-target-identity.md)) |
| Provider-side prerequisite | `implemented` — `#withAttachmentRetry` (`provider.ts:1086`) re-issues an attachment failure for up to 3 s across five sends. The failure itself is `measured`, see [`01-capability-matrix.md`](01-capability-matrix.md) |
| What ADR 0022 changes | The stream is keyed by the run, so it carries the run's selection. [ADR 0022](../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md) makes it per target, so a person looking at one tab does not receive another tab's frames. **`implemented`.** `watchFrames(surface, target, signal)` is keyed by the target, the request carries `{ surface, target }`, and the client asks for `viewedPage` — the page in front, which is the *client's* cell, not the run's selection. `browser-service.ts` — `watchFrames`; `client/features/browser/projection/browser-state.ts` — `selectWebuiBrowserStreamTarget` |

### 2. A tab's input forwarding

| | |
| --- | --- |
| Required check | The surface switch is on; the command satisfies `WebuiBrowserInputCommand`; the named target is **the page the person is looking at** and matches the registry including generation. The named target is the *client's* cell: a gesture is never bound to the run's selection (`client/features/browser/application/browser-commands.ts` — `prepareWebuiBrowserInputCommand`) |
| Refusal | `browser_surface_not_authorized`, `browser_command_invalid`, `browser_target_stale` |
| Code today | **`implemented`.** `WebuiBrowserService.sendInput` (`browser-service.ts:832`) calls `validateBrowserInputCommand` first (`input.ts`), then refuses with `browser_surface_not_authorized`, then calls `this.#registry.isCurrent(validated.target)` and refuses with `browser_target_stale`. It is registered as the `sendBrowserInput` operation |
| What made the generation check effective | The registry's counter is fed: `#ensureProvider` subscribes to `provider.onTargetChanged` and calls `registry.raiseGeneration` (`browser-service.ts:620`), so the registry's generation advances when the provider reports a page replacement. Finding F2 in [`07-review-findings.md`](07-review-findings.md) |
| Not measured | No run drove a navigation and observed a refused input — verified by reading the source |
| What does exist | `WebuiBrowserInputCommand` (pointer / key / text), `WebuiBrowserBridgeInputCommand`, and `browser_command_invalid` in the pinned error codes |
| Why validation is a gate and not hygiene | A tab showing a stale page must not deliver input to whatever replaced it. The generation in the command is what makes that refusal possible. A real browser showed both halves of it: on one page the person's text and the Agent's action were both delivered, and an input recorded before that page moved was refused with `browser_target_stale` rather than dropped (`isolated-chromium-two-pages.test.ts`, "the run's selection and the tab in front, on a real browser") |

### 3. The Agent's browser tools

| | |
| --- | --- |
| Required check | The surface switch for the selected surface is on, and the requested action is in the restricted command set (or the Full CDP gate is on, for anything outside it). `open_tab` is the exception the tab model introduces: it reads the surface switch and creates the page itself, so it needs no prior selection |
| Refusal | `browser_surface_not_authorized`, `browser_capability_denied` |
| Code today | **Implemented.** The restricted vocabulary is declared in `packages/agent-tools/src/desktop/builtin-browser-defs.ts` — `LOCAL_BROWSER_ACTION_NAMES` at line 744 (24 names) and `LOCAL_BROWSER_ACTION_INPUT_CONTRACTS` at line 714. The WebUI's tool adapter (`packages/webui/src/runtime/browser/tool-adapter.ts`) implements `LocalBrowserAdapter` over the browser service: `getCapabilities()` declares exactly the restricted set, and `execute` forwards the action to the service, which reads the surface switch and the Full CDP gate. An action outside the restricted set is refused with `browser_capability_denied` even when Full CDP is on, because the tool path is the restricted path. |
| Reachability from this client | **Reachable.** The WebUI has a browser port (`WebuiBrowserPort`, `runtime/port.ts`), a browser adapter (`runtime/harness/browser.ts`) and the registered browser operations. The adapter is handed to the runtime host as the `browserProvider` by both composition roots, and the service is the one place the switch is read — so the Agent's tools and the panel address the same session by construction rather than by convention. The service's `sendCommandToSelection` runs the action against the **selected** target of the surface, and refuses when there is no selection rather than defaulting to one. A run that has never selected anything therefore cannot act at all, `open_tab` included. [ADR 0022](../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md) decides that `open_tab` is that path, and there is now a second one: **the bootstrap** — a page a person opened while the run had no selection becomes the run's selection, decided by the runtime at the moment the page appears. `implemented`: `openWebTab`'s `WebuiBrowserTabOpener` argument, `browser-service.ts` |
| Isolated-surface provider | The WebUI's own: `packages/webui/src/runtime/browser/isolated-chromium/provider.ts` with `cdp-connection.ts` and `core-transport.ts`. The repository also has a TUI-side provider (`packages/tui/src/runtime/browser/headless-chrome-provider.ts`); the WebUI does not adopt it, because the WebUI's provider is the one the panel's live image stream and the tool adapter share |

### 4. Bridge admission

| | |
| --- | --- |
| Required check | Loopback Host; the path is `/browser-bridge`; the extension identity is allowlisted; the pairing proof verifies; the switch for the claimed browser is on |
| Refusal | `browser_pairing_rejected`, `browser_surface_not_authorized` |
| Code today | **`implemented` and wired.** `admitBrowserBridgeUpgrade` (`server/browser-bridge/admission.ts:81`) implements every required check below, and `BrowserBridgePairing` (`server/browser-bridge/pairing.ts:129`) implements the allowlist, the challenge and the proof verification. `packages/webui/src/server/websocket-server.ts` routes a `/browser-bridge` upgrade to the bridge's **own** admission, before the generic `admitWebSocketUpgrade`, and the generic path is unchanged. The bridge is constructed by both composition roots and handed to the service, so `WebuiBrowserService` gets a provider for `edge` and `chrome` whenever their switches are on. Finding F3 in [`07-review-findings.md`](07-review-findings.md) |
| What does exist today | The generic admission it must not inherit: `admitWebSocketUpgrade`, `packages/webui/src/server/access-policy.ts:51`, and the credential check it skips when `dev` is true at `access-policy.ts:76` |
| Both entries run `dev: true` | `scripts/run-webui-server.mjs` and `release/webui-npm/bin/mcode-webui.mjs`. The bridge's admission does not read it: `admission.ts` carries an explicit no-op `if (context.dev)` branch |
| Requirement | The `dev` flag is not an input to this path. `admission.ts:137` carries an explicit no-op `if (context.dev)` branch that documents the bypass as absent, so a future edit that adds `return undefined` there is caught. Proof and authorization are verified unconditionally — see [`03-extension-admission.md`](03-extension-admission.md) |
| Also required | A missing `keyId`→credential mapping must fail with `browser_credential_store_unavailable` rather than admitting unpaired or falling back. `BrowserBridgePairing.issueChallenge` calls `credentialStore.isAvailable()` first (`pairing.ts:218`) and throws `BrowserCredentialStoreUnavailableError` — [`04-pairing-credentials.md`](04-pairing-credentials.md) |

### 5. The Full CDP gate

| | |
| --- | --- |
| Required check | `fullCdp` is on **and** the surface switch is on. Both, in that order: the switch decides whether the surface exists, the Full CDP gate decides how wide it is |
| Refusal | `browser_surface_not_authorized` when the surface is off; `browser_capability_denied` when a full-CDP-only call is attempted with `fullCdp` off |
| Code today | **`implemented`.** `isBrowserCommandAllowed` (`authorization.ts:140`) has a caller: `WebuiBrowserService.sendCommand` (`browser-service.ts:1117`) checks the surface switch **first** (`browser-service.ts:1400`) and then `isBrowserCommandAllowed(authorization, command, WEBUI_BROWSER_RESTRICTED_COMMANDS)` (`browser-service.ts:1406`), refusing an out-of-set command with `browser_capability_denied` rather than forwarding it. The restricted vocabulary is pinned as `WEBUI_BROWSER_RESTRICTED_COMMANDS` (`contracts/browser.ts:428`, 28 names), and the path is exposed as the `sendBrowserCommand` operation. Finding F5 in [`07-review-findings.md`](07-review-findings.md) |
| What does exist | `fullCdpApplies` on `WebuiBrowserCapabilityEntry`, a declaration that the switch widens a surface; and `browser_capability_denied` in the pinned error codes |
| Not measured | No run sent a real DevTools command through the gate with the switch off — verified by reading the source |
| Constraint on the widening | The command set is whatever the active provider actually supports. It does not enable a surface that is disabled or unavailable, and it does not promise that Edge, Chrome and isolated Chromium expose identical domains |

### 6. The surface's own fences

The five points above decide whether a call may be made. A call that passes them can still be refused,
because **the surface knows things the switches do not**.

| | |
| --- | --- |
| Required check | The action is one this surface can perform, against a target it still owns |
| Refusal | `browser_capability_denied` |
| Code today | **`implemented`.** The isolated provider refuses `return_to_previous_tab` (`provider.ts:814`) because it moves between the pages a **run** has open, and the run's pages are the service's record rather than the provider's. The bridge refuses `open_tab` (`server/browser-bridge/server.ts:834`) because `chrome.debugger` cannot open a page in the person's browser, and refuses a `screenshot` of a tab that is not in front (`server/browser-bridge/server.ts:939`) because there is no picture of it to give |
| Why this is not a sixth switch | These refusals are facts about the **browser**, not authorizations. The surface switch is on and the command is in the restricted set; the surface still cannot do this one thing. A switch would make it a policy, and a policy would be wrong — the person may switch on Full CDP and `open_tab` would still be impossible on a bridged surface |
| The boundary it preserves | Each refusal names the fact rather than pretending the page could not do it: the page is fine, and the request is about something the page does not know |

A restricted action that reaches the surface is executed by **Browser Core**, and the core refuses an
action it does not implement in the same place rather than in the provider and the core separately.
See [`10-browser-core-integration.md`](10-browser-core-integration.md).

## The composable rule

Each enforcement point is one of two kinds, and the distinction decides where a check belongs:

| Kind | Decides | Reads | Applies at |
| --- | --- | --- | --- |
| **Surface authorization** | whether this browser may be used at all | one surface switch | every path, before anything else |
| **Full CDP widening** | how wide an already-authorized surface may be driven | `fullCdp`, on top of the surface switch | only where a command outside the restricted set is requested |

The ordering is the whole point: a call is refused for `browser_surface_not_authorized` if the surface
is off, regardless of `fullCdp`. Full CDP never authorizes a surface on its own. Turning `fullCdp` off
blocks further full-CDP calls and ends full-CDP-only streams; it does not disable ordinary Browser Use
on a surface that is still enabled.

The four switches are separate on purpose, and the separation is only meaningful if each is checked at
each of the six points above. A combined check — one switch consulted in one place — would make it
impossible to allow one surface without allowing the rest.

## Summary

| Enforcement point | Surface switch checked | Full CDP checked | Code today |
| --- | --- | --- | --- |
| A tab's image stream | required | not applicable | **implemented** — surface check enforced, frames fenced to the selected generation (F6). The stream is keyed by the **target** (`runtime/browser/browser-service.ts:893`), and the provider routes a frame to its page by the envelope's session id |
| A tab's input forwarding | required | not applicable | **implemented** — validation, surface check and `isCurrent`; the registry's generation is fed from `onTargetChanged` (F2) |
| Agent browser tools | required | required, for non-restricted commands | **implemented** — the tool adapter (`packages/webui/src/runtime/browser/tool-adapter.ts`) forwards to the same browser service the panel uses, and the composition root hands it to the runtime host. A run with no selection is refused every action except `open_tab`, which is the action that would create the selection the gate wants (`runtime/browser/tool-adapter.ts:178`) |
| Bridge admission | required | not applicable | **implemented** — the bridge has its own upgrade path, branched on before the generic one (F3), and the command routing is fixed (F4) |
| Full CDP gate | required first | required | **implemented** — `sendCommand` checks the surface first, then the switch (F5) |
| The surface's own fences | not applicable | not applicable | **implemented** — `return_to_previous_tab` is refused on the isolated surface, `open_tab` and an off-screen `screenshot` on the bridge. These are facts about the browser, not authorizations |

## Related

| Concern | Document |
| --- | --- |
| The switches and their defaults | `packages/webui/src/shared/contracts/browser.ts` |
| What each surface is allowed to offer | [`01-capability-matrix.md`](01-capability-matrix.md) |
| The admission path and the `dev: true` bypass | [`03-extension-admission.md`](03-extension-admission.md) |
| The credential admission requires | [`04-pairing-credentials.md`](04-pairing-credentials.md) |
| The target identity each check compares | [`05-target-identity.md`](05-target-identity.md) |
| Who executes a restricted action | [`10-browser-core-integration.md`](10-browser-core-integration.md) |
