# Review findings — WebUI Browser Use

**Twelve review rounds** have been run against this change: nine by a `codex` `gpt-6-luna` reviewer
reading the source rather than the description, a seventh that was the final acceptance pass run
against the finished tree, an eleventh raised by the tab-model review, and a twelfth raised by the
Browser Core integration. This document records what each round found and what was done about it.

Two **probe rounds** — a real browser against the built extension, and the
external path driven against it — are recorded here as well. They are numbered
`Probe A` and `Probe B` rather than as rounds, because they were findings of
the implementation, not of a reviewer, and because the two used to carry the
same numbers as rounds 5 and 6.

Every status below is a claim about the **tree**, and each one names the file
that carries it. A finding that is still open is marked open; nothing here is
rounded up.

## How to read the statuses

| Status | Meaning |
| --- | --- |
| `fixed` | The code now does the thing, and a test proves it. |
| `fixed, platform unverified` | The code does the thing; the platform behaviour it depends on could not be executed on this machine. |
| `open` | Not done. What remains is stated. |

---

## Round 1

> Verdict: the plan cannot be closed. The extension bridge is not wired into
> WebSocket upgrades or the browser service, Agent tools do not share the
> panel's session, Full CDP is not enforced, and the OS credential-store
> implementation cannot reliably reload credentials after restart. There is also
> a stale-generation input defect and a bridge router that can select the wrong
> session.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | BLOCKER | Pairing credentials did not survive a restart, and the secret appeared in child-process arguments. | `fixed` |
| F2 | BLOCKER | An input recorded against an old target generation could still be accepted after a navigation. | `fixed` |
| F3 | MAJOR | The external bridge was not connected to the server or the browser service. | `fixed` |
| F4 | MAJOR | Bridge commands were routed to the most recently admitted session rather than to the session that owns the target. | `fixed` |
| F5 | MAJOR | The Full CDP switch had no command path and no enforcement. | `fixed` |
| F6 | MAJOR | Image frames were not fenced to the currently selected generation. | `fixed` |
| F7 | MAJOR | The published documents disagreed with the tree. | `fixed` |

### What was done

- **F1** — `packages/webui/src/server/browser-bridge/credential-store.ts` was
  rewritten. The secret is no longer in `argv` on any platform: macOS uses
  `security add-generic-password` with the secret on **stdin**, Linux uses
  `secret-tool store` with the secret on stdin, and Windows dropped `cmdkey`
  for a PowerShell **DPAPI** round trip. The credential is stored as base64 of
  the raw bytes, so the byte→text→byte round trip is exact for bytes that are
  not valid UTF-8. `load()` reads the **platform** rather than an in-memory
  copy and returns `undefined` when the platform cannot read back. There is
  still no plaintext file fallback: a failed save throws the typed unavailable
  error and writes nothing. — `fixed, platform unverified`: the macOS and
  Windows forms could not be executed on this Linux host and are asserted
  through an injected command runner.
- **F2** — The provider announces a target change when the main frame
  navigates (`onTargetChanged`); the service raises the registry's generation
  and moves the selection with it; and the provider itself refuses a command
  whose generation no longer matches, so the check that protects the page does
  not depend on the registry having heard about the navigation. Proven against
  a **real** browser: `packages/webui/test/integration/browser-use-real-input.test.ts`.
- **F3** — `packages/webui/src/server/browser-bridge/server.ts` owns the
  bridge's own WebSocket server, one pairing per surface and one registry;
  `packages/webui/src/server/websocket-server.ts` branches on `/browser-bridge`
  **before** the generic admission and returns; `packages/webui/src/server/service.ts`
  accepts and closes it; both composition roots build the one shared instance.
- **F4** — `packages/webui/src/server/browser-bridge/registry.ts` keeps a
  target-ownership table keyed by `(browserId, targetId)`, built from the
  extension's `targets` announcements, and requires an exact generation match.
- **F5** — `sendBrowserCommand` exists end to end. The gate is
  `isBrowserCommandAllowed`: a restricted browser-tool action is allowed
  whenever the surface is authorized; anything else needs the Full CDP switch.
  Full CDP never authorizes a surface on its own.
- **F6** — The service binds each stream to the complete target identity and
  drops any frame whose surface, browser, tab or generation no longer matches
  the current selection.
- **F7** — The documents were corrected against the tree, and the measured,
  implemented and not-yet-measured claims are separated.

---

## Round 2

> Verdict: the plan cannot be closed. The external path still cannot complete
> pairing or provide a runtime provider, bridge startup enables pairings
> regardless of the browser switches, and external frames can be relabelled with
> a newer generation. Edge/Chrome Full CDP is also denied outright.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | BLOCKER | The host and the extension mint **independent** pairing credentials, so the extension can never produce a proof the host accepts. | `fixed` |
| F2 | BLOCKER | Bridge startup enabled Edge and Chrome regardless of the authorization switches. | `fixed` |
| F3 | MAJOR | The composition passed `createBridgeProvider` where the bridge exposes `createProvider`, so the service was handed an undefined factory. | `fixed` |
| F4 | BLOCKER | An external frame was stamped with the latest announcement's generation, so a delayed frame from the old page passed the selection fence. | `fixed` |
| F5 | MAJOR | External target generations never reached the runtime registry, so a target that navigated could become unusable. | `fixed` |
| F6 | MAJOR | Full CDP was unavailable on Edge and Chrome: the bridge provider refused every raw command. | `fixed` |
| F7 | MAJOR | This document itself was stale about round 1. | `fixed` |

### What was done

- **F2** — The bridge no longer switches any surface on by itself.
  `BrowserBridgeServer.start()` starts the WebSocket server and nothing else;
  the pairings follow the switches, because the switches own them. The browser
  service reads the persisted authorization and calls the bridge's
  `enableSurface` / `disableSurface` for the surface whose switch moved, each
  surface independently. Turning a surface off revokes its credential, closes
  that browser's sessions and refuses the old credential from then on.
  `packages/webui/test/unit/browser-bridge-server.test.ts` — "holds no
  credential and admits no session for a surface that is off".
