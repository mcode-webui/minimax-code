# The WebUI is a scheduler host for scheduled tasks, and the slot claim decides who acts

## Status

Accepted. It supersedes the premise of the retired 0012 record ("the WebUI runs its own
scheduled tasks until the runtime offers one", listed in the
[Decisions table](../README.md), with its live facts in
[known-gaps.md](../known-gaps.md) §7). The WebUI gets a scheduled-task surface back and it
executes scheduled tasks. It does not get a scheduler of its own: it uses the v2 runtime's
one scheduler, the same one the Desktop uses, and the two of them are kept correct by the
shared database rather than by an agreement between the applications.

## Context

### The two cron models are not the same model

- The v1 model lives in `packages/agent-modules/cron` (`@mavis/cron`) with
  `packages/local-runtime/src/cron/`. Each task is a JSON config file under
  `<dataDir>/local-crons/<agent>/<name>.json` and its history is a SQLite row
  (`packages/local-runtime/src/cron/store.ts:30-41`); markdown with YAML frontmatter is the
  legacy form it migrates from
  (`packages/local-runtime/src/cron/legacy-md-migration.ts:231`). The terminal client drives
  it, and the Desktop exposes it to the model through the `mavis` tool's cron commands
  (`packages/local-runtime/src/runtime/mavis-cron-adapter.ts`). Its HTTP routes are
  retired sources.
- The v2 model lives in `packages/local-runtime-v2/src/service/cron/`. It stores definitions
  and run history in SQLite (`cronDefinitions`, `cronRuns`) and schedules through
  `infra/scheduler/index.ts`, a `croner`-based scheduler whose job rows are persisted in
  `schedulerJobs`. It is composed into every v2 host: `services.ts:1260` calls
  `initializeCronService`, which refuses to start without an owned Scheduler client.

This ADR is about the v2 model only. The v1 store is not read, migrated, or mirrored.

### What the WebUI can and cannot reach today

