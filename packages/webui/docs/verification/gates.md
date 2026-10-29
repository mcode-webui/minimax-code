# Gates and evidence

What this package's gates prove, what they do not, and the evidence levels a claim has to name.
Passing CI is not the same as having exercised a live service. The built-client suite has its own
document: [`browser-suite.md`](browser-suite.md).

## Gates

`pnpm verify` runs these in this order (`scripts/verify.mjs`); it is the same set CI runs.

| Gate | Proves | Fails on |
| --- | --- | --- |
| `pnpm typecheck:webui` | Every source file and every test file compiles under `strict`: the server/runtime/shared config, the client config, and one test program whose `include` is the whole `test/` and `src/` tree | A port member without its stub, a missing binding, a wrong DTO, a test fixture that no longer matches the signature it calls |
| `pnpm check:webui-dependency` | Import direction and role ownership over the resolved source graph, including `import type` edges | A forbidden direction, a role violation, a business holding one role in two homes, a private cross-business import, or an unclassified source |
| `pnpm build:webui` | The client and server bundles build, and prints input counts | A module that is written but not wired (counts do not move) |
| `pnpm check:webui-boundary` | The combined client/server build graph contains required entries and inputs within declared package roots; direct WebUI workspace imports use exported subpaths; the artifact integrity record matches current inputs and outputs | A retired source path, the terminal renderer, a private direct workspace import, a forbidden internal reference, or a stale/modified build artifact |
| `pnpm test:webui-package` | The packaged artefact runs as published | Packaging drift |
| `pnpm test:webui` | The registered WebUI Vitest group (unit, integration and verification-gate tests) | Behaviour change, unregistered new test file |
| `pnpm test:webui-browser` | Every Playwright spec collected under `packages/webui/test/browser/`: the built client and deterministic in-page transport, plus explicit real-browser bridge and production-host/native-PTY harnesses. The screenshot comparisons run against the font files committed under `packages/webui/test/browser/fonts/`, so their result does not depend on the fonts the machine has installed | Behaviour change in the built bundle, a real bridge path, or native lifecycle |
| `pnpm check:source` | `release/public-source.json` lists exactly the delivered files | A new, moved or deleted file without inventory regeneration |

`pnpm check:webui-dependency` reads the resolved source graph; `pnpm check:webui-boundary` reads the
combined esbuild metafile. The dependency check enforces import direction, including type-only edges,
while the boundary check validates the aggregate build inputs and artifact integrity. Because the
build script merges client and server metafile inputs, the boundary check does not independently
attribute each input to a particular output. The dependency check rejects new direction violations
and stale baseline entries; the current direction baseline is empty. Its separate structural
allowance records the non-literal runtime import described in
[`../architecture/boundaries.md`](../architecture/boundaries.md). That document states the rules these
gates enforce.

## Evidence levels

Name the level a claim was established at. The levels are not interchangeable, and a lower level
never proves a higher one.

| Level | What it is | Established by |
| --- | --- | --- |
| 1 | Pure behaviour | Unit tests over projections, reducers and mechanisms — no DOM, no transport |
| 2 | Assembled application behaviour | `test/unit/*application*`, `*workflows*`, `*commands*`, creation/adoption and lifecycle suites, with injected capabilities, storage and channel |
| 3 | Real boundary behaviour | `test/integration/loopback-harness-path.test.ts`: a real service, real loopback socket, real envelope, dispatcher and registry, a real `watchEvents` delivery, drop-and-reconnect, and a close that refuses further connections |
| 4 | Built-browser behaviour | `pnpm test:webui-browser`: rendered built client, navigation, multi-page interaction and recoverable zone failures. Fixture-backed specs use a deterministic in-page transport and do not prove the production service/runtime path. |
| 5 | Real local product boundary | `agent-transcript.test.ts`, `real-host-loopback.test.ts`, `real-host-model-turn.test.ts`, `miniapp-real-flow.test.ts`, `miniapp-ui-flow.test.ts`, the real Chromium navigation integrations, `browser-core-agent-actions.test.ts`, explicit real-browser bridge specs, and `native-runtime.spec.mjs` on the executing host. These prove only the named local boundary and platform; they do not prove cloud accounts, live external providers or other platforms. |

