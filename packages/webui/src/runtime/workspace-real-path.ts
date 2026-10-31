// The real location of a workspace path, and the fence that keeps a write
// inside the workspace.
//
// The workspace boundary is checked on the *real* path, never on the spelling a
// request carries. A path that looks like it is inside the workspace can still
// point outside it: a symlink inside the workspace does, and a *dangling*
// symlink does so in the way that matters for a write — `realpath` fails on it
// exactly as it fails on a file that is not there yet, but writing through the
// link creates the file it points at. A check that falls back to the lexical
// spelling in that case compares a path inside the workspace and lets the file
// land outside it. That fallback is what the upstream runtime's write path
// still does (`resolveWorkspaceWritePath` in
// `packages/local-runtime-v2/src/service/workspace/operations/workspace-path.ts`),
// and the upstream fix for it was reverted because it touched packages this
// branch does not own. This is the same fence on this side of the boundary.
//
// Two rules the walk keeps:
//   * A path that cannot be resolved at all — a symlink cycle, a permission
//     error, a missing workspace root — is refused rather than guessed at.
//   * A symlink that stays inside the workspace keeps working: the fence
//     compares real locations, so an in-workspace link is inside by definition.
//
// Node built-ins only; the fence adds no dependency to this package.

import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Symlink hops before the walk gives up (guards against cycles). */
const MAX_REAL_PATH_SYMLINK_HOPS = 32;

/**
 * What the fence says about one target path.
 *
 * `unresolvable` and `outside` are separate answers because they are separate
 * facts: the first is a path the filesystem could not explain, the second is a
 * path that is explained and does not belong to this workspace. Both are
 * refusals, and both are reported, but the caller phrases them differently.
 */
export type WorkspaceFenceVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "outside" | "unresolvable" };

/**
 * Resolve a path to the location the filesystem really uses for it.
 *
 * `realpath` the target; when the target does not exist yet — a write creates a
 * file that is not there — resolve its nearest existing ancestor and re-attach
 * the missing segments.
 *
 * The part that needs a hand: the target may be a *dangling* symlink. `realpath`
 * fails on it the same way it fails on a missing file, but a write through a
 * dangling link creates the file it points at, so the link is followed here
 * instead of being treated as a missing path. Without that branch a dangling
 * link that points outside the workspace resolves to a path *inside* it and
 * passes the fence.
 *
 * Returns `undefined` when the path cannot be resolved at all — a symlink
 * cycle, a permission error — so the caller refuses the target instead of
 * guessing where it points.
 */
export async function resolveRealPath(
  absolutePath: string,
  hops = 0,
): Promise<string | undefined> {
  let candidate = resolve(absolutePath);
  const suffixParts: string[] = [];
  for (;;) {
    try {
      const ancestorReal = await realpath(candidate);
      return suffixParts.length === 0
        ? ancestorReal
        : resolve(ancestorReal, ...suffixParts);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const link = await readlinkOrUndefined(candidate);
      if (link !== undefined) {
        if (hops >= MAX_REAL_PATH_SYMLINK_HOPS) return undefined;
        const realParent = await realpathOrUndefined(dirname(candidate));
        if (!realParent) return undefined;
        // A relative link is relative to the directory that holds it, which
        // is the *real* directory when the link sits in a symlinked one.
        const followed = isAbsolute(link) ? resolve(link) : resolve(realParent, link);
        const resolved = await resolveRealPath(followed, hops + 1);
        if (!resolved) return undefined;
        return suffixParts.length ? resolve(resolved, ...suffixParts) : resolved;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      suffixParts.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Whether `candidate` is `root` itself or a path inside it.
 *
 * The comparison is `path.relative`-based rather than a string prefix: a prefix
 * wrongly accepts `/tmp/evil` for a root of `/tmp/ev`, and a sibling named
 * `..evil` is not an escape either.
 */
export function isInsideDirectory(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * The fence: does `target` really live inside `workspaceRoot`?
 *
 * The root is resolved with `realpath` as well — a workspace root is itself
 * allowed to be a symlink, and comparing a real target against a lexical root
 * would refuse every path in such a workspace.
 *
 * Refuses rather than guesses: a target that cannot be resolved, and a
 * workspace root that cannot be resolved, are both `unresolvable`.
 */
export async function checkWorkspaceFence(
  workspaceRoot: string,
  target: string,
): Promise<WorkspaceFenceVerdict> {
  const realRoot = await realpathOrUndefined(resolve(workspaceRoot));
  if (!realRoot) return { allowed: false, reason: "unresolvable" };
  const realTarget = await resolveRealPath(target);
  if (!realTarget) return { allowed: false, reason: "unresolvable" };
  return isInsideDirectory(realRoot, realTarget)
    ? { allowed: true }
    : { allowed: false, reason: "outside" };
}

export async function realpathOrUndefined(
  target: string,
): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

async function readlinkOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await readlink(target);
  } catch {
    return undefined;
  }
}
