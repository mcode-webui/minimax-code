# The WebUI shares the CLI data directory

The WebUI reads and writes `~/.minimax`, the same directory the installed CLI uses,
instead of its own `MINIMAX_DATA_DIR`. The login state and provider configuration
are already there, which is what makes the WebUI usable without signing in again,
and it is what makes existing session history visible in the browser at all.

## Consequences

Working on the WebUI writes to real session history, so a change that needs a clean
slate has to opt into isolation explicitly with `MINIMAX_DATA_DIR` rather than
relying on the default. The shared directory is also why cold-start execution is
quarantined; see
[0002](0002-in-process-runtime-host-with-quarantined-cold-start.md).
