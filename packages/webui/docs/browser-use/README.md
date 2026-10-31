# WebUI Browser Use — validated technical contracts

**Status:** These documents mix three kinds of statement, and every document now separates them with a
status line of its own:

| Label | Means | Trust it for |
| --- | --- | --- |
| `measured` | A probe observed this. The document names the artifact. | What happened on the machine that was probed, and nothing else |
| `implemented` | The source does this today. The row names the file and line. | What the code does now; re-check after any refactor |
| `not yet measured` | An open question. | Nothing — it is a gap, not a denial and not a promise |

Where a document mixes the three, they are separated inline rather than merged into one sentence.

**Read [`07-review-findings.md`](07-review-findings.md) before anything else.** **Twelve review rounds**
have run against this change — nine by a `codex` `gpt-6-luna` reviewer reading the source rather
than the description, a seventh that was the final acceptance pass against the finished tree, an
eleventh raised by the tab-model review, and a twelfth raised by the Browser Core integration. That
document records every finding and states, for each, whether it is closed or still open. **The first
twelve rounds are closed**; the ones that changed a decision are recorded in the decision record's
amendments, and the ones that could not be closed on this machine are marked `fixed, platform
unverified` rather than rounded up.

The decision record for this programme is
[`../adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md`](../adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md),
amended by **A8** for the tab model, whose own decision record is
[`../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md`](../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md).
This directory holds the evidence and the pinned contracts that ADR 0019 left as validation work:
what was actually measured, what was deliberately not measured, and the exact wire shapes the tab
strip, the Agent's browser tools and the extension must agree on.

Nothing here describes shipped, released behavior. The isolated-Chromium surface has a provider, a
service and a panel path in this branch, and the extension bridge is wired into the server's upgrade
path; the external handshake completes against a real Chrome and a real Edge, and the acceptance
matrix records what each run observed. The tab model that ADR 0022 decides is **in this tree** except for
its acceptance record: the rows that have code behind them say `implemented` and name the file. Where a
document states a rule that has no implementing code, it says so in place rather than in a footnote.

## Implementation status was re-checked against the tree

These documents originally said the runtime did not exist. It does now, and every implementation
statement in this directory has been re-read against the working tree of this branch. Where a document
still says something is not implemented, that is because it is not — the per-row evidence is in
[`06-runtime-authorization-trace.md`](06-runtime-authorization-trace.md).

| Path | State now | Where it is documented |
| --- | --- | --- |
| `packages/webui/src/runtime/browser/authorization.ts` | `implemented` — the surface gate is enforced by the browser service | `06` |
| `packages/webui/src/runtime/browser/target-registry.ts` | `implemented`, and fed from `provider.onTargetChanged` (F2) | `05` |
| `packages/webui/src/runtime/browser/browser-service.ts` | `implemented` — owns authorization, providers, the registry and the per-run frame streams | `06` |
| `packages/webui/src/runtime/browser/isolated-chromium/provider.ts` | `implemented` — including the attachment retry; it drives one page per web tab, and every page is addressable | `01` |
| `packages/browser-core/` | `implemented` — the provider-neutral core that owns the **semantics** of a browser action. The WebUI consumes it on **both** surfaces over a `BrowserTransport` adapter each | `10` |
| `packages/webui/src/runtime/browser/isolated-chromium/core-transport.ts` | `implemented` — the core's transport over the isolated Chromium's own CDP connection | `10` |
| `packages/webui/src/server/browser-bridge/core-transport.ts` | `implemented` — the core's transport over the bridge's `cdp` frame, with the extension's pushed visible-tab frame as the screenshot source | `10` |
| `packages/webui/src/server/browser-bridge/credential-store.ts` | `implemented`, rewritten mid-review; the three per-OS forms are in place, and the macOS and Windows forms are asserted through an injected runner rather than executed | `04` |
| `packages/webui/src/server/browser-bridge/admission.ts`, `pairing.ts`, `session.ts`, `registry.ts`, `reconnect.ts` | `implemented` and **wired** into the server's upgrade path and the browser service; target-ownership routing fixed (F4) | `02`, `03` |
| `packages/webui/src/shared/operation-names.ts` | `implemented` — eight browser operations registered, including `sendBrowserCommand` (F5) | `06` |
| `packages/browser-extension/` | `implemented` — MV3 service worker, `chrome.storage.local` credential, Web Crypto signing | `02`, `04` |
| The tab model of ADR 0022 | `implemented` for the strip, the surface-switcher deletion, the launcher content kind, the tab's toolbar, the tile launcher and the run-vs-tab split — the workspace's reducer carries a `launcher` content, the strip renders tool tabs and web tabs in one row, `BrowserPanelHost` is keyed by a target rather than a switchable surface, and the run's selection and the tab the person is looking at are two cells with one writer each plus one runtime-decided bootstrap; what remains is the acceptance record | `01`, `05`, `07` |

