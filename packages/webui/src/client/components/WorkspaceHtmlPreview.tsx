// Owns the workspace HTML-preview feature (rendering an .html file inside
// the workspace panel). Nothing is implemented yet: this file is the seam a
// different implementer fills in. The only thing that lives outside it is
// the dispatch in `WebuiFilePreview`, which routes `.html`/`.htm` here
// before the read result is consulted.

import type { ReactElement } from "react";
import type { WebuiWorkspaceFileContent } from "../../server/port.js";

export type WorkspaceHtmlPreviewProps = {
  /** The file path the preview tab was opened with. */
  readonly path: string;
  /**
   * The streamable URL of the file, credential included, as returned by
   * `transport.workspaceFileUrl`.
   *
   * The preview points an iframe at this rather than carrying the document in
   * a prop. The server already answers `/workspace-file` with
   * `Content-Security-Policy: sandbox allow-scripts` for `text/html`, which
   * runs the document in an opaque origin — the one thing that stops a
   * previewed artifact from reading `window.__WEBUI_CONFIG__.token` off the
   * page that framed it. Handing the view a string instead would mean
   * re-implementing that isolation client-side, with two places to keep
   * agreeing about it.
   */
  readonly fileUrl: string;
  /**
   * The read result, when the panel already has one. `mimeType` is how the
   * view refuses a file whose extension says `.html` but whose bytes are
   * something else: the extension picks the route, and only the runtime
   * knows what the file actually is.
   */
  readonly content?: WebuiWorkspaceFileContent;
};

/**
 * Placeholder HTML preview. It renders the "not available" state so the file
 * preview has a mount point; replacing the body is a change inside this file
 * alone.
 */
export function WorkspaceHtmlPreview(_props: WorkspaceHtmlPreviewProps): ReactElement {
  return <div role="status"><p>HTML 预览尚未接入。</p></div>;
}
