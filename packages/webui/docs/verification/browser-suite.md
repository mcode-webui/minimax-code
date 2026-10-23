# The built-client browser suite

`pnpm test:webui-browser` drives the built client — `dist-webui/client/index.html`, `client.js`,
`styles.css` and files under `assets/` — in a real browser. The deterministic harness server serves
those built assets from the client output directory and refuses paths outside that directory. Run
`pnpm build:webui` first; the script installs the
lockfile-pinned Chromium revision when it is missing, and on Linux also installs Chromium's system
dependencies, which include the CJK fonts the Chinese UI renders with. The deterministic cases are
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
rendered ordering and persisted history. It does not currently exercise a runtime environment change,
tool-driven file write, embedded-browser operation during an active turn, `/plan`, `/goal`, Ask User,
fork isolation, cancellation or retry. Those are outstanding integration journeys in the active
strategy plan; the fixture-backed cases remain client evidence only.

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
message and title in the fixture request, then verifies navigation to the returned session. These
fixture-backed interactions do not establish runtime fork isolation; that integration journey
remains to be added.

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

## Determinism

Playwright uses one pinned Linux viewport (1440×900, DPR 1, `zh-CN`, `Asia/Shanghai`, light colour
scheme, reduced motion). `visual-baselines.spec.mjs` keeps ten Linux Chromium screenshots across
eight cases beside the spec for the shell/session rail, transcript/composer, settings dialog,
progress panel, embedded browser panel, composer command overlay, plugin marketplace, Skill
marketplace, Skill management list and MCP management list. `plugin-catalogue-layout.spec.mjs`
adds four Linux screenshots for the add Skill, create Agent, add MCP Server and Git import dialogs.
Together the repository keeps 14 representative screenshots. The shell case asserts that built
image assets finish loading successfully. The tests also assert relevant DOM state and viewport
geometry; screenshots are not the sole oracle. These are deterministic fixture renders with
synthetic session content, not user workspace or account data. Review image diffs on the pinned
Linux Chromium revision before accepting baseline changes. Build before either browser command:

```sh
pnpm build:webui
pnpm test:webui-browser
```

The screenshots are only comparable within one font environment. The gate installs Chromium's
Linux system dependencies, which include the CJK fonts the Chinese surfaces need; on a runner
without them the browser has no glyph to draw for Chinese text and renders tofu boxes instead.
The committed baselines therefore record real Chinese glyphs, and a reviewer reading a diff can
read the Chinese in it. The same applies in reverse: regenerating the baselines anywhere that
does not install those fonts produces boxes, and the comparison against the committed baselines
fails. Treat a font change on the runner as a baseline change, not as a rendering difference to
be accepted.

To deliberately regenerate only these baselines, use
`pnpm exec playwright test packages/webui/test/browser/visual-baselines.spec.mjs --update-snapshots`
on Linux CI Chromium, inspect every resulting image, then run the same command without
`--update-snapshots` to compare. Regenerate on a Linux environment that has the gate's fonts
installed — `pnpm exec playwright install --with-deps chromium` before the run — so the new
baselines carry the same glyphs the committed ones do. A passing fixture screenshot proves the
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
in-page transport only. The separate real-host MCP list case is in `real-host-loopback.test.ts` and
does not constitute a browser-to-runtime page test or a live server connection.

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
