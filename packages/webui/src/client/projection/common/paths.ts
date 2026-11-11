/**
 * Pure path helpers for labels, guards and boundaries.
 *
 * Both rules were written out at several call sites and had drifted: the
 * "last segment" rule appeared with `/`-only splitting and with both
 * separators, and with `||` and `??` fallbacks — the `??` ones never fired,
 * because `split(...).at(-1)` on a string always returns a string, so a path
 * ending in a separator produced an empty label instead of falling back.
 *
 * Splitting on both separators is what the backslash-aware copies already did,
 * and it is what the `/`-only copies needed: a Windows path is one label, not
 * a path with no basename.
 *
 * The segment rules below are what the diff boundaries are made of: the
 * browser has no `path` module and no filesystem, so a path is compared as a
 * posix-style string, with `..` applied and absolute paths compared segment
 * by segment rather than by string prefix. Two boundaries need them — the
 * workspace root and the session's own artifacts directory — so they are
 * written once here.
 */

/**
 * The last segment of a path, for a label.
 *
 * Empty segments are dropped, so a trailing separator does not produce an
 * empty label, and a value that is all separators falls back to the value
 * itself rather than to nothing.
 */
export function basenamePath(value: string): string {
  const last = value.split(/[\\/]/u).filter(Boolean).at(-1);
  return last || value;
}

/** Whether a workspace directory is spelled as an absolute path. */
export function looksLikeAbsoluteWorkspacePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(value)
  );
}

/**
 * The workspace directory a creation request carries, validated.
 *
 * It is a guard rather than a transform: the trimmed value comes back, or the
 * caller is told why the request cannot be made — an empty field is a mistake and
 * a relative one would create a session somewhere the user did not choose.
 *
 * It sits with the path helpers because three creation origins need the same
 * rule (the ordinary send, the goal submission and the plugin-chat creation) and
 * no single business owns it: the goal path reading it out of the Composer's
 * module was the last reason for a Composer↔Turn application import.
 */
export function readWorkspaceDirField(workspaceDir?: string): string | undefined {
  if (workspaceDir === undefined) return undefined;
  const value = workspaceDir.trim();
  if (!value) throw new Error("项目目录不能为空，请重新选择项目目录");
  if (!looksLikeAbsoluteWorkspacePath(value))
    throw new Error(`项目目录需要绝对路径，收到的是「${value}」。请重新选择项目目录`);
  return value;
}

/** A path spelled with posix separators, whatever the host wrote. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/gu, "/");
}

/**
 * A Windows drive letter, lowercased so `C:` and `c:` name one drive.
 */
export function driveLetter(segment: string): string | undefined {
  return /^[a-z]:$/iu.test(segment) ? segment.toLowerCase() : undefined;
}

/**
 * The path's segments, with `.` dropped and `..` applied.
 *
 * `..` is applied against the segments collected so far, so `a/../b` is `b`
 * and `../b` is nothing at all — the second cannot be placed under any root,
 * which is what makes it out of bounds. The root's own segments are not part
 * of the stack: climbing one level above the root is the case the boundaries
 * exist for, and a path that does it is refused rather than clamped back
 * inside.
 */
export function resolveSegments(value: string): string[] | undefined {
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
export function isAbsolutePath(value: string): boolean {
  const posix = toPosixPath(value);
  return posix.startsWith("/") || /^[a-z]:\//iu.test(posix);
}

/** Split an explicitly named local file for the directory-scoped read APIs. */
export function absoluteFileLocation(value: string): { workspaceDir: string; path: string } | undefined {
  const normalized = toPosixPath(value);
  if (!isAbsolutePath(normalized) || normalized.startsWith("//")) return undefined;
  const separator = normalized.lastIndexOf("/");
  if (separator < 0 || separator === normalized.length - 1) return undefined;
  const segments = normalized.slice(normalized.startsWith("/") ? 1 : 3).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  const rootLength = normalized.startsWith("/") ? 1 : 3;
  return { workspaceDir: normalized.slice(0, Math.max(separator, rootLength)), path: normalized.slice(separator + 1) };
}

/**
 * What an absolute path's root is spelled as.
 *
 * Two paths can only contain one another when their roots are the same kind:
 * `/srv/data` and `//srv/data` resolve to the same segments, but one is a
 * directory below `/` and the other is a share on a host, and a drive path
 * names a different root again. Comparing segments without the kind would let
 * one spelling of a root vouch for a path reached through another.
 */
export type WebuiPathRootKind = "posix" | "drive" | "unc";

/** An absolute path, as the root it names and the segments below it. */
export interface WebuiResolvedAbsolutePath {
  readonly kind: WebuiPathRootKind;
  readonly segments: readonly string[];
}

/**
 * Resolve an absolute path, or `undefined` when it is not one.
 *
 * A relative path has no root of its own to compare, so it is refused here
 * rather than resolved against something the caller did not name.
 */
export function resolveAbsolutePath(
  value: string,
): WebuiResolvedAbsolutePath | undefined {
  const trimmed = value.trim();
  if (!trimmed || !isAbsolutePath(trimmed)) return undefined;
  const posix = toPosixPath(trimmed);
  const kind: WebuiPathRootKind = posix.startsWith("//")
    ? "unc"
    : /^[a-z]:\//iu.test(posix)
      ? "drive"
      : "posix";
  const segments = resolveSegments(trimmed);
  if (!segments) return undefined;
  return { kind, segments };
}

/** Whether `file`'s segments begin with `root`'s, segment by segment. */
export function segmentsWithinRoot(
  file: readonly string[],
  root: readonly string[],
): boolean {
  if (file.length < root.length) return false;
  return root.every((segment, index) => segment === file[index]);
}
