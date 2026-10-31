# The remote-control link

The 远程控制 tab of the 远程 page: pairing a phone with this service, and letting that phone
drive the session it is paired with.

## The split, and where it differs from Desktop

Desktop splits the link across two processes. The renderer signs `GET /desktop/bindings` —
only the renderer's axios holds the token — and pushes the one-shot ticket down to the main
process, which holds the WebSocket.

The WebUI has no renderer that holds the credential: the browser document never receives the
account token, because it may be running on another machine and the WebUI's own transport is a
local loopback socket. So the **service** signs the binding HTTP, and the service holds the
socket. The shape of the Desktop's split is kept — the `applyRemoteControlCredentials`
operation still exists and still works — but the signer moves.

## The credential

The bearer is the **service's OAuth lease**: the one `@mavis/oauth-core` instance that
`runtime/auth-session.ts` owns, the same lease the quota and the daily check-in sign with.
The assembly hands it down through `host.getAuthCredential()`
(`runtime/assembly.ts`), and `runtime/remote-control/pairing.ts` keeps it in a
`RemoteControlCredentialSource`.

That source is not decoration. The bridge's `PairingClient` reads the bearer
*synchronously*, so the lease is cached and refreshed ahead of its expiry rather than at it.

Two rules hold that cache together, and both were learned from a pairing that failed:

- **A renewal that fails keeps the bearer.** The bearer is a lease: a refresh that cannot
  renew it — a network hiccup, a lease mid-rotation — is not a sign-out. Clearing the good
  token would turn a transient failure into `no user JWT available`, and the bridge's
  pairing poll treats that answer as fatal: it tears the pairing session down, and a phone
  that binds a minute later finds nobody listening.
- **A refresh that cannot resolve the account id keeps the id this host already knows.** The
  server cross-checks the `user_id` common-param against the token's own subject, and an
  identity that flips under the pairing poll ends that poll the same way.

Desktop's main process cannot do any of this: under Shared OAuth it fails closed on the
legacy SSO token projection (`getJwt: () => ''`), so Desktop 3.1.3's own pairing-code
request is unsigned. The WebUI's service holds a first-party lease, so it signs.

The ticket is one-shot. It is never persisted, never logged and never returned to the
browser; `remote-control/state.json` holds the device id, the binding id and the account id
and nothing else.

## Relinking after a restart

The service re-opens a pairing it already owns. When the 远程控制 tab is opened — the browser
reads the status — the service asks archon_biz what this device is bound to, and opens the
socket with a fresh ticket when the answer is a binding.

The server's answer is the authority, not the local copy. The local `binding_id` is only
written once the pairing completes, so a service that died between the phone's binding and
the poll's discovery would have nothing to relink to if it trusted its own file. A host that
never paired asks once and then stops asking.

Without this, restarting the WebUI would leave the phone paired but the producer offline: the
phone would report "network load failed" and the gateway would refuse to route messages, until
the user paired a second time.

## The pieces

| Path | What it is |
| --- | --- |
| `runtime/remote-control/bridge/` | The vendored `@mavis/remote-control-bridge`: the pairing client, the connection, the frame codec, the data plane, the command router seam. Host-neutral; the only dependency is `ws`. |
| `runtime/remote-control/pairing.ts` | The pairing client, the origin resolution and the credential source. |
| `runtime/remote-control/owner.ts` | The owner: the proxy, the status fan-out, the relink, the credential and the pairing session. |
| `runtime/remote-control/command-router.ts` | The local runtime entry used by the bridge. It maps Desktop HTTP routes to runtime capabilities and converts typed session, project, pin, queue, permission and questionnaire responses to Desktop wire names. Unsupported paths return 404 and are logged without credentials or message content. |
| `runtime/remote-control/global-events.ts` | The events the phone receives from the local runtime, decoded against the frontend global-event catalogue. |
| `runtime/harness/remote-control.ts` | The adapter that answers the port's nine remote-control members. |
