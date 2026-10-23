// The workspace boundary for a diff entry.
//
// A turn's diff lists the files a turn touched, and an entry in it can name a
// file outside the workspace: the runtime's capture layer records an
// out-of-workspace write as an absolute path, so the entry reaches the client
// with the outside file's content attached. The upstream fix that stopped the
// collection was reverted (PR #240) because it changed a package this fork may
// not change, so the boundary is drawn here instead — the client is the last
// place before the content reaches a screen.
//
// The rule is lexical. The browser has no `path` module and no filesystem, so
// the comparison is made on posix-style strings, the same normalization the
// message file-reference reader uses
// (`features/transcript/projection/message-file-reference.ts`), extended to
// resolve `..` and to compare absolute paths segment by segment.
//
// Two boundaries this does not close, stated rather than papered over:
//
//  * A symlink inside the workspace that points outside it resolves outside,
//    and the browser cannot see that: the entry's path is a relative one and
//    stays contained here. Telling the two apart needs `realpath` on every
//    target, which only the runtime side can do.
//  * A path whose workspace root the client does not know is not a boundary.
//    Without a root there is nothing to compare against, so the entries are
//    shown as they are. A client that hid everything it could not place would
//    hide ordinary content as well, which is the worse failure.

import type { WebuiFileDiffInfoView } from "../../../shared/contracts/session.js";

/**
 * What replaces the body of a file the boundary keeps out.
 *
 * The wording follows the other refusals in the diff surfaces: the file is
 * named, and what is withheld is said plainly rather than left as an absence.
 */
export const WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE =
  "该文件在工作区之外，内容未展示。";

/**
 * One file's diff entry, with the boundary's verdict attached.
 *
 * The verdict travels with the entry so that the surface which renders the
 * body and the projection which withholds it cannot disagree: both read the
 * same flag, and there is no second path that decides on its own.
 */
export interface WebuiDiffFileEntry extends WebuiFileDiffInfoView {
  /**
   * Whether the entry's path stays inside the workspace root.
   *
   * `true` when the root is unknown: without a root there is no boundary to
   * judge against, and an entry that cannot be placed must not be hidden for
   * it.
   */
  readonly withinWorkspace: boolean;
}

/** A path spelled with posix separators, whatever the host wrote. */
function toPosixPath(value: string): string {
  return value.replace(/\\/gu, "/");
}

/**
 * A Windows drive letter, lowercased so `C:` and `c:` name one drive.
 */
function driveLetter(segment: string): string | undefined {
  return /^[a-z]:$/iu.test(segment) ? segment.toLowerCase() : undefined;
}

/**
 * The path's segments, with `.` dropped and `..` applied.
 *
 * `..` is applied against the segments collected so far, so `a/../b` is `b`
 * and `../b` is nothing at all — the second cannot be placed under any root,
 * which is what makes it out of bounds. The root's own segments are not part
 * of the stack: climbing one level above the root is the case this module
 * exists for, and a path that does it is refused rather than clamped back
 * inside.
 */
function resolveSegments(value: string): string[] | undefined {
  const segments: string[] = [];
  const parts = toPosixPath(value).split("/");
  for (const [index, part] of parts.entries()) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(index === 0 ? (driveLetter(part) ?? part) : part);
  }
  return segments;
}

/** Whether a path is spelled as an absolute path. */
function isAbsolutePath(value: string): boolean {
  const posix = toPosixPath(value);
  return posix.startsWith("/") || /^[a-z]:\//iu.test(posix);
}

/**
 * Whether a path stays inside a workspace directory.
 *
 * The comparison is lexical and segment-wise. A relative path is resolved
 * against the root and refused when it climbs out of it; an absolute path is
 * compared with the root segment by segment, so a sibling directory whose
 * name starts with the root's name (`/ws-backup` against the root `/ws`) is
 * outside — a string prefix would have called it inside.
 *
 * An unknown root (`undefined`, blank, or a path that cannot be resolved) is
 * not a boundary: the entry is allowed through, because a check that cannot
 * place a file has no reason to withhold it.
 */
export function isWebuiDiffPathWithinWorkspace(
  workspaceDir: string | undefined,
  filePath: string,
): boolean {
  if (!workspaceDir?.trim()) return true;
  // A path that names no file cannot be placed inside the workspace.
  if (!filePath.trim()) return false;
  const root = resolveSegments(workspaceDir);
  if (!root) return true;
  const file = resolveSegments(filePath);
  if (!file) return false;
  if (!isAbsolutePath(filePath)) {
    // A relative path is under the root by construction: `resolveSegments`
    // already refused the ones that climb out of it.
    return true;
  }
  if (file.length < root.length) return false;
  return root.every((segment, index) => segment === file[index]);
}

/**
 * Project one diff entry for display.
 *
 * The entry keeps everything that traces the change — the file, its status,
 * the added and deleted line counts — and loses only the body when the
 * boundary says the file is outside the workspace. The entry itself stays in
 * the list: "which file was touched" is the part a person can still act on.
 */
export function projectWebuiDiffFile(
  file: WebuiFileDiffInfoView,
  workspaceDir: string | undefined,
): WebuiDiffFileEntry {
  if (isWebuiDiffPathWithinWorkspace(workspaceDir, file.file)) {
    return { ...file, withinWorkspace: true };
  }
  return {
    file: file.file,
    additions: file.additions,
    deletions: file.deletions,
    ...(file.status !== undefined ? { status: file.status } : {}),
    withinWorkspace: false,
  };
}

/**
 * Project a diff's file entries for display.
 *
 * This is the one place the decision is made, so every surface that shows a
 * diff body shows the same one: the entries handed to a renderer carry no
 * body for a file outside the workspace, and the renderer only has to say so.
 */
export function projectWebuiDiffFiles(
  files: readonly WebuiFileDiffInfoView[] | undefined,
  workspaceDir: string | undefined,
): readonly WebuiDiffFileEntry[] {
  return (files ?? []).map((file) => projectWebuiDiffFile(file, workspaceDir));
}
