# Harness code is editable for local client-identity work

ADR 0007 treated harness code as read-only because every harness edit recurs as a
conflict at the next upstream synchronization. That reasoning assumed the work
would go upstream. It does not: the WebUI lives on a separately maintained branch,
harness edits are made directly in this repository, and there is no pull request to
the upstream projection and therefore no three-way-merge cost to amortise.

So the harness-read-only clause of ADR 0007 is **superseded for client-identity
work in `packages/local-runtime` and `packages/local-runtime-v2`**, and only for that
work. ADR 0007's additive-only rule still governs anything destined for upstream, and
the rule that the terminal and CLI code is never trimmed still stands everywhere.

## What "editable" does and does not permit

Permitted: adding a module, adding a test, and rewiring call sites **within**
`local-runtime` and `local-runtime-v2`.

Not permitted, because they are the actual defects this work exists to fix rather
than costs it accepts:

- widening `'electron' | 'cli' | 'tui' | string` by appending `| string`. It already
  collapses to `string`; adding a member documents forward compatibility and enforces
  nothing.
- routing a new owner value through the existing predicates without a declared row.

## Why a policy resolver instead of a new string

`runtimeOwnerKind` is read by more than twenty call sites that decide independently
what the value means, and the readings disagree — three sites encode "am I a desktop",
two encode "am I a degraded runtime", and neither set is a subset of the other. An
unrecognised value therefore lands in a bucket nobody designed: it would drop the V1
compatibility layer while silently granting memory and cron.

The fix is one resolver, `resolveRuntimeOwnerPolicy`, that names every decision once
and returns it as data. Thirteen cells in two groups — five *wiring* cells (what the
host assembles and exposes) and eight *execution* cells (how a turn behaves) — because
**not redundant is not the same as one concept**: a consumer should be able to ask for
a wiring cell without also being handed turn-execution semantics.

Adding `'webui'` directly would have been the cheaper change and is the wrong one: it
lands in exactly that undesigned bucket.

## Consequences

- The harness change is complete when it resolves `runtimeOwnerKind: 'webui'` to a
  policy and a test constructs that host. It does **not** establish that the WebUI
  declares that owner, nor that the WebUI's UI receives the expected capability.
  "WebUI is a first-class client" requires the declaration change plus a WebUI-level
  integration check, both deferred.
- `'absent'` and `'runtime'` stay **distinct** rows. They disagree today, and
  collapsing them would be a deliberate behaviour change chosen by the word
  "normalisation". The `'absent'` row records an incoherence rather than fixing it:
  an undeclared owner is read as "assume desktop" by the service gates and as
  "unknown" by the compatibility gate. Fixing it changes behaviour, so it is a named
  follow-up, not part of this work.
- An unrecognised owner is **fail-closed on grants and fail-open on wiring**: an
  unknown client still gets a working host, but no capability it did not declare.
- The guarantee is **harness-internal**. A client that declares a typo gets an explicit
  unknown-owner policy, not a type error, because the WebUI declares its own local
  option type and crosses the boundary with a cast.
- Phase 1 introduces the resolver and its rows **without changing any call site**.
  That is what makes its behaviour-identical claim checkable rather than aspirational.

The full decision record, including the corrections that invalidated earlier drafts, is
in `docs/webui/webui-client-identity-plan.md`.