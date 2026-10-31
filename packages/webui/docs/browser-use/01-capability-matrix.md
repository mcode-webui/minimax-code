# Capability matrix per browser surface

**Status:** This document mixes three kinds of statement, and every one is labelled with which kind it
is:

| Label | Means | Backed by |
| --- | --- | --- |
| `measured` | A probe observed this on the machine named in the section heading. | `.plan/browser-use/complete/cdp-evidence.json`, `.plan/browser-use/complete/credential-store-evidence.json` or `.plan/workspace-browser-tab/complete/two-page-spike.json` |
| `implemented` | The source does this today. The row names the file. | The cited file in this repository |
| `not yet measured` | An open question. Not a denial and not a promise. | Nothing — see the section that collects them |

The surfaces were measured on one Linux host: the isolated Chromium directly, and Edge and Chrome
through the extension bridge. Everything else is declared or implemented, and is labelled as such.

This is the matrix ADR 0019 decision 6 requires: what each browser surface offers, which commands were
actually observed to work, and where the evidence runs out. The authoritative list of what the host
*intends* to offer is the capability declaration in
`packages/webui/src/shared/contracts/browser.ts` (`WebuiBrowserCapabilityEntry`), which is a
declaration rather than a probe result. This document is the measurement half.

## How to read the marks

| Mark | Meaning |
| --- | --- |
| **measured** | A probe on the validation host sent this and the browser answered without an error. The row names the evidence field. |
| **probed, unconfirmed** | A probe sent this and it failed, but for a reason that does not show the command is absent. Never read as "unsupported". |
| **not measured** | No probe exercised this. Absence of a mark is not a denial and not a promise. |
| **required** | A rule the contracts pin. It has no implementing code unless a row says otherwise. |

## Surface summary

| | Isolated Chromium | Edge | Chrome |
| --- | --- | --- | --- |
| How it is reached | `implemented` — this process launches it and speaks CDP over a loopback WebSocket. Probe measured the CDP surface end to end. | `implemented` — the extension bridge, reached over the dedicated `/browser-bridge` path. The handshake and the refusal are **measured** in real Edge. | `implemented` — the same bridge, on the `chrome` surface. The handshake and the refusal are **measured** in real Chrome. |
| Authorization switch | `isolatedChromium` | `edge` | `chrome` |
| Live image stream | **measured** — `Page.captureScreenshot` and `Page.startScreencast` both succeeded against a real page | **measured** — the extension captured the visible tab and a non-empty image frame reached the host, in a real Edge | **measured** — the same, in a real Chrome |
| Pointer / keyboard / text input | **measured** — mouse press + release, `Input.insertText`, and `Input.dispatchKeyEvent` all succeeded against a real page | **measured** — the text the host sent appeared in the page's field, read back through the browser's own automation, in a real Edge | **measured** — the same, in a real Chrome |
| Agent browser tools | **implemented** — the tool adapter forwards to the same browser service the panel uses, and the composition root hands it to the runtime host. Which *surface* a call acts on is resolved from the run's own selection, so a run that has selected nothing is refused rather than being sent somewhere the person is not looking — except for `open_tab`, which is the one action that would create the selection the gate wants, and which therefore may. [ADR 0022](../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md) gives `open_tab` that path (`implemented` — `runtime/browser/tool-adapter.ts:178`) | **implemented**, same adapter | **implemented**, same adapter |
| Full CDP widening | `implemented` — gated in `WebuiBrowserService.sendCommand` | `implemented`, same gate | `implemented`, same gate |
| Restricted command set | `implemented` — `WEBUI_BROWSER_RESTRICTED_COMMANDS`, 28 names, `packages/webui/src/shared/contracts/browser.ts:428` | same vocabulary, **executed** by Browser Core | same vocabulary, **executed** by Browser Core |
| Who executes a restricted action | `implemented` — Browser Core, over the provider's own CDP connection. [`10-browser-core-integration.md`](10-browser-core-integration.md) | `implemented` — Browser Core, over the bridge's `cdp` frame | `implemented` — Browser Core, over the bridge's `cdp` frame |
| Actions the surface itself answers | `open_tab` is the provider's; `return_to_previous_tab` is **refused** with `browser_capability_denied` | `open_tab` is **refused** with `browser_capability_denied` | `open_tab` is **refused** with `browser_capability_denied` |
| Extension permission gate | not applicable — no extension is involved | The extension's own browser permission, independent of the WebUI switch | The extension's own browser permission, independent of the WebUI switch |

## Measured on the validation machine — `.plan/browser-use/complete/cdp-evidence.json`

Everything in this section is `measured`, and every value is quoted with the JSON field it came from.

**Browser measured.** `/usr/bin/google-chrome`, `Chrome/152.0.7977.82`
(`cdp-evidence.json` → `chromePath`, `version.product`), revision
`@d04cdb24d67b081f6cf80200ffc5233f44b61109`, `jsVersion` `15.2.124.21`, protocol version `1.3`
(`version.protocolVersion`), user agent
`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36`
(`version.userAgent`).

**Probe method.** The probe launched that binary itself with `--headless=new`,
`--remote-debugging-port=0` and `--remote-debugging-address=127.0.0.1`, into a fresh temporary
user-data directory; it read the endpoint from the `DevToolsActivePort` file in that directory and
spoke CDP as raw JSON-RPC over a `ws` WebSocket. `endpointReachable` is `true`
(`cdp-evidence.json`). This is the same launch shape the repository's own isolated-Chromium transport
uses (`packages/tui/src/runtime/browser/headless-chrome-transport.ts:189`).

**There is no typed CDP client in the dependency set.** No `chrome-remote-interface`, no
`devtools-protocol`, no `puppeteer` appears in any `package.json` in this repository. The `ws`
package (`8.21.3`, `packages/webui/package.json:41`) is the WebSocket dependency, and `ws` is MIT
licensed. CDP is therefore hand-rolled: the probe's client builds JSON-RPC frames itself, and the
repository's own transport does the same over `ws`
(`packages/tui/src/runtime/browser/headless-cdp-connection.ts:7`). A capability matrix written against
a generated CDP client type would have had no source in this dependency set.

**The command catalogue was probed, not introspected.** `Schema.getDomains` was attempted first and
failed: the evidence records `schemaDomainAvailable: false` and the note
`Schema.getDomains unavailable: 'Schema.getDomains' wasn't found (-32601)`, and the `domains` object in
the evidence is empty. Chrome does not expose the `Schema` domain over a normal DevTools WebSocket, so
there was no catalogue to read. Instead each command was sent individually with the parameters it
actually requires — an empty parameter object is rejected by Chrome as `Invalid parameters`, which
would have made a working command look absent. Browser-scoped commands were sent on the browser
connection and page-scoped commands on an attached page session.

This matters for how much the matrix can claim: **the probe covers 44 named commands. It is not a
statement about the other CDP commands Chrome implements.** A command that was not sent has no status
here.

### Commands measured supported — 41 of 44

`cdp-evidence.json` → `commands` records `"supported"` for exactly these 41. Each was sent with real
parameters and returned without an error.

