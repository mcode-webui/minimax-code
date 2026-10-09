# Changes stay additive so upstream synchronization stays viable

> **Partly superseded by [ADR 0013](0013-harness-code-is-editable-for-local-client-identity-work).**
> The harness-read-only clause below does not apply to client-identity work in
> `local-runtime` / `local-runtime-v2`, because that work does not go upstream. The
> additive-only rule still governs anything destined for upstream, and the
> never-trim rule still stands everywhere.

Upstream is a reviewed public projection whose history arrives through a three-way
merge, and its own guide warns that moving or renaming files costs a conflict at the
next synchronization. The WebUI work therefore adds a package and incremental wiring
rather than restructuring anything: harness code is treated as read-only, the
terminal and CLI code is never trimmed, and build or verification scripts take only
small additive edits, kept in their own commits so a conflict is easy to resolve.

## Consequences

Small one-line exceptions exist and are recorded separately — for example adding an
editor directory to the source inventory's skip set, which the inventory needs
because it scans the working tree rather than Git. Anything larger than wiring
should first be considered as a change to send upstream rather than a local patch.