- **F3** — The runtime reaches the bridge through the member the bridge
  actually exposes, and the adapter is where the two meet. The runtime's
  provider interface names the surface rather than the isolated literal, so the
  bridge's provider satisfies it rather than being excluded by construction.
- **F4** — A frame keeps the generation it carries. A frame whose generation
  does not match the latest announcement is **dropped**, not relabelled.
  `packages/webui/test/unit/browser-bridge-server.test.ts` — "drops an
  extension frame whose generation the announcement moved past".
- **F5** — The external branch subscribes to the provider's target changes and
  raises the registry's generation, and the registry adopts the provider's
  generation for a new entry without regressing a newer one.
- **F7** — This document.

### What was open then, and how it closed

**F1 — the pairing exchange.** The host mints a credential and keeps it in the
OS secure store; the extension currently mints a *different* credential and
keeps it in `chrome.storage.local`. Nothing transfers one to the other, so
the extension cannot answer a challenge the host issued. The fix is an
initial, authenticated pairing exchange: the host issues a single-use,
short-lived pairing code, the extension presents it, the host transfers the
credential once, and the extension stores it. Two things make this a decision
rather than a patch:

1. **How the code reaches the extension.** A browser extension cannot read the
   host's files, so the code has to travel through the person — the host shows
   it, the person enters it in the extension's options page. That is a product
   surface (a Settings panel that displays a live pairing code) and it has to
   be designed, not merely wired.
2. **What "automatically pairs" means.** ADR 0019 says enabling a switch pairs
   the browser without per-tab confirmation. A one-time code is per-browser
   confirmation, not per-tab, but the wording should be reconciled with the
   mechanism rather than left to the reader.

**F1 is now closed**, and the mechanism is **not** the one this finding
proposed. There is no pairing code and no settings surface: the extension
generates an ephemeral ECDH P-256 key pair when it connects, and the host
seals its credential to that public key — ECDH P-256, then HKDF-SHA256, then
AES-256-GCM — and sends it in a `pair` frame
(`packages/webui/src/server/browser-bridge/pairing.ts:470`,
`sealCredentialForExtension`; `packages/webui/src/server/browser-bridge/session.ts:695`).
The extension validates the frame, decrypts it and stores it, and the host's
credential is authoritative: the extension never mints one.

That is a decision, and it is recorded as one — ADR 0019's amendment **A1**,
" How the extension obtains the host's pairing credential", which states the
seal, the reason a code is not needed, and the reason the host seals to the
key *that peer supplied* rather than to a key it chose. The finding's two open
questions are therefore answered by A1 rather than left open: the credential
never travels through the person, and "automatically pairs" means the transfer
happens during the handshake.

Until this lands, the external surfaces cannot complete a handshake, and every
external capability is blocked behind it.

**F6 — Full CDP on the external surfaces.** The runtime gate is in place and
the isolated Chromium forwards a raw DevTools method, but the bridge provider
refuses every raw command, because `chrome.debugger` exposes only a subset of
the DevTools domains. The honest fix is a bounded bridge command frame and an
extension-side `chrome.debugger.sendCommand` dispatch restricted to that
subset, with an unsupported method refused explicitly. **At the time of this
round it was not done**: it needed the same wire change as F1's exchange, and
doing both at once without a real Edge or Chrome to test against would produce
a protocol that had never spoken to a browser.

**F6 is now closed**, and the way it was closed is the way the finding asked
for. The host sends a raw DevTools command as a `cdp` frame and the extension
answers with a `cdp-result`; the extension keeps an explicit list of the
commands it will send and refuses anything outside it **before** it makes any
browser call, and that refusal says `unsupported`, so the host can tell "the
extension will never run this" from "this failed". The host's own gate is
unchanged and still comes first: the surface must be authorized, and the
command must be a restricted browser-tool action or permitted by the Full CDP
switch. The provider does not keep a second opinion about that, which is why
it no longer refuses a raw command on the surface's own authority.

`packages/webui/test/unit/browser-bridge-server.test.ts` — "forwards a raw
DevTools command rather than refusing it";
`packages/browser-extension/test/cdp.test.ts` — "sends a command that is in the
supported subset" and "refuses a command outside the subset without asking the
browser".

## Round 3

> Verdict: the plan cannot be closed. A host restart rotates the host's
> pairing credential away from the one the extension still holds; the Agent's
> browser tools never reach the browser service; the target selection is
> per-surface rather than per Agent run; Full CDP is denied on the external
> surfaces; the frame queue is unbounded; and this document was stale.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| N1 | BLOCKER | Startup minted a **new** host credential instead of loading the persisted one, so a restarted host and the extension held different secrets. | `fixed` |
| N2 | BLOCKER | The Agent's browser tools never reach the browser service. | `fixed` |
| N3 | MAJOR | The target selection is per surface, not per Agent run. | `fixed` |
| N4 | MAJOR | Full CDP is denied on the external surfaces. | `fixed` |
| N5 | MAJOR | The frame queue was unbounded. | `fixed` |
| N6 | MAJOR | This document set still said the bridge was not wired. | `fixed` |

### What was done

- **N1** — `BrowserBridgePairing.restore()` re-adopts the credential the store
  already holds, and `BrowserBridgeRegistry.restoreSurface` and
  `BrowserBridgeServer.restoreSurface` expose it. The browser service calls
  **restore** at startup and **enable** on a user toggle, and the two are
  different on purpose: a restart must not rotate the credential away from the
  one the extension still holds, while turning a switch off and on again must
  mint a fresh one. The switch-off path removes the credential from the store,
  so the next enable finds nothing to restore.
  `packages/webui/test/unit/browser-bridge-pairing.test.ts` — "keeps the
  credential the extension still holds when the host restarts" and "mints a
  fresh credential when the surface was switched off in between".
