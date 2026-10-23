# The client draws the workspace boundary for a diff body

**Status:** Accepted and implemented.
**Date:** 2026-10-23.

A turn's diff lists the files a turn touched, and one of those files can be **outside the
workspace**. The runtime's capture layer records an out-of-workspace write as an absolute path, so
the entry reaches the client with that file's content attached, and the client used to render it:
the diff card's own review panel and the workspace review panel both put the patch text on screen.

The **WebUI client** now draws that boundary. A diff entry whose path resolves outside the
workspace root keeps its name, its status and its added/deleted line counts, and loses its body —
the diff text, the patch hunks, the file's content. The entry itself stays in the list, and the
surface says what is withheld instead of showing it.

## Why the boundary is drawn here

The fix that stopped the collection at the source was made upstream in
`packages/local-runtime/src/turns/file-changes.ts`, and it was **reverted in PR #240** because it
changed a package this fork may not change: the sixteen upstream packages are outside the boundary
of this branch, and a fix that reaches into one of them cannot be merged here. The upstream fix was
therefore not wrong — it was in the wrong layer for this repository.

So the boundary is drawn on the client side, which is where the content becomes visible. The client
is the last point before the content reaches a screen, and it is the only layer this branch may
change.

This is a **mitigation with a stated scope**, not a replacement for the upstream fix. The upstream
fix also stopped the content from being *collected*; the client-side boundary stops it from being
*shown*. The content still travels between the runtime and the browser for an out-of-workspace
file. Closing that gap properly needs the upstream change.

## The rule is lexical

The browser has no `path` module and no filesystem, so the comparison is made on posix-style
strings, the same normalization the message file-reference reader uses
(`client/features/transcript/projection/message-file-reference.ts`), extended to resolve `..` and
to compare absolute paths segment by segment.

- A **relative** path is under the workspace root by construction, and is refused when it climbs
  out of it (`../outside.txt`, `src/../../outside.txt`).
- An **absolute** path is compared with the root segment by segment, so a sibling directory whose
  name starts with the root's name (`/work/project-backup` against the root `/work/project`) is
  outside. A string prefix would have called it inside.
- The comparison is **case-sensitive except for a Windows drive letter**, and it accepts both
  separator spellings, because the runtime writes the path in the host's spelling.

## An unknown root is not a boundary

A diff entry is only withheld when the client **knows** the workspace root. When the root is
missing — a session with no workspace, a surface that has none to give — the entries are shown as
they are.

This is deliberate. A check that hid everything it could not place would hide ordinary content as
well, and the failure mode of "the diff shows nothing" is worse than the one it prevents: it is
silent, it looks like a bug, and it applies to the files a person actually worked on. The check is
therefore allowed to say "inside" only when it can compare, and the surfaces that have no root keep
the previous behaviour.

The same rule is why the boundary is applied by a **projection** and not by the components: the
projection is handed the root, decides once, and hands the entries on. A component that renders
the entries it is given cannot leak a body it was never given.

## What this decision does not settle

- **A symlink inside the workspace that points outside it.** The entry's path is a relative one, so
  it stays contained here, and the browser cannot see what it resolves to. Telling the two apart
  needs `realpath` on every target, with careful handling of files that do not exist yet, on the
  runtime side — the same limit the upstream fix states. The test suite says this out loud rather
  than leaving it to be discovered.
- **The content still travels.** Nothing here stops the runtime from sending an out-of-workspace
  file's patch to the browser; it stops the browser from showing it. Only the upstream fix stops
  the collection.
- **The session-diff operation.** The client can ask the runtime for a whole session's diff
  (`getSessionDiff`), and no surface consumes that answer today. When one does, it goes through the
  same projection.
