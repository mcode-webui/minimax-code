// Owns the workspace file-tree feature: the recursive tree component and the
// file lookup/filter helpers. A different implementer works in this file; the
// container in `WorkspacePanels.tsx` only imports from it.

import type { ReactElement } from "react";
import type { WebuiWorkspaceFile } from "../../server/port.js";
import { WebuiIconChevronLeft, WebuiIconFile } from "../icons.js";

export function filterWorkspaceFiles(files: readonly WebuiWorkspaceFile[], query: string): WebuiWorkspaceFile[] {
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

export function findWorkspaceFile(files: readonly WebuiWorkspaceFile[], path: string): WebuiWorkspaceFile | undefined {
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

export function FileTree({ files, onOpen, expandedPaths, loadingPaths, directoryErrors, onToggle, selectedPath }: { readonly files: readonly WebuiWorkspaceFile[]; readonly onOpen: (file: WebuiWorkspaceFile) => void; readonly expandedPaths: ReadonlySet<string>; readonly loadingPaths: ReadonlySet<string>; readonly directoryErrors: Readonly<Record<string, string>>; readonly onToggle: (file: WebuiWorkspaceFile) => void; readonly selectedPath?: string }): ReactElement {
  return <div className="webui-file-tree">{files.map((file) => {
    const expanded = expandedPaths.has(file.path);
    return <div key={file.path}>
      <button type="button" className={`webui-file-tree-row ${file.path === selectedPath ? "is-selected" : ""}`} aria-current={file.path === selectedPath ? "true" : undefined} aria-expanded={file.type === "directory" ? expanded : undefined} aria-busy={file.type === "directory" && loadingPaths.has(file.path) ? "true" : undefined} onClick={() => file.type === "directory" ? onToggle(file) : onOpen(file)}>
        {file.type === "directory" ? <WebuiIconChevronLeft className={`inline size-3 transition-transform duration-[180ms] ease-out ${expanded ? "rotate-90" : ""}`} /> : <WebuiIconFile className="inline size-3" />} {file.name}
      </button>
      {file.type === "directory" ? <div className={`webui-expandable-motion${expanded ? " is-open" : ""}`} aria-hidden={!expanded} ref={(element) => element?.toggleAttribute("inert", !expanded)}>
        <div className="webui-file-tree-children">
          {loadingPaths.has(file.path) ? <p role="status">正在加载目录…</p>
            : directoryErrors[file.path] ? <p role="alert">{directoryErrors[file.path]}</p>
              : file.children?.length ? <FileTree files={file.children} onOpen={onOpen} expandedPaths={expandedPaths} loadingPaths={loadingPaths} directoryErrors={directoryErrors} onToggle={onToggle} selectedPath={selectedPath} />
                : <p>此文件夹为空。</p>}
        </div>
      </div> : null}
    </div>;
  })}</div>;
}
