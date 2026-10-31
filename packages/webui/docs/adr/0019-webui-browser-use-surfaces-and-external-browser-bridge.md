# WebUI Browser Use surfaces and external browser bridge

**Status:** Product and distribution decisions accepted; implementation pending.
**Date:** 2026-10-20.

WebUI Browser Use will support two browser surfaces: an isolated browser presented in a WebUI
browser panel, and a user's already-running, logged-in Edge or Chrome browser. The external browser
surface will be controlled through a browser extension. Do not require the user to enable remote
debugging or manually discover a CDP endpoint as the product path. The extension route still requires
the user to install the extension and grant its browser permissions; it does not imply silent
installation or permission bypass.

The person using WebUI and the Agent can both operate the selected browser session. The panel shows
the browser through a live image stream and forwards user input; it is not an iframe into the target
site. Browser tools and the panel must address the same underlying session so that actions and the
visible page state stay aligned. The existing isolated-Chromium MVP is evidence for this panel
interaction shape only; its temporary profile and synthetic-page measurements do not establish
support for a logged-in external browser.

For external browsers, each Agent run/TUN owns its target selection; one run's selection must not
overwrite another run's target. The Agent may choose a different authorized tab each turn. The panel
follows the target of the active/focused Agent run, and the Agent must reacquire page elements after
switching tabs because references belong to the prior page. Concurrent operations against the same
tab are serialized; operations against different tabs may proceed independently. If the extension
disconnects during an operation, retry connection for at most 15 seconds using exponential delays of
250 ms, 500 ms, 1 s, 2 s and 4 s (capped at 5 s, with jitter). When that operation's deadline expires,
return an explicit error and do not replay an operation whose execution is uncertain. Keep the
selected target. While the browser switch remains enabled, background reconnection continues with
backoff capped at 30 seconds until the extension reconnects or the user disables that browser. Never
silently switch to another tab, TUN, browser or isolated surface.

Browser Use remains a host-owned runtime capability with explicit configuration, not a WebUI plugin.
Settings will expose three independent browser-surface authorization switches: one for the isolated
browser, one for Edge, and one for Chrome. All default to off. Enabling the Edge or Chrome switch automatically
pairs with that browser's installed extension and authorizes all of its tabs without per-tab
confirmation. Each browser's enabled state and authorization survive WebUI and browser restarts, and
its extension reconnects automatically until the corresponding switch is turned off. Turning a
browser's switch off immediately revokes that connection and invalidates that browser's saved
pairing credential. Turning it on later automatically establishes a fresh pairing without a second
user confirmation. The extension's browser permission and each WebUI browser switch are independent
gates. Each browser receives a distinct high-entropy pairing credential. Store WebUI-side credentials
in the operating system's secure credential store and extension-side credentials in that extension's
local extension storage. Pairing proves possession through a challenge-response exchange; credentials
are not written to logs and are never replaced by the per-start WebUI connection token. Turning a
browser switch off revokes the server credential, closes active sockets and rejects every copy of the
old credential; turning it on creates a fresh credential and pairs automatically. If the operating
system secure store is unavailable, report an explicit pairing failure rather than writing the
credential in plaintext. The runtime has a provider adoption seam, and both the
development server entry (`scripts/run-webui-server.mjs`) and the
packaged entry (`release/webui-npm/bin/mcode-webui.mjs`) now adopt a browser provider: the one
binding carries both the browser session the panel shows and the Agent's browser tools, so the two
cannot end up on different browsers. The Agent's control of that session arrives through the Browser
Use Plugin's host binding rather than through either entry. Both entries still run with `dev: true`.
The dedicated
extension pairing/admission path must validate its pairing credential and browser authorization
independently of generic development-mode checks; a development-mode bypass must not bypass extension
admission.

