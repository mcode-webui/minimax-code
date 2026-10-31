# Handoff: starting `/implement-spec` for the WebUI workspace browser tab model

Prepared 2026-10-21. Nothing in this programme has been implemented yet. This file is the
operational handoff for the run that starts the implementation; it is workspace material and is
not part of the published source projection.

## The board

- **Tracker:** GitHub issues on `mcode-webui/minimax-code` (the `origin` remote of this checkout).
  Always pass `--repo mcode-webui/minimax-code` to every `gh` call.
- **Parent specification:** [#199](https://github.com/mcode-webui/minimax-code/issues/199). Read it
  first; it carries the problem, the user stories, the implementation decisions, the testing
  decisions and the out-of-scope list.
- **Tickets:** #200–#212, all labelled `workspace-browser` and `ready-for-agent`.
- **Research notes:** #197, #198 — labelled `workspace-browser` and `documentation` only. They are
  reference material, **not** work items. Do not close them as tickets.
- **Blocking edges:** native GitHub issue dependencies. A ticket is unblocked exactly when every
  blocker is closed.

Frontier query — `gh issue list --json` does not expose the dependency summary, so the blockers are
read per issue. The parent specification is excluded explicitly, because it is a work item's
context and not work itself:

```bash
for n in $(gh issue list --repo mcode-webui/minimax-code --state open --label "ready-for-agent" \
             --json number --jq '.[].number' | sort -n | grep -v '^199$'); do
  open_blockers=$(gh api repos/mcode-webui/minimax-code/issues/$n/dependencies/blocked_by \
                    --jq '[.[] | select(.state=="open") | .number] | join(",")')
  [ -z "$open_blockers" ] && echo "FRONTIER: #$n"
done
```

Today the frontier is exactly one ticket: **#200**, the technical validation ticket, which blocks
the other twelve. It has to land first — the per-page generation accounting, the per-target frame
stream, the operation registration and the tab-model sites are what every later ticket is written
against.

## Authority chain

ADR 0022 decides, and ADR 0019's **A8** records the change to the panel's role. The tickets carry
the work and the acceptance criteria. The plan
(`.plan/workspace-browser-tab/workspace-browser-tab-plan.md`) carries the work packages and the
acceptance matrix, and it is **tracked**, so an implementer working in a git worktree can read it.
The board and the plan must not drift apart: an amendment belongs in the plan first, and the
affected tickets are updated to match.

ADR 0022 is on the fork's `webui` branch, merged by
[#196](https://github.com/mcode-webui/minimax-code/pull/196). Read it at
`packages/webui/docs/adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md` in the working
checkout, or at
[the fork's `webui`](https://github.com/mcode-webui/minimax-code/blob/webui/packages/webui/docs/adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md).

If implementation evidence contradicts ADR 0022, amend ADR 0022 first, then re-scope the ticket.

## Branch and pull request conventions

- Integration branch: create it from an explicit ref on the fork's `webui` branch. Do not branch
  from whatever `HEAD` happens to be, and do not branch from the current dirty working tree (it
  carries unrelated workspace-panel work in progress).
- Per-ticket branches follow the fork workflow: `feat/<short-description>`, lower-case kebab-case,
  no agent or tool names in the prefix.
- Pull requests target `webui` on the fork. Never push to `upstream` (`MiniMax-AI/minimax-code`) and
  never file an issue there.
- Each implementer worktree's branch must be confirmed to be based on the integration branch tip
  before work starts, and must merge the integration tip before reporting done.

## Findings that will shape the implementation

These came out of the pre-implementation exploration. They are constraints, not tasks; each one
belongs to a specific ticket. The research notes #197 and #198 carry the full inventory.

1. **The generation is per page, and three sites make it per browser today.**
   `provider.ts:251` reports a constant `1` for every page that is not the launch page;
   `provider.ts:229` sends `Page.enable` only to the launch page's session, so a second page never
   receives the navigation events that would raise it; and `provider.ts:532` raises the generation
   only for the launch page's session. **A page whose generation never advances is a page whose
   recorded references never go stale** — the fence would be dead on every tab but the first.
   Affects #200, #201.
2. **The frame's target identity is the envelope's session id.**
   `cdp-connection.ts:237` puts the flattened target session on the event as `event.sessionId` (a
   string). `event.params.sessionId` is the numeric screencast acknowledgement id, and routing by it
   looks right and silently finds no page. Affects #200, #201, #204.
3. **A stable tab id breaks the caches that are keyed by it.**
   The file results are cached by tab id (`WorkspacePanels.tsx:291`, `:485`) and the review summary
   is matched by tab id (`:339`), while the effects that read them depend on `[activeTab?.id]`. With
   a stable id and a mutable content the effect does **not** re-run and the component reads the
   previous content's entry. Affects #207, #208.
4. **`deleteSession` is not a hook.** It is a binding with no browser-service edge
   (`binding-mechanism.ts:43`), and a session is also removed by archiving and by a transfer away
   (`runtime/session-transfer.ts:108`). A release that covers only deletion leaks a page per
   archived session. Affects #205.
5. **A new operation is not registered by adding a name.** The browser family's readiness is declared
   in `capability-manifest.ts:141-149`, where the `browser.ready` list names the operations the
   family is ready for. The name also has to reach the operation registry, the server's handler
   table, the transport's request table and the port. Affects #203.
6. **The per-target frame stream is a breaking change to an existing operation.**
   `watchBrowserFrames` takes `{ surface, runId? }` (`operation-names.ts:458`); a per-target stream
   takes the target instead. It is not a second operation beside it, and a client that sends the old
   shape is refused rather than answered with the wrong page. Affects #204.
7. **The panel is the isolated browser's view, and the `browser` kind is deleted.**
   The surface switcher (`BrowserPanel.public.tsx:207`) goes with the tab it belonged to. Edge and
   Chrome lose their entry point in the interface — the bridge, the pairing and the credential store
   are untouched, and a switched-on surface still authorizes the Agent's commands, but the panel
   is not where those browsers are driven. Affects #208, #209, #210.
8. **A new source file and a new test file both need registering.** The frozen path metadata
   fixture lists every TypeScript, TSX and CSS source path and the gate fails on a path that is not
   in it; a new Vitest file must be in the declared suite groups or it never runs; a new Playwright
   spec must live under `packages/webui/test/browser/`. Affects every ticket that adds a file.
9. **The provider drives exactly one page, and `open_tab` created a page nobody could drive.** That
   is the bug the programme exists to close, and it is why the provider's single page has to become
   a per-target map rather than a second page being bolted on. Affects #201, #202.

## Gates

Each ticket names the gates that bear on it. The delivery gate is `pnpm verify`, run once for the
final inputs. The WebUI's own gates are `pnpm typecheck:webui`, `pnpm test:webui`,
`pnpm check:webui-dependency`, `pnpm build:webui` with `pnpm check:webui-boundary`, and
`pnpm check:source` after `node scripts/source-inventory.mjs --write`.

## Workspace material (tracked in the repository)

- `.plan/workspace-browser-tab/workspace-browser-tab-plan.md` — the development plan, with §5 holding
  the work packages and §6 the acceptance matrix.
- `.plan/workspace-browser-tab/board/` — the published issue bodies, one file per issue, and this
  handoff.
- `.plan/workspace-browser-tab/complete/` — where this programme's acceptance records are written.

`.plan/` is **tracked** and part of the public source projection, so a worktree carries it and an
implementer can read the plan, this handoff and the research notes without leaving the checkout.
Nothing an implementer needs may exist only in a machine-local place: the published issues carry
the same material for anyone reading the repository.
