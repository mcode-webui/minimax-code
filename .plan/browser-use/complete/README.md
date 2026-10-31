# Completion evidence — Browser Use development plan

This directory is where the Browser Use programme's **completion evidence** lives: the records the
suites write while they run, and whatever the programme's completion note ends up being.

The plan is [`../browser-use-development-plan.md`](../browser-use-development-plan.md). The
execution board is [`../board/`](../board/); the notes taken before implementation are in
[`../exploration/`](../exploration/).

## What belongs here

| File | Written by | What it holds |
| --- | --- | --- |
| `<suite>.acceptance.json` | the Playwright suites, through `packages/webui/test/browser/acceptance-record.ts` | one record per case: the browser version, the operating system, the settings that were enabled, and what was observed |
| `*.evidence.json` | a probe run by hand | what a real browser or a real credential store did, on the machine named in the record |

The published matrix — `packages/webui/docs/browser-use/09-acceptance-record.md` — is written **from**
these records, and it says which run it was written from. A record here without a published row is
an observation nobody has claimed; a published row without a record here is a claim nothing supports.

## The rule

One suite owns one file. A suite replaces its own file on the first record of a run, so a re-run
cannot leave a case behind from the previous one, and two suites cannot overwrite each other's
records.