The WebUI resolves to a v2 host that declares itself a scheduler host.
`packages/webui/src/runtime/assembly.ts:325` sets `runtimeOwnerKind: "webui"`, and the
`webui` row of the runtime owner policy grants `schedulerHost: true`
(`packages/local-runtime/src/runtime/runtime-owner-policy.ts:405`) and `cronService: true`
(``:411`) — deliberately aligned with the `electron` (Desktop) row (`:273`). The WebUI also
shares the data directory with the Desktop
([ADR 0006](0006-webui-shares-the-cli-data-directory.md)), so both processes open the same
SQLite file. Two processes are already an accepted arrangement there: the client opens it
with `journal_mode=WAL, busy_timeout=5000` (`infra/db/client.ts:119`).

The WebUI cannot reach the Cron service at all today. Its only runtime surfaces are
`apiHost` and `cliService` (`packages/webui/src/runtime/harness/host-contract.ts`), and
neither `CliService` nor `WebuiRuntimeCliService` declares a cron member. That is the
second condition of the retired ADR 0012 — "the created service is reachable from the host
rather than sealed inside `createLocalRuntimeHostV2` locals" — and it is still unmet.

### What is already safe, and what is not

Execution is already safe. `executePending` calls `runs.claimExecution(runId, nowMs)`
before doing any work (`service/cron/orchestration/executor.ts:454`), and `claimExecution`
is an atomic conditional update that requires `executionClaimedAtMs IS NULL`
(`adapters/run.repository.ts:160-175`). Delivery is idempotent per run:
`turns.steer()` is called with `idempotencyKey: request.runId`
(`service/cron/runtime-delivery.ts:38-45`). One run row produces one turn, and a
duplicated delivery does not duplicate it.

Scheduling is not safe. Three facts make it unsafe.

1. **The timer is process-local, and mutations arm it unconditionally.**
   `CronDataLifecycle` calls `scheduler.schedule()` directly inside its transaction
   (`service/cron/orchestration/lifecycle.ts:30`), `scheduler.get()` to read a job for
   update (`:60`) and delete (`:92`), and `scheduler.reschedule()`/`cancel()` to mutate it
   (`:126`). `scheduler.schedule()` always constructs a `Cron` timer
   (`infra/scheduler/index.ts:146-157`). A definition created in the WebUI is therefore
   armed in the WebUI process and in no other. The WebUI's cold start is `quarantined`
   (`assembly.ts:327`), which resolves to `restorePersistedJobExecution: false`
   (`runtime.ts:857`) and therefore skips every restored job
   (`infra/scheduler/index.ts:272-276`): the task fires while that WebUI process lives and
   stops silently after its next restart.
2. **The trigger identity is a process-local counter.** The handler builds
   `triggerId = ${schedulerId}:${job.scheduleGeneration}:${job.runCount}`
   (`service/cron/composition.ts:102`), and the run count it reads is the post-increment
   value (`infra/scheduler/index.ts:389-403`). `insertPendingScheduled` converges on that
   trigger id (`adapters/run.repository.ts:57-79`), so two hosts that hold the same counter
   produce one run. They do not hold the same counter. `protect: () => reportSkipped('overlap')`
   (`infra/scheduler/index.ts:365`) skips a fire that lands while the previous handler is
   still running, and the two hosts have different execution durations, so one host
   regularly advances while the other does not. The counters drift, the trigger ids
   diverge, and one logical slot produces two runs.
3. **A write-back can undo the other host's change.** `advanceJob` re-persists the row
   from the host's own in-memory record (`infra/scheduler/index.ts:412-425`), and
   `updateJob` writes the whole row — `schedule_json`, `schedule_generation`, `run_count`,
   `state`, `next_run_at_ms` (`infra/scheduler/index.ts:686-696`). `restoreTimer` writes the
   same whole row (`:341`). A host whose in-memory copy is stale overwrites the other
   host's schedule, state and counter with its own.

The same three facts are why the WebUI-owned scheduler was deleted on 2026-10-09: two
schedulers over one queue.

### The constraint that shapes the answer

The Desktop application is owned by another team and its source is not in this repository.
A design that requires the Desktop to change its behaviour, or to ship a new runtime,
cannot be relied on. So the WebUI feature has to be correct against a Desktop that stays
exactly as it is.

That rules out electing a single armed process by a lock both sides must take, and it
rules out making the WebUI a passive client that never fires anything — which would also
leave a WebUI-only user with no scheduler at all.

What it does not rule out is making the shared database the arbiter. Every mechanism below
is either a conditional write or a new nullable column, so an unmodified Desktop keeps
working and simply behaves correctly.

## Decision

**The WebUI is a scheduler host. It arms the persisted scheduled tasks and fires them.
When another host is also armed, the database decides which one acts on a given slot.**

The WebUI is a peer of the Desktop here, not a subordinate. There is no lease, no
election, no reconcile loop, and no Desktop change.

### R1. Cron arming no longer follows the cold-start policy

`restorePersistedJobExecution` currently comes from `startupExecutionEnabled`
(`runtime.ts:857`), which is false for the WebUI because its cold start is `quarantined`.
It comes from the owner policy's `schedulerHost` cell instead, which is true for both
`electron` and `webui` (`runtime-owner-policy.ts:273`, `:405`).

`recoverPersistedState` (`runtime.ts:878`) and `greetingEnabled` (`:879`) stay gated by the
cold-start policy. This is a narrow amendment to
[ADR 0002](0002-in-process-runtime-host-with-quarantined-cold-start.md): the quarantined
cold start governs session and turn recovery, and it no longer governs cron job arming.
The reason ADR 0002 gave for rejecting the default cold-start policy — "the data directory
is shared with the CLI, so a WebUI restart and the terminal client would both attempt to
resume the same persisted jobs" — is answered by the mechanisms below rather than by
restoring that policy wholesale.

### R2. A restore must not roll a peer back

`restoreTimer` writes the whole row today (`infra/scheduler/index.ts:341`), so a WebUI
boot that lands between a Desktop's read and its write can move the Desktop's `run_count`
backwards. Restore writes become conditional:

```
SET next_run_at_ms = ?, updated_at_ms = ?
WHERE scheduler_id = ? AND run_count = ? AND schedule_generation = ?
```

A zero-change result means the peer moved the row. The restoring host adopts the peer's
row instead of writing over it. A boot can never move a counter backwards.

### R3. Pre-fire adopt-or-abort

Before firing, a host reads the persisted row. If the row disagrees with the host's
in-memory record on `run_count`, `schedule_generation`, `state`, `schedule_json` or
`next_run_at_ms`, the host adopts the row, re-arms its timer to the row's schedule, and
**aborts that fire**. It fires only when the row and its memory agree.

This one rule is what makes the trigger id safe, and it is why the trigger id does not
change. The id stays `${schedulerId}:${scheduleGeneration}:${runCount}`, because an
unmodified Desktop computes it that way and the two must agree for the run to converge.
What changes is that the precondition — both hosts holding the same counter — becomes
true instead of assumed: the host that drifted adopts the row and defers, and the slot it
was late for is already covered by the host that did not drift.

The same rule subsumes two further problems without a separate mechanism for each:

- **A pause made in the Desktop.** The Desktop's `cancel()` sets `state = 'cancelled'` in
  the shared row (`infra/scheduler/index.ts:199-204`). The WebUI's next fire sees the
  disagreement, adopts, stops its timer, and does not fire the old expression.
- **A schedule changed in the Desktop.** The row's `schedule_json` and
  `schedule_generation` change. The WebUI adopts the new schedule and re-arms to it
  instead of firing the expression it was holding.

### R4. A run records who claimed it, so recovery can be scoped

`recoverPendingRuns` lists pending runs globally
(`adapters/run.repository.ts:138-146`) and marks every claimed pending run failed with
`PROCESS_RESTARTED` (`service/cron/orchestration/executor.ts:259-282`). That is wrong in
both directions once the WebUI executes. The Desktop's boot sweep kills a live WebUI run;
and if the WebUI never sweeps, a run the WebUI claimed and then died on stays pending
forever — and `delete` then refuses the definition with "Cron definition has pending runs"
(`service/cron/orchestration/lifecycle.ts:95-97`), so a WebUI-only user is left with a
cron they cannot remove.

`cronRuns` gains a nullable `owner_instance_id`. The host that claims a run writes its
instance id. Recovery reclaims a claimed run only when the claimant's runtime-owner lease
is gone, which the runtime already knows how to answer:
`RuntimeOwnerIdentity.isOwnerAlive` (`infra/runtime-owner/identity.ts:27`, `:109-136`).

The column is nullable, so the Desktop keeps writing nothing and its existing sweep is
untouched. The Desktop's sweep may still mark a live WebUI run failed at the Desktop's
next boot. That residual cannot be closed without a Desktop change, and it is accepted and
bounded: it affects one run, it fails visibly rather than silently, and the run's
definition stays deletable once the run reaches a terminal state.

### The WebUI surface

Six operations, following the five-step recipe in `packages/webui/AGENTS.md`:
`listCronTasks`, `createCronTask`, `updateCronTask`, `deleteCronTask`, `runCronTaskNow`,
`listCronTaskRuns`. `CliService` gains a Cron member and `WebuiRuntimeCliService` declares
the six forwarded members; without that the feature cannot exist, and the retired ADR 0012
stays retired. The request and response shapes are the WebUI's own — the shared contracts
directory may not import the runtime's Cron types, so the adapter converts, in the pattern
the existing adapters already use.

`runCronTaskNow` executes in the host that was asked. It does not need to be enqueued for
another host, because `claimExecution` is atomic: at most one host executes the run, and
delivery is idempotent per `runId`.

The client surface is a dedicated `scheduling` business under
`src/client/features/scheduling/`, published through its own `.public.tsx` surface like
every other business, with a dedicated entry in the left rail that opens a dedicated
panel. The panel is not a section of the settings modal and not a tab of the
session-scoped workspace panel: scheduled tasks are not session-scoped, and the rail is
the only way back out of a panel in this client.

The panel shows, for each definition: its name, its humanized schedule, its next fire
time, whether it is enabled, and **whether this client is the scheduler host for it**.
That last field is not decoration. Two scheduler hosts can serve one data directory, and a
person has to be able to tell whether a task keeps running when they close the browser.

It deliberately does not name the other host. The job row records no owner, and an
unmodified Desktop does not publish one, so naming it would require the Desktop to change
— which this ADR rules out. The panel reports what the browser can truthfully report:
this client has the task armed, or it does not, and another runtime instance may be
running on the same machine.

## Considered Options

- **Elect a single armed host with a cross-process lease.** Rejected. The lease is only
  meaningful if both sides implement it, and the Desktop's source is not in this
  repository. A lease the WebUI honours and an unchanged Desktop does not produce one
  armed host; they produce two, which is the failure this ADR exists to prevent. The
  instance lease under `v2/runtime-owner-leases/` is also already spoken for: the
  generation fence scans that directory for `*.owner` files
  (`infra/runtime-owner/rootless-v2-generation-fence.ts:124`, `:130-131`) and would refuse
  `generation rollback` while it saw one.
- **Make the WebUI a passive client that never fires.** Rejected. It leaves a WebUI-only
  user with no scheduler at all, which is the requirement the feature exists to satisfy.
- **Derive the trigger id from the slot's fire instant instead of the counter.** Rejected.
  An unmodified Desktop still emits `${schedulerId}:${generation}:${runCount}`, so a
  WebUI-emitted slot-derived id never collides with the Desktop's. The unique index
  (`infra/db/schema/cron.ts:71-73`) would dedupe nothing and two runs would be guaranteed
  rather than merely possible.
- **Re-read the counter from the row at fire time.** Rejected. It fires the wrong slot:
  the host emits the next slot's id early, and the real fire at that slot then converges
  onto the already-created run. R3 keeps the id formula and fixes the precondition
  instead.
- **Rotate the scheduler job on every edit so the peer's stale timer resolves to
  `CRON_NOT_FOUND`.** Rejected. `CronDefinitionPatch` carries only `name`, `prompt`,
  `sessionTarget`, `model` and `project`
  (`service/cron/contracts.ts:291-297`), so rotating the definition's `scheduler_id`
  needs a new repository method on a shared public contract. It is also asymmetric: it
  would kill a stale fire caused by a WebUI edit, but a schedule edit made in the Desktop
  keeps the same `scheduler_id`, so the WebUI's stale timer would still fire the old
  expression — and the Desktop-side edit is the common case under this ADR's constraint.
  R3 handles both directions with one rule.
- **Reconcile the scheduler against the definitions on a timer.** Rejected. There is no
  adopt path to reconcile with: `schedule()` inserts a new row and collides on the primary
  key, and `reschedule()` throws for a job that is not in the host's in-memory map, which
  is only populated at start (`infra/scheduler/index.ts:271`). Reaching for `reschedule()`
  anyway resets `run_count` to zero (`infra/scheduler/index.ts:174`), which breaks
  `maxRuns` accounting (`:497-502`), and churns `next_run_at_ms` against a shared WAL file
  whose `busy_timeout` is 5000 ms. R3 reaches the same result by reading the row at the
  moment it matters, and writes nothing.
- **Expose the v1 `@mavis/cron` tasks in the same panel.** Rejected. The two models have
  different data, different storage and different clients; one panel over both would need
  a dual-write adapter and a shared identity space, and the panel would show two different
  answers to "when does this task next run".
- **Put the entry in the settings modal.** Rejected. Scheduled tasks are a management
  surface with a list, an editor, a run history and a per-task action set. A settings
  modal section is for a handful of switches.

## Consequences

- A user who runs only the WebUI gets working scheduled tasks. They are restored at boot,
  they survive a restart, and they are listed with their next fire time.
- A user who runs the Desktop and the WebUI at the same time gets one execution per slot,
  and edits made in either client take effect in both.
- The Desktop needs no change. It keeps restoring persisted jobs at boot, keeps firing
  them, and keeps its existing sweep. It gains correct behaviour from the shared row.
- The panel cannot name the host that will fire a task. It reports whether this client
  has the task armed, and that another runtime instance may be running on the same
  machine. The job row records no owner and an unmodified Desktop publishes none, so
  naming the other host would need a Desktop change.
- `cronRuns` gains one nullable column and a migration.
- The scheduler's restore path stops writing whole rows and starts writing conditionally.
- A host that is slow enough to overlap its own next fire still skips that slot
  (`protect: () => reportSkipped('overlap')`, `infra/scheduler/index.ts:365`). That is
  pre-existing behaviour, and it is now visible to the user: the run history shows the
  skipped slot rather than the task dying silently.
- A fixed-target task whose session is mid-turn in another host is rejected by `steer`
  with a `CRON_DELIVERY_<REASON>` code
  (`service/cron/runtime-delivery.ts:46-56`) and the run fails. That is a product
  decision, stated here rather than left implicit.
- The verification gate for this feature is a two-host test in the runtime package: two
  hosts on one data directory, both armed, asserting that one slot produces exactly one
  run row and exactly one delivery, that a pause in one host stops the other's timer,
  that a boot never rolls a counter back, and that a run claimed by a host that then dies
  is reclaimed once that host's lease is gone. It is registered in
  `test/vitest-suites.json`; the file path is not written into the Vitest config.

## Deferred

- **The trigger id stays counter-based.** A slot-derived id would close the last drift
  case, and closing it properly needs the Desktop on the same runtime. Until then, a
  host that drifts adopts the row and defers (R3), which is safe but skips the slot it
  was late for.
- **The Desktop's boot sweep can still mark a live WebUI run failed.** Closing it needs
  the Desktop to write the claim owner, which is a Desktop change.
- **A host that is slow enough to overlap its own next fire still skips that slot.**
  Whether a skipped slot should queue or catch up is a product decision this ADR does not
  make.