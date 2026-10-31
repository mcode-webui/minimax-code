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
