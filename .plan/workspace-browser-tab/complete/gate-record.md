# The gate, and what it was run against

The plan's §7 names six gates, and §9 makes them the completion definition: "The WebUI gates in §7
pass". This file is that record — what was run, on what, and what it said — so the claim can be
checked without running it again.

**The run.** Every gate below was run on the tree that carries this record, in one sequence, in this
order. The run was made at `4e7efd43`, the commit that carries the plan's implementation; the gate
was first run on that code at `4d247f43`. Two test-side commits came after it — `9d945e54` and
`a4f8f7c6`, which bound the external-bridge harness's waits and fix its cleanup — and **the whole
of §7 was run again at the tip that carries this record**, after them: types, 208 files and 3230
unit tests, dependency direction, build, build boundary, the source projection (5407 paths), and
146 browser cases in 2.0m. No source file of the programme changed after `4e7efd43`.

**The unit suite ran four more times** after the last of the fixes below, on the same tree: 208 files
and 3230 tests, every time, with no unhandled errors. The gate had been red twice before that — once
for a reason that is now understood, and once for a reason that was a defect in the service.

**The environment.** Linux 7.0.0-38-generic, Node v26.8.1, Google Chrome 152.0.7977.82
(`/usr/bin/google-chrome`), in the branch's own worktree.

## The gates

| Gate | Command | Result |
| --- | --- | --- |
| Types | `pnpm typecheck:webui` | **pass** — the server, the client and the test projects all type-check |
| Unit and gate tests | `pnpm test:webui` | **pass** — 208 files, 3230 tests |
| Dependency direction | `pnpm check:webui-dependency` | **pass** — 476 source files, 1734 in-package references, 0 violations, 0 cycles, 0 role violations, 0 publication violations |
| Build | `pnpm build:webui` | **pass** — 130 server inputs, 345 client inputs, 467 total |
| Build boundary | `pnpm check:webui-boundary` | **pass** — 467 inputs; source/output integrity, required entries and public workspace imports verified |
| Source projection | `node scripts/source-inventory.mjs --write` then `pnpm check:source` | **pass** — 5407 published paths |
| Real browser | `pnpm test:webui-browser` | **pass** — 146 Playwright tests, 2.1m, against real Chrome 152 |

One gate beyond §7 was run as well, because it is the closest thing the repository has to
"the thing a person installs works":

| Gate | Command | Result |
| --- | --- | --- |
| Installed package | `pnpm test:webui-package` | **pass** — `@fectivnfy112358/minimax-code-web@0.1.0-preview.3`; archive installation, real runtime startup, HTTP assets, the packaged bridge's admission and shutdown |

The repository's own full gate is deliberately **not** run: §7 says the repository-level gates cover
ground this change does not move, and the macOS `verify` job is CI's to run.

## The cadence, honestly

§7 says the gates run **once**, at the end of the whole slice, because running them per work
package would spend the time on gates that cannot pass until the slice is finished. The rule was
honoured where it matters — **the gate was never run per work package**; each issue ran only the
suites that issue touched — but the gate as a whole ran **five times, not once**. Every run came
after a whole block of changes, and each of the first four found a real defect, so stopping after
the first would have meant shipping a gate that was red for a known reason.

| Run | The tree it ran at | What it found |
| --- | --- | --- |
| 1 | at the end of the plan | two defects: the stylesheet referenced two variables that do not exist, and the file results were read by the tab id while the read was filed by the content key |
| 2 | after the external review's fixes (`456f814c`) | the port-slices test named the browser slice's members, which the new close operation had joined |
| 3 | `4d247f43` | an acceptance case failing intermittently — a run with no selection that opened a web tab was not given the page, because the service compared a selection it had read *before* the listing against a generation that had moved while the listing was in flight. The service now reads the selection per target, and the registry adopts a provider-reported generation that is ahead, because a page that is still loading is observed as a replaced page while it is being attached to. |
| 4 | the same tree, before `782c137b` | the suite's file failing with every test in it passing: the provider removed its profile directory right after killing the browser, and the browser was still writing it. The removal is now retried. |
| 5 | `4e7efd43` | nothing — everything green, as the table above says |

Runs 3 and 4 found the *same* two defects from different angles: the first was a test failing, the
second was a file failing with nothing failing in it.

**Everything else was a targeted re-run, not the gate.** The unit suite was re-run four more times
on the final tree — 208 files and 3230 tests every time, no unhandled errors — while the two
intermittent failures above were being pinned down, and single suites were re-run while their own
defect was being fixed. Those are development iterations on a failing suite; the table above is the
list of the gate runs, and this file is the list of what each one found.