The *measurements* in these documents were never affected by the tree moving. They come from the probe
artifacts, not from the source. What moved was the implementation status, and that is what this pass
corrected.

The tree moved through **four review waves** while this pass was running:

1. `packages/webui/src/server/browser-bridge/credential-store.ts` was rewritten from `cmdkey` to a DPAPI
   round trip, with the secret on stdin rather than in `argv`.
2. `browser-service.ts` and `server/browser-bridge/registry.ts` gained the fixes for F2, F4, F5 and F6.
3. The bridge stopped switching surfaces on by itself, the runtime started reaching it through the
   member it actually exposes, external frames stopped being relabelled, and a host restart started
   restoring its pairing credential instead of rotating it.
4. The bridge gained the `cdp` / `cdp-result` frame pair and the extension gained its allowlist, so
   Full CDP reached the external surfaces (F6 and N4); and the **Browser Core** integration landed,
   moving the semantics of a restricted action out of the providers and into `@mavis/browser-core`.

Every line number cited in these documents was re-verified against this branch. The findings that are
still open are listed in [`07-review-findings.md`](07-review-findings.md).

## Documents

| Document | Owns | Read it when |
| --- | --- | --- |
| [`01-capability-matrix.md`](01-capability-matrix.md) | What each browser surface offers, which commands were measured supported, and what was not verified | You need to know what a surface can actually do, or what evidence a claim rests on |
| [`02-bridge-protocol.md`](02-bridge-protocol.md) | The `/browser-bridge` wire protocol: frames, the challenge/proof construction, the HMAC material, the pinned test vector, the reconnect schedule | You implement either side of the bridge, or you change a frame shape |
| [`03-extension-admission.md`](03-extension-admission.md) | The dedicated extension admission path, its checks and refusal statuses, and why it is separate from generic WebSocket admission | You touch WebSocket admission, extension identity, or the `dev` flag |
| [`04-pairing-credentials.md`](04-pairing-credentials.md) | Credential lifecycle, the per-OS secure store on each platform, and the explicit-failure rule when no store exists | You implement pairing, credential storage, revocation or re-enable |
| [`05-target-identity.md`](05-target-identity.md) | The three-part target identity and its generation, what invalidates a generation, and how a stale reference is rejected | You work with targets, input forwarding, tab selection or run scoping |
| [`06-runtime-authorization-trace.md`](06-runtime-authorization-trace.md) | Each of the four authorization switches traced to the place it must be enforced, with the current implementation status of each check | You implement an authorization check, or you are auditing whether one exists |
| [`07-review-findings.md`](07-review-findings.md) | All the findings from the twelve review rounds, what was done about each, and what is still open | You want to know what is known to be broken, or what has been corrected |
| [`packages/browser-extension/STORE-DISCLOSURES.md`](../../../browser-extension/STORE-DISCLOSURES.md) | The store disclosures for the Chrome Web Store and the Edge Add-ons, and the differences between a packaged build and a development build | You are preparing a store submission, or you need to know what a packaged build is |
| [`09-acceptance-record.md`](09-acceptance-record.md) | The acceptance matrix: every surface, every case, the browser version, the operating system, the settings and the observed result — written from the records the suites produce | You want to know what was actually run, and where the evidence is thin |
| [`10-browser-core-integration.md`](10-browser-core-integration.md) | The Browser Core layer: who owns the semantics of a browser action, the `BrowserTransport` seam, the two adapters, and what each surface still cannot do | You change a browser action, an element reference, or the bridge's command path |

## How to read these documents

**Three kinds of statement, kept apart on purpose.** A *measurement* is something a probe observed on
a specific host; every one names the artifact and the JSON field it came from. An *implementation
statement* is something the source does today; every one names the file. A *requirement* is a rule the
contracts pin, which may or may not have code behind it. The per-document status lines say which is
which, and each row carries the same label where a document mixes them.

**A matrix entry that was not measured is not a capability.** `01-capability-matrix.md` marks
measured-supported, not-measured and probed-but-unconfirmed separately. Do not promote a not-measured
cell to a claim.

**A measurement is scoped to the machine that produced it.** The credential-store probe ran on one
Linux host. Its negative result is a fact about that host. It is not a fact about Linux, and it says
nothing about macOS or Windows, which were never probed.

**Overstatement is the failure mode these documents exist to prevent.** Where the evidence did not
support a statement, the document says what was not measured rather than reasoning around the gap.
Finding F7 was exactly this failure in these documents, and it is recorded in
[`07-review-findings.md`](07-review-findings.md).

## Evidence provenance

The measurements below come from two probes written for this work and run against the Chrome on the
validation host, and from the acceptance suites that write a record as they run:

| Probe | Result | What it establishes |
| --- | --- | --- |
| `.plan/browser-use/complete/probe-cdp.mjs` | `.plan/browser-use/complete/cdp-evidence.json` | Which CDP commands a real Chrome accepted, whether real input and image capture work, and whether a renderer-attachment race exists |
| `.plan/browser-use/complete/probe-credential-store.mjs` | `.plan/browser-use/complete/credential-store-evidence.json` | Which OS secure credential store **the one Linux host it ran on** actually offers. Nothing about any other platform |
| `packages/webui/test/browser/*` (Playwright) and `packages/webui/test/integration/browser-use-real-input.test.ts` (Vitest) | `.plan/browser-use/complete/*.acceptance.json` | The acceptance matrix: the browser version, the operating system, the settings and the observed result, for every surface. See [`09-acceptance-record.md`](09-acceptance-record.md) |

`.plan/` holds the development plans, the boards and the raw probe records. It is **tracked in the
repository**, so a ticket and the plan behind it are both readable from a worktree, and it is
part of the public-source projection like any other tracked file. The raw probe records therefore
travel with the published checkout; each measurement is still quoted inline below, so the derived
value can be checked against the probe output without leaving the document.
The probe scripts are reproducible: re-running them regenerates the evidence for the host they run on,
and **produces a different artifact on a different host**.

## The contracts these documents pin

| Contract | Path |
| --- | --- |
| Browser Use wire contracts: surfaces, the four authorization switches, target identity with generation, input commands, image frames, stable error codes | `packages/webui/src/shared/contracts/browser.ts` |
| The extension bridge protocol: path, challenge/proof, frame kinds | `packages/webui/src/shared/contracts/browser-bridge.ts` |

Both files are contracts, not implementations. The switches, the generation counter and the error codes
began as declarations that no code consumed; the table above records what consumes them now. The
contract is the pinned wire shape either way, and the source is what decides whether it is enforced.

## Vocabulary

Repository terms are defined in `CONTEXT.md` at the repository root. The terms specific to this
directory:

| Term | Meaning |
| --- | --- |
| **Surface** | One of `isolated-chromium`, `edge`, `chrome`. Each is a separate authorization; enabling one never implies another. |
| **Isolated Chromium** | The browser this process launches and owns, reached over CDP on loopback. |
| **Bridged surface** | `edge` or `chrome` — the person's own browser, reached through the extension bridge rather than launched here. |
| **Restricted command set** | The fixed browser action vocabulary the Agent's tools may use while Full CDP access is off. |
| **Browser Core** | The provider-neutral package (`@mavis/browser-core`) that owns the **semantics** of a browser action — element references, retained snapshots, action deadlines, effect validation. It reaches a browser through a `BrowserTransport` and knows nothing about any particular browser or switch. See [`10-browser-core-integration.md`](10-browser-core-integration.md). |
| **Transport** | The adapter that carries a Browser Core command to one page or tab. The WebUI has one per surface: `runtime/browser/isolated-chromium/core-transport.ts` and `server/browser-bridge/core-transport.ts`. |
| **Full CDP** | The separate authorization to send arbitrary DevTools commands to an already-authorized surface. It never authorizes a surface on its own. |
| **Generation** | The monotonic counter that makes a recorded page reference detectably stale rather than silently mis-aimed. See [`05-target-identity.md`](05-target-identity.md). |
| **Run** | The Agent's browser working context, keyed by the WebUI Agent session. One session drives one browser selection. |
| **Run selection** | The page the Agent acts on. The runtime's cell: the Agent writes it, the client reads it. There are two paths into it — the run's own `open_tab`, and the bootstrap below. |
| **Tab in front** | The page the person is looking at. The client's cell: the person writes it by choosing a tab, and the picture and the input binding follow it. |
| **Bootstrap** | The one write that crosses the two cells: a page a person opened while the run had no selection becomes that run's selection, decided by the runtime at the moment the page appears. |
| **Tab** | A slot in the workspace panel's strip. It holds one piece of content at a time, and its content can be replaced without the tab being closed. |
| **New tab page** | The launcher a newly opened tab shows: the tool views and a URL box. Choosing either replaces that tab's content. The URL box exists nowhere else. |

## Publication note

Every file in this repository is listed in the generated inventory `release/public-source.json`.
Recording a new or moved file requires running, in the repository root:

```sh
node scripts/source-inventory.mjs --write
pnpm check:source
```

The inventory is generated and must not be hand-edited. Until it is regenerated a new document is
present in the working tree but not recorded as part of the published source projection, and
`pnpm check:source` will report it as missing from it.

The index at [`../README.md`](../README.md) lists this directory, with a one-line Browser Use entry
among the other nested subject groups.