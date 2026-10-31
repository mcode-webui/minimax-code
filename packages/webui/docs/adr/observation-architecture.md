# Decision: the WebUI client keeps reconciling its own delivery state

**Status:** decided by execution, 2026-10-16. Outcome: **keep the client's reconciliation
approach**. A server snapshot-plus-deltas design is **not** promoted. ADR 0018 records the decision;
this document is its evidence.

**Evidence availability:** the two probes this decision was made from were scratch artifacts run
from the repository root and deliberately kept **outside** the repository. They are not present in
this checkout or on this machine any more. What survives is this record of what they measured — treat
it as the evidence, and re-run the comparison (see §"Limits") rather than re-deriving it from a
reconstruction.

## What was executed

| Artifact | What it did |
| --- | --- |
| `probe-real-host.mts` | Booted the **real** production chain — real assembly, real port, real registry, real `WebuiService` on a loopback socket, real `ws` clients — and inspected the frames a real turn produced. Only the external model service was a local stub. |
| `run-traces.mts` | The plan's seven traces (nine scenarios: the terminal-loss row split into one-channel and both-channels, plus one exercising the repair for the defect found) against an always-online oracle and three designs. Arm A drives the **repository's own** reconciliation functions; frame loss is injected independently on each channel. |

Both ran from the repository root under `npx tsx --tsconfig tsconfig.standalone.json`, exit 0. No
production operation, public event, feature flag or host API was added.

## Arm A — the client's own policy, as it stands

Arm A is not a re-implementation. The harness drives `decideWebuiSessionStart`, `claimWebuiLease`,
`releaseWebuiSubscription`, `recheckWebuiSubscription`, `recoverMissedWebuiTurn`,
`resolveWebuiSubscriptionRecheck`, `isWebuiSubscriptionProbeCurrent`, `matchesWebuiTerminalTurn`,
`recogniseWebuiStreamPayload`, `reduceWebuiStreamFrame` and `applyFrameCursor` from
`client/conversation/` and `client/features/turn/`. **8 of 9** scenarios converge.

## Arm B0 — snapshot plus deltas on what the host offers today

A `getMessages` snapshot and a `watchEvents` subscription, with no invented contract. **1 of 9**
converges, and only in the scenario that happens to resnapshot after the fact.

## Arm B1 — B0 plus an invented epoch, cursor and update channel

**9 of 9** converge — but every convergence comes from a capability the harness supplies and the host
does not have:

| Invented capability | Evidence the host lacks it |
| --- | --- |
| a server epoch | the real-host probe found no ordering-candidate field on any event frame, and none shared with the stream channel |
| a monotonic update cursor | the only cursor on the wire is the stream cursor, which addresses one turn's frame buffer |
| a session-scoped update channel carrying every logical update | the real event channel carried only `session.created`, `session.start`, `session.finish`, `session.title_updated` — 0 frames containing an `agent_message` |

## What the real host actually provides

From the real-host probe, on a turn whose answer really streamed (16 frames on the `sendMessage`
stream, the stub model really serving it):

- the wire envelope carries `body`, `kind`, `protocolVersion`, `requestId` and nothing else;
- the event channel carries **no** transcript: assistant text appears only on the per-turn stream;
- a `getMessages` read taken mid-turn holds 1 message while the oracle ends with 2;
- the stream's `event_id` values are name-derived and non-contiguous (`…_pi_turn_start_3`,
  `…_pi_turn_end_7`, `…_pi_agent_end_8` — four to six carry no id at all), so they cannot order two
  updates or distinguish a gap from a step that never had one;
- `getActiveTurn` is the only read that names the running turn, which is what makes any recovery
  possible at all.

A snapshot-plus-deltas client therefore converges to a transcript that is missing the answer. The
consistency obligation fails on the existing host — executed, not inferred.

## Why the client approach was kept

1. **Correctness and a justified consistency model are prerequisites for promotion.** Arm B1 passes
   in the harness, but its consistency model cannot be justified on this host: the epoch, the cursor
   and the session-scoped update channel do not exist, and adding them is a new host contract, which
   this comparison explicitly did not have licence to implement. Promotion fails this rule.
2. **Keep the client approach if it meets the scenarios with fewer total responsibilities, or the
   server approach cannot prove ordering without a new host contract.** Both halves hold: Arm A meets
   8/9 with eight client-side policies and no new protocol identity; Arm B1 needs a new host contract
   and three new server obligations to reach 9/9.
3. **Promotion is not recommended.** The server obligations it adds are larger than the client
   policies it would eliminate.

| | Arm A (client) | Arm B1 (server, invented) |
| --- | --- | --- |
| Client policies | active-turn probe; generation-fenced lease claim and scoped release; the `session.start` decision; recheck resolution; terminal attribution by turn id; cursor resume and overflow resync; delivery handle registration; stale-completion fence | the same probe is still needed for a turn the client never saw; snapshot/subscription ordering; gap and overflow handling; stale-epoch fence |
| New protocol identities | 0 | 2 (epoch, update cursor) |
| New server persistence | 0 | 1 (the update log) |
| Reads per scenario (measured) | 1–3 `getActiveTurn` | 1 epoch read + 0–1 delta reads |
| Converged | 8/9 | 9/9, only with the invented contract |

## The one identified client defect, and its remediation

**Defect.** When a turn's terminal signal is lost on **both** channels, the lease and the phase stay
`streaming`. The recovery pass cannot repair it: the authoritative read says nothing is running, and
`recoverMissedWebuiTurn` only attaches to a turn that *is* running. The lease was repaired by the
**next** turn's `session.start`, which resolves through `resolveWebuiSubscriptionRecheck` to
`release`.

**Remediation, implemented.** In the recovery pass, when the authoritative read reports no active
turn, the probed lease is a recovered lease and that exact generation is still current, the client
settles it and returns the phase to idle. A locally issued send lease is preserved, because the
active-turn read can race send acceptance. A newer or replaced generation is never released. The wire
is unchanged. Regression coverage: `test/unit/webui-application-commands.test.ts` (the policy
decision and the newer-generation fence) and `test/unit/conversation-turn-commands.test.ts` (the
assembled production command updates phase, lease and sending state while preserving the transcript).

## Limits of this evidence

- The trace comparison ran against a **scripted** host. That is enough for deterministic fault
  injection; the host-consistency claims come from the separate real-host probe, not from it.
- The invented update channel has no loss policy in the harness. A design that adds a third channel
  has to say what happens when that one drops too; that obligation is listed and **not** measured.
- The real-host probe exercised one turn shape (a text answer, no tools, no queue drain) and no
  overflow. Overflow and restart behaviour are covered by the scripted traces only.
- Arm A's retention is bounded by the scenario's message count (at most two). No long-turn or
  high-chunk-rate measurement was taken, so "bounded retained state" is established structurally, not
  under load.
- **Re-run the comparison if the host ever gains a session-scoped, ordered update stream.** The
  conclusion is about this host, not about the design in the abstract.
