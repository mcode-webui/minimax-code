# ADR 0003 amendment — shared event corpus in `@mavis/local-runtime-v2`

## Status

Amendment to [0003-no-dependency-on-tui-internals.md](0003-no-dependency-on-tui-internals.md).
Accepted as the bridge between ADR 0003 ("the WebUI may not import
`packages/tui`") and ADR 0001 ("the WebUI is a peer of the harness").
Records the design that lets the WebUI re-implement TUI projection logic
without drifting from TUI's behaviour.

## Context

The original WebUI build was a half-finished client under
`packages/webui/` whose behaviour was roughly consistent with the terminal
client, but not derived from it. The WebUI intentionally copies a small,
well-defined subset of TUI behaviour into the WebUI tree:

- the compaction projection (`packages/tui/src/runtime/projections/context-snapshot.ts`);
- the compaction event predicate
  (`packages/tui/src/tui/controller/runtime/runtime-event-flow.ts:1115`);
- the permission / questionnaire state mapping
  (`packages/tui/src/tui/controller/runtime/runtime-state-coordinator.ts:27-50`);
- the usage projection that does not double-count compaction messages
  (`packages/tui/src/application/response-usage.ts:14`).

ADR 0003 rejected "Copying the projection logic" outright, on the grounds
that two copies drift apart. The plan adopts the same rejection. The
amendment adds the mechanism that keeps the copies aligned without
violating the ADR.

The terminal client and the WebUI are peer clients of the harness
([ADR 0001](0001-webui-is-a-peer-client-of-the-harness.md)), not of each
other. They are updated independently and have separate review paths.
When the harness event protocol changes, both clients must update their
consumers. Neither client is a source of truth for the other.

## Decision

The harness owns a **shared event corpus** at
`packages/local-runtime-v2/test/fixtures/event-corpus/`. Each fixture is
a recorded `SessionStreamFrame` shape (the same wire format the harness
emits at runtime) plus a documented expected projection outcome. The
corpus is the conformance surface for the harness event protocol.

Each client that consumes harness events runs a regression test against
the corpus:

- `packages/tui/test/unit/runtime-event-normalizer.test.ts` exercises
  the TUI's `normalizeTuiRuntimeEvent` against the corpus.
- `packages/webui/test/unit/projections.test.ts` exercises the WebUI's
  local reducers against the corpus.

The two test files reference the same fixtures and the same expected
outcomes, so any harness event protocol change lights up tests in
whichever client has not yet been updated. There is no cross-client sync
obligation. The corpus is reviewed alongside every harness protocol
change.

## Layout

```
packages/local-runtime-v2/test/fixtures/event-corpus/
  README.md
    One paragraph each:
    - who owns the corpus (@mavis/local-runtime-v2 maintainers);
    - how to add a fixture (record a frame, document expected outcome,
      commit);
    - how to update the corpus (a harness protocol change requires both
      client test suites to be updated in the same PR cycle).
  compaction.completed.json
    Recorded session.compaction.completed frame plus expected
    WebuiContextSnapshotResponse.compaction projection outcome.
  compaction.failed.json
  permission.ask.json
  permission.resolved.json
  questionnaire.ask.json
  questionnaire.dismissed.json
  usage.turn-end.json
  reconnect.cursor-out-of-range.json
  ...
```

A fixture is **not** an end-to-end test of the harness; it is a recorded
shape that lets each client's reducer prove it produces the documented
projection outcome. The harness itself is tested in the integration
suites; the corpus only standardises the input shape for client
reducer tests.

## Why not extract a shared client package

ADR 0003 lists "Extracting a shared client package" as the deferred
long-term shape:

> Extracting a shared client package — deferred: the right long-term
> shape, but it moves existing call sites and files, which is exactly
> the kind of change that collides with upstream synchronization.

The shared event corpus is a narrower move: it standardises the **input
shape** (the corpus) and the **expected outcome** (per-client test
assertions), but does not standardise the **code**. Each client still
owns its own reducer; both reducers are independently implemented and
independently reviewed. The corpus is the reviewable interface; the
code is per-client.

The repository's `AGENTS.md` warns that "moving or renaming files
therefore has a cost that a normal repository does not have: it shows up
as a conflict or an unreviewed new file at the next synchronization."
A shared client package would move files out of `packages/tui/src/` and
`packages/webui/src/`, which is exactly the kind of change that
collides with upstream synchronization. The corpus avoids that.

The shared client package remains the long-term shape. When the harness
event protocol stabilises, and when both clients have stabilised their
reducer implementations against the corpus, a future ADR can propose the
package extraction and migrate the reducers.

## Consequences

- The WebUI is allowed to re-implement the relevant TUI projection
  logic under this amendment.
- Each re-implementation is paired with a corpus-backed regression test
  registered in `test/vitest-suites.json`.
- The corpus lives in `@mavis/local-runtime-v2` so both clients'
  test suites can import it as a workspace dependency.
- A harness event protocol change is reviewed for corpus impact; if a
  fixture changes, the PR is expected to update both clients' test
  suites in the same review cycle.
- This amendment does **not** override ADR 0003 in other respects.
  Reading TUI's projection code remains the expected practice;
  depending on it (importing) does not. The corpus is the substitute for
  depending on the code.