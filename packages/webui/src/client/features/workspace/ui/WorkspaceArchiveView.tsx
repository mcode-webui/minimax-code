// Owns the workspace archive feature (list + extract inside .zip/.tar archives).
// `WorkspacePanels.tsx` mounts this for every path `isWorkspaceArchivePath`
// accepts, and the runtime owns every hardening decision — this file renders
// what `readWorkspaceArchive` is willing to name and never invents a path.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  useWebuiWorkspaceArchive,
  useWebuiWorkspaceQueriesState,
} from "../../../bindings/use-query-state.js";
import type {
  WebuiArchiveEntry,
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceArchiveListing,
} from "../../../../shared/contracts/workspace.js";
import { archiveDestinationFor, formatArchiveSize } from "../projection/archive-projection.js";
import { FeedbackError } from "../../../ui/feedback.js";

export type WorkspaceArchiveViewProps = {
  /** Absolute workspace root; every archive path below is relative to it. */
  readonly workspaceDir: string;
  /** The archive's path inside the workspace, as the file tree reported it. */
  readonly path: string;
  /**
   * Lists one level of the archive. The runtime owns every hardening
   * decision (entry ceiling, expansion ratio, path validation), so the view
   * renders only what this call is willing to name. `prefix` walks deeper
   * levels; absent, the listing is the archive root.
   */
  /** Writes selected entries out of the archive into `destination`. */
  /**
   * The directory extraction is allowed to write into. A browser cannot ask
   * for an arbitrary path, so the view picks one from the workspace and
   * hands it to the port rather than typing a raw destination.
   */
  readonly destination?: string;
};

type ArchiveLoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "ready"; readonly listing: WebuiWorkspaceArchiveListing };

type ArchiveExtractState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "done"; readonly result: WebuiWorkspaceArchiveExtractResult }
  | { readonly status: "error"; readonly error: string };

/**
 * One directory level of an archive, with navigation and the extract control.
 *
 * Split out from the container so every state is reachable without a running
 * effect: `renderToStaticMarkup` does not run effects, and the parent would
 * otherwise leave loading, empty, error and truncated untestable.
 */
export function WorkspaceArchiveListing({
  archivePath,
  prefix,
  destination,
  entries,
  totalEntries,
  truncated,
  extractState,
  onEnterDirectory,
  onGoUp,
  onExtract,
}: {
  readonly archivePath: string;
  /** The directory being shown, relative to the archive root; "" is the root. */
  readonly prefix: string;
  /** The workspace-relative directory an extraction would write into. */
  readonly destination: string;
  readonly entries: readonly WebuiArchiveEntry[];
  readonly totalEntries: number;
  readonly truncated: boolean;
  readonly extractState: ArchiveExtractState;
  readonly onEnterDirectory?: (name: string) => void;
  readonly onGoUp?: () => void;
  readonly onExtract?: () => void;
}): ReactElement {
  return (
    <div className="webui-workspace-archive-view" data-testid="workspace-archive-view">
      <p className="webui-workspace-archive-path" data-testid="workspace-archive-path">
        {`${archivePath}${prefix ? ` › ${prefix}` : ""}`}
      </p>
      {prefix
        ? <button type="button" data-testid="workspace-archive-up" onClick={onGoUp}>返回上级</button>
        : null}
      {truncated
        ? (
            <p role="status" data-testid="workspace-archive-truncated">
              {`压缩包共 ${totalEntries} 项，这里只显示了 ${entries.length} 项；其余条目未列出。`}
            </p>
          )
        : null}
      {entries.length === 0
        ? <p data-testid="workspace-archive-empty">该目录没有条目。</p>
        : (
            <ul className="webui-workspace-archive-entries" data-testid="workspace-archive-entries">
              {entries.map((entry) => (
                <li
                  key={entry.path}
                  data-testid="workspace-archive-entry"
                  data-archive-path={entry.path}
                  data-directory={entry.isDirectory ? "true" : "false"}
                >
                  {entry.isDirectory
                    ? (
                        <button type="button" data-testid="workspace-archive-directory" onClick={() => onEnterDirectory?.(entry.name)}>
                          {`${entry.name}（目录）`}
                        </button>
                      )
                    : (
                        <>
                          <span data-testid="workspace-archive-file">{entry.name}</span>
                          {entry.size === undefined
                            ? null
                            : <span data-testid="workspace-archive-size">{formatArchiveSize(entry.size)}</span>}
                        </>
                      )}
                </li>
              ))}
            </ul>
          )}
      <ArchiveExtractControls destination={destination} extractState={extractState} onExtract={onExtract} />
    </div>
  );
}