- **N1 (the pairing exchange)** — The host and the extension now share a
  credential. The extension generates an ephemeral P-256 ECDH key pair per
  connection and sends the public key in its `hello`; the host replies with a
  `pair` frame carrying the credential encrypted to it (ECDH → HKDF-SHA256 →
  AES-256-GCM) together with the host's own ephemeral public key, the HKDF
  salt and the ciphertext. The extension decrypts it, stores it in
  `chrome.storage.local` and answers the challenge with it. The secret never
  crosses the wire in the clear, and no person has to carry a code. Both sides
  pin the same derivation vector, so the two implementations cannot drift.
  The decision and its limits are recorded in the ADR's amendments.
- **N2, N3** — See above.
- **N5** — The stream keeps the **newest frame per target** and nothing else. A
  live stream pushes a frame per visual change, and a client that reads
  slowly would otherwise accumulate every one of them; a frame that is already
  superseded when it is read is not worth delivering.
- **N6** — `03-extension-admission.md`'s status table now states what the tree
  does: the bridge reaches the upgrade path, a session is registered on `ready`
  rather than on socket open, the switch drives the pairing, and a credential
  survives a host restart.

### What is still open, and why

**N2 — the Agent's browser tools now reach the service.**
`packages/webui/src/runtime/browser/tool-adapter.ts` implements
`LocalBrowserAdapter` over the browser service. `getCapabilities()` declares
exactly the restricted command set, and `execute` forwards the action to the
service, which reads the surface switch and the Full CDP gate — so there is
one place where the authorization is decided, and the tool path does not carry
a second notion of it. An action outside the restricted set is refused with
`browser_capability_denied` **even when Full CDP is on**, because the tool
path is the restricted path by construction.

The ordering problem was real: the runtime host takes the browser provider as
an *input*, and the browser service needs the host for the authorization
switches. The service is therefore constructed against a store that resolves
the host at read time, and the composition root attaches the host once the
runtime is assembled. A host that cannot answer the authorization leaves the
port absent, so the browser operations stay unregistered rather than bound to
a port that refuses everything.

**N3 — the selection is now scoped to the run.** The service's selection is
keyed by `(surface, runId)`, where the run is the Agent session id. The tool
path passes `ctx.sessionId`; the panel path sends the active run's session id
in the operation body, because the wire frame carries none. Two runs on the
same surface keep their own selections, each run's image stream shows its own
target's frames, and a run with no selection is refused rather than falling
back to another run's. The no-run selection is a named thing, not an empty
string, and it is what the panel shows when no run is active.

**N4 — Full CDP on the external surfaces.** The runtime gate is in place and
the isolated Chromium forwards a raw DevTools method, but the bridge provider
refuses every raw command, because `chrome.debugger` exposes only a subset of
the DevTools domains. The fix is a bounded bridge command frame and an
extension-side dispatch restricted to that subset, with an unsupported method
refused explicitly. It needs the same wire change as the pairing exchange, and
without a real Edge or Chrome to speak to, doing both at once would produce a
protocol that has never been exercised against a browser. **At the time of this
round it was not done.**

**N4 is now closed**, in the way round 2's F6 describes: the `cdp` /
`cdp-result` frame pair, and the extension's allowlist with an explicit
`unsupported` refusal for anything outside it. The evidence is in
[`10-browser-core-integration.md`](10-browser-core-integration.md) and in
[`02-bridge-protocol.md`](02-bridge-protocol.md).

## Round 4

> Verdict: the plan cannot be closed. The credential exchange and the run-scoped
> selection exist, but the panel's image stream stays attached to the target that
> was selected when the stream started, the Agent tool path has no connection to
> the surface the panel is showing, and the extension's allowlisted `Origin` does
> not authenticate an extension.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| N1 | BLOCKER | Admission trusts the `Origin` header to select an allowlisted extension id, and the host then encrypts its credential to the public key that peer supplies. A local process can spoof the allowlisted origin, supply its own key, decrypt the credential and answer the challenge. | `fixed` |
| N2 | MAJOR | Changing the selected target did not retarget the active image stream. | `fixed` |
| N3 | MAJOR | The Agent tool path silently used the isolated Chromium even when the panel was showing Edge or Chrome. | `fixed` |
| N4 | MAJOR | The published documents still said the tool adapter did not exist and that the host and the extension minted independent credentials. | `fixed` |

### N1 — the bridge is now authenticated by an installation key

This finding was a **design** gap rather than a defect, and the ADR's amendment **A2**
records the shape of the answer: the extension needs an **installation key** that a local
process does not have, and the exchange must be bound to it.

**What this round found.** The host selected the allowlisted extension id from the `Origin`
header, and then sealed its pairing credential to the **public key that peer supplied**,
and sent it. A local process can put any `Origin` on a loopback socket, so it could be
admitted as the allowlisted extension, supply its own ephemeral key, decrypt the
credential and answer the challenge. The exchange protected the credential **in transit**
and nothing more; it was not an authentication of the peer. Until the installation key
existed, the honest position was that the external surfaces were **not** safe against an
attacker who can reach loopback, and the switch that enables them should be understood as
enabling them for **the person's browser**, not as a boundary against a local process.

**What the tree does today.** The `Origin` header is now a **pre-filter**, not the
authentication decision:

- The host mints a 32-byte **installation key** per surface, keeps it in the OS secure
  store, and shows it in the WebUI Settings surface
  (`packages/webui/src/server/browser-bridge/server.ts:380`).
- The extension stores it in `chrome.storage.local`
  (`packages/browser-extension/src/pairing.ts:48`) and thereafter shows only a fingerprint.
- The handshake is **proof-first**: `hello` → `challenge` → `proof`, and only then, for a
  peer that proved the installation key, the sealed pairing credential
  (`packages/webui/src/server/browser-bridge/pairing.ts:270`,
  `verifyProof`; `packages/webui/src/server/browser-bridge/session.ts:652`).