Settings will also expose a separate **Full CDP access** switch, default off. This is a global,
persistent authorization for the Agent to use all CDP domains and commands supported by the active
browser provider, including advanced diagnostic and sensitive browser-internal capabilities. When
the switch is off, ordinary Browser Use remains available through its restricted command set, while
full-CDP-only capabilities are denied. Turning the switch on is the user's explicit authorization;
there is no additional per-command approval. The browser's own extension permission and its
corresponding browser switch remain required, so Full CDP access does not enable a browser surface
that is otherwise disabled or unavailable. Turning the switch off blocks further full-CDP calls and
ends full-CDP-only streams; it does not disable ordinary Browser Use on an enabled surface.

"All CDP capabilities" means all commands the selected browser and provider actually expose; it
does not claim that Edge, Chrome, and isolated Chromium implement identical CDP domains. Capability
availability and unsupported-command errors must be surfaced accurately.

The browser extension is the chosen control mechanism for external Edge and Chrome, and it will
connect to the WebUI runtime through a loopback WebSocket after pairing. Native Messaging was
considered but not selected because it adds a registered native host and OS-specific installation
and packaging. The existing WebUI WebSocket admission accepts loopback HTTP(S) origins plus the
WebUI token; it does not admit a `chrome-extension://` origin. The extension therefore needs a
dedicated, authenticated pairing/admission path. Do not broaden the existing origin check to accept
arbitrary extension origins.

The alternatives considered were requiring users to launch or configure a remote-debugging endpoint,
limiting the first product version to the isolated browser, and using Native Messaging to reach the
WebUI runtime. The extension path avoids requiring manual remote-debugging setup while allowing
control of the user's existing logged-in browser; it requires extension installation, browser
permission, pairing and lifecycle handling as specified below.

## Extension installation and distribution decisions

During development, install an unpacked extension build locally in the browser's developer mode.
For user distribution, publish a Chrome build through the Chrome Web Store and an Edge build through
Microsoft Edge Add-ons, generated from the same source package but submitted as separate store
artifacts. Include `packages/browser-extension/` in this repository's public-source projection and
register it through the normal workspace and source-inventory process. Validate each store build's
exact extension identity at the bridge; development identities are explicit development
configuration and are not accepted by packaged builds.

Store publication is a separate release action; local implementation and acceptance do not publish
either artifact. Chrome Web Store publication requires a developer account, agreement to its terms,
a one-time registration fee and two-step verification. Initial submissions and updates are reviewed;
sensitive permissions can require manual review. The Edge Add-ons submission uses a Partner Center
developer account with no registration fee; company accounts require company verification. Both
stores require accurate purpose, permission and data-use disclosures. Since this extension accesses
browser page data, its listings and privacy policy must explain the data flow to the local WebUI and
limit handling to the stated Browser Use function.

## Business and source layout decisions

Browser Use is a distinct WebUI client business because it owns browser target state, authorization
and connection projections, browser commands, and the shared target state used by the Agent and
browser panel. Its client modules live under `packages/webui/src/client/features/browser/`, using
only the role directories required by the feature. Settings and workspace surfaces consume the
Browser business through its published contracts; they do not own parallel browser state. Server,
shared-contract and runtime code remain in their respective WebUI layers rather than being pulled
under the client feature directory.

The Edge/Chrome extension source lives in the independent workspace package
`packages/browser-extension/`. The extension has a separate browser execution context, manifest,
permission set, build target and verification surface, so it is not nested under the WebUI client
business. It communicates with the WebUI through the bridge protocol; it does not import WebUI
client or Node runtime implementation modules. Adding this package requires the repository's normal
workspace and source-scope registration. Its public-source inclusion and store distribution are
decided above.

## Resolved implementation decisions

The six questions raised during plan review are resolved as follows. This ADR remains the sole
Browser Use decision record. The implementation plan contains work sequence and acceptance criteria,
not a duplicate question or decision list.

