---
name: merge-and-baseline
description: Merge a PR into this repo without contaminating the baseline, then bring the local checkout, the roadmap and the group chat back in sync. Use after any PR is merged or after someone else's PR is merged into `webui` or `main`.
---

# Merge, then realign

A merge is not done when GitHub says merged. It is done when three copies
agree: the remote baseline, the local checkout, and what the team was told.

This exists because on 2026-10-03 a PR that was meant to carry two test files
was branched from the wrong HEAD and dragged 2 375 lines of unreviewed work
into `webui` with it. GitHub was green throughout. The contamination was only
visible in `git diff <expected-base> <head>`.

## 1. Before opening or merging

**Never branch from "wherever HEAD happens to be".** A checkout left on
another branch turns `-b` into a fork of that branch.

```bash
git fetch origin <target-base>            # know the true baseline
git checkout -B <branch> origin/<target-base>   # -B forces the START POINT
git log --oneline -1                       # confirm you are on the new base
```

**Check the PR carries what it claims.** A PR that says "6 files" and diffs
twenty is the whole failure mode in one command:

```bash
git fetch origin <branch>
git diff --stat origin/<base>...origin/<branch> | tail -1
git log --oneline origin/<base>..origin/<branch>
```

Every commit in that list should be explainable by the PR's title. If a commit
is not, stop and find out how it got there before merging.

**Wait for the gate, and read which one failed.** `Verification failed at:
<gate>` is an entry point, not an answer. The answer is in that job's log:

```bash
gh pr checks <n>
JID=$(gh pr checks <n> | grep macos | awk '{print $NF}')
gh run view ${JID%/job/*} --job ${JID##*/job/} --log-failed | grep -E "Verification failed at|× "
```

## 2. Merging

```bash
gh pr merge <n> --merge     # merge commit, keeps per-commit attribution
```

Never squash a PR whose commits mean different things. This repo's gate order
is part of the review surface: a squashed PR hides which gate a fix belongs to.

## 3. Immediately after the merge

```bash
git fetch origin <target-base>
git checkout <local-branch-on-that-base>
git merge --ff-only origin/<target-base>   # ff-only: a real merge here means someone merged your branch
```

`--ff-only` is deliberate. If it refuses, your local branch is ahead of the
remote base — which is what happens when your branch already got merged
*through another PR*. Find out which one:

```bash
git log --oneline --merges origin/<base> -4
git merge-base --is-ancestor <your-old-head> origin/<base> && echo "已在 baseline 上"
```

## 4. Report the baseline change to the team

The roadmap is the team's shared record. A merge that changes what exists but
not what the roadmap says is a merge that will be re-litigated next week.

The bot speaks for 莫克 in the group. Send one message that states: what was
merged (PR + title), the baseline commit moved to, and what the roadmap's
"基准线" line now reads. Then update the roadmap itself:

- Baseline line in `mcode-webui-roadmap` (`BBu7dwPTCo5Ryix2MG7ctlAwndg`) —
  the commit under `## 决定`, and its date/author, must match `webui` HEAD.
- The claim table and the ✅/🟡/➖/❌ summary rows follow from what actually
  merged. Recompute them from the merged code, not from intent.

Re-read the document's block structure before editing. Its tables are real
docx `table` blocks; writing a markdown pipe row as text produces a line
nobody can read and a table that silently loses a column.

## 5. Verify the local checkout really matches

```bash
git rev-parse --short HEAD origin/<target-base>
git diff --stat origin/<target-base>   # empty means aligned
git status --short                     # empty tree
```

Both commands empty. A non-empty diff against the baseline means you are
testing something the team does not have.

## Gates

For this repo, `pnpm verify --profile platform` is what CI runs. Two known
conditions on `webui`, both fixed by merged PRs rather than by anything local:

- `test:webui` was red on the 83321d0 baseline (four stale tests).
- `test:capabilities` was red on macOS (a `/var` vs `/private/var` comparison
  that also made the test vacuous).

A red gate on your branch is not automatically your regression. Diff the
failing test names against the baseline before you start hunting.