| Domain | Measured supported |
| --- | --- |
| `Page` | `Page.enable`, `Page.navigate`, `Page.stopScreencast`, `Page.setInterceptFileChooserDialog`, `Page.getFrameTree`, `Page.reload`, `Page.getNavigationHistory` |
| `Input` | `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`, `Input.dispatchTouchEvent`, `Input.setIgnoreInputEvents`, `Input.imeSetComposition` |
| `Runtime` | `Runtime.evaluate`, `Runtime.enable` |
| `Emulation` | `Emulation.setDeviceMetricsOverride`, `Emulation.setScrollbarsHidden` |
| `Network` | `Network.getCookies`, `Network.setCookie`, `Network.enable` |
| `Storage` | `Storage.clearDataForOrigin` |
| `DOM` | `DOM.getDocument`, `DOM.enable` |
| `Accessibility` | `Accessibility.getFullAXTree`, `Accessibility.enable` |
| `Fetch` | `Fetch.enable`, `Fetch.disable` |
| `ServiceWorker` | `ServiceWorker.enable`, `ServiceWorker.stopAllWorkers` |
| `Browser` | `Browser.getVersion`, `Browser.getWindowForTarget`, `Browser.setPermission`, `Browser.grantPermissions`, `Browser.resetPermissions` |
| `Target` | `Target.setDiscoverTargets`, `Target.setAutoAttach`, `Target.getTargets`, `Target.getBrowserContexts`, `Target.createBrowserContext`, `Target.createTarget`, `Target.closeTarget` |

Two further commands are confirmed supported outside the `commands` table, in the real-input phase:
`Page.captureScreenshot` (`inputEvidence.screenshotBytes` = `6452`, a real PNG payload length) and
`Page.startScreencast` (`inputEvidence.screencast` = `"started"`).

`Target.createBrowserContext` and `Target.setDiscoverTargets` were exercised a second time on the
browser connection and recorded again under `externalEvidence` as `"supported"`. This matters for the
design: the **isolated** surface can create an isolated browser context. An **external** browser cannot
be reached this way at all — `Target.*` commands act on the browser the connection belongs to, and the
extension's `chrome.debugger` API routes commands by `tabId` over a supported subset of CDP domains
rather than exposing a DevTools browser connection.

### Commands probed but not confirmed — 3 of 44

None of these three shows the command is absent. Do not use this table to justify a capability denial.

| Command | Evidence field | What the failure actually shows |
| --- | --- | --- |
| `Page.captureScreenshot` (during the command sweep) | `commands["Page.captureScreenshot"]` = `unsupported: Not attached to an active page (-32000)` | Sent immediately after `Page.navigate` in the same sweep, before the renderer was attached. The same command succeeded later, twice — see the attachment race below. The sweep row is an ordering artifact, not a verdict. |
| `Page.startScreencast` (during the command sweep) | `commands["Page.startScreencast"]` = `unsupported: Not attached to an active page (-32000)` | Same ordering artifact. `inputEvidence.screencast` = `"started"` confirms it works once the page is attached. |
| `Runtime.callFunctionOn` | `commands["Runtime.callFunctionOn"]` = `unsupported: Invalid remote object id (-32000)` | The probe passed a placeholder `objectId` because it had no real remote object to name. The failure is about the parameters, not the domain. |

### Real input against a real page

The probe navigated a data-URL page and drove it (`cdp-evidence.json` → `inputEvidence`):

| Observation | Value |
| --- | --- |
| Page loaded and readable | `pageTitle` = `"probe"` |
| Pointer press + release | `pointer` = `"dispatched"` |
| Text insert + key down/up | `keyboard` = `"dispatched"` |
| Screenshot | `screenshotBytes` = `6452` |
| Screencast | `screencast` = `"started"` |

### The renderer-attachment race is real and measured

This is the one failure that changes the contract rather than just the matrix.

| Attempt | Evidence field | Result |
| --- | --- | --- |
| `Page.captureScreenshot` issued immediately after `Page.navigate` | `attachmentRace.immediate` | `error: Not attached to an active page (-32000)` |
| The same capture issued 750 ms later | `attachmentRace.afterSettle` | `ok:3636` |

A provider must therefore **wait for the page to be attached before capturing an image or starting a
screencast**. A capture issued straight after a navigation fails; the same capture succeeds once the
renderer has settled. Note the two different payload lengths (`screenshotBytes` = `6452`, `afterSettle`
= `3636`): they are different pages, and the length is a payload size, not a health signal.

**`implemented` — the isolated-Chromium provider does handle this failure.**
`packages/webui/src/runtime/browser/isolated-chromium/provider.ts` wraps the affected sends in
`#withAttachmentRetry` (`provider.ts:1086`), which re-issues an operation while it fails with an
attachment error, up to a bounded window:

| Element | Value | Source |
| --- | --- | --- |
| Mechanism | `#withAttachmentRetry(operation)` | `provider.ts:1086` |
| Retry window | `ATTACHMENT_RETRY_WINDOW_MS` = 3 000 ms | `provider.ts:70` |
| Retry delay | `ATTACHMENT_RETRY_DELAY_MS` = 100 ms | `provider.ts:72` |
| Failure test | `isAttachmentFailure` matches the message `Not attached to an active page` | `provider.ts:1104` |
| Non-attachment errors | rethrown immediately, never retried | `provider.ts:1094` |
| On window expiry | the original error is thrown, not a timeout | `provider.ts:1098` |

The retry wraps **five** call sites:

| Command | Source |
| --- | --- |
| `Page.enable` | `provider.ts:409` |
| `Emulation.setDeviceMetricsOverride` | `provider.ts:580` |
| `Page.bringToFront` | `provider.ts:619` |
| `Page.startScreencast` | `provider.ts:622` |
| a raw DevTools method, when Full CDP is on | `provider.ts:847` |

**The navigation and capture commands are no longer the provider's.** They were, when this table was
first written; Browser Core issues them now — `Page.navigate` and `Page.reload` at
`packages/browser-core/src/browser-actions.ts:203` and `:276`, `Page.navigateToHistoryEntry` at `:245`,
and `Page.captureScreenshot` at `packages/browser-core/src/browser-action-artifacts.ts:65`. The
provider reaches them through its core transport
(`packages/webui/src/runtime/browser/isolated-chromium/core-transport.ts`), whose `send` is the
provider's own CDP connection — so the retry's *scope* narrowed while the *failure* it covers did
not: an attachment failure is still a failure of the same connection, and the core's own command
path does not carry the provider's retry.

Two limits of this fix are worth stating, because the measurement does not cover them:

- **`not yet measured`** — the probe measured the failure and the 750 ms settle, but did **not** measure
  the provider's own retry. No test has been run that drives a real `Page.startScreencast` through the
  race. The retry is `implemented`, not `measured`.
- The bound is a heuristic, not a contract: a page that stays unattached for longer than 3 s fails with
  the original `Not attached to an active page` error rather than a distinct timeout code.

**The bridge side has no equivalent.** The extension's image path does not use CDP screencast at all:
`packages/browser-extension/src/images.ts` states that `chrome.debugger` exposes a restricted CDP subset
that excludes `Page.captureScreenshot`, so the extension captures through `chrome.tabs.captureVisibleTab`
instead. No attachment retry applies there.

