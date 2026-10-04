// Owns the workspace archive feature (list + extract inside .zip/.tar archives).
// Nothing is implemented yet: this file is the seam a different implementer
// fills in. `WorkspacePanels.tsx` does not mount it yet — there is no archive
// tab to mount it on, and adding one would be a feature, not a split.

import type { ReactElement } from "react";
import type { WebuiWorkspaceArchiveExtractResult, WebuiWorkspaceArchiveListing } from "../../server/port.js";

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
  readonly readWorkspaceArchive?: (request: { readonly workspaceDir: string; readonly path: string; readonly prefix?: string }) => Promise<WebuiWorkspaceArchiveListing>;
  /** Writes selected entries out of the archive into `destination`. */
  readonly extractWorkspaceArchive?: (request: { readonly workspaceDir: string; readonly path: string; readonly destination: string; readonly prefix?: string }) => Promise<WebuiWorkspaceArchiveExtractResult>;
  /**
   * The directory extraction is allowed to write into. A browser cannot ask
   * for an arbitrary path, so the view picks one from the workspace and
   * hands it to the port rather than typing a raw destination.
   */
  readonly destination?: string;
};

/**
 * Placeholder archive view. It renders the "not available" state so the
 * workspace panel has a mount point, and stays type-safe: replacing the body
 * with a real listing is a change inside this file alone.
 */
export function WorkspaceArchiveView(_props: WorkspaceArchiveViewProps): ReactElement {
  return <div role="status"><p>工作区压缩包预览尚未接入。</p></div>;
}
