// Pure workspace file-tree helpers (view layer).
//
// Moved here from `client/features/workspace/ui/WorkspaceFileTree.tsx` so the one tree
// structure is shared: the tree query owner
// (`client/features/workspace/application/workspace-queries.ts`) merges a directory's
// freshly loaded children with the same function the tree component filters and walks
// with, instead of a second copy living beside each consumer. The component re-exports
// these names, so its public surface is unchanged.

import type { WebuiWorkspaceFile } from "../../../../shared/contracts/workspace.js";

export function filterWorkspaceFiles(
  files: readonly WebuiWorkspaceFile[],
  query: string,
): WebuiWorkspaceFile[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...files];
  return files.flatMap((file) => {
    const children = file.children ? filterWorkspaceFiles(file.children, normalizedQuery) : [];
    if (file.name.toLowerCase().includes(normalizedQuery) || children.length > 0) {
      return [{ ...file, ...(file.children ? { children } : {}) }];
    }
    return [];
  });
}

export function mergeWorkspaceFileChildren(
  files: readonly WebuiWorkspaceFile[],
  directoryPath: string,
  children: readonly WebuiWorkspaceFile[],
): readonly WebuiWorkspaceFile[] {
  return files.map((file) => {
    if (file.path === directoryPath && file.type === "directory") {
      return { ...file, children };
    }
    return file.children?.length
      ? { ...file, children: mergeWorkspaceFileChildren(file.children, directoryPath, children) }
      : file;
  });
}

export function findWorkspaceFile(
  files: readonly WebuiWorkspaceFile[],
  path: string,
): WebuiWorkspaceFile | undefined {
  for (const file of files) {
    if (file.path === path) return file;
    const nested = file.children ? findWorkspaceFile(file.children, path) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

export function getWorkspaceFileParentPaths(path: string): string[] {
  const segments = path.replace(/\\/gu, "/").split("/").filter(Boolean);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

// How a file's size and modified time read in the tree.
//
// The derivation lives on the layer that already owns the concept instead of
// riding along in the component that renders it.

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

const BYTE_STEP = 1024;

/**
 * Size scheme: binary units (1 KB = 1024 B), a space before the unit, whole
 * bytes with no decimal, and one decimal place from KB up. The displayed value
 * is rounded BEFORE the unit is promoted, because promoting on the raw value
 * lets 1048575 B round to "1024.0" KB and read `1024 KB`; rounding first sends
 * it to `1 MB`. Returns undefined for a value that cannot be a byte count, so
 * an unusable field renders nothing at all.
 */
export function formatWorkspaceFileSize(size: number): string | undefined {
  if (!Number.isFinite(size) || size < 0) return undefined;
  let value = size;
  let unitIndex = 0;
  for (;;) {
    const amount = unitIndex === 0 ? Math.round(value) : Number(value.toFixed(1));
    if (amount < BYTE_STEP || unitIndex === BYTE_UNITS.length - 1) return `${amount} ${BYTE_UNITS[unitIndex]}`;
    value /= BYTE_STEP;
    unitIndex += 1;
  }
}

/**
 * Time scheme: `YYYY-MM-DD HH:mm` in UTC, assembled from the UTC date getters
 * instead of `toLocaleString` / `toLocaleDateString`. Those follow the host
 * locale and timezone, so the same file would read differently on two machines
 * and any assertion on the text would be environment-dependent; fixed-width
 * ISO fields in UTC are identical everywhere and still sort chronologically.
 * Seconds are dropped because a file tree is read at a glance, and an
 * out-of-range epoch returns undefined rather than throwing the `Invalid Date`
 * that `toISOString` would raise.
 */
export function formatWorkspaceFileModifiedAt(modifiedAt: number): string | undefined {
  if (!Number.isFinite(modifiedAt)) return undefined;
  const date = new Date(modifiedAt);
  const time = date.getTime();
  if (Number.isNaN(time)) return undefined;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