1. **Installation and distribution:** use unpacked development installs and publish separate Chrome
   Web Store and Edge Add-ons artifacts from the shared source; include extension source in the public
   source projection.
2. **Pairing credentials:** use unique high-entropy credentials per browser, OS secure credential
   storage in WebUI, extension local storage in the browser, challenge-response pairing, rotation on
   re-enable and immediate revocation on disable. Fail explicitly if secure storage is unavailable.
3. **Reconnect:** use the 15-second operation deadline and exponential retry schedule defined above;
   fail the in-flight operation without uncertain replay or target fallback, while background
   reconnect continues as long as the browser switch remains on.
4. **Routing:** scope target selection to Agent run/TUN, preserve independent targets across concurrent
   runs, serialize operations per tab, permit independent tabs to proceed, and show the active run's
   target in the single Browser panel.
5. **Tab discovery and presentation:** show every tab the enabled extension can access, with browser,
   title, URL, connection status and active Agent-run indicator. Both user and Agent can select a
   target. Unsupported or policy-blocked targets are reported as unavailable; no per-tab authorization
   prompt is added.
6. **CDP capability parity:** ordinary Browser Use uses the restricted command set; Full CDP access
   exposes all commands the active provider actually supports. Maintain a per-browser/provider
   capability matrix, return explicit unsupported-command errors and never silently fall back. Chrome
   extension limitations, including restricted CDP domains and frame/session behavior, are technical
   validation targets, not a promise of full Chrome DevTools parity.

Settings must guide users to install the correct store build when a browser extension is absent and
explain missing browser permissions. These decisions do not remove the separately established
default-off browser switches or Full CDP authorization.

## Remaining technical validation

There are no unresolved product decisions from the six questions above. WP0 must still verify
supported browser/API versions, the capability matrix, credential-store integration, MV3 worker
recovery, and the bridge protocol against the actual implementation seams. A failed technical
assumption must be reported and any product-direction change recorded here before implementation
proceeds.

The Chrome and Edge API compatibility findings, loopback-origin constraint, and technical sources
supporting these decisions are kept here with the decision record.

### Research findings

- Microsoft Edge lists the `debugger` extension API for Manifest V2/V3 on Windows, Linux and macOS.
  It supports attaching to multiple tabs and routes commands by `tabId`
  ([Edge extension API support](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)).