## What the repository's CI says, and what it does not

The fork's CI runs the repository's whole `verify` profile, which is wider than §7. Its history on this
branch and on the base branch:

| Tip | What failed |
| --- | --- |
| `83d8052a` (the first push) | `test:webui` on ubuntu — the suite's file failing with every test in it passing: the `ENOTEMPTY` cleanup race, fixed in `782c137b` |
| `5d154673` | `test:capabilities` on macos-latest, in `packages/local-runtime-v2/test/unit/agent/storage/agent.repository.test.ts` |
| `acbf1b40` | `verify (ubuntu-latest)` — the six external-bridge cases described below |
| `01cf5785` | the same six, and `verify (macos-latest)` was **cancelled** with the matrix |
| `9d945e54` | the same six — now with a named cause — and `verify (macos-latest)` **passed** (14m51s) |
| `54db73a3` | the ubuntu and windows jobs **pass** — the ubuntu job is green for the first time since the browser-use programme landed; the macOS job was cancelled while it was still queued, so it carries no verdict |
| `3d3b7846` | **nothing** — all three platforms pass, and the workflow's own "Require every planned check" gate passes with them |
| `4a0a5d90` | `test:webui` on ubuntu — a suite file failing with every test in it passing: the `ENOTEMPTY` removal race, this time in a test's own teardown. And `test:windows` on windows, where the runner's PowerShell timed out while it checked the checkout volume |
| `a63a6c99` — the base branch's own CI run, before this programme | `verify (macos-latest)` and `verify (ubuntu-latest)` |

So the `test:capabilities` failure is **pre-existing on the base branch**, in a package this slice
does not touch: `packages/local-runtime-v2`. The plan's §7 says the repository-level gates cover
ground this change does not move, and that is exactly what the history shows. The webui gates — the
ones §7 names and §9 requires — are green at the tip that carries this record, and the run at
`83d8052a` that the CI caught was the cleanup race, which is fixed.

The base branch's own run, `a63a6c99`, **cannot** say anything about the external-bridge spec: the
spec did not exist at that commit. It was introduced by the browser-use programme at `91a1a1c4`, and
every CI run of that programme from there on has failed the same six cases.

### The CI's ubuntu job, at the tip

The CI's `Source verification` run at the tip this record carries — run `39649558021`, head
`01cf5785`:

| Job | Result |
| --- | --- |
| `changes` | **pass** |
| `verify (windows-latest, 24)` | **pass** (3m14s) |
| `verify (macos-latest, 24)` | **cancelled** — the matrix cancelled it when the ubuntu job failed, so it carries **no verdict**, not a pass |
| `verify (ubuntu-latest, 24)` | **failure** (18m45s), stopped at `test:webui-browser` |
| `verification` | failure — "Require every planned check" |

Inside the ubuntu job:

| Step | Result |
| --- | --- |
| `test:webui` | **pass** (107.5s) — the webui unit suite is green in CI |
| `test:webui-package` | **pass** (23.1s) |
| `test:webui-browser` | **FAIL** (890.4s) — 140 passed, **6 failed** |

The next run of the branch — `39656341109`, head `9d945e54` — repeated the ubuntu failure and settled
the macOS question: `changes` **pass**, `verify (windows-latest)` **pass** (2m59s),
`verify (macos-latest)` **pass** (14m51s), `verify (ubuntu-latest)` **failure** (16m59s). The macOS job
had no verdict at `01cf5785` because the matrix cancelled it; it has one now.

### The six failures, and what they are not

The six are all in `packages/webui/test/browser/browser-bridge-real-external.spec.ts` — the
**previous** programme's external-bridge cases, which drive a real browser with the built extension
and then act on the **live tab**. At `01cf5785` each one ran to the test's own 120-second timeout
with no other error:

| Case | Result |
| --- | --- |
| `browser-bridge-real-external.spec.ts:82:5` — the bridge survives the worker being terminated in `chromium` | timeout (2.0m) |
| `browser-bridge-real-external.spec.ts:162:5` — text input reaches the page through the chrome bridge in `chromium` | timeout (2.0m) |
| `browser-bridge-real-external.spec.ts:262:5` — a DevTools command runs against the live tab through the chrome bridge in `chromium` | timeout (2.0m) |
| `browser-bridge-real-external.spec.ts:82:5` — the bridge survives the worker being terminated in `msedge` | timeout (2.0m) |
| `browser-bridge-real-external.spec.ts:162:5` — text input reaches the page through the edge bridge in `msedge` | timeout (2.0m) |
| `browser-bridge-real-external.spec.ts:262:5` — a DevTools command runs against the live tab through the edge bridge in `msedge` | timeout (2.0m) |

