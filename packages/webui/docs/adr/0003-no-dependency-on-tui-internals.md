# The WebUI does not import the terminal client's internals

`packages/tui` holds terminal-independent logic worth reading — stream frame parsing
and message projection, event normalisation for permissions and questionnaires, and
the shared-auth assembly — but it publishes no client subpath exports, and that
logic is written against terminal types and tool previews. The WebUI writes its own
narrow adapter and reuses only independently exported packages from the harness
layer.

## Considered Options

- **Deep imports from `packages/tui/src/...`** — rejected: couples the WebUI to
  private paths and to the terminal client's types, so an upstream change to that
  client can break the WebUI without touching it.
- **Copying the projection logic** — rejected: two copies drift apart, and protocol
  fixes then have to be applied twice.
- **Extracting a shared client package** — deferred: the right long-term shape, but
  it moves existing call sites and files, which is exactly the kind of change that
  collides with upstream synchronization.

## Consequences

Reading that code before writing the equivalent is expected; depending on it is
not. Where the terminal client's behaviour is the reference, the WebUI adapter
should match it deliberately rather than by import.
