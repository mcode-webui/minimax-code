# The acceptance record

**Status:** This document records what was **measured**, and each row names the suite that measured
it. Nothing here is a claim about a machine other than the one named.

| Label | Means |
| --- | --- |
| `measured` | A suite ran on the host named in the row and observed the result in the row. |
| `not yet measured` | An open question. Not a denial and not a promise. |

## Why the record exists

Two tickets ask for a recorded result rather than a claim: the browser version, the operating system,
the settings that were enabled, and what was observed. A matrix written by hand drifts from what the
suites did, so **the suites write the record as they run** and this document is written from it.

The record is written to `.plan/browser-use/complete/<suite>.acceptance.json`, which is tracked in
the repository and part of the published source projection, so the raw record travels with this
document. The four suites that produce it are:

| Suite | What it drives |
| --- | --- |
| `isolated-chromium` | The browser this process launches and owns, against a real page. Vitest. |
| `real-browser` | The extension's handshake and its refusal, in a real Chrome and a real Edge. Playwright. |
| `real-external` | The bridge itself — input, image, DevTools, worker termination — in the same two browsers. Playwright. |
| `real-packaged` | The **packaged** entry: a store build's identity, and what a packaged host does with it. Playwright. |

A suite **empties** its own file at the start of a run, so a re-run cannot leave a case behind from
the previous one, a run that fails during setup leaves an empty file rather than the previous run's
passes, and the suites cannot overwrite each other's records. A **failing** case is recorded as a
failure before the error is re-thrown: a record that holds only the passing cases is a record of
what was supposed to happen.

The settings in a record are **read from the host** — the switch states come from the bridge's own
snapshot — and they are read **after** the case body has run, so the record describes the state the
observation was made in rather than the state the case started in. The two switches the bridge does
not carry are named as such rather than guessed at.

## The run this document was written from

| | |
| --- | --- |
| Operating system | `linux 7.0.0-38-generic` |
| Google Chrome (installed, `/usr/bin/google-chrome`) — the browser the **isolated Chromium** surface launches | 152.0.7977.82 |
| Chromium (bundled, installed by Playwright) — the browser the **Playwright** suites drive | 153.0.8010.12 |
| Microsoft Edge (installed, `/usr/bin/microsoft-edge`) | 151.0.4129.107 |
| Date | 2026-10-21 |

Two different Chromiums are in play, and the matrix names which one each row used. The isolated
Chromium surface launches the **installed** Google Chrome, because that is the browser the provider
resolves on this host; the Playwright suites drive the **bundled** Chromium, because Playwright
installs and controls it. The Edge is the installed browser at `/usr/bin/microsoft-edge`.

**The four WebUI authorization switches are off by default**; the settings column below says which
ones each case actually had.

## The matrix

