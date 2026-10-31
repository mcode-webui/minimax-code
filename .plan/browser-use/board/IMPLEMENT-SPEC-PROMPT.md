# Prompt: run `/implement-spec` for WebUI Browser Use

Copy everything below the line into a fresh agent session that has this repository checked out.

---

Implement the **WebUI Browser Use** programme from the published ticket board.

Call the Skill tool with `implement-spec` and follow it. The specification is GitHub issue
**#176**; the tickets are **#177–#194**; the board's blocking edges are native GitHub issue
dependencies. The programme is fully planned, fully specified and ready to execute — there is no
planning work left, and no ticket should be authored from scratch.

**Do not start by re-planning, re-deriving the board, or re-writing tickets.** Read what exists,
then execute it. If a ticket's technical detail turns out to be wrong, that is a finding to report
against that ticket, not a licence to redesign the programme.

## 1. Read these, in this order

1. `gh issue view 176 --repo mcode-webui/minimax-code --comments` — the specification: problem,
   solution, 40 user stories, implementation decisions, testing decisions, out of scope, and the
   board table.
2. `packages/webui/docs/adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md` — the
   **sole** decision record for this feature. It is in git and readable from any worktree.
3. `gh issue view 173 --repo mcode-webui/minimax-code` — research notes: runtime and server seams.
   `gh issue view 174` — browser-core contracts and WebUI client conventions.
   `gh issue view 175` — repository plumbing for a new package and new gates.
   These three are reference material, not work items. Do not close them as tickets.
4. `gh issue view 177 --repo mcode-webui/minimax-code` — the first ticket, and the only one
   currently on the frontier.
5. `packages/webui/docs/agents/issue-tracker.md`, `packages/webui/docs/agents/domain.md`,
   `packages/webui/docs/agents/triage-labels.md` — this repository's tracker, glossary and label
   conventions.
6. `packages/webui/AGENTS.md` and `packages/webui/docs/README.md` — the operating guide for the
   package you will change, and the index of its documentation.
7. `CONTEXT.md` at the repository root — the glossary. Use its vocabulary in code, tests, commit
   messages and issue comments.

## 2. The board

- Tickets: **#177–#194**, each labelled `browser-use` and `ready-for-agent`.
- Parent specification: **#176**. Do not modify or close it until the whole board is done.
- Blocking edges are native GitHub issue dependencies, so a ticket is unblocked exactly when every
  blocker it names is closed. `#177` blocks all seventeen others; the frontier today is `#177`
  alone. Two tickets become unblocked at once after `#177` and `#178` land: `#179` and `#185`.

Find the frontier with:

```bash
for n in $(gh issue list --repo mcode-webui/minimax-code --state open --label "ready-for-agent" \
             --json number --jq '.[].number' | sort -n | grep -v '^176$'); do
  open_blockers=$(gh api repos/mcode-webui/minimax-code/issues/$n/dependencies/blocked_by \
                    --jq '[.[] | select(.state=="open") | .number] | join(",")')
  [ -z "$open_blockers" ] && echo "FRONTIER: #$n"
done
```

## 3. Repository rules that bind this run

- **Always pass `--repo mcode-webui/minimax-code`** to every `gh` call. Without it `gh` resolves
  this checkout to the public upstream `MiniMax-AI/minimax-code`, and issues and pull requests
  filed there land in the published projection. Never push, comment, label or file anything on
  upstream.
- **Integration branch:** create it from an explicit ref, never from whatever `HEAD` happens to be.
  Base it on the fork's `webui` branch — at handoff time the local `webui` tip was `9f14141` and
  `origin/webui` was `b705259`, with one unpushed commit between them. Re-check the refs yourself
  and state in your first report which ref you used and why.
- **Per-ticket branches** follow the fork workflow: `feat/<short-description>`, lower-case
  kebab-case, no agent or tool names in the prefix. Pull requests target `webui` on the fork.
- **The main checkout is dirty with someone else's in-flight work**
  (`packages/webui/src/client/features/models/**`, and possibly `src/client/ui/Dropdown.tsx`). Do
  not stage it, do not commit it, do not revert it, and do not let it into a Browser Use commit.
  Work in worktrees, which the skill already gives you, and leave the main checkout alone.
- **ADR 0019 decides.** If implementation evidence contradicts it, amend ADR 0019 first, then
  re-scope the affected ticket. Do not create a second decision record, and do not resolve a
  product question in code.
- Documentation and commit messages are **English**.
- No account data, sessions, logs, credentials or real user content in tests or commits. Use
  temporary data directories and synthetic pages.