- A peer that proves **only** a pairing credential the host already issued is admitted
  without a further credential. A peer that proves neither is refused and **receives no
  credential at all** — the `pair` frame is sent only to a peer that has proved the
  installation key.

Provisioning is explicit, and that is the deliberate cost: an unprovable peer identity
cannot be automated away. The automatic pairing ADR 0019 describes is automatic with
respect to **tabs**, not with respect to **peer identity**.

### A residual gap the N2 fix left behind — now closed

The panel used to open its image stream once per `(surface, runId)`. Opened
**before** the run had selected anything, the service refused it — which is
the required behaviour — and the panel then showed no live frames until the
surface or the run changed.

The subscription is now tied to the run's **selected target**: when the person
picks a target the stream opens, and when the run's target moves the previous
subscription is closed and a new one opened for the new target. The decision
is a pure function in the projection
(`selectWebuiBrowserStreamTarget` / `webuiBrowserStreamTargetKey`), so it is
tested without a DOM renderer — the client test environment has none.

### N2, N3, N4

- **N2** — The stream now follows the run's current selection: a selection
  change restarts the provider stream for the new target and stops the
  previous target's stream, so a screencast is not left running for a tab the
  person moved away from. The existing identity and generation fences still
  drop a frame that belongs to a superseded target.
- **N3** — The tool path no longer defaults to the isolated Chromium. It acts
  on the surface the **run** selected, and a run that has selected nothing is
  **refused** with a stable browser error code rather than being sent to a
  browser the person is not looking at.
- **N4** — The stale claims in this document and in
  `03-extension-admission.md` are corrected.

## Probe A — found by probing the real browser

No review round caught this one, because every test of the extension runs
against its **TypeScript source**. A probe against a real Chrome shows the
gap: the extension **registers** — the service worker is created and the
extension id is `ijoijfjbpmfdebiopnbodncfgdjmgjce` — but the manifest points
`background.service_worker` at `src/background/service-worker.ts`.

**A browser extension runtime executes JavaScript only.** The worker therefore
registers and then cannot run, and the extension as packaged cannot drive a
browser at all. The evidence is in
`.plan/browser-use/complete/extension-load-evidence.json`; the probe is
`.plan/browser-use/complete/probe-extension-load.mjs`.

The fix is a build step: bundle the extension's TypeScript to JavaScript and
point the manifest at the built output. Until that lands, every claim about
the external path is a claim about the **source**, not about a browser.

This is the kind of gap that only a real browser finds, and it is the reason
the programme's evidence says "not yet measured" for the external surfaces
rather than claiming they work.

## Probe B — the external path, against a real browser

A Playwright spec now drives a **real Chrome with the built extension loaded**
against a **real bridge server**: `packages/webui/test/browser/browser-bridge-real-browser.spec.ts`.

**What it proves.** An extension that cannot prove the installation key is
**refused**: the host reports the surface as configured and enabled but not
connected, and no credential crosses to the peer. That is the security property
that matters, and it is now established against a real browser rather than a
synthetic peer.

**What it now proves — both halves.** The happy path **passes**: the
extension completes the handshake once it can prove the installation key, and
the host reports the surface as connected. The refusal **passes**: the same
extension without the key is refused, and no credential crosses to the peer.

**The defect it found.** A Manifest V3 service worker is **lazy** — it starts
on an event and is torn down when it goes idle. Saving the installation key
did not wake it, so the extension sat there configured but unconnected, and the
options page told the person to *"Reconnect the extension to pair with the
host"* — a manual step that a person can get wrong and that nothing checks.
The options page now asks the worker to reconnect, and the worker answers.

**Both browsers.** Edge *is* installed on this machine
(`/usr/bin/microsoft-edge`, 151.0.4129.107) — an earlier note in this
document said otherwise, and that was wrong. The acceptance therefore runs
against **both** the bundled Chromium and the installed Edge, and all four
cases pass: the handshake completes in each, and an unprovisioned peer is
refused in each.

**What this means for the claims.** The external path is demonstrated working
against **two real browsers**, and the security property is demonstrated
against both. What is *not* established is Edge's DevTools domain parity with
Chrome's — ADR 0019 decision 6 forbids claiming identical CDP domains across
surfaces, and the extension's `chrome.debugger` subset was not dispatched
against a live tab. Ticket #193 stays open for that reason and for the store
builds, not because Edge is unavailable.

## Round 5

> Verdict: the plan is not closable. The real-browser test does launch both
> Chrome and Edge, but its bridge server enables the **Chrome** surface in both
> cases, so it does not establish independent Edge-surface acceptance. The
> published documents also still describe the bridge as unwired.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| N1 | MAJOR | The published documents contradict the current tree, and the review record contradicted itself about which browsers had been exercised. | `fixed` |
| N2 | MAJOR | The Edge browser test authenticated the **Chrome** surface, so the Edge switch, the Edge pairing credential and the Edge routing were never exercised. | `fixed` |

### What was done

- **N1** — The capability matrix, the bridge protocol and the extension
  admission document were reconciled against the tree: the bridge is wired, the
  Agent's tool adapter exists, and the measurement column says what was
  measured on which surface. The review record's own contradictory sentences
  about which browsers had been exercised were removed.
- **N2** — The acceptance is now parameterised by **surface**, not only by
  browser. The Chrome run is admitted on the `chrome` surface with the Chrome
  allowlist, and the Edge run on the `edge` surface with the Edge allowlist,
  and each asserts the matching surface's state. A single bug — reading the
  installation key from the wrong surface — was what the parameterisation
  exposed, and it is fixed.

## Round 6 — the external path, driven end to end in a real browser

The handshake acceptance proved that an extension can pair. It did not prove
that the **bridge** works — that a keystroke the host sends arrives in the page
the person is looking at, that the page's image reaches the host, or that a
DevTools command runs against the live tab. A new acceptance drives all three
through the real bridge, in real Chrome and real Edge, each on its own surface.