### The restricted command set

The restricted set is the command vocabulary that may be sent without Full CDP access. There are two
lists in the tree and they are **not** the same, which is worth stating before either is cited:

| List | Where | Count | Whose it is |
| --- | --- | --- | --- |
| `WEBUI_BROWSER_RESTRICTED_COMMANDS` | `packages/webui/src/shared/contracts/browser.ts:428` | **28** | the WebUI's own gate, read by `isBrowserCommandAllowed` and enforced in `WebuiBrowserService.sendCommand` |
| `LOCAL_BROWSER_ACTION_NAMES` | `packages/agent-tools/src/desktop/builtin-browser-defs.ts:744` | **24** | the Agent tools' browser-action vocabulary |

The 28-name WebUI list adds `wait_for`, `get_dom`, `verify_text` and `inspect_editable_targets` to the
Agent list.

**The list says what may be sent; it does not say who executes it.** Since Browser Core was
integrated, the executor is Browser Core on **both** surfaces — one implementation, reached over a
transport. The two surfaces differ in what the *browser* can do, not in what the WebUI knows how to
express. [`10-browser-core-integration.md`](10-browser-core-integration.md) owns that layer.

Three actions are answered by the surface rather than by the core, because they are about the run's
pages rather than about one page:

| Action | Isolated Chromium | Bridge | Reason |
| --- | --- | --- | --- |
| `open_tab` | the provider answers it | refused with `browser_capability_denied` | `chrome.debugger` cannot open a page in the person's browser |
| `return_to_previous_tab` | refused with `browser_capability_denied` | refused | it moves between the pages a **run** has open, and the run's pages are the service's record, not the provider's |

And one restricted action is a **capability difference** rather than a semantic one:

| Action | Isolated Chromium | Bridge | Reason |
| --- | --- | --- | --- |
| `upload_files` | performed | **unavailable** | it needs `DOM.setFileInputFiles`, which is deliberately absent from the extension's allowlist — see below |

`DOM.setFileInputFiles` is not on the extension's list (`packages/browser-extension/src/cdp.ts`) on
purpose: the extension's debugger could run it, but what it must not do is give the Agent a way to
name an arbitrary local file in the user's real browser. The bridge therefore refuses the action
because its **method** is not available — the extension refuses `DOM.setFileInputFiles` as
unsupported, and the bridge maps that refusal to `browser_capability_denied` — rather than
approximating it. **No suite pins this refusal** — the vocabulary test names the action, and
nothing asserts that the bridge refuses it.

**The probe's `restrictedActionCount: 28` matches the WebUI list exactly** — the same 28 names, in the
same set. That number is therefore not an arbitrary enumeration: it is the restricted vocabulary the
programme settled on, observed by the probe. It is still a *count from a hardcoded list in the probe*
(`probe-cdp.mjs:376` computes `restricted.length`), so it is **not** evidence about what a browser can
do; it only tells you which vocabulary was being enumerated.

### Full CDP access

Full CDP access is a global, persistent authorization for the Agent to send any command the active
provider supports. It widens an already-authorized surface and never authorizes one on its own.

**`implemented`.** `WebuiBrowserService.sendCommand`
(`packages/webui/src/runtime/browser/browser-service.ts:1117`) is the command path: it checks the surface
switch first, so a disabled surface is refused with `browser_surface_not_authorized` regardless of
`fullCdp`, then calls `isBrowserCommandAllowed(authorization, command, WEBUI_BROWSER_RESTRICTED_COMMANDS)`
(`browser-service.ts:1406`). A command outside the restricted set with `fullCdp` off is refused with
`browser_capability_denied` and is never forwarded. The path is exposed as the `sendBrowserCommand`
operation, and the same operation answers three callers: a run's tools (`sendCommandToSelection`), the
panel with no run (`sendCommand`), and a web tab's toolbar, which names the page its tab holds
(`sendCommandToTarget`). All three make the same switch, gate and generation fences — the toolbar is a
new caller, not a new gate. See [`06-runtime-authorization-trace.md`](06-runtime-authorization-trace.md)
and finding F5 in [`07-review-findings.md`](07-review-findings.md).

**`not yet measured`** — no run sent a real DevTools command through that gate. This is verified by
reading the source.

### OS secure credential store

**`measured` — on the validation host, and on that host only.**
`.plan/browser-use/complete/credential-store-evidence.json`, `platform: "linux"`:

| Provider | Field | Value |
| --- | --- | --- |
| `secret-tool` | `providers.secretTool` | `false` |
| `kwallet-query` | `providers.kwallet` | `false` |
| `gnome-keyring-daemon` | `providers.gnomeKeyringDaemon` | `true` |
| D-Bus session bus | `providers.dbusSession` | `true` |
| **Overall** | `available` | `false` |

