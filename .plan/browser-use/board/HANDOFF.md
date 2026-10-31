# Handoff: starting `/implement-spec` for WebUI Browser Use

Prepared 2026-10-20. Nothing in this programme has been implemented yet. This file is the
operational handoff for the run that starts the implementation; it is workspace material and is not
part of the published source projection.

## The board

- **Tracker:** GitHub issues on `mcode-webui/minimax-code` (the `origin` remote of this checkout).
  Always pass `--repo mcode-webui/minimax-code` to every `gh` call.
- **Parent specification:** [#176](https://github.com/mcode-webui/minimax-code/issues/176). Read it
  first; it carries the problem, the user stories, the implementation decisions, the testing
  decisions and the out-of-scope list.
- **Tickets:** #177–#194, all labelled `browser-use` and `ready-for-agent`.
- **Research notes:** #173, #174, #175 — labelled `browser-use` and `documentation` only. They are
  reference material, **not** work items. Do not close them as tickets.
- **Blocking edges:** native GitHub issue dependencies. A ticket is unblocked exactly when every
  blocker is closed.

Frontier query — `gh issue list --json` does not expose the dependency summary, so the blockers are
read per issue. The parent specification is excluded explicitly, because it is a work item's
context and not work itself:

```bash
for n in $(gh issue list --repo mcode-webui/minimax-code --state open --label "ready-for-agent" \
             --json number --jq '.[].number' | sort -n | grep -v '^176$'); do
  open_blockers=$(gh api repos/mcode-webui/minimax-code/issues/$n/dependencies/blocked_by \
                    --jq '[.[] | select(.state=="open") | .number] | join(",")')
  [ -z "$open_blockers" ] && echo "FRONTIER: #$n"
done
```

Today the frontier is exactly one ticket: **#177**, the technical validation ticket, which blocks
all seventeen others. It has to land first — the capability matrix, the bridge protocol, the
credential-store feasibility, the worker-lifecycle behaviour and the reconnect contract are what
every later ticket is written against.

## Authority chain

ADR 0019 decides. The tickets carry the work and the acceptance criteria. The plan
(`.plan/browser-use/browser-use-development-plan.md`) carries the work packages and the acceptance
matrix, and it is **tracked**, so an implementer working in a git worktree can read it. The board
and the plan must not drift apart: an amendment belongs in the plan first, and the affected
tickets are updated to match.

If implementation evidence contradicts ADR 0019, amend ADR 0019 first, then re-scope the ticket.

## Branch and pull request conventions

- Integration branch: create it from an explicit ref on the fork's `webui` branch. Do not branch
  from whatever `HEAD` happens to be, and do not branch from the current dirty working tree (it
  carries unrelated model-selector work in progress).
- Per-ticket branches follow the fork workflow: `feat/<short-description>`, lower-case kebab-case,
  no agent or tool names in the prefix.
- Pull requests target `webui` on the fork. Never push to `upstream` (`MiniMax-AI/minimax-code`) and
  never file an issue there.
- Each implementer worktree's branch must be confirmed to be based on the integration branch tip
  before work starts, and must merge the integration tip before reporting done.

## Findings that will shape the implementation

These came out of the pre-implementation exploration. They are constraints, not tasks; each one
belongs to a specific ticket.

1. **`@mavis/browser-core` is not a WebUI dependency today.** Its only consumer is `packages/tui`.
   Adding it to WebUI is a dependency-rule change, not a given. The WebUI client bundle may import
   only `@mavis/shared` and `@mavis/protocol` — not `browser-core` — so the provider contract has to
   reach the client as shared DTOs. Affects #179, #180, #186, #187.
2. **No OS secure credential store exists in this repository.** `oauth-core`'s credential store is
   file-based; the old `os-keyring` survives only as a migration-readable literal, and the DPAPI
   code present is vendored Rust that is not callable from here. ADR 0019's "no plaintext fallback"
   is net-new work. A new native module may pull in the Node compatibility matrix and
   `pnpm.onlyBuiltDependencies`. Affects #190, and #177's credential-store validation.
3. **`packages/shared/src/browser-manifest.ts` is a different mechanism.** It belongs to the desktop
   native-messaging integration, which ADR 0019 explicitly did not select. Its extension id and its
   manifest are not this programme's extension, and the manifest file and `verify-extension-id.sh`
   it names do not exist in this public projection. Do not reuse that id and do not extend that
   module. Affects #185.
4. **The image transport does not fit the current WebSocket framing.** Binary frames are rejected
   by the frame handler, the message ceiling is 256 KB, and `sendFrame` does not await socket
   back-pressure. A live image stream needs its own transport shape and its own back-pressure
   policy. Affects #180, #187.
5. **The WebSocket upgrade admission is a single funnel, and development mode bypasses the token
   check there.** The dedicated extension admission path must sit ahead of the generic handler and
   must validate the pairing credential regardless. The generic origin policy already rejects
   extension origins and must stay that way. Affects #185.
6. **`beta.browserUseTooling` is derived from provider adoption.** It is a readiness statement, not
   an authorization, and must not be widened silently when no surface is authorized. Affects #178,
   #179.
7. **Adding a workspace package is a four-file change.** `pnpm-workspace.yaml` is an explicit path
   list, not a glob; `release/extraction.json`'s `packageRoots` is edited by hand;
   `release/dependency-licenses.json` must declare the package's dependencies; and
   `release/public-source.json` is regenerated. `pnpm gen:tsconfig` regenerates two files, not one.
   The extension is a store artifact rather than an npm file, but its source still belongs in the
   published source projection. Affects #185.
8. **A new Vitest file must be registered** in the declared suite groups or it never runs. A
   Playwright spec placed outside the WebUI browser-suite directory fails the source check. Affects
   every ticket that adds a test.
9. **The isolated Chromium provider must be supplied by both composition roots** — the development
   entry and the packaged production entry. Validating only the development entry does not prove
   the shipped path. Affects #179, #194.

## Gates

Each ticket names the gates that bear on it. The delivery gate is `pnpm verify`, run once for the
final inputs. `pnpm typecheck:webui` does not cover the extension package: that package carries its
own typecheck command, registered in `scripts/verify.mjs`.

## Workspace material (tracked in the repository)

- `.plan/browser-use/browser-use-development-plan.md` — the development plan, with §10 holding the board map.
- `.plan/browser-use/exploration/01-runtime-server.md`, `02-browser-core-client.md`, `03-repo-plumbing.md` — the
  raw exploration notes behind #173, #174 and #175.
- `.plan/browser-use/board/` — the published issue bodies, one file per issue, and this handoff.

`.plan/` is **tracked in the repository** and part of the public source projection, so a worktree
carries it and an implementer can read the plan, this handoff and the research notes without
leaving the checkout. Nothing an implementer needs may exist only in a machine-local place: the
published issues carry the same material for anyone reading the repository.