It found **four** defects, all of them real:

1. **The extension's frame parser had no `cdp` case.** A DevTools command was
   therefore rejected as an *unknown frame kind*, and the client closed the
   socket — which is why the first attempt reported "session closed before
   reply" rather than a refusal.
2. **A refusal was converted to a transport failure too early.** The session
   turned the extension's refusal into a terminal retry outcome, so the
   provider never saw it and the stable error code the contract promises never
   applied. A refusal is an **answer**, not a transport failure.
3. **The provider discarded the command's result**, so a caller had no way to
   read what the command produced.
4. **The extension could not capture the page at all.** `chrome.tabs.captureVisibleTab`
   requires the `<all_urls>` host permission or an `activeTab` permission
   granted by a user gesture on the page — and there is no gesture here, the
   host is asking for the picture. The permission is now declared, and the
   reason is recorded in the extension's README rather than left implicit.

### The worker's termination, exercised

The same acceptance now terminates the extension's **service worker** while an
image stream is running — the browser closes the worker's target, which is what
the browser does when it reclaims an idle worker. The host sees the session
drop, the worker is woken by the next event, and the bridge is usable again:
a DevTools command against the live tab answers afterwards.

That is exercised in both Chrome and Edge, so the bridge's survival across a
worker restart is no longer an assertion about the code's shape but an
observation of the behaviour.

## Round 7 — the final acceptance pass

This round was run by the implementer against the finished tree, against the
acceptance criteria the tickets state, rather than by a reviewer reading the
diff. It found five things; all five are closed.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| P1 | MAJOR | The **packaged production entry did not set `packaged: true`**. The bridge read the development allowlist in both composition roots, so a packaged host accepted development identities — the one thing the packaged build is for is refusing. | `fixed` |
| P2 | MAJOR | Four of the adversarial cases the acceptance names — an oversized frame, a malformed frame, a duplicate extension connection, and a revocation during an in-flight action — had **no test at all**. | `fixed` |
| P3 | MAJOR | The credential lifecycle ticket asks for "a test that observes a credential never appearing in captured log output". **No such test existed.** | `fixed` |
| P4 | MAJOR | The published documents still described the input, image and DevTools paths as exercised against a **synthetic peer**. They are exercised against a real browser. | `fixed` |
| P5 | MINOR | The acceptance was not **recorded**: no run wrote down the browser version, the operating system, the settings and the observed result. | `fixed` |

### What was done

- **P1** — `release/webui-npm/bin/mcode-webui.mjs` now passes `packaged: true`
  to the bridge, so the packaged entry reads
  `MAVIS_BROWSER_STORE_EDGE_EXTENSION_IDS` / `MAVIS_BROWSER_STORE_CHROME_EXTENSION_IDS`
  and never the development variables. The development entry
  (`scripts/run-webui-server.mjs`) is the one that reads the development
  allowlist. The difference is now **measured**, not asserted, and for **each**
  store: the new `real-packaged` suite builds the Chrome Web Store artifact
  and the Edge Add-ons artifact from the one shared source, loads each in its
  own browser, and shows that the id the browser assigns is the id the key
  determines, that the two builds differ in the manifest's `key` and nothing
  else, that a packaged host admits them through the store allowlist, and that
  the same packaged host refuses them when the id is named only in the
  development allowlist.
- **P2** — `packages/webui/test/unit/browser-bridge-adversarial.test.ts` drives
  all four cases against a real `ws` server and a real client. The host
  survives the first two, the earlier session is replaced rather than left
  alive beside the newer one, and the in-flight action fails rather than
  hanging.
- **P3** — `packages/webui/test/unit/browser-bridge-credential-secrecy.test.ts`
  runs the whole pairing with the console and both process streams captured,
  and watches the host's stored secrets in every form they could take — raw
  bytes, base64, hex. None of them appears in the output, and none appears in
  the frames the host sent: the credential travels sealed.
- **P4** — the paragraph above is the correction: the external path is driven
  end to end in a real Chrome and a real Edge, each on its own surface.
- **P5** — the suites now write an acceptance record as they run, and the
  published matrix is written from it. See
  [`09-acceptance-record.md`](09-acceptance-record.md).

## Round 8 — the seventh `codex` review, of the finished tree

The seventh `codex` review was run against the tree round 7 left behind, with
the instruction to attack the newest material hardest: the packaged host
wiring, the acceptance record, the acceptance matrix, the adversarial suite,
the credential-secrecy suite, the store builds and the published documents.
It raised six findings; all six are closed.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| Q1 | MAJOR | **A development extension identity could bind to the wrong browser surface.** The admission accepted an origin if *any* pairing admitted it and stopped at the first match, and the server repeated that first match. An unpacked build has one identity, and a person who loads it in Edge and Chrome lists that identity on both surfaces — so a Chrome browser landed on the Edge pairing, and the Edge surface reported connected while the person was looking at Chrome. | `fixed` |
| Q2 | MAJOR | **The packaged acceptance did not exercise the packaged entry.** It built a bridge with `packaged: true` in the test, which proves the option's behaviour but not that the shipped entry passes it. | `fixed` |
| Q3 | MAJOR | **The store disclosure understated the extension's access.** It said the extension "never reads the DOM, the cookies or the storage of a page", while the allowed DevTools set includes `DOM.getDocument`, `DOM.getOuterHTML`, `Runtime.evaluate`, `Accessibility.getFullAXTree`, `Network.getCookies` and `Network.getResponseBody`. | `fixed` |
| Q4 | MAJOR | **Four published status claims were stale** — the Agent's browser tools "not implemented", the bridge admission "unwired", the external image and input paths "exercised against a synthetic peer", and the MV3 worker restart "not verified". | `fixed` |
| Q5 | MINOR | **The acceptance records overstated the settings and could preserve a stale pass.** The switch states were written by the caller rather than read from the host, and the record file was emptied on the first *record*, so a run that failed during setup left the previous run's cases in place. | `fixed` |
| Q6 | MINOR | **The secrecy test missed some logged representations.** Console arguments were captured with `String(arg)`, which turns an object into `[object Object]` and a byte array into a comma-separated decimal list. | `fixed` |

