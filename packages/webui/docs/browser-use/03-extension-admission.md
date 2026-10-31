# The dedicated extension admission path

**Status:** This document mixes three kinds of statement, labelled inline:

| Label | Means | Backed by |
| --- | --- | --- |
| `implemented` | The source enforces this today; the row names the file and line. | The cited file in this repository |
| `required` | A rule the contracts pin with no enforcing code at that point. | `packages/webui/src/shared/contracts/browser-bridge.ts` |
| `not yet measured` | An open question. Not a denial and not a promise. | Nothing |

**The admission function is wired and exercised.** `admitBrowserBridgeUpgrade` is implemented in
`packages/webui/src/server/browser-bridge/admission.ts` and the server's upgrade dispatcher
(`packages/webui/src/server/websocket-server.ts`) branches on `/browser-bridge` **before** the generic
`admitWebSocketUpgrade`, so a bridge request never reaches the generic path and the generic path is
unchanged. A real Chrome and a real Edge have connected and been refused through it — see
[`07-review-findings.md`](07-review-findings.md).

## Why a dedicated path

The WebUI already admits WebSocket upgrades, in `admitWebSocketUpgrade`
(`packages/webui/src/server/access-policy.ts:51`). That function cannot admit an extension:

- **The origin check rejects it.** `isAllowedOrigin` (`access-policy.ts:119`) parses the origin and
  returns `false` unless the protocol is `http:` or `https:` and the hostname is `127.0.0.1` or
  `localhost`. A `chrome-extension://` origin fails the protocol test at `access-policy.ts:127`.
- **The credential it expects is the wrong one.** `admitWebSocketUpgrade` reads a `token` query
  parameter and checks it against the per-start WebUI credential. That credential is a fresh
  `randomUUID()` for every service start (`createWebuiCredential`,
  `packages/webui/src/server/credentials.ts:19`). An extension installed once cannot learn a value
  that changes on every restart, and ADR 0019 forbids replacing the pairing credential with it.

So the extension cannot be admitted by the existing path, and the existing path must not be widened to
admit it. The bridge gets its own admission.

## The generic path, quoted exactly

For reference, this is the rule the dedicated path must not inherit. From `admitWebSocketUpgrade`
(`packages/webui/src/server/access-policy.ts:51`):

| Step | Check | Refusal |
| --- | --- | --- |
| 1 | `Host` header is present and its host part is loopback (`127.0.0.1`, `localhost`, `::1`, `[::1]`) | `403 Forbidden Host` |
| 2 | The URL hostname is `127.0.0.1` or `localhost` | `403 Forbidden Host` |
| 3 | If an `Origin` is present, it is a loopback HTTP(S) origin | `403 Forbidden Origin` |
| 4 | The `token` query parameter matches the per-start credential — **unless `dev` is true** | `401 Unauthorized` |

Refusals are written by `rejectUpgrade` (`access-policy.ts:83`) as a bare HTTP status line followed by
`Connection: close`.

## The `dev: true` bypass, and why it must not apply here

Step 4 is skipped entirely when `context.dev` is true. The condition at
`packages/webui/src/server/access-policy.ts:76` reads:

```ts
const presented = url.searchParams.get("token");
if (!context.dev && !credentialMatches(context.credential, presented)) {
  rejectUpgrade(socket, 401, "Unauthorized");
  return false;
}
```

**`dev: true` disables the credential check, not just the token requirement.** That is a real bypass,
and it is the current state of both composition roots:

| Entry point | Line | `dev` | Bridge allowlist |
| --- | --- | --- | --- |
| `scripts/run-webui-server.mjs` | 56 | `dev: true` | development — `MAVIS_BROWSER_EDGE_EXTENSION_IDS`, `MAVIS_BROWSER_CHROME_EXTENSION_IDS` |
| `release/webui-npm/bin/mcode-webui.mjs` | 48 | `dev: true` | **store** — `MAVIS_BROWSER_STORE_EDGE_EXTENSION_IDS`, `MAVIS_BROWSER_STORE_CHROME_EXTENSION_IDS` |

So on a packaged WebUI today, the generic path already accepts any upgrade that passes the loopback
Host, URL-host and origin checks **without presenting the token at all**. ADR 0019 already records that
both entries run with `dev: true`.

**The two entries differ in one more way, and it is the one that matters here.** The packaged entry
passes `packaged: true` to the bridge, so it reads the **store** allowlist and never the development
one. An unpacked build's id is derived from the directory it was loaded from, so it is not an
identity anyone can rely on; a packaged host that accepted those ids would admit whatever unpacked
extension happened to be present. The development entry is the one that reads the development
allowlist, because that is where the ids of unpacked builds belong. The distinction is measured
against a real browser in [`09-acceptance-record.md`](09-acceptance-record.md): the id a store build
gets is the one its public key determines, a packaged host admits that id, and the same packaged host
refuses it when the id is named only in the development allowlist.

