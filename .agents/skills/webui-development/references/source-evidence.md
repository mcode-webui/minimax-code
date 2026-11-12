# Source evidence, discipline and refresh

## Working discipline on this checkout

This tree is edited by more than one agent session at a time, and a report usually starts as a symptom
rather than a request for a change.

- **Investigate read-only first.** For a reported bug, grep, probe and decode bundles before editing, then
  state what you found and what you propose. A patch that lands before the diagnosis is a guess with a diff.
- **Check who else is writing.** Before touching a hot file: `git status --porcelain` and
  `find packages/webui/src -newermt '-15 minutes' -type f`. If another session is writing it, choose an
  additive seam — a new export, a provider, a one-line prop at the shell — rather than rewriting the file.
- **Verify a batch of patches, not each patch's return value.** After a batch, grep the file for one marker
  from every patch: another session can rewrite a region from its own snapshot while each edit still
  reports success.
- **Stash only your own files.** `git stash push -- <paths>`, never the whole tree — another session's work
  is not yours to hide, and this is the standard way to prove a red test predates you.
- **Keep work material out of the repository.** Probes, briefs, logs and browser output go to a directory
  outside the checkout; the source inventory scans untracked files, so scratch inside the tree becomes a
  publication problem. Point `WEBUI_BROWSER_OUTPUT_DIR` at that external directory too.
- **A fresh worktree has no `node_modules`.** `pnpm install --frozen-lockfile --prefer-offline` restores the
  pinned toolchain. A compiler-option error you did not cause (`TS5101 … baseUrl … deprecated`) is a global
  `tsc` on `PATH`, not your edit.

## What this skill investigated, and what it did not

It was built by reading source, tests and documents at a fixed commit, then refreshed at later commits;
repository history is the record of each pass. Coverage is architecture-oriented: every execution
boundary, business home, application wiring, submission and freshness mechanism, the operation registry
and bindings, capability derivation, runtime resources, the style/token/compiler setup and representative
unit, integration and browser tests.

It is not a line-by-line correctness review, and no full suite or real provider/account scenario was run to
produce it. When a claim matters to your change, read the current source: a copied rule is navigation, not
proof. A citation is evidence only if you read the cited line — pattern-matching a file name is not a read.

## Claims that were checked and failed

Do not reintroduce these; each appeared in an earlier version of this material.

| Claim | Reality at the last check |
| --- | --- |
| Account sign-in lives in `packages/webui/src/server/check-in.ts` | No such file; the account surface is `features/account/` over `shared/contracts/account.ts` and `@mavis/shared/daily-signin` |
| Session runtime state lives in `src/client/app.tsx` | No such file; see `application/session-store.ts` and `client/application/create-application.ts` |
| `packages/webui` is absent from `upstream/main`, so file moves are merge-free | `origin/main` carries more than 1,300 paths under `packages/webui/`; moving files costs a three-way merge |

Two counting habits worth keeping: take roster numbers from the test that pins them rather than from the
registry (handler-entry factories register operations the bindings list never names), and describe them in
the test's own words instead of inventing a category.

## Refresh workflow

Re-read the current operating instructions and the touched source before trusting a reference. Refresh the
skill when changed source or an actual task shows it is stale — not on a schedule, and never to restore a
retired plan or a generated table from memory.

For a visual refresh: inspect the CSS/source changes, rebuild, run `scripts/capture-visuals.mjs` into a
directory outside the repository, inspect the original PNGs in both themes, review the manifest and page
errors, and only then replace the reference images deliberately. Rendering a new screenshot does not
approve a redesign, and a failed selector or missing build is reported, never papered over with a fake
reference image.

After any file addition or removal, run `node scripts/source-inventory.mjs --write` and `pnpm check:source`,
and report what the inventory recorded rather than editing it by hand.