### The Mini App suites

Two suites cover the Mini App business flow, and they are at **different** levels — the difference
matters when a claim is written about them.

| Suite | Level | What it proves |
| --- | --- | --- |
| `test/integration/miniapp-real-flow.test.ts` | 5 — the real host | a Mini App package becomes installed in an isolated data directory, appears in the catalogue, starts a real runner child process, serves its own page through the real proxy, stops, refuses to start when it cannot, is disabled and enabled, and is uninstalled. The publication of the package is the file move the real importer performs; the network fetch that precedes it in the product is out of scope for a hermetic gate |
| `test/integration/miniapp-ui-flow.test.ts` | 5 — the real host and a **real** browser | the management surface's buttons against the built client: 打开 starts the Mini App, 查看 opens the standalone tab and the Mini App's page renders in it, 停止 stops it, 停用 takes a **local** package out of the startable set, 启用 puts it back, and 卸载 drops it from the catalogue — the mutation path a local package takes, with the plugin source the runtime needs to choose it |

**Not covered:** the catalogue's 应用 area has no row for a Mini App owned by another client, so the
"another client is running this" presentation and the 停止 button beside it are unpinned.

### The browser's own suites

Three suites cover the Browser Core layer, and they are at **different** levels — the difference
matters when a claim is written about them.

| Suite | Level | What it proves |
| --- | --- | --- |
| `test/integration/browser-core-agent-actions.test.ts` | 5 — a **real** Chromium | the Agent's `inspect` → `click` → `type` run through the core against a real browser, and that a reference recorded before a navigation is refused while a current one is accepted. It **requires** a browser: unlike the other Chromium suites it does not use `describe.skipIf`, so on a machine with no Chrome it **fails** rather than skips |
| `test/unit/browser-bridge-core-actions.test.ts` | 2 — assembled, with the extension as a **test double** | the bridge routes a restricted action through the core, the navigation fence holds, and a screenshot is answered with the frame the extension streams — and refused for a tab that is not in front. It proves the **wiring**, not a browser's behaviour |
| `test/unit/browser-restricted-commands.test.ts` | 1 — pure behaviour | the 28-name restricted vocabulary cannot drift: it holds only actions the runtime's contract declares, holds every action the runtime's aggregate tool accepts, and lists each action once |

**Not covered:** `upload_files` on the bridge path. The vocabulary test names the action and nothing
asserts the bridge's refusal, so that capability difference is unpinned.

See [`../browser-use/10-browser-core-integration.md`](../browser-use/10-browser-core-integration.md).

Deterministic loopback tests replace the leaf host, and deterministic browser tests replace the
server transport. Their levels do not imply native execution. `real-host-loopback.test.ts` and
`real-host-model-turn.test.ts` additionally use the production host; the latter controls only its
external HTTP model endpoint. The current `agent-transcript.test.ts` is a built-Chromium real-path
journey: a user sends a message through the WebUI socket, production service and runtime adapter into
an isolated persisted session; a local model stub streams reasoning and holds its answer while the
page reloads. The user queues a second message through the real composer during that turn. The test
observes the queue across refresh, the `resumeSession` cursor, resumed transcript, runtime queue drain
and ordered persisted messages. A third composer turn asks the stub model to call production
`todowrite`; the test observes its tool label, resulting todo in the rendered progress card, and
persisted runtime history. This proves refresh/resume, one queued-send path and one runtime
todo-to-panel path. A later composer turn selects an actual `@` suggestion, stages a synthetic
attachment through the mounted file input, verifies its exact bytes and reference at the local model
request, then asserts the response in persisted history and transcript. Later turns cover runtime
`/plan`, `/goal`, Ask User continuation, a fork-only follow-up and same-session row actions. A
confirmed rewind refreshes the selected transcript from production history; the integration checks
that the message disappears from the mounted transcript and persisted history without route change,
then opens the inline editor for a surviving user row in the same mounted session without a reload.
The real-path integration checks the Agent/todo/browser overlap as concurrency, with independent
assertions for `todowrite` → progress panel and mounted browser input → production browser service →
local Chromium page. While the deterministic model response is held, the Agent turn stays active, the
todo remains visible and a user click/type reaches the synthetic page. The todo does not trigger the
browser action and the browser action does not produce the todo. The same production client/runtime
journey clicks Stop during an active turn, checks the `abortSession` request, runtime settlement and
absence of late content from rendered/persisted history, then submits a successful follow-up in the
same session. It also exercises an actual Agent file write → runtime workspace event → environment
request invalidation → rendered diff count, a forced `watchEvents` disconnect/reconnect, and a local
model failure → visible error → same-session Retry recovery. While the fork carries the error, the
test switches to the source session to check error isolation, returns to the fork, retries and confirms
the persisted answer. These are named local integration journeys; they do not establish every
workspace mutation type, every reconnect race, packaged desktop behavior or an already-open user
session. The fixture-backed browser specs prove their named built-client interactions separately;
they do not upgrade those flows to runtime integration evidence.
The fixture-backed browser specs prove
their named built-client interactions separately; they do not upgrade those flows to runtime
integration evidence.