The evidence's own `reason` is `no Secret Service client (no secret-tool, no kwallet-query) on this
host`. The keyring daemon and a session bus are present, but without a client that speaks the
freedesktop Secret Service there is no store to write to.

**Scope of that result — read it narrowly.** It is a statement about **one machine**, and it is exactly
as narrow as it looks:

| This result says | This result does **not** say |
| --- | --- |
| On the host the probe ran on, no Secret Service client was installed and the store was unavailable | Anything about Linux in general; another host may have `secret-tool` or `kwallet-query` installed |
| `gnome-keyring-daemon` being present is not sufficient evidence of a store | Anything about macOS or Windows, which were not probed at all |
| The explicit-failure path is reachable on a host with no store | That any other platform is available or unavailable |

No macOS or Windows probe was run, so this document makes **no** cross-platform availability claim.
The mechanisms the code implements per platform are listed in
[`04-pairing-credentials.md`](04-pairing-credentials.md); they are `implemented`, not `measured`.

The required behaviour follows from that measurement: **pairing fails explicitly with
`browser_credential_store_unavailable`, and the credential is never written to a file.** This repository
also has no OS keyring dependency today — `keytar` appears in no `package.json` — and
`packages/oauth-core/src/credential-store/types.ts` declares
`CredentialStoreKind = 'file'` with `'os-keyring'` present only as `LegacyCredentialStoreKind`, so the
existing OAuth credential store is file-based. That existing store must not be reused as a fallback for
a pairing credential. See [`04-pairing-credentials.md`](04-pairing-credentials.md).

## Not measured

Read this section before citing the matrix. Each line is a gap in the evidence, not a known limitation
of the product.

- **The isolated surface drives one page per web tab now.** The provider resolves a target to the
  page that carries it, raises the generation per page, and routes a screencast frame by the
  envelope's session id. **What the browser itself does with two pages was measured** — see
  [the workspace browser tab model](#the-workspace-browser-tab-model) and
  `.plan/workspace-browser-tab/complete/two-page-spike.json`.
- **The isolated surface's CDP matrix was measured on Chromium only.** The probe ran against the
  bundled Chromium, not against Edge, so the isolated surface's cells describe that browser. Edge
  *was* exercised for the **extension** path — see the real-browser acceptance below — but the
  isolated surface's command matrix was not re-measured against it.
- **The extension path is measured in both Chrome and Edge.** The real-browser acceptance
  (`packages/webui/test/browser/browser-bridge-real-browser.spec.ts`) loads the built extension into
  each browser in turn and proves the same two things in each: the handshake completes once the
  extension can prove the installation key, and an extension that cannot is refused and receives no
  credential. That is evidence about the **bridge**, not about Edge's CDP domain list.
- **Chrome's extension `chrome.debugger` domain subset was not exercised against a live tab.** The
  extension was loaded and the handshake run, but no DevTools command was dispatched to a real page.
  The subset behaviour is documented by the vendor and recorded in the ADR's research findings; it was
  not verified here.
- **A real logged-in external browser was not exercised.** Every measurement used a fresh headless
  profile with synthetic `data:` pages. No account, session or user content was involved, and nothing
  here demonstrates support for a logged-in external browser. The ADR says this explicitly about the
  earlier isolated-Chromium MVP, and the same limit applies to this probe.
- **macOS and Windows credential stores were not probed.** The credential probe ran on a Linux host and
  reports nothing about any other platform. Nothing here may be cited as cross-platform validation.
- **The provider's attachment retry was not exercised by the probe.** The probe measured that the
  failure is real and that a 750 ms settle clears it. It did not drive `WebuiBrowserIsolatedChromiumProvider`
  itself through the race, so the retry in `provider.ts` is `implemented` only.
- **The bridge was exercised only as far as the matrix above says.** The acceptance connects a real
  Chrome and a real Edge to `/browser-bridge`, completes the handshake, drives the input, the image
  and a DevTools command, and refuses a peer that cannot prove its installation key. What was **not**
  exercised is a real browser against a **production** host: the bridge the acceptance drives is
  constructed by the test, and the packaged production entry is checked at its admission, by the
  package verification, rather than through a full pairing.
- **The commands outside the extension's allowed subset were not exercised against a real browser.**
  The subset is refused as `unsupported`, which the acceptance observes; the commands *inside* it
  were not each run against a live page.
- **Commands outside the 44 probed were not measured.** Chrome implements far more CDP commands than
  were sent. `Schema.getDomains` being unavailable is precisely why no catalogue was available.
- **`Target.disposeBrowserContext` was called but not recorded.** The probe disposes of the context it
  creates, and the disposal result is not in the evidence. It has no status in this matrix.
- **No gate was run for this document.** This is a Markdown file; the checks that bear on it are
  `node scripts/source-inventory.mjs --write` followed by `pnpm check:source`, which record the file in
  the public-source inventory. See the note at the end of [`README.md`](README.md).

## Surface capability declarations

The declaration the host intends to offer, from
`packages/webui/src/shared/contracts/browser.ts`. These are intent, not measurement; the runtime checks
each call against live authorization, so a wrong declaration degrades to a refused call rather than to
an unearned capability.

| Surface | `bridged` | `liveImages` | `input` | `agentTools` | `fullCdpApplies` |
| --- | --- | --- | --- | --- | --- |
| `isolated-chromium` | `false` | `true` | `true` | `true` | `true` |
| `edge` | `true` | `true` | `true` | `true` | `true` |
| `chrome` | `true` | `true` | `true` | `true` | `true` |

`liveImages` and `input` are `true` for the two bridged surfaces as declarations only. The image stream
and input paths for those surfaces run over the bridge, and nothing measured here confirms either.

## The workspace browser tab model

[ADR 0022](../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md) turns the workspace panel into a
browser tab strip: a tab is a **web tab**, and the panel shows a picture of a live page. That gives the
tab model its own matrix. It is measured against the **isolated Chromium** — the surface the
programme's first slice uses — because that is the surface the repository drives itself.

**Measured on the validation host.** `/usr/bin/google-chrome`, `Chrome/152.0.7977.82`, revision
`@d04cdb24d67b081f6cf80200cfc5233f44b61109` (`two-page-spike.json` → `host.chrome`). The record is
`.plan/workspace-browser-tab/complete/two-page-spike.json`.

**Probe method.** The spike launches a real Chrome in the provider's own launch shape and speaks CDP
through the repository's own `WebuiBrowserCdpConnection`
(`packages/webui/src/runtime/browser/isolated-chromium/cdp-connection.ts`). It attaches to **two**
pages and exercises them at the same time. It also launches the repository's own
`WebuiIsolatedChromiumProvider` to record what the provider does today. The two pages are real
documents served from `127.0.0.1`; no network and no real user content were involved. The spike
asserts nothing — the record is the evidence.

### What a web tab can do — measured

Every cell in this table is `measured`, and the evidence field is named.

| Capability | Mark | Evidence |
| --- | --- | --- |
| Two pages of one isolated Chromium, live at the same time | **measured** | `substrate.pages` — two pages, two distinct target ids and two distinct target sessions |
| Each page is driven independently | **measured** | `substrate.afterNavigation` — page A answers `Page A`, page B answers `Page B2` |
| Each page is streamed independently | **measured** | `substrate.framesAtTheEnd.byEnvelopeSession` — A: 1 frame, B: 3 frames, from two different target sessions; `substrate.frameIdentityIsSufficient.bothPagesStreamedAtTheSameTime` is `true` |
| A page that is **not** in front produces no new frames | **measured** | typing into the background page added no frame to its stream; `Page.bringToFront` on that page made it produce one. Chrome renders the foregrounded tab and throttles the others |
| A newly opened page's generation may advance once | **measured** | a page opened with a `data:` URL finished loading before the provider attached to it and stayed at generation `1`; a page opened with a real URL was still loading, and the provider saw the page behind the tab replaced — the generation went to `2` and a target change was announced |
| Each page is input into independently | **measured** | `substrate.input` — page A's field reads `alpha`, page B's reads `bravo`; `independent` is `true` |
| A navigation on the second page advances **that** page's generation and leaves the first alone | **measured** | `substrate.generation` — A stays `1`, B goes `1` → `2` |
| A reference recorded against a page's previous generation is refused | **measured** | `substrate.fence.staleReferenceOnNavigatedPage` — refused with `browser_target_stale` |
| A reference against the untouched page's current generation is still accepted | **measured** | `substrate.fence.currentReferenceOnUntouchedPage` — `accepted: true` |
| The frame's page is resolved from the **envelope's** session id | **measured** | `substrate.frameRouting` — the envelope's `event.sessionId` resolves to a page for every frame; `event.params.sessionId` resolves to none |

**The frame's identity, in one line.** The envelope's `event.sessionId` is the target session — a
string, put on the event by the CDP connection (`cdp-connection.ts:234`, `:237`) — and it identifies the
page. `event.params.sessionId` is the **number** `1` for frames from *both* pages
(`substrate.frameRouting.paramsSessionIdValues`), and identifies nothing. A screencast frame is
routed by the envelope.

### What this repository does today

`not yet measured` in this table means the source does not do this yet, and the row names the ticket
that closes it. It is a gap, not a denial.

| Capability | Mark | Where it stands |
| --- | --- | --- |
| The provider drives one page per web tab | **implemented** | the provider holds a map of target id → session and generation, and resolves the session by target in `sendCommand`, `sendInput`, `startImageStream` and `stopImageStream`. `packages/webui/src/runtime/browser/isolated-chromium/provider.ts` |
| The generation advances per page | **implemented** | the generation lives on the page, not on the browser. `Page.enable` goes to every page, and the raise is keyed by the event's own session. `provider.ts` — `#attachPage` and `#onEvent` |
| A frame is routed to the page that asked for it | **implemented** | a screencast frame is matched to its page by the **envelope's** session id, and the subscriber that receives it is that page's own. `provider.ts` — `#onEvent` |
| A page the provider never attached to is still refused | **implemented** | only the pages the provider attached to are in the map, and a target that is not in the map is refused with `browser_target_unknown` rather than being sent to the wrong page. `provider.ts` — `sendCommand` |
| The identity `open_tab` returns names the page it created | **implemented** | the answer carries the surface, the browser id, the target id and the generation the provider's own accounting gives the page. `packages/webui/src/runtime/browser/isolated-chromium/provider.ts` — the `open_tab` case of `sendCommand` |
| The service observes a new page from the identity `open_tab` returns | **implemented** | the service reads the answer and observes that target in the registry, so the identity is usable at once — it does not have to wait for the provider to be asked for its list again. `packages/webui/src/runtime/browser/browser-service.ts` — `#observeOpenedTarget` |
| The image stream is keyed by target | **implemented** | the client asks for the target it is showing; the service's frame subscribers are keyed by target, one screencast per page, and a frame that names another page is dropped and counted. `packages/webui/src/runtime/browser/browser-service.ts` — `watchFrames` |
| A session's pages are released when the session ends | **implemented** | the release is keyed on the **session**, not on one operation. The three ways a session goes away — deletion, archiving, and a transfer away — all reach it: the first two through the harness port's own `deleteSession` and `archiveSession`, the third through the transfer's rollback, which calls the same `deleteSession`. `packages/webui/src/runtime/harness/sessions.ts` — `releaseSessionIfItEnded`; `packages/webui/src/runtime/browser/browser-service.ts` — `releaseSession` |
| The runtime publishes the session's web tabs as a snapshot | **implemented** | the service keeps the session's web tabs beside the run's selection and publishes them on the `watchBrowserWebTabs` stream — each tab's id, its target identity, its title, its URL, and whether it is the run's selection. `packages/webui/src/runtime/browser/browser-service.ts` — `watchWebTabs` |
| The client subscribes to the published snapshot | **implemented** | the browser port carries `watchBrowserWebTabs`, the transport's request table has it, and the wire opens the stream, and the strip subscribes **under the session's run id**: the pages of a session are recorded in that cell whether the Agent opened them or the person did, so one subscription carries both. `packages/webui/src/client/features/browser/contracts/browser-port.ts`; `packages/webui/src/client/features/workspace/ui/WebuiWorkspaceTabStrip.public.tsx` |
| The Agent opens tabs and gives a run its first selection | **implemented** | `open_tab` is the one action a run with no selection may perform, because it is the action that would create the selection the gate wants. Every other action of a cold run is still refused with `browser_target_unknown`. `packages/webui/src/runtime/browser/tool-adapter.ts:178` — the `open_tab` branch, which calls `openWebTab`; `packages/webui/src/runtime/browser/browser-service.ts:1188` — `openWebTab` |
| The client's tab is a stable id with a mutable content | **implemented** | the id is assigned by the client when the tab is opened and does not change when the content does, so two web tabs in one session are two tabs. The rules that used to fall out of the id — the same file opens one tab, the workspace review and the turn review are two tabs — are content checks now. `packages/webui/src/client/features/workspace/projection/workspace-panel-state.ts` |
| The frame operation's request names a target | **implemented** | `watchBrowserFrames` takes `{ surface, target }`. A request that still carries a run id is refused with an explicit error rather than answered with the run's selection. `packages/webui/src/server/operation/browser.ts` — `validateFrameStream` |
| The provider's attachment retry | **implemented** | `provider.ts` — the mechanism is cited in full above |
| A restricted action is executed by one implementation on both surfaces | **implemented** | Browser Core owns the semantics — element references, retained snapshots, action deadlines, effect validation — and reaches each browser through a `BrowserTransport`. The isolated Chromium's adapter is `packages/webui/src/runtime/browser/isolated-chromium/core-transport.ts`; the bridge's is `packages/webui/src/server/browser-bridge/core-transport.ts`. [`10-browser-core-integration.md`](10-browser-core-integration.md) |
| A reference names an element the Agent can act on | **implemented** | `inspect` returns an opaque `browser-element:<generation>-<uuid>`. The core holds the element map and the retained snapshot, and refuses a reference whose page has moved on with a stale-reference refusal (`STALE_ELEMENT_REF` or `STALE_SNAPSHOT`) — while a reference on a page that did **not** navigate stays usable. `packages/browser-core/src/browser-action-targets.ts`; `packages/webui/test/integration/browser-core-agent-actions.test.ts` |
| The bridge's `back` and `forward` actually navigate | **implemented** | they are Browser Core's `history` semantics, so they read the tab's history and go to the entry. The bridge's earlier path only asked for the history and never moved. `packages/browser-core/src/browser-actions.ts:245`; `packages/webui/test/unit/browser-bridge-core-actions.test.ts` |
| The bridge's screenshot is the tab the person is looking at | **implemented** | it comes from the extension's own pushed visible-tab frame, through the core's `captureScreenshot` hook. A tab that is not in front has no frame to give and is refused with `browser_capability_denied` rather than answered with another tab's picture. `packages/webui/src/server/browser-bridge/server.ts` — `#captureVisibleFrame`; `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx` |
| The files tab is a singleton | **implemented** | an explicit content check now: one files tab per session and directory. The id no longer implies it, because the id says nothing about what the tab is showing |
| The two review tabs are two tabs | **implemented** | the workspace's change set and a turn's review are told apart by the content's `source`, so opening one no longer replaces the other |
| A tab's label follows its content | **implemented** | the content carries the kind, and a web tab is titled by the page the runtime publishes |
| The strip renders tool tabs and web tabs in one row | **implemented** | a published `WebuiWorkspaceTabStrip` renders every tab the workspace's reducer holds — tool tabs (files / review / canvas / terminal) and web tabs side by side — and owns the close button, the active tab and the "+" new-tab affordance. The strip does not keep its own list of web tabs: each `watchBrowserWebTabs` snapshot becomes an `open-web-tab` command, and the reducer's existing-tab rule keeps duplicates out. `packages/webui/src/client/features/workspace/ui/WebuiWorkspaceTabStrip.public.tsx` |
| The surface switcher is gone | **implemented** | Edge and Chrome are reached in the person's own windows now; the only surface the panel ever shows is the isolated Chromium. `BrowserPanel.public.tsx` no longer renders the three-button radio row, and `BrowserPanelHost.public.tsx`'s `surface` prop becomes a `target` prop, the target the active web tab is bound to. `packages/webui/src/client/features/browser/ui/BrowserPanel.public.tsx`; `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx` |
| A newly opened tab opens as the new tab page | **implemented** | the strip's "+" dispatches `open-new-tab`, the workspace's reducer opens a tab with the `launcher` content kind and makes it active. It is a fresh tab every time — the launcher is a tab's content, so a person who typed a URL into one presses "+" again for another. `packages/webui/src/client/features/workspace/projection/workspace-panel-state.ts`; `packages/webui/src/client/features/workspace/contracts/panel-command.ts` |
| The new tab page is a launcher, not a menu | **implemented** | four tiles — 变更 / 终端 / 画布 / 查看文件 — and a URL box, rendered by `WebuiWorkspaceLauncher` next to the strip that owns the row. The tiles are the registry's rows that carry a tile, in one order list, so the launcher's list is not a second enumeration; the browser tool view is not among them. `packages/webui/src/client/features/workspace/ui/WebuiWorkspaceTabStrip.public.tsx` — `webuiWorkspaceLauncherTiles` |
| Choosing a tile replaces the tab's content | **implemented** | `open-tab` and `open-workspace-review` carry an optional `tabId`, and with it the reducer replaces that tab's content in place instead of the singleton lookup. The tab keeps its id and is neither closed nor replaced. The singleton rule still holds for every caller that does not name a tab |
| A URL typed in the launcher opens a page through the same switch | **implemented** | the launcher calls the browser business's port — `openBrowserWebTab`, a new unary operation whose handler calls `WebuiBrowserPort.openWebTab`, the same member the Agent's `open_tab` reaches. The switch, the provider gate and the refusal codes are shared; a surface that is switched off refuses both paths with `browser_surface_not_authorized`, before a provider is asked for a page. `packages/webui/src/server/operation/handlers/browser.ts`; `packages/webui/src/runtime/port.ts` |
| The page a person opened lands in the tab that asked for it | **implemented** | the launcher dispatches `request-web-page` before the call, so a `watchBrowserWebTabs` snapshot that lands mid-call finds the tab that asked; `open-web-tab` binds the page to the named tab, and to a launcher that is waiting when the command names none. Either order, one page, one tab — and the tab is not activated, so a person who looked elsewhere is not moved. `packages/webui/src/client/features/workspace/projection/workspace-panel-state.ts` |
| A refusal keeps the launcher, and says why | **implemented** | the runtime's own message is carried on the launcher's `request.error` and rendered under the URL box, so the box stays and the person can type something else. Nothing about the launcher's refusal is worded differently from the Agent's |
| The URL box exists only on the new tab page | **implemented** | the launcher renders exactly one input, and a web tab renders none: the browser business's host shows the page's URL in the tab's toolbar as text, not as a field. `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx` |
| A web tab carries back, forward, reload, home and the URL | **implemented** | the toolbar is rendered by the browser business's **published host** — ADR 0022's component table already gave it that home ("binds a tab to a target, shows the picture and the toolbar") — and it is drawn over the one thing the strip hands it: the tab's target, the url and navigation-history availability the runtime publishes with it. Back and forward are disabled when no entry exists in that direction; home replaces the current tab's content with its launcher. The strip owns the row of tabs; a workspace component drawing a foreign business's page chrome would invert the dependency rule. `BrowserPanelHost.public.tsx` |
| The toolbar's three presses go through the existing command path, and name the page | **implemented** | one request per press on the browser family's own `sendBrowserCommand` operation — no second operation, no second route. `WebuiBrowserCommandRequest` gained an optional `target`, and the handler routes a named target to `WebuiBrowserPort.sendCommandToTarget`. The target is what makes the press mean the page in front of the person: an absent target still resolves the surface's selection (a run's, or the panel's own cell), which is a page the tab may not be showing. `packages/webui/src/server/operation/browser.ts`, `packages/webui/src/server/operation/handlers/browser.ts`, `packages/webui/src/runtime/browser/browser-service.ts` |
| A toolbar press that cannot be honoured says so, and leaves the page alone | **implemented** | the refusal travels out with the runtime's own code and message: `browser_target_stale` for a reference recorded before a move, `browser_capability_denied` when the page's history has nothing to go to. The service checks the surface switch and the command gate first, so a refusal names the switch rather than the page. The client helper does not catch: `browser-web-tab-toolbar.test.tsx` |
| Back, forward and reload move a real page | **implemented** | `packages/webui/test/integration/isolated-chromium-two-pages.test.ts`, "the web tab's toolbar, on a real page": three presses through the client's own helper, the operation's validator and handler, the service and a real isolated Chromium. Observed: `back` lands on the page it came from, `forward` on the one it left, `reload` re-reads the page it is on, the generation advances with each move so the pre-move reference is refused with `browser_target_stale` while the tab's current reference still works, and a `back` with nothing behind it is refused with `browser_capability_denied` with the page untouched |

