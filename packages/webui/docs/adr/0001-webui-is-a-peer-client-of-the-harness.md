# The WebUI is a peer client of the harness layer, not a CLI wrapper

We build the WebUI directly on the harness layer — the process-local host and
`CliService` from `@mavis/local-runtime-v2` — which is the same seam the terminal
client uses. The cheaper alternative was to drive the CLI and speak ACP to it,
which needs no fork at all, but ACP is an adapter inside the terminal client
package: building on it would make the WebUI a client of the CLI instead of a peer
of it, and would cap every WebUI capability at what that adapter happens to expose.

## Considered Options

- **ACP client over a spawned `mcode acp`** — rejected: makes the WebUI a client of
  the CLI rather than of the harness, and inherits ACP's vocabulary as its ceiling.
- **Headless `mcode exec --output-format stream-json`** — rejected: one prompt per
  process, with no session or interaction control.
- **Importing the published npm CLI** — impossible: `@minimax-ai/code` ships a
  bundled executable with no `exports` field, and every workspace package is
  `private`.

## Consequences

The harness layer is not distributed anywhere, so its source must live in this
tree. Upstream synchronization therefore becomes a standing concern; see
[0007](0007-additive-changes-that-keep-upstream-synchronization-viable.md).