### Where they stop, and what was done about it

A timeout with no other information says nothing about *where* the case stopped, because the
harness's waits on the extension have no deadline of their own: a service worker Chrome has
reclaimed does not answer, and a message nobody replies to does not settle. Every such wait is now
bounded, and each bound names the step it was waiting for (`9d945e54`) — a bound that expires
fails the case with a diagnosis, and it neither makes a failing case pass nor skips one.

With the bounds in place, the next CI run named the step:

```
Error: the bridge's http server did not close did not finish within 30000ms
    at real-browser-bridge.ts:127
```

So the cases' **work is finished** — the browser starts, the extension pairs, the handshake
completes, the DevTools command runs against the live tab — and what hangs is the **cleanup**. The
browser is still running while the harness closes its server, so the browser may still be holding a
connection: the extension's socket, or the keep-alive connection the test page was fetched over.
A server that waits for a client to go away first cannot close while that client is still running,
and the extension makes it worse by reconnecting to a host that is going away.

Two changes, both test-side, neither of them an assertion:

| Commit | Change |
| --- | --- |
| `9d945e54` | every wait in the harness that can outlive its case is bounded, and names its step |
| `a4f8f7c6` | the browser stops before the server, and the harness cuts the connections it still holds instead of waiting for them |

The local browser suite is green with both (146 cases, 2.1m).

**And the CI is green.** The run at `54db73a3` has `verify (ubuntu-latest)` **passed** — `test:webui` 208
files, `test:webui-browser` **146 passed in 2.8m**, the source projection 5407 files, the dependency
and build-boundary checks, the installed package and the capability suite — and
`verify (windows-latest)` passed with it. The six cases that had been red on every CI run since
the browser-use programme introduced them now pass on the runner that has been failing them. The
macOS job of that run was cancelled while it was still queued, so it carried no verdict; the next
run, at `3d3b7846`, has **all three platforms passing** and the workflow's own "Require every
planned check" gate passing with them — and so does the run at `9ac67622`, after the second
`ENOTEMPTY` fix below. The fork's CI has been red on this line since the browser-use programme
landed; it is green now, and it is green on the tree this record carries.

### The second `ENOTEMPTY`, and a runner flake

The run at `4a0a5d90` failed the ubuntu job on a suite file whose every test passed:

```
FAIL packages/webui/test/integration/browser-use-real-input.test.ts
Error: ENOTEMPTY: directory not empty, rmdir '/tmp/webui-browser-use-e2e-*/browser'
```

That is the same race as the one this record already carries, in a different place: the browser is
killed and its profile directory is removed straight away, and the browser may still be writing its
last files. The provider's own removal has retried for that reason since `782c137b`; the tests that
remove a browser's profile did not, so the race surfaced there instead. Every such removal retries
now (`9ac67622`) — a profile is a directory the browser owned, and the browser is gone, so a removal
that races with its last writes is retried rather than reported as a failure.

The same run failed the **windows** job on `test/windows-contract.test.mjs` — "Windows could not
verify the checkout volume (spawnSync powershell.exe ETIMEDOUT)". That is the runner's PowerShell
timing out while it checked the volume, in a repository-level gate this slice does not touch; the
run before it passed the same test on the same code, and the run after it did too.

**This corrects what an earlier version of this record said.** It said the runner "cannot drive a
real browser with the extension", and that the spec's "is the browser installed" guard was the
reason. Both were wrong. In the *same job*, the sibling spec
`packages/webui/test/browser/browser-bridge-real-browser.spec.ts` **passes in both channels**: the
extension completes the handshake in **785 ms** in `chromium` and in **22.6 s** in `msedge`. The
runner does launch a real browser with the built extension, and the extension does pair with the
host. What is true is narrower: on that runner, the external spec's operations against the live tab
never come back.

**And it is inherited, not introduced here.** The same six cases failed the same way on `a18c916b`
— the browser-use programme's own head commit, merged as PR #195 — where the ubuntu job stopped at
the same gate with **138 passed, 6 failed**:

```console
$ gh run view 39538891164 -R mcode-webui/minimax-code --log-failed \
  | grep -oE "✘ +[0-9]+ packages/webui/test/browser/[^ ]+|[0-9]+ failed|[0-9]+ passed \([0-9.]+m\)|Verification failed at: .*"
✘   20 packages/webui/test/browser/browser-bridge-real-external.spec.ts:82:5
✘   21 packages/webui/test/browser/browser-bridge-real-external.spec.ts:162:5
✘   22 packages/webui/test/browser/browser-bridge-real-external.spec.ts:262:5
✘   23 packages/webui/test/browser/browser-bridge-real-external.spec.ts:82:5
✘   24 packages/webui/test/browser/browser-bridge-real-external.spec.ts:162:5
✘   25 packages/webui/test/browser/browser-bridge-real-external.spec.ts:262:5
138 passed (15.8m)
6 failed
Verification failed at: test:webui-browser
```

`a18c916b` is an ancestor of this branch's base (`webui`), so the base branch carries that redness.
This slice does not touch the extension, the bridge server, or that spec:

```console
$ git diff --name-only webui..HEAD -- packages/browser-extension packages/webui/src/server/browser-bridge
                                     # (no output)
$ git diff --name-only webui..HEAD -- packages/webui/test/browser
packages/webui/test/browser/acceptance-record.ts
packages/webui/test/browser/architecture-acceptance.spec.mjs
packages/webui/test/browser/browser-bridge-real-external.spec.ts
packages/webui/test/browser/native-runtime.spec.mjs
packages/webui/test/browser/real-browser-bridge.ts
packages/webui/test/browser/review-consumers.spec.mjs
packages/webui/test/browser/terminal-cross-page.spec.mjs
```

Of the seven files under `packages/webui/test/browser/`, five are the acceptance-record writer and
four specs that never mention the bridge or the extension, and the other two are the external-bridge
case and the harness it shares with the sibling spec — the two files the cleanup fix above touches.
Neither the extension nor the bridge server changed at all.

**They pass here**: the same six cases, on the same tree, in about five seconds, and the record they
write names the browsers they ran in — Chromium 153.0.8010.12 and Edge 155.0.4283.62, six cases,
all `pass` (`.plan/browser-use/complete/real-external.acceptance.json`).

**What is left, exactly:** nothing in CI. All three platforms pass at `3d3b7846`, together with the
workflow's own "Require every planned check" gate. The ubuntu job had been red on the six
external-bridge cases since the browser-use programme landed them; the fix that turned them green
is in this branch, and the record says which two commits did it and what each one changed.

## What the real-browser acceptance rests on

The fourteen acceptance cases in
[`workspace-browser-tab.acceptance.json`](workspace-browser-tab.acceptance.json) were written by the
suite itself, against real Chrome 152, at the commit that carries this record. The record is the
programme's own evidence, and it is the file the published acceptance record is written from.

## What was not observed

- The macOS `verify` job at the tip: it was **cancelled** with the matrix when the ubuntu job
  failed, so it had no verdict. It has one now: the run at `3d3b7846` passed all three platforms
  and the workflow's own "Require every planned check" gate.
- The cross-surface bootstrap — a person opening a web tab while the run is selected on Edge — is
  implemented run-wide, but it has no dedicated test. The two same-surface cases are covered by the
  acceptance suite. The plan's own acceptance matrix (§6) is entirely on the `isolated` surface, so
  this is a gap in the evidence rather than in the plan's requirements.
- Playwright's trace for the six external-bridge cases is written to the runner's temporary
  directory and is not uploaded with the verification summary, so the trace itself has not been
  read. The bounded waits name the step without it.

## A commit whose subject names only part of it

`0cc664a0` is titled `docs(webui): the plan records that the slice is delivered`, and it is also
where one line of `packages/webui/test/unit/webui-port-slices.test.ts` changed: `closeBrowserWebTab`
joined the expected members of the browser port slice. The commit's body says so. The subject was
not rewritten afterwards, because rewriting it would change the hash of every commit above it, and
those hashes are what the two records in this directory and the published comments on the board
issues refer to — the evidence chain would break in exchange for a better first line. The change
itself is one line, in a test that asserts the port's published members.

## Where the external review's invocation is recorded

The review was run through **paseo**, which started a Codex session against this branch. The
invocation — the provider, the model, the thinking option, the session, the workspace and the
prompt — is written down in [`codex-review.md`](codex-review.md), so that the review is not only
attested by the commit that fixed its findings.

