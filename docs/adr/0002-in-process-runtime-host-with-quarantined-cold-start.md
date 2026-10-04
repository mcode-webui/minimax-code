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

## Amendment: the scheduled-task panel starts the cron scheduler on demand

The scheduled-task panel (`定时`) reads and writes the same cron store the terminal
client uses, reached through `apiHost.cronRuntime` rather than the `services.cron`
composition that `runtimeOwnerKind: 'tui'` leaves undefined. Using it calls
`cronRuntime.ensureStarted()`, which starts the croner scheduler inside the WebUI
process. That is a deliberate change to the picture the options above describe, and
it is worth being precise about what did and did not change.

**Unchanged.** `startupExecutionPolicy` stays `'quarantined'`. It gates only the
host's own cold-start path, so a WebUI restart still never resumes persisted jobs on
its own. `runtimeOwnerKind` stays `'tui'`; no Electron-only capability is claimed.

**Changed.** Reaching the scheduler is a *use-time* action, not a startup one. The
first schedules operation loads persisted cron definitions from the shared store and
schedules them for the lifetime of the process. So a WebUI service that is left
running will fire cron tasks at their times, where before it would not.

**Accepted hazard.** The data directory is shared, so a WebUI service and the
terminal client can both hold the scheduler for the same agent at the same time and
each fire the same task. The engine's busy-queue bounds overlap within one process;
it does not arbitrate across two. The panel therefore states which side is executing
rather than implying the WebUI owns execution.

**Rejected alternative.** Restricting the panel to list plus manual trigger, and
leaving scheduling to the terminal client only. It keeps one scheduler per data
directory, but a task created in the WebUI does nothing until the user happens to run
the desktop client, which is the "builds but never runs" failure the panel exists to
avoid.