- Keep scratch material outside the repository's published source projection.

## 4. Hard constraints found before implementation

These are established facts about this codebase. Do not rediscover them the wrong way, and do not
design around them as if they were open questions.

1. **`@mavis/browser-core` is not a WebUI dependency today** — its only consumer is `packages/tui`.
   The WebUI client bundle may import only `@mavis/shared` and `@mavis/protocol`; `browser-core`
   cannot reach the client layer, so the provider contract must arrive client-side as shared DTOs.
   The WebUI must not import `packages/tui`. (Tickets #179, #180, #186, #187.)
2. **No OS secure credential store exists in this repository.** `oauth-core`'s credential store is
   file-based; `os-keyring` survives only as a migration-readable literal; the DPAPI code present
   is vendored Rust that is not callable from here. ADR 0019's "no plaintext fallback" is net-new
   work, and a new native module may pull in the Node compatibility matrix and
   `pnpm.onlyBuiltDependencies`. (#177, #190.)
3. **`packages/shared/src/browser-manifest.ts` is a different mechanism** — the desktop
   native-messaging integration, which ADR 0019 explicitly did not select. Its extension id is not
   this programme's extension id; the manifest file and `verify-extension-id.sh` it names do not
   exist in this public projection. Do not reuse that id and do not extend that module. (#185.)
4. **The image transport does not fit the current WebSocket framing** — binary frames are rejected
   by the frame handler, the message ceiling is 256 KB, and `sendFrame` does not await socket
   back-pressure. A live image stream needs its own transport shape and its own back-pressure
   policy. (#180, #187.)
5. **The WebSocket upgrade admission is a single funnel, and `dev: true` bypasses the token check
   inside it.** The dedicated extension admission path must sit ahead of the generic handler and
   must validate the pairing credential regardless of development mode. The generic origin policy
   already rejects extension origins and must stay exactly that narrow. (#185.)
6. **`beta.browserUseTooling` is derived from provider adoption.** It is a readiness statement,
   not an authorization, and must not be widened silently when no surface is authorized. (#178,
   #179.)
7. **Adding a workspace package touches four files** — `pnpm-workspace.yaml` is an explicit path
   list, not a glob; `release/extraction.json`'s `packageRoots` is edited by hand;
   `release/dependency-licenses.json` must declare the package's dependencies; and
   `release/public-source.json` is regenerated with `node scripts/source-inventory.mjs --write`.
   `pnpm gen:tsconfig` regenerates two files, not one. The extension is a store artifact rather
   than an npm file, but its source still belongs in the published source projection. (#185.)
8. **A new Vitest file must be registered** in `test/vitest-suites.json` or it never runs. A
   Playwright spec placed outside the WebUI browser-suite directory fails `pnpm check:source`.
9. **Both composition roots must supply the provider** — `scripts/run-webui-server.mjs` and
   `release/webui-npm/bin/mcode-webui.mjs`. Validating only the development entry does not prove
   the shipped path, and the packaged path is what the acceptance matrix asks for. (#179, #194.)

## 5. Gates

Each ticket names the gates that bear on it. The delivery gate is `pnpm verify`, run once for the
final inputs. `pnpm typecheck:webui` covers every WebUI source and test file but **not** the new
extension package, which carries its own typecheck command registered in `scripts/verify.mjs`.
Reuse a passing gate's evidence only when its source, configuration and platform inputs are
unchanged. `packages/webui/docs/verification/gates.md` states what each gate does and does not
prove, and the evidence level a claim must name.

## 6. Definition of done

- All eighteen tickets closed, each with its acceptance criteria demonstrably met and its gates
  recorded.
- The acceptance matrix from ADR 0019 is satisfied for the isolated Chromium, Edge and Chrome. A
  surface that was not exercised on a platform is called out explicitly, never inferred from
  another platform's result. Synthetic and mock evidence stays separate from real-browser
  evidence.
- A pull request open against `webui` on the fork, with the required repository gates green and the
  source inventory regenerated and reviewed.
- ADR 0019 still the only Browser Use decision record. Documentation describes what the source now
  does, not what it was planned to do.

## 7. Report back

Report the integration branch, the pull request, the per-ticket outcome, the gate results with
their evidence levels, and anything you could not verify — explicitly. If you find that a ticket's
technical detail is wrong, say so against that ticket and stop the affected work rather than
quietly re-deciding it. Do not report a ticket as done on the strength of a fake provider, a mock
peer, or the development entry alone.