| Surface | Entry | Browser | Case | Settings | Result |
| --- | --- | --- | --- | --- | --- |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | The isolated Chromium delivers text input to the page it is showing | `isolatedChromium` on; a pointer click and a text input both arrive in the page the provider is driving | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | The isolated Chromium refuses an input recorded against the page a navigation replaced | `isolatedChromium` on; the stale identity is refused with `browser_target_stale` and the page that replaced it receives nothing | `measured` — pass |
| `chrome` | development | Chromium 153.0.8010.12 (bundled) | The extension completes the handshake once it can prove the installation key | `chrome` on, `edge` off; the host reports the surface connected | `measured` — pass |
| `chrome` | development | Chromium 153.0.8010.12 (bundled) | An extension that cannot prove the installation key is refused | `chrome` on, `edge` off; the host refuses the extension and reports no connected surface | `measured` — pass |
| `edge` | development | Edge 151.0.4129.107 | The extension completes the handshake once it can prove the installation key | `edge` on, `chrome` off; the host reports the surface connected | `measured` — pass |
| `edge` | development | Edge 151.0.4129.107 | An extension that cannot prove the installation key is refused | `edge` on, `chrome` off; the host refuses the extension and reports no connected surface | `measured` — pass |
| `edge` and `chrome` | development | Chromium 153.0.8010.12 (bundled) and Edge 151.0.4129.107 | Each browser lands on its own surface when one identity is listed on both | both surfaces on, one identity on both allowlists; both browsers were connected, each on its own surface, and each surface's provider belonged to that surface | `measured` — pass |
| `chrome` | development | Chromium 153.0.8010.12 (bundled) | The bridge survives the worker being terminated during an active stream | `chrome` on; the host notices the terminated worker, the surface goes down and comes back, and a command against the live tab answers again | `measured` — pass |
| `chrome` | development | Chromium 153.0.8010.12 (bundled) | Text input reaches the page and the page's image reaches the host | `chrome` on; the text the host sent appeared in the page's field, and a non-empty image frame for that page arrived at the host | `measured` — pass |
| `chrome` | development | Chromium 153.0.8010.12 (bundled) | A DevTools command runs against the live tab, and one outside the allowed set is refused as unsupported | `chrome` on, Full CDP exercised; the command in the allowed subset answered with the page's title, and a command outside it was refused as unsupported | `measured` — pass |
| `edge` | development | Edge 151.0.4129.107 | The bridge survives the worker being terminated during an active stream | `edge` on; the host notices the terminated worker, the surface goes down and comes back, and a command against the live tab answers again | `measured` — pass |
| `edge` | development | Edge 151.0.4129.107 | Text input reaches the page and the page's image reaches the host | `edge` on; the text the host sent appeared in the page's field, and a non-empty image frame for that page arrived at the host | `measured` — pass |
| `edge` | development | Edge 151.0.4129.107 | A DevTools command runs against the live tab, and one outside the allowed set is refused as unsupported | `edge` on, Full CDP exercised; the command in the allowed subset answered with the page's title, and a command outside it was refused as unsupported | `measured` — pass |
| `chrome` | **packaged** | Chromium 153.0.8010.12 (bundled) | The chrome store build's identity is the one its public key determines | store allowlist; the browser assigned the extension the id the public key determines | `measured` — pass |
| `chrome` | **packaged** | Chromium 153.0.8010.12 (bundled) | The chrome store build differs from the development build in exactly the manifest key | store allowlist; the packaged manifest carries the store's public key and differs from the development manifest in nothing else | `measured` — pass |
| `chrome` | **packaged** | Chromium 153.0.8010.12 (bundled) | A packaged host admits the chrome store build through the store allowlist | store allowlist; the packaged host completed the handshake and reported the surface connected | `measured` — pass |
| `chrome` | **packaged** | Chromium 153.0.8010.12 (bundled) | A packaged host refuses the chrome extension named only in the development allowlist | development allowlist on a packaged host; the packaged host refused the extension and reported no connected surface | `measured` — pass |
| `edge` | **packaged** | Edge 151.0.4129.107 | The edge store build's identity is the one its public key determines | store allowlist; the browser assigned the extension the id the public key determines | `measured` — pass |
| `edge` | **packaged** | Edge 151.0.4129.107 | The edge store build differs from the development build in exactly the manifest key | store allowlist; the packaged manifest carries the store's public key and differs from the development manifest in nothing else | `measured` — pass |
| `edge` | **packaged** | Edge 151.0.4129.107 | A packaged host admits the edge store build through the store allowlist | store allowlist; the packaged host completed the handshake and reported the surface connected | `measured` — pass |
| `edge` | **packaged** | Edge 151.0.4129.107 | A packaged host refuses the edge extension named only in the development allowlist | development allowlist on a packaged host; the packaged host refused the extension and reported no connected surface | `measured` — pass |

**Twenty-one cases, twenty-one passes.** The three surfaces the specification names — the isolated
Chromium, Edge and Chrome — are all in the matrix, and every row names the surface it ran on.

## The packaged entry, in detail

The other suites admit an **unpacked** extension: its id is derived from the directory it was loaded
from, so the id is a property of the machine rather than of the extension. A packaged build is
different — it carries the store's public key, and its id is the one that key determines. That is the
id a store issues, and the id the bridge has to validate.

The `real-packaged` suite therefore proves four things in order, **for each store and in that
store's browser** — the Chrome Web Store build in Chrome, the Edge Add-ons build in Edge:

