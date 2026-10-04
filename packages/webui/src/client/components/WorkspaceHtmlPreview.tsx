// Owns the workspace HTML-preview feature (rendering an .html file inside
// the workspace panel). Nothing is implemented yet: this file is the seam a
// different implementer fills in. `WorkspacePanels.tsx` does not mount it yet
// — `WebuiFilePreview` has no HTML branch to route into it, and adding one
// would be a feature, not a split.

import type { ReactElement } from "react";
import type { WebuiWorkspaceFileContent } from "../../server/port.js";

export type WorkspaceHtmlPreviewProps = {
  /** The file path the preview tab was opened with. */
  readonly path: string;
  /**
   * The file content as `readWorkspaceFile` returned it. `mimeType` is the
   * signal a later implementer uses to route `.html` versus `.htm` (and to
   * refuse anything that is not text/html).
   */
  readonly content: WebuiWorkspaceFileContent;
  /**
   * How the document is isolated once it renders. Workspace HTML is
   * untrusted, so the implementer must default to a sandboxed document
   * (no same-origin access, no script into the panel) and may only widen it
   * behind an explicit user choice.
   */
  readonly sandbox?: "allow-scripts" | "allow-same-origin" | "none";
};

/**
 * Placeholder HTML preview. It renders the "not available" state so the file
 * preview has a mount point; replacing the body is a change inside this file
 * alone.
 */
export function WorkspaceHtmlPreview(_props: WorkspaceHtmlPreviewProps): ReactElement {
  return <div role="status"><p>HTML 预览尚未接入。</p></div>;
}