Several Vitest integration suites launch a system Chromium and use `describe.skipIf` when none of
their supported executable paths exists. In a skip, their real-browser assertions are untested even
though the rest of `test:webui` may pass. The Playwright bridge specs similarly skip Edge-specific
cases when the installed Edge executable is missing. Report those skips from the actual gate output;
do not infer their execution from the suite or file being registered.

**One suite does not skip, and that is the point.** `browser-core-agent-actions.test.ts` uses a plain
`describe`, so on a machine with no Chrome it fails rather than skipping. Its file header says the
suite skips when the browser is missing, and the header does not match the code. A green run of
`test:webui` therefore *does* imply that a real Chromium was present for that suite — but only
because it fails otherwise, not because it reports a skip.

Other current browser cases exercise their named UI interactions against deterministic fixtures.
For example, the transcript spec covers built-client message actions and fixture-backed fork
navigation, while workspace-progress and embedded-browser specs render fixture events and route
controls to the in-page transport. They do not prove runtime delivery. The separate local integration
claims above are supported only by their production service/runtime/persisted-session paths; do not
infer those boundaries from fixture coverage.
`native-runtime.spec.mjs` starts the production host/service in a separate process and verifies real
native PTY ownership, output and exit events, providing level-5 evidence for that local terminal
path on the executing platform. State the specific seam and platform instead of extending a green
gate's conclusion to those boundaries.

The Plugins zone has built-client coverage in `plugin-catalogue-layout.spec.mjs`,
`plugin-mcp-status.spec.mjs`, and `visual-baselines.spec.mjs`. The Playwright cases use the real
mounted catalogue/forms and assert visible list, status and dialog results plus the emitted
`pluginManagement` request envelopes. Their catalogue, Skill and MCP responses are synthetic
fixture data. This is level-4 UI and request-wiring evidence; it is not a marketplace call, a real
filesystem install, a production plugin runtime operation, or a live MCP connection. Plugin
workflow Vitest cases separately exercise the production workflow owner with injected operation
ports, and server operation tests validate the accepted action/input contract. No current gate
claims a production-runtime-to-installed-plugin or live MCP journey. The action inventory records
the supported action set and identifies `listRuntimeSkills` as the one action without a client UI
caller.

The add Skill, create Agent, add MCP Server and Git repository import controls are clicked in the
built browser suite. Those cases assert dialog semantics, full-viewport fixed overlay and centered
geometry, desktop field alignment, 390×844 constrained viewport fit, field widths, cancel/backdrop
dismissal, validation, successful request payloads and close-after-save behavior. The MCP case also
switches transport and checks advanced HTTP headers and timeout. Linux screenshots accompany each
dialog. These remain level-4 UI/request evidence because the browser transport uses the in-page
fixture. `real-host-loopback.test.ts` separately exercises production MCP listing through the real
runtime adapter, operation registry, WebuiService and loopback WebSocket, then decodes the response
with the production client codec. A separate Chromium case in the same file serves the built client
through that production service in explicit loopback development mode, clicks Plugins → Manage → MCP,
checks the actual empty list and absence of the result-shape error, opens Add MCP Server, asserts
overlay/centering/field geometry at 1440×900, and submits a disabled synthetic stdio entry that
reappears in the list. The development mode allows relative static assets that do not carry the
service token; the host, operation registry, service, adapter and persisted local settings are real.
The disabled MCP process is not started, so this does not prove a live MCP connection. Live
marketplace, plugin installation and external MCP service behavior remain outside the default gates.