### What was done

- **Q1** — the surface is now settled by the peer, not by the order the
  pairings happen to be in. The session holds the **candidate** pairings — the
  ones whose allowlist admits the peer's identity — and the peer's own `hello`
  names the browser it runs in; the pairing for that browser is the one that
  authenticates it, and the challenge is issued by that pairing
  (`session.ts`). A peer that names a browser the host does not know is
  refused with `unknown_browser` rather than attached to a pairing it does
  not belong to. The registry keys its live sessions by **surface and
  instance** rather than by instance alone, so one browser can no longer close
  another because they reported the same instance id. The acceptance now
  exercises the configuration the fix is about: one unpacked build, one
  identity, both allowlists, a real Chrome and a real Edge — each lands on
  its own surface (`browser-bridge-real-browser.spec.ts`), and the
  adversarial suite covers the unit-level case and the refusal
  (`browser-bridge-adversarial.test.ts`).
- **Q2** — the package verification now checks the **installed** package's
  bridge, not a bridge the test built. It starts the real `mcode-webui` from
  the installed archive, configures it with both allowlists, and shows that
  the store identity is admitted on its `/browser-bridge` path while the
  development identity is refused (`scripts/verify-webui-package.mjs`).
  The real-browser acceptance still drives a packaged host against a real
  browser, for the store identity and the handshake.
- **Q3** — `STORE-DISCLOSURES.md` now says what the extension can read: the
  DOM, the values of the page's JavaScript objects, its accessibility tree,
  its cookies and the bodies of its responses, and that whatever such a
  command returns goes to the loopback host. The claim that was wrong is
  gone; the claim that is true is stated.
- **Q4** — the four documents are corrected against the tree, and each row
  now says what the suite that measured it actually measured.
- **Q5** — the record's switch states are read from the bridge's own
  snapshot, and the two switches the bridge does not carry are named as such
  rather than guessed at. The record file is emptied at the **start** of a
  run, so a run that fails during setup leaves an empty file rather than the
  previous run's passes.
- **Q6** — the console capture renders each argument in every form it could
  carry the secret: a string as itself, a byte array as base64, base64url,
  hex and the decimal list, and an object as JSON with byte arrays expanded.
  The test also captures a secret it writes itself and asserts the capture
  finds it, so a capture that silently captured nothing cannot pass for the
  right reason.

## Round 9 — the eighth `codex` review, of round 8's fixes

The eighth `codex` review was run against the tree round 8 left behind, with
the instruction to attack the fixes themselves. It raised eight findings; all
eight are closed.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| R1 | MAJOR | **`hello.browser` is an unverified claim.** The review read the surface selection as trusting the peer's own name, and asked for the surface to be bound to a secret the peer cannot obtain through the other surface. | `fixed` — the binding already existed and is now stated and proved |
| R2 | MINOR | **A peer that never opens with a `hello` holds the socket indefinitely.** There was no deadline on the greeting. | `fixed` |
| R3 | MAJOR | **The server exposes one provider per surface while the registry allows several sessions on one surface.** With two browser instances on a surface, the provider described whichever connected last. | `fixed` |
| R4 | MINOR | **Target ownership omitted the surface from its key.** | `fixed` |
| R5 | MAJOR | **The store disclosure contradicted itself.** The new text said the extension can read the page, while the `<all_urls>` permission row and the privacy policy still said it does not and that it collects no personal data. | `fixed` |
| R6 | MAJOR | **Four more published status claims were stale** — the bridge admission "unwired" in two documents, the capability matrix's "one surface was measured", and the reconnect policy "unwired". | `fixed` |
| R7 | MINOR | **The acceptance record read the switch states before the case body ran**, so a change during the case would leave the record describing the state the case started in. | `fixed` |
| R8 | MAJOR | **The secrecy test checked only the `pair` frame, and replaced only five console methods.** A secret that leaked in another frame, or through `console.table`, would have passed. | `fixed` |

### What was done