**`implemented`: the bridge admission path never reads `dev`.** The pairing proof is verified
unconditionally, and the browser switch is checked unconditionally. `admission.ts:135` holds an
explicit no-op `if (context.dev)` branch whose only purpose is to make the absence of a bypass
reviewable: adding `return undefined` inside it would short-circuit every check below it, and the
branch's comment says so. That is a contract marker, not an enforcement mechanism — the enforcement is
that no such early return exists.

The three requirements stand as written:

- Extension admission does not consume `context.dev` as authority to skip a check. There is no `dev`
  parameter on it and no branch inside it that grants anything.
- Pairing proof is verified unconditionally. There is no mode in which the bridge accepts a socket
  without a valid proof.
- Browser authorization is checked unconditionally. A `dev: true` WebUI does not admit an extension
  for a browser whose switch is off.

Turning a development bypass into a way to control somebody's logged-in browser would defeat the
purpose of the whole pairing design. The exemption is scoped to the generic WebUI path and stays there.

## Admission checks and refusal statuses — what the function does

The order matters: cheap structural checks first, then identity, then the credential, then
authorization. This table is `implemented` and transcribed from `admission.ts:81` and `pairing.ts`:

| # | Check | Source | Refusal returned |
| --- | --- | --- | --- |
| 0 | The upgrade URL parses | `admission.ts:89` | `400 Bad Request` |
| 1 | Request path is exactly `/browser-bridge` (`WEBUI_BROWSER_BRIDGE_PATH`) | `admission.ts:95` | `400 Bad Request` |
| 2 | `Host` header host part is loopback (`isLoopbackHost`) | `admission.ts:102` | `403 Forbidden Host` |
| 3 | URL hostname is `127.0.0.1` or `localhost` | `admission.ts:107` | `403 Forbidden Host` |
| 4 | `Origin` is a `chrome-extension://<id>/` URL **and** some pairing's allowlist admits that id | `admission.ts:114`, `admission.ts:128` | `403 Forbidden Origin` |
| 5 | A challenge has been issued and the presented `proof` verifies: `keyId` matches, `nonce` matches, the algorithm is the issued one, and the signature compares equal | `pairing.ts`, via `verifyWebuiBrowserBridgeProof` (`contracts/browser-bridge.ts:323`) | closed with `reason` |
| 6 | The switch for the browser named in `hello` is on, and a current credential exists for it | `pairing.ts:175` | closed with `reason` |

**Check 4 is a pre-filter, not the authentication decision.** The `Origin` header is
writable by any local process, so it says which extension *claims* to be connecting — it does
not say who is connecting. What authenticates the peer is the **proof**, and a peer that
proves the surface's **installation key** is the only one the host will release the pairing
credential to (`pairing.ts:270`, `verifyProof`; `session.ts:652`). A peer that proves only a
pairing credential the host already issued is admitted without a further credential; a peer
that proves neither is refused and receives no credential at all.

Two corrections to the shape this document originally specified, both now taken from the source:

- A **path** mismatch is refused with `400`, not `404`. `admission.ts:92` comments that a wrong path is
  a misroute from the generic upgrade dispatcher rather than a missing resource.
- The extension-identity check and the origin check are **one** check with one refusal.
  `admission.ts:118` returns `403 Forbidden Origin` both when the origin is not a `chrome-extension://`
  URL and when no pairing's allowlist admits that id. The implementation merges them deliberately.

Checks 5 and 6 are independent of 1–4, and of each other: a correctly signed proof from a browser
whose switch is off is still refused, and a revoked credential fails even from an allowlisted
extension.

**Wire-level codes.** The HTTP statuses above are on the upgrade. The post-upgrade refusals reported to
the client are the stable error codes in `packages/webui/src/shared/contracts/browser.ts` —
`browser_pairing_rejected` and `browser_surface_not_authorized` are both in that set, along with
`browser_credential_store_unavailable`. The extension-identity refusal has **no** stable code: an
extension refused for its identity is given `403 Forbidden Origin`, which is indistinguishable from a
malformed origin by design. This remains an open decision — either it reuses
`browser_pairing_rejected`, which is defensible since an unallowlisted extension must not learn that it
is unallowlisted rather than unpaired, or a code is added to the pinned list. This document does not
decide it; it records that the decision is outstanding.

## The extension-identity allowlist

Each store build's **exact** extension identity is validated at the bridge. The allowlist is by
identity, not by shape:

| Rule | Detail |
| --- | --- |
| Packaged builds accept only their own store identities | A Chrome Web Store build and an Edge Add-ons build are distinct identities and neither is accepted for the other. |
| Development identities are explicit development configuration | An unpacked extension's identity is accepted only when the host is configured to accept it. |
| **A packaged build never accepts a development identity** | Development identities are not accepted by packaged builds. This is the rule that keeps an unpacked, locally-loaded build from being a way into a released client. |
| An identity outside the list is refused | It is not merely deprioritized or asked to confirm. |

The allowlist is configuration, not code-level inference: the host must be told which identities it
accepts. Because the two stores are separate submissions generated from one source package, the two
identities differ and both must be registered.

## The origin check is not broadened

**Required, and stated separately because it is the tempting shortcut.** `isAllowedOrigin`
(`access-policy.ts:119`) is not modified. The rule that only loopback HTTP(S) origins are admitted
stays exactly as it is. `chrome-extension://` is not added to it. A `chrome-extension://` origin
continues to be rejected by the generic path, and that rejection is what forces the dedicated path to
exist rather than being an inconvenience to work around.

Broadening the generic check would admit *every* extension origin against *every* WebSocket endpoint on
the loopback interface, which is a much larger grant than admitting one known extension to one known
path.

## Summary of what is required versus what exists

| Element | State |
| --- | --- |
| Loopback Host, URL-host and origin checks | `implemented` — `admitWebSocketUpgrade`, `access-policy.ts:51` |
| Per-start token check with a `dev: true` bypass | `implemented` — `access-policy.ts:76` |
| Rejection of `chrome-extension://` by the generic origin check | `implemented` — `access-policy.ts:127` |
| Per-start credential that changes on every start | `implemented` — `createWebuiCredential`, `credentials.ts:19` |
| Dedicated `/browser-bridge` path check | `implemented` — `admission.ts:95` |
| Extension-identity allowlist | `implemented` — `BrowserBridgePairing.admitsExtensionId`, `pairing.ts:142`; configured per pairing |
| Pairing-proof admission | `implemented` — `verifyWebuiBrowserBridgeProof`, `contracts/browser-bridge.ts:218` |
| Browser-switch authorization at admission | `implemented` — `pairing.ts:152` refuses when the switch is off |
| `dev` does not bypass the bridge | `implemented` — `admission.ts:135` carries an explicit no-op `if (context.dev)` branch documenting the bypass as absent |
| **The bridge reaching the upgrade path** | `implemented` — `websocket-server.ts` branches on `/browser-bridge` **before** the generic `admitWebSocketUpgrade` and returns; the generic path is unchanged |
| **A listener owning a bridge session** | `implemented` — `server/browser-bridge/server.ts` owns the bridge's own WebSocket server and registers a session on `ready`, not on socket open |
| **The switch driving the pairing** | `implemented` — the bridge does not switch a surface on by itself; the browser service reads the persisted authorization and calls `enableSurface` / `disableSurface` / `restoreSurface` |
| **A credential that survives a host restart** | `implemented` — `BrowserBridgePairing.restore` re-adopts the stored credential at startup instead of rotating it, so the extension's copy still matches |
| **An extension-identity refusal with a stable wire code** | **open decision** — see the wire-level codes note above |
| The extension connecting end to end | **implemented, and `not yet measured`** — the host and the extension share a credential through the encrypted exchange; it has not been performed against a real Edge or Chrome. See `07-review-findings.md` |
| **The peer is authenticated against a local process** | `implemented` — the `Origin` header still selects the allowlisted extension id, and it is no longer the thing that decides. A peer must additionally prove possession of the **installation key** before the host hands over a pairing credential, and a peer that proves only a credential this host already issued receives no credential at all. A local process can spoof the origin and supply its own ECDH key, but it holds neither secret, so no `pair` frame is sent to it. See [`04-pairing-credentials.md`](04-pairing-credentials.md) |
| **The specific refusal says what is missing** | `implemented` — `BrowserBridgeProofRefusal` distinguishes `switched_off`, `unknown_nonce`, `unknown_key_id`, `installation_key_mismatch`, `pairing_credential_mismatch` and `no_peer_public_key`, and each maps to its own stable `closed`-frame reason text in `describeRefusal` (`session.ts`). A generic "pairing proof failed" would leave the person unable to tell "paste your installation key" from "your host rotated". |

## Related

| Concern | Document |
| --- | --- |
| The wire shape admitted here | [`02-bridge-protocol.md`](02-bridge-protocol.md) |
| The credential presented at check 4 | [`04-pairing-credentials.md`](04-pairing-credentials.md) |
| Where each switch is enforced | [`06-runtime-authorization-trace.md`](06-runtime-authorization-trace.md) |