- Chrome documents that active WebSocket connections extend Manifest V3 service-worker lifetime
  starting with Chrome 116. The worker can still terminate and restart, so the extension must support
  reconnection
  ([Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
- Chrome requires host permissions for extension service workers to make cross-origin requests to
  the loopback WebUI service
  ([Chrome cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)).
- The current WebUI WebSocket admission checks loopback Host, permits only loopback HTTP(S) Origins,
  and validates the per-start WebUI token (`src/server/access-policy.ts`). A `chrome-extension://`
  Origin is rejected, and that token changes on every service start (`src/server/credentials.ts`).
- Native Messaging starts a registered host process and requires an OS-specific host manifest and
  extension origin allowlist in both Chrome and Edge
  ([Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
  [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging)).
- Chrome's `chrome.debugger` exposes only a supported subset of CDP domains and requires the
  `debugger` extension permission; its domain list and frame/session behavior constrain what an
  extension provider can offer
  ([Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)).
- Chrome Web Store publishing requires developer registration, a one-time fee and two-step
  verification; each new submission/update is reviewed, with manual review possible for sensitive
  permissions
  ([registration](https://developer.chrome.com/docs/webstore/register/),
  [review status](https://developer.chrome.com/docs/webstore/check-review),
  [program policies](https://developer.chrome.com/docs/webstore/program-policies/policies?hl=en)).
- Microsoft Edge Add-ons uses Partner Center; developer registration has no fee, while company
  accounts require company verification and submissions go through certification
  ([developer account registration](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account),
  [publishing](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)).
- Chrome Web Store user-data policy requires accurate disclosures and a privacy policy when the
  extension handles user data; permission requests should be limited to the extension's stated
  functionality
  ([Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies/policies?hl=en)).

The two handoff documents supplied during this decision review record the MVP behavior and earlier
WebUI research. They are research records, not implementation evidence. Current implementation
claims must be checked against the source.

## Amendments

Implementation and the review rounds recorded in
[`../browser-use/07-review-findings.md`](../browser-use/07-review-findings.md)
raised questions the original text did not settle. These are the answers,
recorded here because they change how the bridge is built rather than only how
it is documented.

### A1 — How the extension obtains the host's pairing credential

The decision above says pairing is automatic: enabling a browser's switch pairs
the browser's installed extension without per-tab confirmation. It does not say
how the two sides come to hold the same secret, and the first implementation
left that open — the host minted a credential and the extension minted a
different one, so the handshake could never complete.

The answer is a **credential exchange over the existing socket**, with the
credential encrypted to a key the extension generates for that connection:

- The extension generates an **ephemeral** ECDH P-256 key pair when it
  connects and sends the public key in its `hello` frame. Nothing about the
  key is stored, so there is no long-term key to manage, rotate or leak.
- The host, when the surface's pairing is enabled and the extension's id is on
  the surface's allowlist, encrypts the credential to that public key and
  sends it in a `pair` frame: ECDH P-256, then HKDF-SHA256, then AES-256-GCM.
  The secret never crosses the wire in the clear.
- The extension decrypts it, stores it in `chrome.storage.local`, and answers
  the challenge with it.

This keeps the "automatic" property: there is no code for the person to
carry and no options page to configure. The alternative — a one-time pairing
code the person copied from the host into the extension — was considered and
rejected, because it puts the credential in the clear on the wire and adds a
surface the person has to use correctly.

**What this does not establish — and it is not a small gap.** The extension's
identity is established by its origin being on the allowlist, and a local
process can put any `Origin` header it likes on a loopback socket. The host
then seals the credential to the public key *that peer supplied*. A local
process can therefore be admitted as the allowlisted extension, supply its own
ephemeral key, decrypt the credential and answer the challenge.

The exchange protects the credential **in transit** and nothing more. It is
**not** an authentication of the peer, and the bridge must be treated as
**unauthenticated against anything that can reach loopback** until a stronger
anchor exists. The switch that enables an external surface enables it for
**the person's browser**; it is not a boundary against a local process.

The stronger anchor is an **installation key** the extension holds and a local
process does not: provisioned when the extension is installed and configured,
proved during the exchange, and bound to the key the credential is sealed to so
that only a peer that has already proved possession of it can receive one. The
native-messaging route this record's research findings already list is the
other candidate, and it has the same property — a registered host process,
rather than a spoofable `Origin` header.

This is recorded here as an open product decision rather than left implicit,
because the gap is a security boundary and not a detail of the implementation.

### A2 — The peer is authenticated by an installation key, not by its `Origin`

**Supersedes the limitation A1 recorded.** Admission still selects the
allowlisted extension id from the `Origin` header, but that is now a
**pre-filter**, not the authentication decision. A peer must prove possession of
the surface's **installation key** — a long-lived secret held in the OS secure
store on the host and in `chrome.storage.local` in one browser — before the
host will release a pairing credential.

- The host mints a 32-byte installation key per surface, stores it in the OS
  secure store, and shows it in the WebUI Settings surface. The person pastes
  it into the extension's options page once; the extension stores it and
  thereafter shows only a fingerprint.
- The handshake is **proof-first**: `hello` → `challenge` → `proof` → and only
  then, for a peer that proved the installation key, the sealed pairing
  credential. A peer that proves only a pairing credential the host already
  issued is admitted without a further credential. A peer that proves neither
  is refused and **receives no credential at all**.
- The installation key is **not** destroyed when a surface is switched off: it
  is bound to the browser, not to the switch, so the person does not have to
  provision again after a toggle.

Provisioning is explicit, and that is the deliberate cost. An unprovable peer
identity cannot be automated away: the automatic pairing this record describes
is automatic with respect to **tabs**, not with respect to **peer identity**. The
alternative — native messaging — has the same property and is the other
candidate; it is recorded in the research findings below.

### A3 — What "the enabled state survives a restart" means for the credential

The decision above says each browser's enabled state and authorization survive
WebUI and browser restarts. The first implementation read that as "the switch
is still on" and minted a **fresh** credential on every start, which quietly
contradicted the first half of the sentence: the extension still held the old
secret, so the two could not talk.

The answer is that the two paths are different on purpose:

- **Startup restores.** The host re-adopts the credential the OS secure store
  already holds, because the extension kept its copy across the restart.
- **A user toggle rotates.** Turning a switch off revokes the credential and
  removes it from the store, so the next enable finds nothing to restore and
  mints a fresh one. This is the "turning it on later establishes a fresh
  pairing" behaviour the decision above asks for.

### A4 — The target selection is scoped to the Agent run

The decision above says the Agent run owns the target selection and the panel
follows the active run's target. The first implementation held one selection
per surface, which is a host-wide selection: two runs looking at different
tabs of the same browser would fight over it, and the panel would show
whichever selection was written last.

The selection is therefore carried by the run that made it. What the panel
shows when no run is active — the last selection the run made, or nothing — is
a product decision that the implementation records rather than guessing.

### A5 — The surface is settled by the browser, and bound to that surface's own secret

The decision above treats a surface as a browser. The first implementation
mapped a peer's **extension identity** to a surface, taking the first pairing
whose allowlist admitted it. That is wrong for the development configuration
the decision asks for: an unpacked build has one identity, and a person who
loads it in both Edge and Chrome lists that identity on both surfaces. The
first match won, so a Chrome browser landed on the Edge pairing — the Edge
surface reported connected while the person was looking at Chrome, and the
Chrome surface never came up at all.

The peer therefore names the browser it runs in, and the host answers with the
pairing for that browser. The name is not the authority: each surface has its
own installation key and its own credential, the challenge is issued by that
surface's pairing, and the proof is verified against that pairing's own
secret. A peer that calls itself Edge and answers with the Chrome surface's
installation key is refused. The name only selects *which* secret has to be
proved; it cannot produce one.

### A6 — A packaged host accepts store identities and never development ones

The decision above says the extension comes from a store, so the identity is
the one the store issues. The first implementation had a packaged host and a
development host in the source and no rule connecting them: both composition
roots built the bridge the same way, so a released WebUI accepted whatever
unpacked extension happened to be present. An unpacked build's identity is
derived from the directory it was loaded from, so it is not an identity anyone
can rely on.

A packaged host now reads the store allowlist and never the development one.
The development entry reads the development allowlist, because that is where
the identities of unpacked builds belong. A store identity is still an
ordinary configuration value: an operator who runs the packaged entry against
a locally built extension names that extension's identity explicitly, in the
store variable.

### A7 — A surface is one browser

The decision above has one panel per surface, and the Agent's tools act on the
surface the run selected. The bridge exposed one provider per surface, so a
second live session on that surface would be a browser the host could not
address: its tabs were announced into a table the provider did not read.

A surface therefore serves one browser. A *different* browser instance
connecting to a surface that is already served is refused with a reason,
rather than being allowed to take the surface away from the one that holds
it. The **same** browser reconnecting is not a second browser: a Manifest V3
worker that restarts reconnects, and the new connection has to be able to
take over before the old socket's close has been noticed.

### A8 — The panel shows the person's tab; the run's selection is a separate cell

The decisions above say that the panel follows the target of the active
Agent run, and that both the user and the Agent can select a target. The
implementation carried the first and refused the second: the panel was a
view of a run's selected target, and the only writer of that selection was
the panel's own target list. A run that had never selected anything could
not act at all — not even `open_tab`, which is the action that would have
given it a selection. A person asking the Agent to open a browser got
`browser_target_unknown` for every action.

[ADR 0022](./0022-webui-workspace-panel-is-a-browser-tab-strip.md) replaces
the single Browser panel with a per-session browser tab strip, and it
separates the two things the earlier text had merged:

- The **run's selection** is the page the Agent acts on. The Agent creates it
  with `open_tab`, which opens a page, makes it the run's selection, and
  tells the client so the tab appears in the strip. The panel does not write
  this cell, and the rule that a run with no selection is refused rather than
  given a page nobody chose still stands for every other action.
- The **tab the person is looking at** is the page the person sees and types
  into. Activating a tab and choosing a launcher tile are panel actions.

The two may name different pages at the same time, and the frame stream
becomes per target so that each tab's picture is its own. A person browsing
their own tab therefore does not move the Agent off its page, and the Agent
opening a tab does not yank the person away from theirs.

The external browsers are not changed by this amendment: the extension bridge, the pairing and
the credential store are untouched, and a switched-on surface still authorizes the Agent's commands.
What is removed is the browser tool tab, with the panel it belonged to, and with it the surface
switcher. That switcher was the panel's way of reaching Edge and Chrome, and the panel was never
where those browsers are driven: they are driven in the user's own windows, where the person sees
them. The panel is the isolated browser's view, and it stays that.

### A9 — The browser's action semantics belong to a peer package

The decision above says Browser Use owns "browser commands". That remains true of the
**command path** — the WebUI decides which commands may run, on which surface, against which
target, and it answers the client. It is no longer true of the **semantics** of those commands.

The isolated-Chromium provider answered a restricted action by translating it into a raw
DevTools method. That works for an action one CDP call wide and cannot work for an action
that takes an element reference: turning a reference into a coordinate needs the element map,
the retained snapshot and the generation check, and the provider had no element map. The
honest response was to **refuse** 21 of the 28 restricted actions — including `inspect`, `query`,
`click` and `type` — rather than guess where a click should land. The vocabulary said `click`; the
surface could not do it.

The semantics now live in `@mavis/browser-core` (`packages/browser-core/`), a peer package
the TUI already drove:

- **Browser Core owns what an action means** — element references, retained snapshots, action
  deadlines, effect validation — and reaches a browser through a `BrowserTransport`.
- **The WebUI owns whether an action may run.** The core reads no authorization switch, and
  the surface's own fences (`return_to_previous_tab` on the isolated surface, `open_tab` and
  an off-screen `screenshot` on the bridge) are facts about the browser rather than policy.
- **A transport carries a command; it never judges one.** The WebUI supplies one adapter per
  surface: `runtime/browser/isolated-chromium/core-transport.ts` and
  `server/browser-bridge/core-transport.ts`.

Three consequences follow, and they are the shape of the decision:

- `src/client/` and `src/shared/` may not import the core. The browser bundle must not carry
  a second, unreachable copy of the semantics, so the restricted vocabulary is stated in
  `src/shared/contracts/browser.ts` as well, and a test asserts the two lists cannot drift.
- **A capability difference is not a semantic difference.** The bridge cannot `upload_files`,
  because `DOM.setFileInputFiles` is deliberately absent from the extension's allowlist: the
  extension's debugger could run it, but what it must not do is give the Agent a way to name
  an arbitrary local file in the user's real browser. The isolated Chromium performs the same
  action with the same semantics.
- **The bridge's screenshot comes from the extension's pushed visible-tab frame**, not from
  `Page.captureScreenshot`, which could photograph a tab the person is not looking at. A tab
  that is not in front is refused rather than answered with another tab's picture.

The mechanism is described in
[`../browser-use/10-browser-core-integration.md`](../browser-use/10-browser-core-integration.md).
