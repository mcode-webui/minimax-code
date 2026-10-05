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

## Amendment: the resident service owns the cron schedule

The WebUI is a resident local service, not a surface that runs on demand. The
published `mcode-webui` bin assembles the host, prints a URL, and blocks until
SIGINT or SIGTERM; the browser page is a client that attaches to it. The
scheduled-task panel therefore manages tasks in the shared cron store and the
service itself starts the scheduler during startup
(`ensureStarted("webui:service_start")`), reached through `apiHost.cronRuntime`
rather than the `services.cron` composition that `runtimeOwnerKind: 'tui'`
leaves undefined.

Starting with the service rather than on first use of the panel is the whole
point. A schedule created from the desktop or the CLI has to fire in the
resident WebUI whether or not anyone has opened the panel to watch it; tying
the scheduler to the panel would make "the panel was never opened" silently
mean "the schedule never runs".

**Unchanged.** `startupExecutionPolicy` stays `'quarantined'` and
`runtimeOwnerKind` stays `'tui'`. The policy gates the host's own cold-start
path, and the WebUI starting the cron scheduler is a separate, explicit act
rather than that path. No Electron-only capability is claimed.

**Re-opened on purpose.** The second rejected option above turned on "a WebUI
restart and the terminal client would both attempt to resume the same
persisted jobs". That hazard is now accepted for cron specifically: the data
directory is shared, so the WebUI service and the terminal client can both hold
the scheduler for one agent and fire the same task twice. The engine's
busy-queue bounds overlap within one process; it does not arbitrate across two.
The panel states which side is executing rather than implying the WebUI owns
execution exclusively.

**What still does not resume.** The consequences above are about sessions and
in-flight turns, and they are unaffected: a restart still marks a running turn
`interrupted` rather than continuing it, and reopening a session is an
explicit `resumeSession`. What the WebUI restores at startup is the cron
*schedule* — stored definitions and their timers — not anybody's unfinished work.

