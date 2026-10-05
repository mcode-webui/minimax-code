# One in-process runtime host per WebUI service, with quarantined cold start

The WebUI server creates the runtime host inside its own Node process and uses the
`cliService` that host returns. A crash or restart of the WebUI server therefore
ends every execution it owns: persisted sessions and messages survive, in-flight
turns do not, and recovery marks them `interrupted` instead of resuming them. The
host is created with `startupExecutionPolicy: 'quarantined'`, so restarting the
service never silently resumes jobs restored from disk; interactive requests behave
the same under either policy.

## Considered Options

- **Host in a forked child process** — rejected for the first version: adds a
  serialization boundary and a second failure mode in exchange for crash isolation
  we do not need yet.
- **The default cold-start policy (`enabled`)** — rejected: the data directory is
  shared with the CLI, so a WebUI restart and the terminal client would both attempt
  to resume the same persisted jobs.

## Consequences

The WebUI must not promise "everything resumes after a restart". Reopening an old
session is an explicit `resumeSession` with a cursor, not an automatic continuation.
Execution state that is not persisted — stream buffers, subscriptions, pending
permission and questionnaire requests — belongs to the owner process and cannot be
recovered from disk.

## Amendment: the resident service owns the scheduled-task schedule

The WebUI is a resident local service, not a surface that runs on demand. The
published `mcode-webui` bin assembles the host, prints a URL, and blocks until
SIGINT or SIGTERM; the browser page is a client that attaches to it. The
scheduled-task panel is therefore a control surface over a store the service owns,
and the service runs the schedule for as long as it is up.

**Unchanged.** `startupExecutionPolicy` stays `'quarantined'` and
`runtimeOwnerKind` stays `'tui'`. Neither is widened; the new capability arrives as
a separate host option rather than as a reclassification of the owner.

**What the option does.** The host takes `enableScheduledTasks`. When set, the
process composes the in-process scheduler and the cron service, and the scheduler
starts with `restorePersistedJobExecution: true`, so a restart re-arms the timers
for definitions already in the store. The timers are in-process: nothing is handed
to an operating-system scheduler, because these tasks are harness business and
have to stay governable from inside it. With the process down, a schedule that
comes due simply does not fire.

Re-arming at startup is the difference between a resident service and a page that
happens to run something. A schedule created from the desktop or the CLI has to
keep firing across a WebUI restart; otherwise every restart silently retires every
task, with nothing in the logs to say so.

**The split, stated precisely.** Two mechanisms get conflated while this is being
designed, and the amendment is clearer for separating them:

- *Restoring the schedule* — re-arming timers for stored definitions. Enabled here,
  per capability.
- *Recovering in-flight work* — picking up runs that fired but did not finish.
  Governed by `recoverPersistedRuns`, and **not** changed by this amendment.

**Sessions and turns are untouched.** A restart still marks a running turn
`interrupted`; reopening a session is still an explicit `resumeSession` with a
cursor. Restoring a schedule is not resuming anybody's unfinished work.

**Re-opened on purpose.** The second rejected option above turned on "a WebUI
restart and the terminal client would both attempt to resume the same persisted
jobs". That hazard is now accepted for scheduled tasks specifically: the data
directory is shared, so the WebUI service and the terminal client can both hold the
scheduler for one agent and fire the same task twice. The busy-queue bounds overlap
within one process; it does not arbitrate across two. The panel states which side is
executing rather than implying the WebUI owns execution exclusively.

**The predicate is not shared.** The WebUI reaches the cron service through a
cron-specific ownership check, deliberately not by widening the existing
Electron-capability predicate: that predicate also gates channel delivery, and
widening it would hand a local web service the IM adapters it was never meant to
own.
