// Where an archive entry unpacks to, and how its size reads.
//
// Carved out of `components/workspace/WorkspaceArchiveView.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **2 declarations**, 2 functions.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

/**
 * The destination an extraction uses when the caller supplies none: the
 * archive's own name without its extension, beside the archive.
 *
 * Derived rather than typed for the reason `destination`'s prop comment gives —
 * a browser cannot name an absolute path, and every path it could type would
 * need the server to distrust it. Returns "" for a name that is not a plain
 * relative path, which the view renders as "no usable destination" instead of
 * handing the server something it would have to reject.
 */
export function archiveDestinationFor(archivePath: string): string {
  const cleaned = archivePath.replace(/\\/gu, "/");
  const slash = cleaned.lastIndexOf("/");
  const directory = slash === -1 ? "" : cleaned.slice(0, slash);
  const name = cleaned.slice(slash + 1).replace(/\.(?:tar\.gz|tgz|zip|tar|gz|bz2|xz|7z|rar)$/iu, "");
  const candidate = directory ? `${directory}/${name}` : name;
  if (!candidate) return "";
  return candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ? "" : candidate;
}

/** Bytes as a short human string; absent stays absent rather than becoming 0. */
export function formatArchiveSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