### The two cells, one writer each

The tab model has **two** answers to "which page?", and they are not the same answer. ADR 0022 names
them, the code names them, and keeping them apart is what the input path exists for.

| Cell | Whose | Written by | Read by | Code |
| --- | --- | --- | --- | --- |
| The **run's selection** | the runtime's | the Agent, through its own `open_tab` and its own selection operation | the client, read-only, out of the mark the runtime puts on the target list | `WebuiBrowserRunSelectionTarget` — `WebuiBrowserPanelState.runSelection`, `packages/webui/src/runtime/browser/browser-service.ts` `#runSelections` |
| The **tab the person is looking at** | the client's | the person, by choosing a tab | the client, for the picture, the alt text, the input binding and the frame stream | `WebuiBrowserViewedPage` — `WebuiBrowserPanelState.viewedPage`, `packages/webui/src/client/features/browser/contracts/browser-panel.ts` |

| Capability | Mark | Where it stands |
| --- | --- | --- |
| The panel's input is bound to the page the person is looking at, never to the run's selection | **implemented** | `prepareWebuiBrowserInputCommand` takes the viewed page as its own argument — there is no field of the run's selection left in its signature for a gesture to be aimed at — and `checkWebuiBrowserInputTarget` fences it against that page's generation. `packages/webui/src/client/features/browser/application/browser-commands.ts`; `packages/webui/test/unit/browser-input-command.test.ts`, "binds to the tab the person is looking at while the run's selection is elsewhere" |
| The panel shows and streams the page in front, not the Agent's page | **implemented** | `selectWebuiBrowserStreamTarget` and `selectWebuiBrowserFrame` read `viewedPage`; the host dispatches `page-viewed` when the tab it was handed changes. `packages/webui/src/client/features/browser/projection/browser-state.ts`; `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx` |
| The person cannot write the run's selection from the panel | **implemented** | the mark in the toolbar is a report of the runtime's mark, not a control: it is a span, `BrowserPanelProps` has no `onSelectTarget`, and the client port member `selectBrowserTarget` is no longer called from the panel. The `selectBrowserTarget` operation and port member still exist — the runtime still owns that write — the panel simply is not one of its callers |
| The panel is a window: the strip's tabs, the page, and nothing beside the page | **implemented** | ADR 0022 decides that the single panel's "target list is the strip's tabs", so the panel has **no** list of its own: the tabs are the strip's, and the panel is the page. A browser holds pages that are not tabs — the page it opens at startup, the one the provider drives for itself — and a list naming those beside the person's tab read as more tabs than the person opened. The panel's row is a toolbar: the three commands as marks, the url in an address bar, and the page the Agent is on named at the quiet end of it. `packages/webui/src/client/features/browser/ui/BrowserPanel.public.tsx`; `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx`; `packages/webui/test/unit/browser-panel-view.test.tsx`, "is the window's page and nothing beside it" |
| The picture is live: the page changes and the panel shows it | **implemented** | the picture is a **screencast**, and Chromium holds the next frame until the previous one is acknowledged. The acknowledgement goes to the **page's** session; an ack that goes to the browser's connection instead leaves the page frozen on whatever it first drew — three frames, and then nothing. `packages/webui/src/runtime/browser/isolated-chromium/provider.ts` — `#ackScreencastFrame`; `packages/webui/test/integration/isolated-chromium-screencast.test.ts`, "keeps delivering frames while the page changes" |
| A click lands where the person pointed | **implemented** | the picture is the browser's viewport drawn to fit the surface, so a click on the surface is not yet a point in the browser: the picture is scaled, and the space around it is not part of the page. The point is mapped back into the picture's own size — the arithmetic the picture is drawn with, in reverse — before the command is sent. `webuiBrowserPicturePoint` in `packages/webui/src/client/features/browser/application/browser-commands.ts`; `packages/webui/test/unit/browser-input-command.test.ts`; `packages/webui/test/integration/isolated-chromium-screencast.test.ts`, "a click mapped into the picture lands where the person pointed" |
| The browser's window is the size of the place the page is shown in | **implemented** | the panel states the size it shows the page at (`watchBrowserFrames` carries a `viewport`), and the browser takes it with the same device-metrics override its own window uses — no reload, and the page behind the target is the same page whoever looks at it. Without it the page is scaled into the panel and the person reads it at half the size. `packages/webui/src/runtime/browser/isolated-chromium/provider.ts` — `setViewport`; `packages/webui/src/client/features/browser/ui/BrowserPanel.public.tsx`; `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx`; `packages/webui/test/integration/isolated-chromium-screencast.test.ts`, "the window takes the size the panel shows the page at" |
| Neither cell writes the other when either one moves | **implemented** | `page-viewed` moves `viewedPage` alone; `targets-loaded` and `target-changed` move `runSelection` alone; `run-changed` clears `runSelection` and leaves `viewedPage`. `packages/webui/test/unit/browser-panel-state.test.ts`, "the two cells" |
| The bootstrap: a page a person opened while the run has no selection becomes the run's selection | **implemented** | the request says who opened it — `WebuiBrowserTabOpener` is `"agent"` or `"person"` — and the **runtime** decides: a person-opened page joins the run's selection only when `#selectionOf(surface, runId)` was undefined at the moment the page appeared. `packages/webui/src/runtime/browser/browser-service.ts` — `openWebTab`; `packages/webui/test/unit/browser-service.test.ts`, "run-scoped selection" |
| The bootstrap is not a standing co-write rule | **implemented** | an `agent` opener always sets the selection — a second `open_tab` moves the run and loses nothing — while a `person` opener with a run that already has a page records the web tab and leaves the selection where the Agent put it. Both are asserted in `browser-service.test.ts` and both were observed against a real browser |
| The two cells are separated on a real browser, with both in use | **implemented** | `packages/webui/test/integration/isolated-chromium-two-pages.test.ts`, "the run's selection and the tab in front, on a real browser". Observed: the Agent opened a page and drove it while the person opened a second page and typed into it through the client's binding function and the `sendBrowserInput` handler; the Agent's page read `agent acted` with an empty field, the person's page read `text:person typed` in its field, and the run's selection was still the Agent's page at the end. On one page — the one the bootstrap gave the cold run — the person's text and the Agent's action were both delivered, and an input recorded before that page moved was refused with `browser_target_stale` rather than dropped |

