# Verification

Gate commands, what each one rejects, and the browser suite's own rules live in
`packages/webui/docs/verification/{gates,browser-suite}.md` — read them rather than a copy of them. This
file holds only the traps in running those checks and the boundaries of what the evidence proves.

## Traps in running the checks

- **The fixture port is shared.** It is hard-coded in `playwright.config.mjs` and `test/browser/server.mjs`
  and used by every session on the machine. Check it before blaming a change: a run ending in
  `ECONNREFUSED`, or a missing server id in the harness `afterEach`, is a scheduling collision, not a
  result. Run the non-browser gates, then re-run the spec unchanged once the port is clear.
- **A browser observation is only about the current build.** The dev entry serves the prebuilt bundle and
  the client script carries no cache headers, so a plain reload after a rebuild still runs the old
  `client.js`. Build (`pnpm build:webui`; `pnpm --filter @mavis/webui build:styles` for CSS), then navigate
  with `?cachebust=<Date.now()>` before treating an absent element as evidence. Never drive the user's
  running instance: their page cannot separate a wiring bug from a stale bundle.
- **`check:webui-presentation --accept-review` records the whole tree**, so it cannot run while another
  session's edits are in flight. Check whether *your* module is in the `REVIEW REQUIRED` list (cross-check
  `git status --porcelain`; a flagged file you never touched is someone else's drift) and report the list.
- **The accessibility gate fails in both directions.** `test/browser/rendering-integrity.spec.mjs` produces
  contrast, `target-size` and `aria-required-children` findings; `test/gates/webui-accessibility-gate.test.ts`
  proves the dispositions. An undispositioned finding fails, and a recorded finding that has gone also
  fails — so a fix requires updating the recording in the same change.
- **A new Vitest file must join the `webui` group in `test/vitest-suites.json`**, or no gate ever runs it.
  For a focused run use the root config:
  `pnpm exec vitest run --config vitest.oss.config.mjs <file>`.

Aggregate gates (`pnpm verify`, `pnpm test:webui`, the full browser suite) are not the default for a local
change. `pnpm lint` is not a WebUI ESLint gate. Build artifact checks need a current build: Vite
development behavior is not the shipped esbuild artifact.

## What each kind of evidence establishes

| Evidence | Establishes | Does not establish |
| --- | --- | --- |
| Pure unit behavior | Reducer, projection or mechanism contract | Assembly, DOM or wire |
| Assembled application with injected capabilities | Owner/command/lifecycle collaboration | Real loopback or host |
| `loopback-harness-path.test.ts` | Real service, socket, envelope, registry and event delivery with a scripted leaf | A real provider or account |
| Built-browser fixture | Rendering, navigation and interaction of the built client | Actual service, host or cloud behavior |
| Production host with a controlled model endpoint | Real local host and turn path to that endpoint | Real provider authorization |
| `native-runtime.spec.mjs` | Production host/service and native PTY on the platform that ran it | Other OSes, real account |

The three browser-bridge suites are easy to double-count: `integration/browser-core-agent-actions.test.ts`
drives a real Chromium and needs one; `unit/browser-bridge-core-actions.test.ts` proves the wiring with the
extension as a test double; `unit/browser-restricted-commands.test.ts` proves only that the vocabulary
cannot drift.

HTTP 200 or a listening socket is not browser readiness, a screenshot is not interaction coverage, and one
scenario's native coverage does not make the rest of the fixture suite native. For behavior preservation —
markup, wire payloads, effective CSS — use [module-refactor.md](module-refactor.md)'s evidence layers, and
a targeted mutation only where consolidating ownership demands proof.

## Delivery scope

This is a reviewed public source projection: the source inventory scans untracked files, so keep scratch,
reports and browser output outside the repository. Do not add real sessions, accounts or credentials, and
review any added asset's provenance and license. Documentation and commit messages are English; product
localization stays as it is.

Authorization is explicit and narrow: coding or creating this skill is not permission to file issues, open
PRs, push, or change production. Follow the repository's delivery workflow when a delivery is actually
requested.
