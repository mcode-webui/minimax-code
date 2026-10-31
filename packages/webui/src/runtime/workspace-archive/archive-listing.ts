import path from "node:path";

import type { WebuiArchiveEntry } from "../../shared/contracts/workspace.js";

import { WORKSPACE_ARCHIVE_MAX_LISTED_ENTRIES } from "./archive-policy.js";
import type { ArchiveContents, ArchiveEntry } from "./archive-types.js";

/**
 * The rows for one level, with directories synthesised from their children.
 *
 * A zip or tar routinely stores only file entries and leaves the directories
 * implied, so a listing that reported only what is literally present would show
 * an empty level for a directory full of files. A synthesised directory row
 * carries the same `path` an explicit entry would, with no trailing slash: the
 * name alone distinguishes a directory, and the view navigates by name.
 *
 * `shouldStripArchiveRoot` in `remote/archive.ts` is deliberately *not* ported
 * here. It strips a single top-level directory because a skill install needs
 * the path *inside* the repository, whereas a preview has to name what the
 * archive actually contains — silently dropping the root a user is looking at
 * would make this panel disagree with every other zip tool.
 */
export function listOneLevel(
  contents: ArchiveContents,
  prefix: string,
): {
  readonly entries: readonly WebuiArchiveEntry[];
  readonly truncated: boolean;
} {
  const scope = prefix ? `${prefix}/` : "";
  const directories = new Map<string, WebuiArchiveEntry>();
  const files: WebuiArchiveEntry[] = [];
  let refused = 0;

  for (const entry of contents.entries) {
    if (entry.unsafeReason || !entry.path) {
      // Not named: the view renders only what this call is willing to write, so
      // an entry that extraction would refuse is not advertised first.
      refused += 1;
      continue;
    }
    if (!entry.path.startsWith(scope) || entry.path.length === scope.length)
      continue;
    const remainder = entry.path.slice(scope.length);
    const slash = remainder.indexOf("/");
    if (slash !== -1) {
      const name = remainder.slice(0, slash);
      if (!directories.has(name)) {
        directories.set(name, {
          path: `${scope}${name}`,
          name,
          isDirectory: true,
        });
      }
      continue;
    }
    if (entry.isDirectory) {
      if (!directories.has(remainder)) {
        directories.set(remainder, {
          path: remainder,
          name: remainder,
          isDirectory: true,
        });
      }
      continue;
    }
    files.push({
      path: remainder,
      name: remainder,
      isDirectory: false,
      size: entry.declaredSize,
    });
  }

  const byName = (a: WebuiArchiveEntry, b: WebuiArchiveEntry): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const ordered = [
    ...[...directories.values()].sort(byName),
    ...files.sort(byName),
  ];
  const entries = ordered.slice(0, WORKSPACE_ARCHIVE_MAX_LISTED_ENTRIES);
  return { entries, truncated: refused > 0 || ordered.length > entries.length };
}

/** The entries an extraction writes, scoped to the prefix. */
export function selectForExtraction(
  contents: ArchiveContents,
  prefix: string,
): readonly ArchiveEntry[] {
  if (!prefix) return contents.entries;
  const scope = `${prefix}/`;
  // An entry with no path is one the reader refused, and it is selected
  // regardless of the prefix so the pre-flight refuses the whole archive for it.
  // Scoping it away would make extracting a subdirectory quietly skip a hostile
  // entry that extracting the root refuses.
  return contents.entries.filter(
    (entry) =>
      entry.path === undefined ||
      entry.path === prefix ||
      entry.path.startsWith(scope),
  );
}

/**
 * An entry's path relative to the prefix being extracted, so extracting `src`
 * into `dest` writes `dest/index.ts` rather than `dest/src/index.ts`.
 */
export function entryPathUnderPrefix(
  entry: ArchiveEntry,
  prefix: string,
): string {
  if (!entry.path)
    throw new Error(
      `压缩包中存在不安全的条目：${entry.unsafeReason ?? entry.rawName}`,
    );
  if (!prefix) return entry.path;
  if (entry.path === prefix) return path.posix.basename(entry.path);
  return entry.path.slice(prefix.length + 1);
}
