// Pure workspace file-tree helpers (view layer).
//
// Moved here from `components/WorkspaceFileTree.tsx` so the one tree structure
// is shared: the tree query owner (`application/workspace-queries.ts`) merges a
// directory's freshly loaded children with the same function the tree component
// filters and walks with, instead of a second copy living beside each consumer
// (plan §7.1 "never copied, leaving two implementations"; ticket #51). The
// component re-exports these names, so its public surface is unchanged.

import type { WebuiWorkspaceFile } from "../../shared/contracts/workspace.js";

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
