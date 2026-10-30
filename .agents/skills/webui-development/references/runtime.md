# Loopback, contracts and runtime

Read `packages/webui/docs/runtime/harness-boundary.md`, `boot.md` and `owner-identity.md` as relevant. Source paths below are under `packages/webui/src/`.

## Operation changes

Trace the complete producer/consumer path. The package guide prescribes the declaration sequence:

1. Canonical name and `OperationSpec` row in `shared/operation-names.ts`; shared DTOs in `shared/contracts/<domain>.ts`.
2. Descriptor plus actual body validator in `server/operation/<domain>.ts`. Pin rejection predicate, stable code and exact message when changing validators.
3. Capability binding in `server/operation/bind-handlers.ts`. `binding-mechanism.ts` checks group/method/argument tuple/result mapper. Dedicated `handlers/` remain for stream/terminal/command shapes, response shaping or capability degradation; inspect `DEDICATED_OPERATION_NAMES`.
4. Registration in `server/operation/operations.ts`. Order is observable: append rather than reorder existing entries.
5. Capability in `runtime/port.ts`, adapter in `runtime/harness/`, and affected stubs/fixtures. For browser use, extend feature contract, `client/contracts/transport.ts`, `client/platform/transport.ts`, injected slice and owner command.

Both sides use canonical names, not independent literals. The runtime port references shared DTOs rather than defining them. Type correctness is only one check: prove registration, wiring, caller reachability and real-envelope behavior.

## Capabilities

Read `shared/capability-manifest.ts`, `server/service.ts` (`withRegistryDerivedAvailability`) and `runtime/harness/adapter.ts` (`readHostPrerequisites`). Support comes from registered operations, callable bindings and actual host prerequisites.

`supported`, `absent`, `not-ready` are distinct. Missing manifest on an older handshake means client-side unknown, retaining the unverified attempt path. A complete browser method table proves only protocol knowledge. Permission denial remains a call failure.

## Wire and delivery

`server/operation/operation-dispatch.ts` validates envelopes before trusting identity, rejects non-request frames, honors shutdown, validates bodies and dispatches. Preserve stable capability error codes; uncoded errors become harness errors. Frame identity, payload bytes and order can be compatibility contracts.

Acknowledgement is opt-in. Iterator finalization shares one idempotent gate between abort and normal cleanup so unresolved pulls close without double-return. Client cancellation ends delivery, not host execution.

`client/platform/wire.ts` owns socket/unary/stream mechanics; `transport.ts` maps domain methods to operation names; `event-channel.ts` owns persistent event connection/reconnect. Business interpretation stays with owners.

## Process resources

`server/access-policy.ts` owns loopback Host/Origin/URL-host and upgrade admission; `server/credentials.ts` owns the per-start credential. Retain admission guarantees when diagnosing dev/browser failures.

`runtime/assembly.ts` constructs resources; `runtime/lifecycle.ts` owns startup-failure cleanup and close. Auth, host, mcode-tools broker and external browser provider close in order; all cleanup is attempted and failures reported. Service shutdown stops admission, closes connections and closes harness/resources. Register new process resources with the actual close owner and failure path.

The **browser bridge** is a `server/` resource that is *supplied* to the service rather than created by the assembly, and the service closes it (`server/service.ts`). It is the one `server/` **area** — `src/server/browser-bridge/` — whose modules may import
`@mavis/browser-core`; `src/client/` and `src/shared/` may not. See
[`architecture.md`](architecture.md) for the browser's own boundary and
`packages/webui/docs/browser-use/10-browser-core-integration.md` for the layer itself.

## Browser actions and element references

The browser's action semantics belong to `@mavis/browser-core`. A restricted action reaches it through
a `BrowserTransport` adapter, and the WebUI's own gate decides whether it may run at all.

| Concern | Where |
| --- | --- |
| The restricted vocabulary (28 names) and the gate that reads it | `runtime/browser/authorization.ts` (`isBrowserCommandAllowed`); the list itself is `shared/contracts/browser.ts` |
| The Agent's tool path | `runtime/browser/tool-adapter.ts` — forwards to the same service the panel uses |
| The isolated Chromium's core transport | `runtime/browser/isolated-chromium/core-transport.ts` |
| The bridge's core transport | `server/browser-bridge/core-transport.ts` |

When you add, change, or remove a browser action:

- **Change the semantics in the core**, not in a provider. A provider that translates an action into
  raw DevTools calls is a second definition of what it does.
- **Update the vocabulary in both places.** `shared/contracts/browser.ts` holds the WebUI's copy and
  `@mavis/browser-core` holds the core's; `test/unit/browser-restricted-commands.test.ts` asserts they
  cannot drift. The shared layer cannot import the core, which is why the copy exists.
- **Keep the surfaces' refusals named.** `open_tab` is refused on the bridge, `return_to_previous_tab`
  on the isolated Chromium, and `upload_files` on the bridge. Each refusal says `browser_capability_denied`
  and each names a fact about the browser rather than a policy.

Element references are opaque (`browser-element:<generation>-<uuid>`) and the core holds the element
map and the retained snapshot. A reference whose page has navigated is refused with
a stale-reference refusal (`STALE_ELEMENT_REF` or `STALE_SNAPSHOT`); a reference on a page that did not navigate stays usable. Do not add a path that
turns a reference back into a coordinate outside the core.

Two error vocabularies meet at the core's edge and are deliberately **not** flattened: the core's
action errors (`STALE_ELEMENT_REF`, `STALE_SNAPSHOT`) tell the Agent what to do next, and the WebUI's
codes (`browser_target_stale`, `browser_capability_denied`) tell the panel and the client what to
render. The one translation point is the panel boundary,
`client/features/browser/ui/BrowserPanelHost.public.tsx`.

The host declares `webui` identity rather than borrowing `tui`/`cli`. Inspect the policy row and assembly for quarantined startup, permission/questionnaire behavior, auth leases, beta tools and optional Browser Use before modifying them.

For host-event changes, run `pnpm --filter @mavis/webui gen:host-events`. `shared/contracts/host-event-types.generated.ts` must stay fresh; production session-fact decoding handles each catalog fact or records an explicit unhandled rationale. Generation neither changes host producers nor defines WebUI DTOs automatically.

## Scope and dependencies

Read `docs/known-gaps.md` and `open-questions.md` when behavior seems absent. Disabled tabs, beta tools, optional providers and temporarily failed calls differ. The retired WebUI-owned scheduler and the retired navigation generators are not current requirements; the scheduled-task surface that exists uses the v2 runtime's Cron service (`docs/adr/0027-the-webui-is-a-scheduler-host-for-scheduled-tasks.md`), and a second scheduler in this client is still refused.

Reuse existing dependencies: React/React DOM; marked + KaTeX + selectively registered highlight.js core; xterm/fit for terminal UI; node-pty for processes; ws for loopback; archive adapters' existing libraries. Recheck manifest versions. New browser dependencies need a reviewable reason and bundle assessment; Node dependencies do not become browser-safe through reuse.
