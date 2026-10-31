# The external review of the workspace browser tab model

An independent review of this programme, run with the local OpenAI Codex through
**paseo** (`codex/gpt-6-luna`, `thinkingOptionId: high`), against the branch
`feat/workspace-browser-tab` and its base `origin/webui`.

The reviewer was asked for a read-only review: findings, not patches. It found
five, and the WebUI gate found a sixth. All six are fixed; the commit that
fixes them is `456f814c`, and the acceptance record and the capability matrix
were corrected with them.

## The invocation

The review is not only attested by the commit that fixed its findings. It was run like this:

| | |
| --- | --- |
| Started through | **paseo** (`mcp__paseo__create_agent`) |
| Agent | `40b1e2eb-b15d-4eb9-9bde-9f3137523157` |
| Workspace | `wks_ed83bdde5de1ebe1` |
| Provider and model | `codex` / `gpt-6-luna` |
| Thinking option | `high` |
| Mode | `auto` — Codex's default permissions |
| Codex session | `01a15f26-28d2-7271-9feb-20a0c79a0746` |
| Codex CLI | 0.162.0 |
| Directory | the branch's own worktree, `/home/fectivnfy/my_data/project/my_project/minimax-code-workspace-browser-tab` |
| Started / finished | 2026-10-21T15:48:18Z / 2026-10-21T15:57:47Z |
| Tokens | 176654 in (171904 cached), 3847 out |

The session's own transcript is on this machine at
`~/.codex/sessions/2026/10/21/rollout-2026-10-21T23-48-18-01a15f26-28d2-7271-9feb-20a0c79a0746.jsonl`.
It is not part of the published source — it is a session log — but it is the
record of what was asked and what came back. The prompt was this, verbatim:

```text
You are reviewing a completed feature programme in the MiniMax Code monorepo. **This is a read-only review: report findings, do not edit any file, do not commit anything, do not run the full test gate.** Read the code and reason about it; running a single focused test file is fine if it helps you confirm a finding.

## What to review

The branch `feat/workspace-browser-tab` in this repository, against its base `origin/webui`. Get the diff with:

    git log --oneline origin/webui..feat/workspace-browser-tab
    git diff origin/webui...feat/workspace-browser-tab

The programme is "the workspace panel is a browser tab strip" (ADR 0022). It turns the WebUI's right-hand workspace panel into a browser: a strip of tabs, where a tab is a stable slot whose content can be replaced in place, and a web tab holds a page of the isolated Chromium.

The plan and the issue board are in the repository and are the contract:

- `.plan/workspace-browser-tab/workspace-browser-tab-plan.md` — the plan
- `.plan/workspace-browser-tab/board/spec.md` — the specification
- `.plan/workspace-browser-tab/board/t01.md` … `t13.md` — one ticket per issue, each with its acceptance criteria
- `.plan/workspace-browser-tab/board/HANDOFF.md` — the state of the work
- `packages/webui/docs/adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md` — the decision record
- `packages/webui/docs/browser-use/01-capability-matrix.md` — the capability matrix, written from measurements

Thirteen issues were implemented, one commit each, in the order the board's dependency graph allows. Read the diff and judge the **result**, not the process.

## What I want you to look for

1. **Correctness bugs.** Especially: the generation fence (a page's generation advances when the page behind it is replaced — a reference recorded before that must be refused, on *every* page); the routing of a screencast frame to the page it belongs to (by the envelope's `event.sessionId`, never by `event.params.sessionId`); races between a page's first load and the answer that opened it; anything that can leave a page, a target or a selection behind.
2. **The two cells.** The **run's selection** (the runtime's cell — the page the Agent acts on) and **the tab the person is looking at** (the client's cell) must stay separate, with one writer each, and exactly one documented bootstrap (a person who opens a web tab while the run has *no* selection gives the run that page; a person who opens one while the run *has* a selection must not move it). Look for any path where one cell writes the other.
3. **Layering and ownership.** The workspace business and the browser business must not reach into each other's private modules; the runtime owns the run's selection and the client owns the person's tab. `node scripts/check-webui-dependency.mjs` passes, but a rule the gate cannot see is still a rule.
4. **Tests that do not prove what they claim.** A test that would pass with the behaviour broken, a mock where a real browser is required, an assertion that is weaker than the acceptance criterion it stands for.
5. **The documentation's honesty.** A rule described as `implemented` without the code behind it; a claim of a measurement the record does not support; a stale statement left behind by the change.
6. **Anything the change broke that the programme did not notice** — a capability removed by accident, an error code that changed meaning, a wire shape that other callers still use.

## What I want back

A findings report, in this shape:

- **Findings** — each with a severity (BLOCKER / MAJOR / MINOR), the `file:line`, what is wrong, and **what the consequence is** (a wrong picture on screen, an action aimed at the wrong page, a page left running, a claim that is not true). A finding with no consequence is a preference, not a finding — put it under "Observations" instead.
- **Observations** — things worth knowing that are not defects.
- **What is sound** — the parts you checked and believe are right, and why. I need to know what you actually verified, not what you skimmed.

Rank the findings by severity and be specific. If you find nothing in a category, say so explicitly rather than inventing something. If you are not sure whether something is a defect, say what would settle it.

Do not edit files. Report only.
```