Linux visual baselines include the plugin marketplace and Skill marketplace card grids, Skill
management rows, and MCP management rows. The browser tests assert grid columns and visible/in-view
geometry independently from the screenshots. The MCP failure reason must render using the
secondary-text token; a browser-level computed-style assertion guards that contrast contract.

## Comparison methods

When a change is supposed to preserve behaviour, the comparison — not the green suite — is the
evidence:

- **Moved bodies: AST equivalence.** Compare function bodies between revisions with the repository's
  own TypeScript compiler API. A hand-rolled brace matcher silently skips declarations whose
  parameter types contain a nested `)` (for example `raw: import("ws").RawData`) or whose name is a
  `#`-private, and then reports "no differences" for a file it barely compared. Normalise relative
  import depth (`./x.js` vs `../x.js`) but keep the target module in the comparison.
- **Wire compatibility: bytes, in order.** Compare frame count, frame order and the UTF-8 payload
  bytes (`Buffer.from(payload, "utf8").equals(...)`). Never parse-and-sort JSON first: that hides a
  reordered frame and a changed key order. Compare the capability calls, the abort signals and the
  iterator finalisation, not only the payload.
- **CSS: effective declarations.** Rebuild, then compare the effective declarations rather than the
  bytes: the compiled stylesheet's hash is expected to move when shadowed declarations are dropped.
  `webui-design-tokens.test.ts` additionally hard-asserts that named component classes appear in the
  compiled stylesheet, so a class no markup references can still be pinned.
- **Consolidation: a mutation.** A preservation case may pass before and after. Prove the new
  implementation owns the behaviour with a targeted fault/mutation, or by removing the old path and
  watching the case fail, not by requiring every preservation case to fail on the baseline.

## Conventions

- **A new Vitest file must be registered** in the `webui` group of `test/vitest-suites.json`. It is an
  explicit list, not a glob; an unregistered file never runs.
- **A new, moved or deleted file must reach the inventory**: `node scripts/source-inventory.mjs
  --write` then `pnpm check:source`. Content-only edits do not need it. Review the added, removed and
  renamed paths before regenerating: recording a file does not make it publishable.
- **Never assert that a testid string exists.** Such an assertion survives every mutation and reads
  as manufactured coverage. Assert the visible or observable outcome instead.
- **Validators are asserted by code, not by message.** `webui-service.test.ts` checks the
  `invalidBody` code only, so a changed message or a relaxed predicate is invisible to the suite. Pin
  message text with `assert.deepEqual` when you touch a validator, and diff the old and new
  implementations with a throwaway probe rather than trusting the suite.
- **No DOM test framework.** Do not add jsdom, happy-dom or `@testing-library/*`, and do not change
  `vitest.oss.config.mjs` (`environment: "node"` is shared by every suite). Interaction coverage
  takes two shapes: extract the transitions into exported pure functions and test those, and assert
  each render branch through `renderToStaticMarkup`. Whatever SSR cannot reach belongs in the
  untested-boundary section of your report.
- **Work material stays outside the repository.** The inventory scans the working tree, so scratch
  committed inside the repository silently becomes a publication problem.

## What the boundary check asserts

`pnpm check:webui-boundary` reads `dist-webui/metafile.json` and applies one rule per assertion
(`scripts/lib/webui-boundary.mjs`): both entry points present; no retired source path
(`packages/local-runtime/src/http/`, `packages/local-runtime-v2/src/http/` and the rest of
`scripts/lib/retired-sources.mjs`); no terminal renderer (`packages/tui/src/tui`); no forbidden
internal hosts or embedded credentials in the inputs it reads from disk; no CLI entry module in the
combined inputs; no unapproved direct workspace import from WebUI source; and build inputs within
WebUI, declared workspace package roots, or `node_modules/`. The script is the authority for this
list; extend it there, with its own test, rather than in prose.