1. **The identity is the key's.** The suite generates an RSA key pair, embeds the public key in the
   build, computes the id the browser's own rule produces, and asserts that the id the browser
   assigned to the loaded extension is the same string. The rule is therefore *checked against the
   browser*, not assumed.
2. **The two builds differ in exactly one thing.** The packaged manifest and the development
   manifest are identical apart from the `key` field — the store's public key. The difference is the
   whole of what the store requires, and it is recorded in
   `packages/browser-extension/STORE-DISCLOSURES.md`.
3. **A packaged host admits it.** The packaged host reads the store allowlist
   (`MAVIS_BROWSER_STORE_CHROME_EXTENSION_IDS`, `MAVIS_BROWSER_STORE_EDGE_EXTENSION_IDS`) and the
   handshake completes.
4. **A packaged host refuses the development identity.** The same host, with the same extension, with
   the id named only in `MAVIS_BROWSER_CHROME_EXTENSION_IDS`, refuses it. A packaged host that fell
   back to the development allowlist would admit whatever unpacked extension happened to be present,
   which is the identity nobody can rely on.

The **installed package** is checked too, and not by a bridge the test built. The package
verification starts the real `mcode-webui` from the installed archive, configures it with **both**
allowlists, and shows that the store identity is admitted on its `/browser-bridge` path while the
development identity is refused. That is the shipped process, running the shipped configuration.

The two entries are configured apart, in the source:

| Entry | File | Allowlist it reads |
| --- | --- | --- |
| Development | `scripts/run-webui-server.mjs` | `MAVIS_BROWSER_EDGE_EXTENSION_IDS`, `MAVIS_BROWSER_CHROME_EXTENSION_IDS` |
| **Packaged** | `release/webui-npm/bin/mcode-webui.mjs` | `MAVIS_BROWSER_STORE_EDGE_EXTENSION_IDS`, `MAVIS_BROWSER_STORE_CHROME_EXTENSION_IDS` |

The packaged entry passes `packaged: true` to the bridge; the development entry does not.

## The adversarial cases

The matrix above is the happy path and the refusal. The cases a person on the other side of the
socket can produce **on purpose** are in
`packages/webui/test/unit/browser-bridge-adversarial.test.ts`, against a real `ws` server and a real
client:

| Case | What it proves | Result |
| --- | --- | --- |
| An oversized frame | The socket is closed and the host survives it — a well-behaved peer still pairs afterwards | `measured` — pass |
| A malformed frame | The socket is closed and the host survives it | `measured` — pass |
| A duplicate connection from the same extension | The earlier session is **replaced**, not left alive beside the newer one | `measured` — pass |
| A revocation while an action is in flight | The action **fails** rather than hanging or completing | `measured` — pass |
| One identity on both allowlists | Each browser lands on **its own** surface, and the earlier session is not closed because the other reported the same instance id | `measured` — pass |
| A peer that names a browser the host does not know | The peer is **refused**, rather than attached to a pairing it does not belong to | `measured` — pass |
| A peer that names a browser it cannot prove | The name selects *which* secret has to be proved, and the proof is checked against **that surface's own** installation key — so a peer that calls itself Edge and answers with the Chrome key is refused | `measured` — pass |
| A second browser on a surface that is already served | A surface is one browser: the newcomer is refused, and the browser that holds the surface keeps it | `measured` — pass |

## The credential never reaches a log

The credential lifecycle ticket asks for "a test that observes a credential never appearing in
captured log output". That test is
`packages/webui/test/unit/browser-bridge-credential-secrecy.test.ts`: the whole pairing runs with the
console and both process streams captured, and the host's own stored secrets are watched in every
form they could take — raw bytes, base64, base64url, hex, the decimal list a byte array prints as,
and an object that carries one. None of them appears in the captured output, and none appears in the
frames the host sent: the credential travels **sealed**, not in the clear.

The capture is checked against itself as well: the test writes a secret to the console and asserts
that the capture finds it, so a capture that silently captured nothing cannot pass for the right
reason.

## What this document does not establish

- **The macOS and Windows credential-store commands were not executed.** The three platform forms are
  asserted against the platform command contract — the secret on stdin and never in `argv`, the
  base64 round trip, the typed error when the platform refuses — through an injected command runner.
  The host this was measured on is Linux, and it has no `security` and no `powershell.exe`. The
  Linux form's *availability* was probed separately and was **unavailable** on that host. See
  [`04-pairing-credentials.md`](04-pairing-credentials.md).