**What the bootstrap is not.** It is not a rule that says "the person's page is the run's page", and it
is not decided by the client. The workspace names its session in the request and the runtime compares it
against the selection it owns at that moment; the client cannot see a run's selection at all. That is why
the launcher passes the run id straight through (`webuiWorkspaceLauncherOpenPage`) and applies nothing
itself.

**What the provider does today, measured again.** The provider's `open_tab` creates a page, attaches
to it and registers it, and the page is listed with its own identity
(`phases.provider.newPageIsListedByTheProvider`). Driving it, inputing into it and streaming it all
succeed (`phases.provider.driveNewPageNavigate`, `.driveNewPageInput` and `.streamNewPage` are all
`ok`). The page count still goes from 2 to 3 (`phases.provider.pageCount`) — the third page is the
one Chrome opened for itself, which the provider has never attached to and therefore still refuses.

### The fence, on every page

The fence is what makes a reference to a page that has been replaced detectable. The spike shows it
working on a page that is **not** the one the browser was launched with:

| Page | What happened | Result |
| --- | --- | --- |
| B (navigated) | its generation advanced `1` → `2`; a reference recorded against generation `1` was offered | refused with `browser_target_stale` |
| A (untouched) | its generation stayed `1`; a reference recorded against generation `1` was offered | accepted |

