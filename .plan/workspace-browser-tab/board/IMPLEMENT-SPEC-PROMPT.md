# Prompt: run `/implement-spec` for the WebUI workspace browser tab model

Copy everything below the line into a fresh agent session that has this repository checked out.

---

Implement the **WebUI workspace browser tab model** programme from the published ticket board.

Call the Skill tool with `implement-spec` and follow it. The specification is GitHub issue
**#199**; the tickets are **#200–#212**; the board's blocking edges are native GitHub issue
dependencies. The programme is fully planned, fully specified and ready to execute — there is no
planning work left, and no ticket should be authored from scratch.

**Do not start by re-planning, re-deriving the board, or re-writing tickets.** Read what exists,
then execute it. If a ticket's technical detail turns out to be wrong, that is a finding to report
against that ticket, not a licence to redesign the programme.

## 1. Read these, in this order

1. `gh issue view 199 --repo mcode-webui/minimax-code --comments` — the specification: problem,
   solution, the user stories, implementation decisions, testing decisions, out of scope, and the
   board table.
2. `packages/webui/docs/adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md` — the
   **decision record** for this feature, and
   `packages/webui/docs/adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md`
   amendment **A8** for the change to the panel's role. Both are in git and readable from any
   worktree.
3. `gh issue view 197 --repo mcode-webui/minimax-code` — research notes: the runtime and provider
   sites. `gh issue view 198` — the client's tab model and the sites a mutable content breaks.
   These two are reference material, not work items. Do not close them as tickets.
4. `gh issue view 200 --repo mcode-webui/minimax-code` — the first ticket, and the only one
   currently on the frontier.
5. `.plan/workspace-browser-tab/workspace-browser-tab-plan.md` — the development plan: the work
   packages, the acceptance matrix, the verification plan and the delivery order. It is **tracked**,
   so a worktree carries it.
6. `packages/webui/AGENTS.md` and `packages/webui/docs/README.md` — the operating guide for the
   package you will change, and the index of its documentation.
7. `CONTEXT.md` at the repository root — the glossary. Use its vocabulary in code, tests, commit
   messages and issue comments. The words that matter here: **tab**, **tab strip**, **tool tab**,
   **web tab**, **new tab page**, **run**, **run selection**, **workspace panel**, **surface**.

## 2. The board

- Tickets: **#200–#212**, each labelled `workspace-browser` and `ready-for-agent`.
- Parent specification: **#199**. Do not modify or close it until the whole board is done.
- Blocking edges are native GitHub issue dependencies, so a ticket is unblocked exactly when every
  blocker it names is closed. `#200` blocks the other twelve; the frontier today is `#200` alone.

Find the frontier with:

```bash
for n in $(gh issue list --repo mcode-webui/minimax-code --state open --label "ready-for-agent" \
             --json number --jq '.[].number' | sort -n | grep -v '^199$'); do
  open_blockers=$(gh api repos/mcode-webui/minimax-code/issues/$n/dependencies/blocked_by \
                    --jq '[.[] | select(.state=="open") | .number] | join(",")')
  [ -z "$open_blockers" ] && echo "FRONTIER: #$n"
done
```

The dependency API occasionally answers with a transient `EOF`. A ticket that appears on the
frontier twice in a row, or one whose blockers you cannot read, is **not** on the frontier until
the read succeeds.

## 3. Repository rules that bind this run

- **Always pass `--repo mcode-webui/minimax-code`** to every `gh` call. Without it `gh` resolves this
  checkout to the public upstream `MiniMax-AI/minimax-code`, and issues and pull requests filed
  there land in the published projection. Never push, comment, label or file anything on upstream.
- **Integration branch:** create it from an explicit ref, never from whatever `HEAD` happens to be.
  Base it on the fork's `webui` branch — at handoff time the fork's `webui` tip was `1a1a9757` and
  the local `webui` was the same commit with a clean working tree. Re-check the refs yourself and
  state in your first report which ref you used and why.
- **Per-ticket branches** follow the fork workflow: `feat/<short-description>`, lower-case
  kebab-case, no agent or tool names in the prefix. Pull requests target `webui` on the fork.
- **Work in worktrees**, which the skill already gives you, and leave the main checkout alone.
- **ADR 0022 decides.** If implementation evidence contradicts it, amend ADR 0022 first, then
  re-scope the affected ticket. Do not create a second decision record, and do not resolve a
  product question in code.
- **Two cells, one writer each.** The run's selection — the page the Agent acts on — is written by
  the Agent, through the runtime. The tab the person is looking at is written by the person, through
  the strip. Neither writes the other's. There is exactly one exception, a bootstrap rather than a
  co-write: a person who opens a web tab while the run has **no** selection gives the run that page,
  because a run with no selection cannot act at all. Do not let the two cells quietly merge.
- Documentation and commit messages are **English**.
- No account data, sessions, logs, credentials or real user content in tests or commits. Use
  temporary data directories and synthetic pages.

## 4. Hard constraints found before implementation

