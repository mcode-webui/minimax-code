// Owns the workspace file-tree feature: the recursive tree component and the
// file lookup/filter helpers. A different implementer works in this file; the
// container in `WorkspacePanels.tsx` only imports from it.

import type { ReactElement } from "react";
import type { WebuiWorkspaceFile } from "../../shared/contracts/workspace.js";
import { WebuiIconChevronLeft, WebuiIconFile } from "../icons.js";

// The pure tree helpers moved to `projection/workspace-file-tree.ts` so the
// tree query owner merges with the same function the component walks with
// (ticket #51). Re-exported here so this module's public surface is unchanged.
export {
  filterWorkspaceFiles,
  mergeWorkspaceFileChildren,
  findWorkspaceFile,
  getWorkspaceFileParentPaths,
} from "../projection/workspace-file-tree.js";

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
      <button type="button" className={`webui-file-tree-row ${file.path === selectedPath ? "is-selected" : ""}`} aria-current={file.path === selectedPath ? "true" : undefined} aria-expanded={file.type === "directory" ? expanded : undefined} aria-busy={file.type === "directory" && loadingPaths.has(file.path) ? "true" : undefined} onClick={() => file.type === "directory" ? onToggle(file) : onOpen(file)}>
        {file.type === "directory" ? <WebuiIconChevronLeft className={`inline size-3 transition-transform duration-[180ms] ease-out ${expanded ? "rotate-90" : ""}`} /> : <WebuiIconFile className="inline size-3" />} <span className="min-w-0 flex-1 truncate">{file.name}</span>
        <FileTreeRowMeta file={file} />
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
