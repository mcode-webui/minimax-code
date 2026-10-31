/**
 * Pure path helpers for labels and guards.
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
