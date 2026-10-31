# The built-client browser suite

`pnpm test:webui-browser` drives the built client — `dist-webui/client/index.html`, `client.js`,
`styles.css` and files under `assets/` — in a real browser. The deterministic harness server serves
those built assets from the client output directory and refuses paths outside that directory. Run
`pnpm build:webui` first; the script installs the
lockfile-pinned Chromium revision when it is missing, and on Linux also installs Chromium's system
dependencies. The fonts the Chinese UI renders with do not come from those dependencies: the gate
loads the font files committed under `packages/webui/test/browser/fonts/`, so the rendering does
not depend on what the machine has installed (see [Determinism](#determinism)). The deterministic cases are
evidence level 4 in
[`gates.md`](gates.md): the built client and its transport wiring are real, the server behind them is
not in the deterministic fixture cases. `native-runtime.spec.mjs` additionally boots the real
assembly, loopback service and native PTY bridge in a separate process with an isolated,
credential-free data directory. It serves the same built client in explicit loopback development
mode. It verifies process ownership and shutdown, not credential or provider authentication.

## What the fixture does

The workspace progress cases include a fixture-backed `workspace.git.changed` update: they change
the environment response, emit the runtime event shape, then assert that the built client re-reads
and renders the new branch and line counts without a page reload. This verifies client invalidation
and rendering only. The current local-runtime transcript integration covers a real composer send,
streamed reasoning and answer, page reload, cursor-based `resumeSession`, queueing during the active
turn, runtime queue drain, a production `todowrite` model tool call reflected in the progress card,
rendered ordering and persisted history. It also selects a real `@` suggestion and stages a synthetic
file through the mounted composer, then verifies reference and bytes at the local deterministic model
endpoint plus persisted/rendered response. The same integration also drives `/plan`, `/goal`, Ask User
continuation, copy/fork followed by a fork-only composer turn, and assistant/user row actions. For
rewind it confirms “仅回退对话” on a persisted user row without leaving the mounted session, then
checks the operation response, persisted history and rendered transcript. It next opens the inline
editor for a surviving user row without reloading, checking that message controls remain usable after
the rewind. It also checks message edit, copy and feedback controls. `real-host-loopback.test.ts` additionally drives the mounted Plugins →
Manage → MCP surface and Add MCP Server form against the production local runtime, saving a disabled
synthetic server. These do not establish an external MCP handshake. The production-host transcript
journey also clicks Stop during an active streamed turn, observes the `abortSession` wire
request/runtime settlement and absence of late content in the transcript and persisted history,
then sends a follow-up in the same session and observes recovery. It drives an actual Agent file write
through the runtime, observes the workspace event, the new environment read and rendered diff count,
deliberately disconnects `watchEvents`, waits for a fresh watch request and acknowledgement, and
confirms subsequent environment updates still reach the UI. A separate local model failure returns an
error through the runtime event socket; the mounted UI must show Retry, preserve the error only in its
owning fork while switching sessions, then retry through the composer and persist the successful
answer. The Agent/todo/browser overlap is a concurrency check, not a causal workflow: the integration
separately asserts runtime `todowrite` → rendered progress item and mounted browser control/input →
production browser service → local Chromium page result. While the model reply is held, it verifies
the Agent turn remains active and the todo remains visible during the browser action. Neither feature
triggers the other. The fixture-backed cases remain client evidence only.

The fixture replaces the browser's `WebSocket` constructor before the built client script executes.
The client's normal `createWebuiTransport` path then sends real WebUI wire envelopes to the
deterministic in-page fixture. Session ids, messages, timestamps, cursors and stream events are
synthetic. This covers the built browser client and its transport wiring; it does **not** start the
production WebUI service or a runtime host. The native spec installs no fixture transport;
it verifies cross-page attach/detach, delayed create response, reload at five-process capacity,
explicit close and actual native exit events at service shutdown. It requires working `node-pty`
and runs in the browser gate, after the client build and Chromium installation.

Live and completed turn visibility is asserted from controlled stream frames while the indicator
remains unmodified.

The composer spec selects `/compact` from the slash palette, adds an instruction, and asserts the
`runCommand` request body at the fixture transport. This checks built-client behavior only; a
production command-runner journey is not currently covered by `agent-transcript.test.ts` or another
WebUI integration test.

The transcript spec exercises assistant copy, feedback toggles and message-level fork through the
built client. Copy uses Chromium's clipboard API; the fork case checks the selected assistant
message and title in the fixture request, then verifies navigation to the returned session. The
separate `agent-transcript.test.ts` integration also checks one fork-only follow-up message against
persisted source/fork histories and confirms the same-session rewind/edit result through the
production local boundary. Neither case proves behavior in a user's already-open account session.

## The browser family in the fixture

The fixture answers the **browser** operations too, with a synthetic browser: the switches
(`getBrowserAuthorization`, `setBrowserAuthorization`), the surfaces (`listBrowserCapabilities`), the
session's web tabs (`watchBrowserWebTabs`, `openBrowserWebTab`, `closeBrowserWebTab`), the page
(`watchBrowserFrames`), and the gestures and commands aimed at a page (`sendBrowserInput`,
`sendBrowserCommand`, `listBrowserTargets`, `selectBrowserTarget`). A test stages what the browser
holds with `window.__fixture.setBrowserTabs(...)`, marks the Agent's page with
`window.__fixture.setBrowserSelection(targetId)`, and turns a surface off with
`window.__fixture.setBrowserAuthorization(...)`.

The page the fixture paints is drawn by the fixture itself: a white sheet with the tab's title and
url on it. A one-pixel image would prove that the image path works and nothing else — a screenshot
of the panel would show a grey box — so the panel shows the page the test asked for.

What this proves is the **client's** half: that the panel draws a window, that the strip and the
toolbar follow what the runtime published, that the page the Agent is on is named where a browser
has no such mark, and that a gesture lands on the page in front. It does **not** prove the
runtime's browser behaviour. The isolated Chromium, the extension and the bridge are proven by the
runtime's own integration suites and by `browser-bridge-real-*.spec.ts`, which launch a real
browser instead of answering from a page.

`test/integration/browser-panel-live-navigation.test.ts` is part of the repository's
`test:webui` Vitest gate. When system Chrome is available, it runs the real isolated Chromium,
browser service, CDP pointer and keyboard input, target registry and screencast against two
temporary HTTP origins. The scenarios cover typing and submit clicks, scrolling, same-origin and
cross-origin same-tab links, stream resubscription after navigation, back/forward/reload, and a
cross-origin `target="_blank"` page. The two local origins make navigation repeatable without
depending on a public site's markup, network availability or anti-bot responses. It skips on
machines without a system Chrome executable. This runtime integration complements the
`browser-workspace.spec.mjs` client-panel fixture; neither by itself proves a packaged desktop
application or a user's logged-in Edge/Chrome session.

## Rendering integrity of a migrated surface

`rendering-integrity.spec.mjs` measures each surface ADR 0028 migrates instead of trusting a pixmap:
an element is present, is sized, lies inside its container and does not escape the viewport
sideways, no item rendered with no size outside its surface, and the surface does not clip its own
content. Each surface declares the content extremes it can reach — empty, one, the maximum it lists,
and the longest label it can show — and every state is measured in both themes.

The measurement is compared with `support/rendering-integrity.json`, recorded before the migrations
started. Re-record with `RECORD_RENDERING_INTEGRITY=1 pnpm test:webui-browser rendering-integrity`,
deliberately and in the same commit as the change: the recording is the before-and-after evidence, and
re-recording it by habit turns the comparison into a description of the current state. Text extent is
recorded rather than required to be perfect on the first recording, because a rail row ellipsizes a
long title by design; what the comparison catches is one more clipped label after a migration.

A surface whose declared extremes are not enumerated is reported as **unverified**, and the report is
printed on every run. It is not a pass.

## Determinism

Playwright uses one pinned Linux viewport (1440×900, DPR 1, `zh-CN`, `Asia/Shanghai`, light colour
scheme, reduced motion). `visual-baselines.spec.mjs` keeps ten Linux Chromium screenshots across
eight cases beside the spec for the shell/session rail, transcript/composer, settings dialog,
progress panel, embedded browser panel, composer command overlay, plugin marketplace, Skill
marketplace, Skill management list and MCP management list. `plugin-catalogue-layout.spec.mjs`
adds four Linux screenshots for the add Skill, create Agent, add MCP Server and Git import dialogs,
and `responsive-baselines.spec.mjs` adds ten more for the shell and the workspace panel across the
widths the layout contract covers. Together the repository keeps 24 representative screenshots.
The shell case asserts that built
image assets finish loading successfully. The tests also assert relevant DOM state and viewport
geometry; screenshots are not the sole oracle. These are deterministic fixture renders with
synthetic session content, not user workspace or account data. Review image diffs on the pinned
Linux Chromium revision before accepting baseline changes. Build before either browser command:

```sh
pnpm build:webui
pnpm test:webui-browser
```

The screenshots are comparable across machines, because the gate does not read the host's fonts.
The font files under `packages/webui/test/browser/fonts/` are committed to this repository, and
`scripts/lib/webui-font-environment.mjs` writes a fontconfig that exposes only those files. The
browser is launched with `FONTCONFIG_FILE` pointing at it, so every name in the client's font
stack resolves to a committed face. The fontconfig also selects grayscale antialiasing, because
LCD subpixel rendering colours the glyph edges and that fringe depends on the display's subpixel
layout and on the host's fontconfig version. A machine with no CJK font installed and a machine
with a full set of them therefore render the same bytes: the recorded baseline is a property of
this repository, not of the runner.

That also removes the trap the previous arrangement carried. The gate used to depend on the CJK
fonts that `playwright install --with-deps chromium` pulled in, so the installed set changed with
the CI image and a runner without them rendered tofu boxes — a baseline change that was not a
change in the WebUI. The committed baselines record real Chinese glyphs, and a reviewer reading a
diff can read the Chinese in it.

The pixel comparison itself allows a small budget. The rasterizer's rounding at a rounded corner
is not perfectly reproducible: a bubble's right edge lands on a fractional pixel, and whether it
rounds up or down shifts a handful of antialiased pixels from run to run. Measured over repeated
runs, the widest such shift is seven pixels. The budget is therefore `maxDiffPixels: 8`, under
0.001% of a 1434×900 capture, and it cannot hide a layout change: shifting one bubble edge by a
single pixel already changes nineteen pixels. The DOM and geometry assertions in the specs are
not subject to this budget and carry the structural claims.

To deliberately regenerate only these baselines, use
`pnpm exec playwright test packages/webui/test/browser/visual-baselines.spec.mjs --update-snapshots`
on Linux CI Chromium, inspect every resulting image, then run the same command without
`--update-snapshots` to compare. The font environment is part of the gate, so no extra setup is
needed to regenerate the baselines — the same files produce the same bytes anywhere. A passing
fixture screenshot proves the
built client's rendered
state under the in-page deterministic transport; it does not prove the production service or runtime
path. Those boundaries require the integration suites described above.

The plugin, Skill and MCP browser cases use the mounted catalogue and management flows. They cover
marketplace card layout and expand/collapse, plugin install/enable/uninstall, Skill marketplace
install and composer menu insertion, Skill create/enable/delete, and MCP create/enable/edit/delete.
MCP rows assert connected, idle,
disabled, unavailable and failed states, including the visible server-specific failure reason and
its secondary-text contrast. Late MCP-detail and Git-preview responses are checked against a changed
selection/dialog, and an accepted Git import remains settled after its dialog closes. These cases
use synthetic catalogue responses and the in-page transport; they prove the built UI and request
envelopes, not marketplace downloads, filesystem changes, production plugin runtime calls, live MCP
connections or external accounts. The application workflow tests cover the other declared plugin
operations through their production owner and injected operation port. The action inventory
documents the only declared action without a client caller (`listRuntimeSkills`); no browser control
is invented for it.

The four create/import dialog cases click their actual management controls. They verify `role=dialog`
and `aria-modal`, a fixed backdrop covering the viewport, centered dialogs, aligned fields,
responsive fit at 390×844 (including a settle-on-resize geometry assertion), usable input widths,
backdrop cancellation, successful submission and visible validation failure. Agent and Skill fields
are checked against the request envelope; MCP switches stdio to HTTP and verifies invalid timeout
refusal plus advanced headers/timeout in the successful request; Git preview uses a local synthetic
fixture result and makes no external request. These browser cases exercise the mounted client to the
in-page transport only. A separate Chromium integration case in `real-host-loopback.test.ts` serves
the built client through the production `WebuiService` in explicit loopback development mode and uses
the production runtime adapter and persisted local settings. It clicks Plugins → Manage → MCP,
checks the returned list and visible error absence, opens the actual Add MCP Server dialog, measures
the fixed overlay, centering and field/control alignment at 1440×900, and submits a disabled synthetic
stdio entry that appears in the reloaded list. Development mode is needed because relative static
asset requests do not carry the service token; the host, adapter, operation registry, WebSocket
service and settings path remain real. It does not launch the disabled process or prove an MCP
handshake or external server.

The harness starts with a random server id, and every test asserts that both `/health` and the served
page report **this run's** id. That assertion is registered on the `test` that `harness.mjs` exports,
so a spec gets it by importing `test` from there instead of from `@playwright/test` — it cannot be
left out by a new spec, and a test that runs against any other build fails instead of passing
quietly.

Playwright starts its own harness server on port 4179 and reuses an already-running one only when
`WEBUI_BROWSER_REUSE=1` is set. Without it, a busy port is an error rather than a silent adoption of
whatever process happens to answer there. Set `WEBUI_BROWSER_SERVER_ID` as well to give a
deliberately reused server a known id that matches the run. CI never reuses either way.

## Layout

The fixture-backed suite lives in `packages/webui/test/browser/`: one `*.spec.mjs` per surface, plus
`harness.mjs` (page helpers — fixture configuration, session switching, stream emission, selectors)
and `fixture.mjs` (the deterministic in-page transport). The `.spec.ts` real-browser bridge files
use `real-browser-bridge.ts` instead of the fixture and record their launched browser version and
extension identity. They explicitly skip Edge cases when the installed Edge executable is absent;
Chromium is supplied by the pinned Playwright install. Run the directory rather than a hand-kept
list: Playwright collects every spec in it.

## Protocol startup acceptance

The browser reads the version handshake before constructing business owners. An incompatible
protocol renders the startup fallback without installing event ingress. An absent optional Terminal
bridge remains a local availability state and allows the other businesses to start. The capability
browser cases cover absent, not-ready, missing legacy roster, permission refusal and readiness after
reconnect. The provider case holds the first write while a second toggle changes pending intent.
