// Owns the workspace file-tree feature: the recursive tree component and the
// file lookup/filter helpers. A different implementer works in this file; the
// container in `WorkspacePanels.tsx` only imports from it.

import type { ReactElement } from "react";
import type { WebuiWorkspaceFile } from "../../../../shared/contracts/workspace.js";
import { WebuiIconChevronLeft, WebuiIconFile } from "../../../shell/icons.js";
import { WebuiButton } from "../../../ui/button.js";
import { formatWorkspaceFileSize, formatWorkspaceFileModifiedAt } from "../projection/workspace-file-tree.js";
import { FeedbackError, FeedbackLiveRegion } from "../../../ui/feedback.js";

// The pure tree helpers moved to `features/workspace/projection/workspace-file-tree.ts`
// so the tree query owner merges with the same function the component walks with.
// Re-exported here so this module's public surface is unchanged.
export {
  filterWorkspaceFiles,
  mergeWorkspaceFileChildren,
  findWorkspaceFile,
  getWorkspaceFileParentPaths,
} from "../projection/workspace-file-tree.js";

/**
 * The file-metadata column. `size` and `modifiedAt` are optional by contract:
 * absent for directories, and absent for any runtime that does not stat, so
 * each half is formatted on its own and the whole span is dropped when neither
 * produced a value. Directories never reach it — a directory's byte count is
 * meaningless — which also keeps a stray value from a permissive runtime out
 * of the row.
 */
function FileTreeRowMeta({ file }: { readonly file: WebuiWorkspaceFile }): ReactElement | null {
  if (file.type === "directory") return null;
  const parts = [
    file.size === undefined ? undefined : formatWorkspaceFileSize(file.size),
    file.modifiedAt === undefined ? undefined : formatWorkspaceFileModifiedAt(file.modifiedAt),
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) return null;
  // `webui-file-tree-meta` is a hook for the row layout: the utilities keep
  // the metadata pinned to the end of the flex row while the name truncates,
  // so a long name can never push this off the end.
  return <span className="webui-file-tree-meta shrink-0 text-size_12 leading-line_height_16 text-text_default_tertiary">{parts.join(" · ")}</span>;
}

export function FileTree({ files, onOpen, expandedPaths, loadingPaths, directoryErrors, onToggle, selectedPath }: { readonly files: readonly WebuiWorkspaceFile[]; readonly onOpen: (file: WebuiWorkspaceFile) => void; readonly expandedPaths: ReadonlySet<string>; readonly loadingPaths: ReadonlySet<string>; readonly directoryErrors: Readonly<Record<string, string>>; readonly onToggle: (file: WebuiWorkspaceFile) => void; readonly selectedPath?: string }): ReactElement {
  return <div className="webui-file-tree">{files.map((file) => {
    const expanded = expandedPaths.has(file.path);
    return <div key={file.path}>
      <WebuiButton variant="selectable-row" size="regular" className="webui-file-tree-row" aria-current={file.path === selectedPath ? "true" : undefined} aria-expanded={file.type === "directory" ? expanded : undefined} aria-busy={file.type === "directory" && loadingPaths.has(file.path) ? "true" : undefined} onClick={() => file.type === "directory" ? onToggle(file) : onOpen(file)}>
        {file.type === "directory" ? <WebuiIconChevronLeft className={`inline size-3 transition-transform duration-[180ms] ease-out ${expanded ? "rotate-90" : ""}`} /> : <WebuiIconFile className="inline size-3" />} <span className="min-w-0 flex-1 truncate">{file.name}</span>
        <FileTreeRowMeta file={file} />
      </WebuiButton>
      {file.type === "directory" ? <div className={`webui-expandable-motion${expanded ? " is-open" : ""}`} aria-hidden={!expanded} ref={(element) => element?.toggleAttribute("inert", !expanded)}>
        <div className="webui-file-tree-children">
          {/* 目录在读取中是一条播报；契约的 div 仍带 role="status"，
              `.webui-file-tree-children > [role="status"]` 继续命中。 */}
          {loadingPaths.has(file.path) ? <FeedbackLiveRegion>正在加载目录…</FeedbackLiveRegion>
            : directoryErrors[file.path] ? <FeedbackError message={directoryErrors[file.path]} />
              : file.children?.length ? <FileTree files={file.children} onOpen={onOpen} expandedPaths={expandedPaths} loadingPaths={loadingPaths} directoryErrors={directoryErrors} onToggle={onToggle} selectedPath={selectedPath} />
                : <p>此文件夹为空。</p>}
        </div>
      </div> : null}
    </div>;
  })}</div>;
}