These are established facts about this codebase. Do not rediscover them the wrong way, and do not
design around them as if they were open questions. Each is a way the work can look finished and
still be wrong.

1. **The generation is per page, and three sites make it per browser today.**
   `provider.ts:251` reports a constant `1` for every page that is not the launch page;
   `provider.ts:229` sends `Page.enable` only to the launch page's session, so a second page never
   receives the navigation events that would raise it; and `provider.ts:532` raises the generation
   only for the launch page's session. **A page whose generation never advances is a page whose
   recorded references never go stale** — the fence would be dead on every tab but the first.
   (#200, #201.)
2. **The frame's target identity is the envelope's session id.** `cdp-connection.ts:237` puts the
   flattened target session on the event as `event.sessionId`, a string. `event.params.sessionId`
   is the numeric screencast acknowledgement id, and routing by it looks right and silently finds
   no page. (#200, #201, #204.)
3. **A stable tab id breaks the caches that are keyed by it.** The file results are cached by tab id
   (`WorkspacePanels.tsx:291`, `:485`) and the review summary is matched by tab id (`:339`), while
   the effects that read them depend on `[activeTab?.id]`. With a stable id and a mutable content
   the effect does **not** re-run and the component reads the entry the previous content wrote.
   (#207, #208.)
4. **`deleteSession` is not a hook.** It is a binding with no browser-service edge
   (`binding-mechanism.ts:43`), and a session is also removed by archiving and by a transfer away
   (`runtime/session-transfer.ts:108`). A release that covers only deletion leaks a page per
   archived session. (#205.)
5. **A new operation is not registered by adding a name.** The browser family's readiness is declared
   in `capability-manifest.ts:141-149`, where the `browser.ready` list names the operations the
   family is ready for. The name also has to reach the operation registry, the server's handler
   table, the transport's request table and the port. (#203.)
6. **The per-target frame stream is a breaking change to an existing operation.**
   `watchBrowserFrames` takes `{ surface, runId? }` (`operation-names.ts:458`); a per-target stream
   takes the target instead. It is not a second operation beside it, and a client that sends the old
   shape is refused rather than answered with the wrong page. (#204.)
7. **The panel is the isolated browser's view, and the `browser` kind is deleted.** The surface
   switcher (`BrowserPanel.public.tsx:207`) goes with the tab it belonged to. Edge and Chrome lose
   their entry point in the interface — the bridge, the pairing and the credential store are
   untouched, and a switched-on surface still authorizes the Agent's commands, but the panel is not
   where those browsers are driven. (#208, #209, #210.)
8. **A new source file and a new test file both need registering.** The frozen path metadata fixture
   lists every TypeScript, TSX and CSS source path, and the gate fails on a path that is not in it; a
   new Vitest file must be in the declared suite groups or it never runs; a new Playwright spec must
   live under `packages/webui/test/browser/`. (Every ticket that adds a file.)
9. **The provider drives exactly one page, and `open_tab` created a page nobody could drive.** That
   is the bug the programme exists to close, and it is why the provider's single page has to become
   a per-target map rather than a second page being bolted on. (#201, #202.)

## 5. Gates

Each ticket names the gates that bear on it. The delivery gate is `pnpm verify`, run once for the
final inputs. The WebUI's own gates are `pnpm typecheck:webui`, `pnpm test:webui`,
`pnpm check:webui-dependency`, `pnpm build:webui` with `pnpm check:webui-boundary`, and
`pnpm check:source` after `node scripts/source-inventory.mjs --write`. The real-browser acceptance
is `pnpm test:webui-browser`, and its records go to
`.plan/workspace-browser-tab/complete/<suite>.acceptance.json`.

Reuse a passing gate's evidence only when its source, configuration and platform inputs are
unchanged. `packages/webui/docs/verification/gates.md` states what each gate does and does not
prove, and the evidence level a claim must name.

## 6. Definition of done

- All thirteen tickets closed, each with its acceptance criteria demonstrably met and its gates
  recorded.
- The acceptance matrix in the plan is satisfied for the isolated Chromium. A case that was not
  exercised is called out explicitly, never inferred. Synthetic and mock evidence stays separate
  from real-browser evidence.
- **The gap this programme closes is closed**: the Agent's browser tools have been driven against a
  real browser, and the acceptance record says so.
- The rules the browser-use documents carry as `required` become `implemented`, each with the file
  and the line that carries it; round 11 of the review findings is closed.
- A pull request open against `webui` on the fork, with the required repository gates green and the
  source inventory regenerated and reviewed.
- ADR 0022 still the decision record for this feature, and the documentation describes what the
  source now does, not what it was planned to do.

## 7. Report back

Report the integration branch, the pull request, the per-ticket outcome, the gate results with their
evidence levels, and anything you could not verify — explicitly. If you find that a ticket's
technical detail is wrong, say so against that ticket and stop the affected work rather than
quietly re-deciding it. Do not report a ticket as done on the strength of a fake provider, a mock
peer, or the development entry alone.