- **Nothing was measured on macOS or Windows at all.** Every row in the matrix is a Linux host. The
  extension is one package for both stores, but "the extension package is the same" is not "the
  behaviour is the same".
- **The store submission was not performed.** The packaged build exists; the store identity does not
  exist yet, because a store assigns it when the extension is first published. The acceptance uses a
  key generated at run time for exactly that reason.
- **The packaged entry was exercised at its admission, not through a full pairing.** The installed
  package is started and its bridge is asked to admit an identity — that is the part the packaged
  configuration decides. The full pairing, with a real extension and a real browser, is exercised
  against a packaged *host* in the matrix above, not against the installed process.
- **The Full CDP switch was not exercised through the runtime gate in a real browser.** The bridge
  carries the DevTools command and the extension's allowlist refuses what is not in it — that is
  what the `real-external` rows measured. The switch that gates it is enforced in the runtime
  browser service and is covered by the unit suite.
- **The Agent's browser tools were not driven against a real browser in *this* pass.** The run above
  is the previous programme's, and it does not speak for the tab model. The tab model's own run
  does: see [the workspace browser tab model's acceptance](#the-workspace-browser-tab-models-acceptance)
  below, where the Agent's `open_tab` opens a page in a real Chrome and the run's selection points at
  it.

## The workspace browser tab model's acceptance

The tab model ([ADR 0022](../adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md)) is a second
programme, and its acceptance is a second run: the same machine, the same installed Google Chrome, a
different suite. Its records are written to **its own** completion directory —
`.plan/workspace-browser-tab/complete/workspace-browser-tab.acceptance.json` — so a case from one
programme can never be read as a case from the other.

**The run.** `linux 7.0.0-38-generic`, Google Chrome 152.0.7977.82 (installed,
`/usr/bin/google-chrome`), the `isolatedChromium` switch on, the Full CDP switch on, 2026-10-21. The
suite is `packages/webui/test/integration/workspace-browser-tab-acceptance.test.ts`, and it drives the
shipped paths: the Agent's tool path through the browser tool adapter, the person's launcher path
through the server's own handler, the input path through the client's own binding, and the isolated
provider itself.

| Surface | Entry | Browser | Case | Settings | Result |
| --- | --- | --- | --- | --- | --- |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | the Agent opens a tab | `isolatedChromium` on; the run's selection points at the page the Agent opened, and the client's strip shows it and makes it the active tab | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | the Agent navigates after opening | `isolatedChromium` on; the page is at the requested url and the frame stream follows the page it opened | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | the Agent acts on a page it did not open | `isolatedChromium` on; the action runs on the run's selection, and a reference recorded before the page moved is refused | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | a person opens a tab while the Agent works | `isolatedChromium` on; the Agent's page and the person's page are different, and each shows its own picture | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | a person opens a tab while the run has no selection | `isolatedChromium` on; the run's selection becomes the person's page, so the Agent can act on it | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | a person types into their own tab while the Agent works | `isolatedChromium` on; the input reaches the person's page, not the Agent's | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | a person types a url in the launcher | `isolatedChromium` on; the tab becomes that page, and the url is shown read-only in the toolbar | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | a person closes a web tab | `isolatedChromium` on; the page is released, and the runtime's page set follows the strip | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | back and forward | `isolatedChromium` on; the page moves through its own history, and the generation follows | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | the surface's switch is off | `isolatedChromium` on; the Agent's open_tab and the person's launcher path are both refused with browser_surface_not_authorized | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | a run with no selection acts | `isolatedChromium` on; every action except open_tab is refused with browser_target_unknown | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | a session ends | `isolatedChromium` on; its pages are released and no page is left behind | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | a second web tab in one session | `isolatedChromium` on; both are addressable, and the strip shows both | `measured` — pass |
| `isolated-chromium` | development | Google Chrome 152.0.7977.82 (installed) | a page navigates | `isolatedChromium` on; its generation advances, and a reference recorded against the old generation is refused — on every tab, not only the first | `measured` — pass |

**14 cases, 14 passes.** The three rows this
programme exists for are here: the Agent opening a tab, the person browsing alongside it, and the
generation fence on a page that is **not** the launch page.

### What this run closes

- **The Agent's browser tools were driven against a real browser.** The `open_tab` row is the tool
  adapter's own path — the same adapter the Agent's tools use — opening a page in a real Chrome, and
  the run's selection pointing at it. The "two cells" rows are the person typing in one page while the
  Agent acts in another, in the same browser.
- **The isolated provider drives more than one page.** The "second web tab" row opens two pages in
  one session and drives each on its own.
- **The image stream is per target.** The "navigates" and "back and forward" rows are the page's own
  generation moving, and a reference recorded before the move being refused — on a page that is not
  the launch page.

## The Browser Core layer's own acceptance

The Browser Core integration is a third wave, and it has its own suites. The isolated surface's
cases run against a **real** browser; the bridge's cases run against the bridge's wiring with the
extension as a **test double**, so they prove the wiring rather than a browser.

**The isolated surface — a real browser.**
`packages/webui/test/integration/browser-core-agent-actions.test.ts` drives the Agent's tools through
Browser Core against a real Chromium.

**It requires one.** Unlike the other Chromium suites in this package, it does **not** use
`describe.skipIf`: on a machine with no Chrome the provider's executable discovery throws
`browser_provider_unavailable` and the cases fail rather than skip. A green run of this suite is
therefore evidence that a real browser was present, and its absence from a run is **not** evidence
that the behaviour was checked.

| Case | Result | Evidence |
| --- | --- | --- |
| the Agent inspects the page and gets a reference it can act on | `measured` — pass | the reference is an opaque `browser-element:<generation>-<uuid>` |
| the Agent clicks the element the inspection named | `measured` — pass | the click lands on that element |
| the Agent types into the field the inspection named | `measured` — pass | the text reaches that field |
| a reference recorded before the page navigated is refused | `measured` — pass | refused with a stale-reference refusal — `STALE_ELEMENT_REF` or `STALE_SNAPSHOT` |
| a reference that is still current is accepted | `measured` — pass | the action runs |

**The bridge — the wiring, with a double.**
`packages/webui/test/unit/browser-bridge-core-actions.test.ts` drives the same core action path over
the bridge. The extension is a **test double**, so these cases establish that the bridge routes an
action through the core and answers it, and **not** that a real browser performed them.

| Case | Result | Evidence |
| --- | --- | --- |
| the core's action path runs over the bridge | `measured` — pass | the bridge's `cdp` frames carry the commands |
| a reference recorded before the tab navigated is refused | `measured` — pass | refused with a stale-reference refusal — `STALE_ELEMENT_REF` or `STALE_SNAPSHOT` |
| a reference stays usable while the tab has not navigated | `measured` — pass | the action runs |
| a screenshot is answered with the picture the extension streams | `measured` — pass | the frame the extension pushed is the answer |
| a screenshot of a tab that is not the one in front is refused | `measured` — pass | refused with `browser_capability_denied`, and not answered with another tab's picture |

**The vocabulary cannot drift.**
`packages/webui/test/unit/browser-restricted-commands.test.ts` holds only actions the runtime's
contract declares, holds every action the runtime's aggregate tool accepts, and lists each action
once. It is a pure-behaviour guard over the 28-name vocabulary.

**Not covered by any of these:** `upload_files` on the bridge. The vocabulary test names the action
and nothing asserts the refusal, so the bridge's `upload_files` gap is a **capability difference
without a test pinning it**.

## Reproducing this

```sh
pnpm test:webui          # the isolated-Chromium cases (Vitest)
pnpm test:webui-browser  # the real-browser, real-external and real-packaged cases (Playwright)
```

Both write their records to `.plan/browser-use/complete/`. The records are tracked and published
alongside this document; the rows above are the published copy of them.

A machine without the **installed** Edge cannot run the Edge cases: they are skipped with the
reason, not failed on a browser that was never there. The bundled Chromium is installed by the
gate itself, so the Chromium cases always run. The record names the browser each case ran in, and
this document names the host the rows above were measured on.
