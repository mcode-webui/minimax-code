# The WebUI runs its own scheduled tasks until the runtime offers one

> **Superseded — the WebUI-owned scheduler has been removed.** On 2026-10-09 the
> WebUI's scheduled-task surface was deleted in full: the panel, the six
> operations, `WebuiScheduledTaskPort`, the in-process tick loop and the
> `<dataDir>/webui/scheduled-tasks.sqlite` store are all gone, along with the
> `better-sqlite3` dependency this decision introduced. The retirement condition
> below was never met — the runtime's cron capability is still not reachable
> from a loopback WebUI host — so this record is kept for the reasoning, not as
> a description of current behaviour. The retirement probe it commissioned
> (`webui-scheduled-task-upstream-probe.test.ts`) went with it, which also
> removed the five failures it had been reporting as `gate1=unconfirmed` since
> phase 3 moved `enableCron:` onto the owner-policy cell. Anything that rebuilds
> this surface should start from the open question rather than from the
> two-schedulers-over-one-queue hazard in "Never run both" below, which remains
> the one thing this record still has to say.

The WebUI ships a scheduled-task surface backed by its own store and its own
in-process tick loop. It does not wait for the runtime's cron capability, which
is not reachable from a loopback WebUI host, and it does not read the runtime's
cron tables. This is a **temporary** arrangement with a written retirement
condition below, not a second permanent product.

## Why the runtime's cron is not reachable from here

Measured on `webui` at `2f064db` (2026-10-05), against a real WebUI host:

- **The v1 path is off and its data is gone.** `local-runtime-v2/src/compat/v1/runtime.ts`
  pins `cronConsumerEnabled: false` for every v2-compat host, and
  `local-runtime/src/cron/api.ts` returns early from `ensureStarted` in that
  case, so its registry is never filled. The table it reads,
  `local_runtime_crons`, holds **0 rows**; the migration
  `local-runtime-v2/src/infra/db/migrations/cron/migration-0002-copy-legacy-cron-data.ts`
  moved the data out.
- **The v2 path is not created for this host.** `enableCron` comes from
  `ownsElectronRuntimeCapabilities(runtimeOwnerKind)`
  (`local-runtime-v2/src/application/agent/runtime-browser-use-composition.ts`),
  and the WebUI declares `runtimeOwnerKind: "tui"`
  (`packages/webui/src/server/assembly.ts`), so no `CronService` is built.
- **The service would not be visible even if it were built.**
  `CreatedLocalRuntimeHost` carries only `application?` and `cliService?`
  (`local-runtime-v2/src/local/host-contract.ts`). The one place the services
  object is spread whole is the `cliService`'s own `options`
  (`local-runtime-v2/src/runtime.ts`), and there the `cron` slot is
  `undefined` for the same reason.

An earlier attempt to reach it by declaring the WebUI an Electron owner made
things worse and was reverted: `isV2RuntimeOwner` requires
`capabilities.electronHost` for that kind, and without it the whole v2 service
group — including the `cliService` every other WebUI feature depends on — goes
away. A closed loop over the reachable object graph (depth 5) found no
`CronService` instance anywhere the WebUI can already hold.

## What the WebUI owns instead

- Its own file, `<dataDir>/webui/scheduled-tasks.sqlite`, and its own table.
  It never selects from `local_runtime_crons` or
  `local_runtime_v2_cron_definitions`. Reading the latter from here would be the
  worst available combination: a second scheduler with none of v2's
  concurrency guards, writing turns into the same agent queue as the desktop
  client.
- An in-process tick loop in `WebuiService`, beside the existing heartbeat. The
  runtime itself has no timer, so a runtime not attached to a service never
  fires.
- A port, `WebuiScheduledTaskPort`, whose six methods — `listScheduledTasks`,
  `createScheduledTask`, `updateScheduledTask`, `deleteScheduledTask`,
  `triggerScheduledTaskNow`, `getScheduledTaskCapability` — name the
  operations and not the engine. That is what makes the retirement below a
  one-adapter change.

## Considered Options

- **Use the v1 cron path** — rejected: the switch is pinned off, and its table
  is empty, so it would display nothing and could not be made to.
- **Read v2's tables directly** — rejected for the reason above: it is the one
  combination with two executors and no claim. See
  `local-runtime-v2/src/service/cron/adapters/run.repository.ts`, where
  `claimExecution` is an atomic conditional update and
  `insertPendingScheduled` converges on a trigger id. All of that protection
  lives in the repository, and bypassing it is the whole cost.
- **Open the runtime's gate and wait** — the runtime's own comment marks cron
  as an Electron-only capability absent on embedded hosts, so this is a
  deliberate design position, not an oversight. The WebUI is a loopback process
  the user starts; asking it to become the execution role is an upstream
  architecture decision, and it was raised with the upstream maintainer rather
  than decided here.
- **Keep the panel and show an empty list** — rejected: an empty list reads as
  "you have no scheduled tasks", which is a statement about the user when it is
  actually a statement about the host.

## Retirement condition

**Retire this as soon as the runtime hands a WebUI host a cron capability the
host can actually reach.** Concretely, both of these become true:

1. `services.cron` is created for a `tui` + `cliEmbedded` host — today
   `enableCron` is gated on `runtimeOwnerKind === "electron" | undefined`; and
2. the created service is reachable from the host, i.e. carried on
   `CreatedLocalRuntimeHost` (or on the `cliService` options) rather than
   sealed inside `createLocalRuntimeHostV2`'s locals.

The retirement itself:

1. Implement `WebuiScheduledTaskPort` against the runtime's `CronService` and
   delete the in-process store, the tick loop and the SQLite dependency. Only
   the adapter changes; the port, the operations and the panel do not.
2. Migrate `webui_scheduled_task` into the runtime's table. Tasks created before
   the switch are otherwise stranded, so the migration is part of the change and
   not a follow-up.
3. **Never run both.** The own loop must be torn down in the same change that
   arms the runtime's scheduler. Two schedulers over one queue is precisely the
   failure this decision exists to avoid.

While the runtime keeps the capability closed, this decision stands as written.
It is not a claim that the WebUI is the right owner of scheduled execution; it
is that a panel which cannot see a real task list is worse than one that owns a
small, honest one.

## Consequences

- **A scheduled task in the WebUI and a scheduled task in the desktop client
  are two different things that cannot see each other.** This is the price, and
  it is paid knowingly.
- **The WebUI process being alive is the execution guarantee.** The package is
  started on demand (`mcode-webui`, loopback port 8787); when nobody is running
  it, nothing fires. Slots missed while it was down are **not** replayed — they
  are counted (`missed_count`, `last_missed_at_ms`) so the surface can say so
  rather than imply the task never existed.
- **The scope is fixed and the scheduler is dumb.** Once and fixed interval,
  no cron expressions, no timezone and no active hours. A cron expression is a
  new capability, not a gap in this one.
- **The WebUI takes a first dependency it did not have.** It persists now:
  `better-sqlite3` is declared in `packages/webui/package.json` for this reason.