- **R1** — the review was right that the **name** does not bind the surface,
  and wrong that nothing does. Each surface has its own **installation key**
  and its own **credential**, the challenge is issued by the pairing of the
  claimed surface, and the proof is verified against **that pairing's own
  secret**. A peer that calls itself Edge and answers the Edge challenge with
  the Chrome surface's installation key is refused, because the Edge pairing
  does not hold that key. The name selects *which* secret has to be proved; it
  cannot produce one. That is now stated in the code
  (`session.ts`, `#resolvePairing`) and **proved by a test**
  (`browser-bridge-adversarial.test.ts`, "refuses a peer that names a browser
  it cannot prove"), which answers the Edge challenge with the Chrome
  installation key and expects the refusal.
- **R2** — a session whose peer never opens is closed after fifteen seconds,
  the same window the operation deadline gives. The timer is cleared when the
  `hello` arrives and on teardown.
- **R3** — **a surface is one browser.** The host has one provider per
  surface, so a second live session would be a browser the host could not
  address. A *different* browser instance is now refused with
  "this browser surface is already served by another browser" rather than
  being allowed to take the surface away from the one that holds it. The
  **same** browser reconnecting is not a second browser — a Manifest V3
  worker that restarts reconnects, and the new connection has to be able to
  take over before the old socket's close has been noticed — so it still
  replaces its predecessor.
- **R4** — the ownership key carries the surface, and a command that names a
  target owned by the *other* surface is refused with the mismatch named,
  rather than as an unknown target.
- **R5** — the `<all_urls>` permission row and the privacy policy now say
  what the DevTools subset can read and that the host stores what it is
  given. The disclosure is for a store reviewer: a claim that understates the
  extension is worse than one that does not.
- **R6** — the four documents are corrected, and each row now says what
  measured it.
- **R7** — the record reads the switch states **after** the case body has
  run, so the record describes the state the observation was made in.
- **R8** — the secrecy test now checks **every** frame the host sent, and
  replaces eight console methods rather than five. It also asserts that the
  sealed credential is in the frame that carries it, so the check is about the
  sealing and not about a frame that never arrived.

## Round 10 — the ninth `codex` review, of round 9's fixes

The ninth `codex` review was run against the tree round 9 left behind, with
the instruction to attack the fixes themselves. It raised two findings; both
are closed.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| S1 | MAJOR | **The session declared a liveness ping and never sent one.** It held the pending-ping table, it answered a `pong`, and its own option comment said the session emits a `ping` — but no ping was ever written to the socket. A browser that was gone behind an open socket was therefore never noticed. | `fixed` |
| S2 | MAJOR | **The real-browser acceptance failed on a machine without the installed Edge.** The Edge cases drive `/usr/bin/microsoft-edge`, so a CI image or a container that does not ship Edge reported a broken bridge rather than an absent browser. | `fixed` |

### What was done

- **S1** — an admitted session now pings the peer every ten seconds and closes
  the session when the pong does not come within one interval. A WebSocket can
  stay open long after the browser behind it is gone: the extension's worker is
  terminated, the profile is closed, the machine sleeps. The socket's close is
  then the only signal, and it can take a while to arrive; the unanswered ping
  is the faster signal, and the extension's reconnect ladder picks the session
  back up. The close is transient at the system level — the peer's state lives
  in its own storage, so nothing is lost. The extension already answered a
  `ping` with a `pong`, so nothing on that side changed. The timer is cleared
  on teardown and does not hold the process open (`session.ts`,
  `startLiveness`).
- **S2** — the Edge cases now **skip with the reason** when the installed Edge
  is not on the machine, rather than failing on a browser that was never there
  (`real-browser-bridge.ts`, `isBrowserInstalled`). The bundled Chromium is
  installed by the gate itself, so the Chromium cases always run. The record
  names the browser each case ran in, and the published matrix names the host,
  so a skipped case is visible rather than silent.

## Round 11 — the tab model's review, of the tree the ten rounds left behind

This round was not run by an external reviewer. It was raised by a person asking the Agent to open a
browser and visit a page, and reading the refusal it produced. Four findings came out of that, and
all four are closed by the tab model ([ADR 0022](../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md)),
which is now in the tree.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| T1 | BLOCKER | **The Agent cannot create a selection, so it cannot act at all.** The tool adapter resolves the surface from the run's own selection and refuses with `browser_target_unknown` when the run has none, and the only writer of a selection is the panel. A person asking for a browser therefore got the same refusal for every action — `inspect`, `navigate` and `open_tab` alike — and `open_tab` was the one action that should have produced a selection. ADR 0019 required that both the user and the Agent can select a target; the tree carried half of it. | `closed` — `open_tab` is the one action a run with no selection may perform, because it is the action that would create the selection the gate wants (`packages/webui/src/runtime/browser/tool-adapter.ts:178`). The service opens the page and makes it the run's selection (`packages/webui/src/runtime/browser/browser-service.ts:1188`), and a person who opens a tab while the run has none gives the run that page as a documented bootstrap. Measured in a real Chrome — see [`09-acceptance-record.md`](09-acceptance-record.md), the rows "the Agent opens a tab" and "a person opens a tab while the run has no selection". |
| T2 | MAJOR | **`open_tab` created a page that nothing could address.** The isolated provider drives exactly one page and refuses every other target, so `Target.createTarget` produced a second page that the provider would not drive, would not stream, and would not accept input for. It appeared in the target list as a tab that did nothing when chosen. | `closed` — the provider holds one page per web tab, each with its own CDP session (`packages/webui/src/runtime/browser/isolated-chromium/provider.ts:249`), and `open_tab` attaches the page it creates and registers it (`packages/webui/src/runtime/browser/isolated-chromium/provider.ts:338`). Measured in a real Chrome — the rows "the Agent opens a tab" and "a second web tab in one session". |
| T3 | MAJOR | **The image stream was per run, so the person and the Agent could not be on different pages.** `watchFrames` resolved the run's selection and streamed that target, and the client dropped any frame that did not match it. A person opening another tab had no way to see it without moving the run's selection, which would have moved the Agent's work with it. | `closed` — the stream is keyed by the target (`packages/webui/src/runtime/browser/browser-service.ts:893`), and the run's selection and the tab the person is looking at are two cells with one writer each (`packages/webui/src/client/features/browser/contracts/browser-panel.ts`). Measured in a real Chrome — the rows "a person opens a tab while the Agent works" and "a person types into their own tab while the Agent works". |
| T4 | MINOR | **A page had no identity in the interface.** The panel was a view of a run's selected target, and that selection was invisible: a person moved it by clicking a chip inside the browser panel, and the Agent could not move it at all. | `closed` — a page has a name: the tab strip (`packages/webui/src/client/features/workspace/ui/WebuiWorkspaceTabStrip.public.tsx:231`) shows a row of tabs, and the runtime publishes the session's web tabs as a snapshot (`packages/webui/src/runtime/browser/browser-service.ts`). The strip opens a tab and the Agent opens a tab, each on its own side. Measured in a real Chrome — the row "the Agent opens a tab, and the strip gains it as the active tab". |

### What was done

This round is the reason [ADR 0022](../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md) was
written, and [ADR 0019 amendment A8](../adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md)
records the change to the panel's role. The decisions are settled **and** the tree carries them now:
the rules ADR 0022 pins are `implemented` in [`05-target-identity.md`](05-target-identity.md), each with
the file and the line that carries it, and the behaviour is measured in a real Chrome in
[`09-acceptance-record.md`](09-acceptance-record.md).

## Round 12 — the Browser Core integration, of the tree round 11 left behind

This round was not run by an external reviewer either. It came from the decision to align the WebUI's
browser semantics with the provider-neutral Browser Core that the TUI already drives, and from the
review of the change that did it. Four findings came out of it, and all four are closed in the tree.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| C1 | MAJOR | **The restricted action set was not executable on the isolated surface.** The provider translated a restricted action into a raw DevTools method, which cannot work for an action that takes an element reference: turning one into a coordinate needs the element map, the retained snapshot and the generation check. The provider had no element map, so it **refused** 21 of the 28 actions — including `inspect`, `query`, `click` and `type` — rather than guessing where a click should land. | `closed` — the restricted actions are executed by Browser Core on both surfaces, over a `BrowserTransport` adapter per surface. `packages/webui/src/runtime/browser/isolated-chromium/core-transport.ts`; `packages/webui/src/runtime/browser/isolated-chromium/provider.ts:829`. Proved against a real browser — `packages/webui/test/integration/browser-core-agent-actions.test.ts` drives `inspect` → `click` → `type`. |
| C2 | MAJOR | **The external surfaces could not execute the restricted action set at all.** The bridge provider had its own smaller action path — five of the 28 restricted actions (`navigate`, `reload`, `back`, `forward`, `get_dom`), each mapped to one DevTools command, with every other action refused rather than guessed at — and the actions it did have were implemented against the bridge's wire rather than against a shared definition of what the action means. | `closed` — the bridge runs the same restricted vocabulary through Browser Core, over the bridge's own transport. `packages/webui/src/server/browser-bridge/core-transport.ts`; `packages/webui/src/server/browser-bridge/server.ts:843`. `packages/webui/test/unit/browser-bridge-core-actions.test.ts`. |
| C3 | MAJOR | **`back` and `forward` on the bridge did not navigate.** The bridge's path asked the tab for its navigation history and answered with it — the page never moved. The isolated surface's `back` and `forward` worked, so the same action meant two different things on two surfaces. | `closed` — both surfaces now use Browser Core's `history` semantics, so the action reads the history and goes to the entry. `packages/browser-core/src/browser-actions.ts:245`; `packages/webui/test/unit/browser-bridge-core-actions.test.ts` |
| C4 | MAJOR | **The bridge could not take a screenshot of anything but the tab in front — and did not say so.** The extension's debugger exposes a restricted CDP subset that excludes `Page.captureScreenshot`, so a screenshot had no source on that path. | `closed` — the bridge takes its pictures from the extension's own pushed visible-tab frame, through the core's `captureScreenshot` hook, and refuses a screenshot of a tab that is not in front with `browser_capability_denied` rather than answering with another tab's picture. `packages/webui/src/server/browser-bridge/server.ts:939`; `packages/browser-extension/src/images.ts` |

### What was done

The layer itself is described in [`10-browser-core-integration.md`](10-browser-core-integration.md), and
the surface-specific consequences are in [`01-capability-matrix.md`](01-capability-matrix.md). Three
things are worth stating here because they are decisions rather than code:

- **The core's errors are the Agent's errors.** A stale reference, a missing element and a timeout are
  raised as they are, because the code they carry is what tells the Agent whether to inspect again,
  to pick another element, or to try something else. Flattening them into one failure would leave the
  Agent guessing.
- **The extension's allowlist grew from 26 to 45 commands**, with 19 new commands added to the DOM,
  Runtime, Accessibility, Network and Page domains, and with the **DOMSnapshot** domain introduced.
  Two commands stay out on purpose: `Page.captureScreenshot` and `DOM.setFileInputFiles`. The first
  would let the Agent photograph a tab the person is not looking at; the second would let it name an
  arbitrary local file in the user's real browser. The bridge therefore cannot complete
  `upload_files` — the action's method is refused as unsupported, which the bridge maps to
  `browser_capability_denied`. That is a **capability difference**, not a semantic one.
- **`upload_files` on the bridge is not pinned by a test.** The vocabulary test names the action, and
  nothing asserts the refusal. A future change to the allowlist would silently widen this surface.

## What this document does not establish

- That the external path works end to end against a real Edge or Chrome for
  **every** behaviour. The handshake, the refusal, the input, the image, the
  DevTools command and the worker's termination are established, each on its
  own surface — the `chrome` surface in Chrome and the `edge` surface in Edge.
  What was not established by **this** document's run is the **Agent's** path
  against a real browser, and the Full CDP switch through the runtime gate
  against a real browser: the bridge carries the command and the extension's
  allowlist refuses what is not in it, which is a different thing from the
  runtime switch. The Agent's path is established by the tab model's own run —
  see [the workspace browser tab model's acceptance](09-acceptance-record.md#the-workspace-browser-tab-models-acceptance).
- That the macOS, Windows or Linux credential-store forms behave as intended.
  The Linux form was probed on one host and was **unavailable** there; the
  macOS and Windows forms are asserted through an injected command runner, not
  executed.
- That the store identities exist. A store assigns them when the extension is
  first published, so the packaged acceptance uses a key generated at run time.
- That the Agent's browser tools address the same session as the panel **in a
  real browser**. The tool adapter exists and forwards to the same service, and
  which *surface* a tool call acts on is resolved from the run's own selection
  rather than from a default, so a run that has selected nothing is refused
  rather than being sent somewhere the person is not looking. That path is
  reachable now — round 11's T1, T2 and T3 closed the three things that made it
  unreachable — and the tab model's own run exercises it end to end against a
  real Chrome: the Agent's `open_tab` opens a page, the run's selection points
  at it, the strip gains it, and the Agent's next action lands on the page it
  opened
  ([`09-acceptance-record.md`](09-acceptance-record.md#the-workspace-browser-tab-models-acceptance)).
  What that run does **not** establish is the same path on the **external**
  bridge's surfaces: the rounds above drove the chrome and edge surfaces
  through the bridge, and the tab model's run drove the isolated surface
  through the runtime.
