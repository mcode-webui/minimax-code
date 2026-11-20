# WebUI-only GitHub CI

The public `mcode-webui/minimax-code` repository uses
`.github/workflows/webui-ci.yml` for pull requests, pushes to `main`, and manual
runs. It executes existing WebUI commands directly. It does not invoke the
repository-wide `pnpm verify` pipeline or publish packages.

An active run on `main` can finish while another run on `main` is pending.
Pull requests retain cancellation of superseded runs.

| Coverage | Linux / Node 24 | macOS / Node 24 | Windows / Node 24 |
| --- | --- | --- | --- |
| WebUI server, client and test types | Yes | Yes | Yes |
| Dependency, presentation, motion, overlay and feedback rules | Yes | Yes | Yes |
| WebUI build and bundle boundaries | Yes | Yes | Yes |
| WebUI unit and integration tests | Yes | Yes | Yes |
| Playwright browser scenarios | Yes | Yes | Yes |
| npm package build, installation and launcher verification | Yes | Yes | Yes |

Package verification uses an isolated installation and does not publish to npm.
Browser diagnostics and raw performance samples are retained as Actions artifacts
for seven days on successful and failed runs. Samples are written to the output
directory explicitly so the list reporter cannot discard in-memory attachments.
After a successful build and Chromium installation, browser checks still run if
unit tests fail. Package verification also runs after a successful build even if
an earlier test suite failed. Each failure still makes the job fail; this keeps
independent failures visible in one run instead of masking later suites.
The macOS job has a 60-minute budget because its unit and windowed browser
steps can consume the previous 40-minute job budget together. The browser step
has its own 30-minute limit so a stalled test run can still leave artifacts.
The development-server shutdown integration test reports bounded startup
phase timings on timeout or early exit. It omits child output, including the
credential printed by the launcher.
Linux additionally installs Chromium system dependencies. Every platform runs
the browser and package suites. This coverage declaration
does not establish a passing run; platform and visual-baseline failures remain
visible and require diagnosis rather than relaxed assertions.

Hosted macOS sets `WEBUI_BROWSER_HEADED=1` for the browser suite and runs full
Chromium in a window. Native blank-page controls reproduced headless frame-source
stalls without the WebUI; windowed mode improves pacing but does not eliminate
hosted-runner pauses. Streaming frame p95 is compared diagnostically with the same
page's idle samples before and after streaming, recording whether it exceeds idle
p95 plus 50 ms. The frame gate requires main-thread CPU p95 between consecutive
animation callbacks to stay below 50 ms, capturing cumulative work across tasks.
Raw frame gaps, timers and tasks are retained for investigation.
Application execution retains the absolute 50 ms budget: lightweight Chromium tracing
measures main-thread task CPU time, adding browser-recorded Long Animation Frame
script pauses to their owning tasks to reject synchronous JavaScript waits as well.
Raw script and LongTask wall durations
remain diagnostic because they can include hosted-runner descheduling. Missing timing
capabilities or required task/frame CPU samples fail explicitly. Real idle, busy-script,
forced-layout and synchronous-wait controls verify attribution in the browser suite.
Other interaction budgets are unchanged.
Linux, Windows and local runs remain headless by default. To reproduce
the macOS CI browser mode locally, run `WEBUI_BROWSER_HEADED=1 pnpm test:webui-browser`
after building the client and installing Chromium.

## Active and archived workflows

Two workflows are active in `.github/workflows/`: `webui-ci.yml`, the gate above,
and `update-visual-baselines.yml`, a manual dispatch that re-records the
per-platform screenshot baselines. The refresh runs the same specs on the same
three runners and commits what each of them produced, because a baseline can
only be regenerated on the platform that compares against it. It renders in
the browser mode the CI compares with — windowed Chromium on macOS — and it
cannot publish anything. The following inherited
workflows are archived under `.github/legacy-workflows/`: Source verification,
CLI release, Node compatibility, Performance,
Release audit, Source candidate, Label issue product, Sync GitHub issues to
Feishu, and WebUI npm preview. GitHub does not discover workflows in that
directory. Their content is preserved for recovery and the existing local
workflow-contract tests. npm publishing has no active workflow entry point.

The legacy workflows also remain disabled in repository settings, but the
source archive is what makes this scope portable to a new checkout or repository.
Restoring a legacy YAML file to `.github/workflows/` would restore its triggers;
the workflow-contract test rejects additional active YAML files.
Dependabot can still create dependency-update PRs; those PRs run WebUI CI.

The CI scope does not remove steps from local `pnpm verify` profiles or retire
local package commands. Run them locally when broader runtime, CLI, release or
security validation is needed. A green WebUI CI run does not establish those
broader checks. The previously reported repository-history scan findings are
outside this CI scope and have not been remediated by disabling Release audit.

Automatic CI does not impose merge protection. Required checks and branch rules
remain a separate repository setting.

## Manual WebUI npm release checklist

1. Check the published versions with
   `npm view @minimax-webui/minimax-code versions --json`. Set the next unused
   release version in `release/webui-npm/package.json` and include that change in
   the reviewed source revision.
2. Build from that revision with `pnpm package:webui-npm` and verify the exact
   release directory with
   `pnpm test:webui-package --package-dir dist-webui-npm`. Supply the Chrome store
   public key through `MAVIS_BROWSER_STORE_CHROME_PUBLIC_KEY` when building.
3. Check that the installed version reported by verification matches the version
   in the source manifest. After publishing the verified artifact, confirm the
   registry reports the same version for the intended dist-tag.