/**
 * The extract affordance, with its destination shown rather than typed.
 *
 * The destination is a workspace-relative path this component derived from the
 * archive (or a caller-supplied one); there is no free-text field anywhere in
 * this view, because a destination a browser can type is a path-traversal
 * endpoint rather than a feature. The server re-validates it regardless.
 */
function ArchiveExtractControls({
  destination,
  extractState,
  onExtract,
}: {
  readonly destination: string;
  readonly extractState: ArchiveExtractState;
  readonly onExtract?: () => void;
}): ReactElement {
  return (
    <div className="webui-workspace-archive-extract">
      <p data-testid="workspace-archive-destination">
        {destination ? `解压目标：${destination}` : "没有可用的解压目标。"}
      </p>
      <button
        type="button"
        data-testid="workspace-archive-extract"
        disabled={!destination || !onExtract || extractState.status === "running"}
        onClick={onExtract}
      >
        {extractState.status === "running" ? "正在解压…" : "解压当前目录"}
      </button>
      {extractState.status === "done"
        ? (
            <p role="status" data-testid="workspace-archive-extract-result">
              {`已解压 ${extractState.result.writtenFiles} 个文件到 ${extractState.result.destination}${extractState.result.truncated ? "（条目过多，仅解压了前一部分）" : ""}。`}
            </p>
          )
        : null}
      {extractState.status === "error"
        ? <FeedbackError message={extractState.error} testId="workspace-archive-extract-error" />
        : null}
    </div>
  );
}

/** Shown for every state that is not a listing: unavailable, loading, failed. */
export function WorkspaceArchiveNotice({
  reason,
  role = "status",
}: {
  readonly reason: string;
  /** `alert` for a failure, `status` for a state that was never available. */
  readonly role?: "status" | "alert";
}): ReactElement {
  return <p role={role} data-testid="workspace-archive-notice">{reason}</p>;
}

/**
 * The archive preview: one level at a time, with the extract control.
 *
 * Entering a directory re-lists with `prefix`; going up drops the last segment.
 * A `truncated` listing is passed straight through rather than smoothed over —
 * the runtime hit a ceiling and the user has to know that what they see is not
 * the whole archive.
 */
export function WorkspaceArchiveView(props: WorkspaceArchiveViewProps): ReactElement {
  const { workspaceDir, path, destination } = props;
  const queries = useWebuiWorkspaceArchive();
  const archive = useWebuiWorkspaceQueriesState().archive;
  const [prefix, setPrefix] = useState("");
  const target = destination ?? archiveDestinationFor(path);

  // The listing belongs to the archive owner: this view states what it wants read
  // and renders what came back. A read for a prefix the user has left is superseded
  // by the owner's version key rather than by a per-render flag, and the extract
  // outcome is the owner's too.
  useEffect(() => {
    queries?.readArchive({ workspaceDir, path, ...(prefix ? { prefix } : {}) });
  }, [queries, workspaceDir, path, prefix]);

  const load: ArchiveLoadState =
    archive.listing.status === "ready"
      ? { status: "ready", listing: archive.listing.listing }
      : archive.listing.status === "error"
        ? { status: "error", error: archive.listing.error }
        : { status: "loading" };
  const extract: ArchiveExtractState =
    archive.extract.status === "extracting"
      ? { status: "running" }
      : archive.extract.status === "done"
        ? { status: "done", result: archive.extract.result }
        : archive.extract.status === "error"
          ? { status: "error", error: archive.extract.error }
          : { status: "idle" };

  const enterDirectory = useCallback((name: string) => {
    setPrefix((current) => (current ? `${current}/${name}` : name));
  }, []);
  const goUp = useCallback(() => {
    setPrefix((current) => {
      const slash = current.lastIndexOf("/");
      return slash === -1 ? "" : current.slice(0, slash);
    });
  }, []);
  const extractHere = useCallback(() => {
    if (!queries?.canExtractArchive || !target) return;
    void queries.extractArchive({ workspaceDir, path, destination: target, ...(prefix ? { prefix } : {}) });
  }, [queries, workspaceDir, path, prefix, target]);

  if (!queries?.canReadArchive) {
    return <WorkspaceArchiveNotice reason="当前服务没有提供压缩包浏览能力。" />;
  }
  if (load.status === "loading") return <WorkspaceArchiveNotice reason="正在读取压缩包…" />;
  if (load.status === "error") return <WorkspaceArchiveNotice reason={load.error} role="alert" />;
  return (
    <WorkspaceArchiveListing
      archivePath={load.listing.archivePath}
      prefix={prefix}
      destination={target}
      entries={load.listing.entries}
      totalEntries={load.listing.totalEntries}
      truncated={load.listing.truncated}
      extractState={extract}
      onEnterDirectory={enterDirectory}
      onGoUp={prefix ? goUp : undefined}
      onExtract={queries?.canExtractArchive && target ? extractHere : undefined}
    />
  );
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