A fence that only works on the launch page is a fence that does not work. The provider's fence now
covers every page: the generation it compares against is the page's own, so a reference recorded
against a page that navigated is refused on that page, and the same reference against a page that
did **not** navigate is still accepted.

### The registration cost of the new operation

The programme adds one operation that publishes the session's web tabs. Registering it costs the
**eight** sites below, and every one of them is a place where a change that is forgotten shows up as a
missing capability rather than as an error. **The `watchBrowserWebTabs` operation is registered at
every one of them**; `packages/webui/test/unit/browser-web-tabs-operation.test.ts` is the executable
form of this list, and a site that loses the operation fails there.

| Site | Where | What the new operation needs |
| --- | --- | --- |
| The capability manifest's `browser.ready` list | `packages/webui/src/shared/capability-manifest.ts:143` | the operation's name joins the list. A `ready` member that is not wired makes the whole browser family **not-ready** (`capability-manifest.ts:202`), not absent — a quiet degradation. **Done.** |
| The operation-name constants | `packages/webui/src/shared/operation-names.ts:51` | one new `as const` constant beside the eight browser names. **Done.** |
| The operation spec | `packages/webui/src/shared/operation-names.ts:458` | one row naming the request and the response type, beside `watchBrowserFrames`. **Done.** |
| The contract type | `packages/webui/src/shared/contracts/browser.ts` | the request and response types live here; `watchBrowserFrames` has none of its own, so the new operation introduces one. **Done.** |
| The operation registry | `packages/webui/src/server/operation/operations.ts:162` | one `registerOperation(registry, entry("<name>"))` line inside the `if (browser)` block. **The order is a wire contract** (`operations.ts:69`). **Done.** |
| The server handler | `packages/webui/src/server/operation/handlers/browser.ts:127` | a dedicated handler. A stream handler returns `{ stream: { ok: true, source } }` and lets the service's generator raise the errors — the handler does not catch them. **Done.** |
| The port member and its implementation | `packages/webui/src/runtime/port.ts:637` and `packages/webui/src/runtime/harness/browser.ts:206` | the member on `WebuiBrowserPort` and its body in `createBrowserPort`. **Done.** |
| The transport's request table | `packages/webui/src/client/platform/transport.ts:232` | the client's request builder; a stream also needs the wire session in `packages/webui/src/client/platform/wire.ts:144` and `:373`. **Done.** |