The reviewer answered with five findings, in the shape the prompt asked for, and its report is quoted
in the findings table below.

## What the reviewer was asked for

1. **Correctness bugs** — the generation fence on every page; the routing of a
   screencast frame to the page it belongs to; races between a page's first
   load and the answer that opened it; anything left behind.
2. **The two cells** — the run's selection and the tab the person is looking
   at, with one writer each and exactly one bootstrap.
3. **Layering and ownership** — the workspace and the browser business must not
   reach into each other's private modules.
4. **Tests that do not prove what they claim** — a test that would pass with
   the behaviour broken; a mock where a real browser is required.
5. **The documentation's honesty** — a rule described as `implemented` without
   the code behind it; a claim a record does not support; a stale statement.
6. **Anything the change broke that the programme did not notice.**

## What the reviewer confirmed

- The provider's per-page generation and frame routing: pages by target and by
  CDP session, `Page.enable` per page, the generation raised by a main-frame
  navigation, and events resolved from the envelope's `event.sessionId`. The
  numeric `event.params.sessionId` is used only for the screencast
  acknowledgement. No defect found in those paths.
- The two selection cells are substantially separated: runtime commands resolve
  the run's selection, the client's viewed-page state supplies the target for
  its frame stream and its input, and the panel's `page-viewed` effect does not
  write the run's selection.
- The stable tab model and the cache adjustments: client-assigned ids and
  mutable contents, the same-file rule as a content lookup, the workspace
  review and the turn review as distinct content sources, and the file and
  review reads depending on the content as well as the tab's identity.
- The cross-business edges use published interfaces: the workspace strip calls
  the browser port and shares the browser's DTOs, and the browser host mounts
  the published workspace strip. No private-module import between the two
  businesses in the paths reviewed.

## The findings, and what closed each

| # | Severity | Finding | Closed by |
| --- | --- | --- | --- |
| 1 | MAJOR | **Closing a web tab left its browser page running.** The close button dispatched the client command and nothing else: the runtime kept publishing the tab, the isolated Chromium kept the page alive, and the next snapshot could make the supposedly closed tab reappear. The acceptance test called the service method directly, so it did not cover the person's close action. | A `closeBrowserWebTab` operation beside `openBrowserWebTab`, and the button goes through it. The page is closed in the browser **first** and the tab leaves the strip after — the runtime stops publishing the tab when its page is closed, and a tab that left the strip while the runtime still published it would be re-added by the next snapshot. The acceptance case now closes through the server's own handler. |
| 2 | MAJOR | **The person's launcher could be refused because the Agent was working in Edge.** The launcher sent the run's id, and the runtime chose the run's *selected* surface — so a url typed in the panel went to the bridge, which cannot open a page. The embedded panel is the isolated browser's view. | The person's page is always opened in the isolated Chromium, and the run keeps the page it was working on. |
| 3 | MINOR | **The bootstrap could race an Agent selection.** The run's selection was read after the page was created, so a run that selected a page while the person's page was opening lost its selection to the bootstrap afterwards. | The selection is read **before** the page is created, and read across every surface: the Agent acts on one page, so the bootstrap is about the run and not about a surface. |
| 4 | MINOR | **The acceptance record overstated what it measured about the client strip.** The case fabricated the runtime's snapshot and called the pure reconcile function and the reducer. That exercises the reducer, not the production subscription or the mounted strip. | The case reads the runtime's own published stream, and it says what it did: the runtime publishes the tab, the strip's reconciliation turns it into a panel command, and the reducer makes it the active tab. The mounted strip is covered by the unit suites. |
| 5 | MINOR | **The authorization trace's source pointers were stale.** They named `#frameMatchesSelection` at `browser-service.ts:733`, `sendInput` at `:289` and the target-change listener at `:176`; none of those identified the code that is there now. | The pointers name the fence that is there now. |
| 6 | MINOR | **The file results never appeared** (found by the WebUI gate, not by the reviewer). The file cache was **read** by the tab id while the read was **filed** by the content key, so the preview never found its result. The effect that reads a file also depended on the content *object*, so a content replaced by an equal one re-read the file and superseded the read already in flight. | The render reads the key the read writes, and the effect follows the content key rather than the content object. |

## What the reviewer did not check

- The whole-programme gate. The reviewer ran focused suites only, and the gate
  is the programme owner's.
- The macOS `verify` job, which is a CI concern.
- The `test:webui-browser` Playwright suite in CI; the local run against real
  Chrome 152 is what the 14-case acceptance record was written from.