**There is no `bind()` row to add.** The browser operations are dedicated handlers, not bindings: the
`WEBUI_OPERATION_BINDINGS` table (`packages/webui/src/server/operation/bind-handlers.ts:149`) has no
browser entry, and there is no `RuntimeGroups.browser` group to extend.

**The second operation costs the same eight sites and nothing else.** `openBrowserWebTab` — the call the
new tab page's URL box makes, so a person and the Agent reach the same `open_tab` — is registered at
every site above, and `packages/webui/test/unit/browser-web-tabs-operation.test.ts` asserts both
operations there. Two things about it are worth naming, because both are decisions rather than
mechanics:

- **Its request carries a URL and a run, not a surface.** The surface is read off the run, the same way
  the Agent's path reads it, so the two cannot disagree about where a page is opened. A request with no
  run is the panel's own cell — the panel is not a run — and the bootstrap applies to it as it applies to
  a run. The workspace names its session, which is the same run id the rest of the browser port already
  uses; **what the request does not carry is the answer.** The bootstrap is decided by the runtime, which
  is the only place that can read the run's selection at the moment the page appears, so the launcher
  passes the run through and applies nothing itself. The handler is what declares the request the
  person's: it passes `WebuiBrowserTabOpener`'s `"person"`, and `WebuiBrowserPort.openWebTab` carries it
  to the service. **Done in #211.**
- **Its validator refuses an empty URL** with `invalid_body` rather than defaulting it. A blank page
  opened by a request that claimed to be honoured is worse than a request that was refused.

### The plumbing cost of a new source file and a new test file

| What | Where | What it costs |
| --- | --- | --- |
| The frozen path metadata fixture | `packages/webui/test/gates/fixtures/path-metadata-f00.json` | a new source path needs an entry, classified by the **frozen** baseline classifier. The fixture's own README says not to regenerate expectations from the current classifier: strip only `.public` before the TypeScript suffix, then run the frozen classifier against the path and review any mismatch separately |
| The declared Vitest suite groups | `packages/webui/test/vitest-suites.json` | a new Vitest file is appended to `suites.webui`. This JSON is the single source — no `package.json` script and no Vitest config change |
| The source inventory | `release/public-source.json` | regenerate with `node scripts/source-inventory.mjs --write`; `pnpm check:source` reads it. The inventory scans the working tree, including untracked files, so a scratch file left in the repository becomes a publication problem |
| The Playwright spec directory | `packages/webui/test/browser/` | a real-browser spec lands here. A test that drives the **isolated Chromium runtime** is not a Playwright spec: it belongs in `packages/webui/test/integration/`, beside `browser-use-real-input.test.ts`, and is a Vitest suite |

**The launcher cost none of them.** The new tab page is `WebuiWorkspaceLauncher` inside the strip's own
published file, and its interaction coverage is inside the strip's existing suite: a launcher that was a
new component and a new test file would have added a frozen-fixture entry, a suite-group entry and an
inventory entry for a component the ADR already gives a home. The next programme step should follow the
same shape — a view that belongs to an existing component belongs in that component's file.

### The tab-model inventory, checked against the tree

The inventory the research notes name, checked against the code as it stands. Every row is real.

| Site | Where | What it is |
| --- | --- | --- |
| The files-tab singleton | `workspace-panel-state.ts:289` | `open-primary-view` drops **every** `files` tab before adding one — the singleton is enforced by deletion, not by a lookup |
| The two review tabs that share one id | `workspace-panel-state.ts:279` and `:283` | the workspace's change set and a turn's review derive the **same** id, `tabId("review", sessionId, workspaceDir)`. One of them replaces the other |
| The label derived from the kind | `workspace-panel-state.ts:154` | `webuiWorkspaceTabLabel` switches on `tab.kind` |
| The `kind === "review"` narrowing | `workspace-panel-state.ts:156`, `:299`, `:302`, `:303`; `WorkspacePanels.tsx:332`, `:337`, `:338`, `:340`, `:341` | the two review sources are told apart by narrowing on the kind and then on the source |
| The `activeTab?.kind` guards | `WorkspacePanels.tsx` | **28** of them |
| The caches keyed by a tab id whose effects depend on `[activeTab?.id]` | `WorkspacePanels.tsx:291`, `:306`, `:309`, `:325`, `:327`, `:330`, `:337`, `:347`, `:353`, `:417` | the file-results cache, the review summary, the review search and the review diffs are all keyed by the tab id, and their effects re-run when that id changes |

**Why that breaks under a mutable content.** A tab's id is derived from its kind and its parts
(`workspace-panel-state.ts:251`), and a web tab's page changes without the kind changing. The
caches above are keyed by the id and their effects are keyed by the id, so a content that changes
under a stable id leaves a stale picture on screen: the cache says the tab is showing generation 1
while the page behind it is generation 2. The id has to become stable and the content has to become
the thing that changes — which is what #207 does.

### Not yet measured — the tab model's open questions

- **The two-page case was first measured on the substrate and then through the provider.** The
  provider could not hold two pages when the spike first ran, so the spike drove the CDP connection
  directly to find out what the browser can do. The provider's per-target map is now implemented and
  the same spike observes it driving, inputing into and streaming the second page.
- **The frame mis-stamping count is a modelled consequence, not a provider observation.**
  `substrate.currentProviderFrameRule` applies the provider's current rule to the frames the spike
  observed, because the provider cannot stream a second page at all. It is arithmetic over a
  measurement, and it is labelled as such in the record.
- **The toolbar and the two cells are measured against a real browser; the rest of the tab model is
  not.** The three commands a web tab carries — back, forward, reload — are pressed against a real
  isolated Chromium in `packages/webui/test/integration/isolated-chromium-two-pages.test.ts`, through
  the client's own helper, the operation's validator and handler, and the service. So is the separation
  of the two cells: the Agent working in one page while the person types in another, both delivered on
  the one page the bootstrap gave a cold run, and a stale input refused rather than dropped — in
  "the run's selection and the tab in front, on a real browser", in the same file. The tab model, the
  strip and the new tab page are still exercised only by unit coverage: #208 and #209 covered the tab
  model, the strip and the new tab page, #210 the toolbar, #211 the two cells, and #212 is where the
  acceptance record and the documentation sweep happen.
- **Only the foregrounded page renders.** Chrome throttles the pages it is not showing, so a tab in
  the background produces no new frames. A strip shows one tab at a time, so the page in front is the
  one that produces the picture — but whether a background tab should show a *still* picture, and
  when it is refreshed, is not decided.
- **The bridged surfaces have no tab model at all.** Everything measured here is the isolated
  Chromium. The extension bridge exposes one visible tab per browser, so a tab strip over it is a
  different question and was not asked.
