// Owns the workspace media-preview feature: the image branch of the file
// preview, moved out of `WebuiFilePreview`. A different implementer works in
// this file; `WorkspacePanels.tsx` only imports the component from it.

import type { ReactElement } from "react";
import type { WebuiWorkspaceFileContent } from "../../server/port.js";

/**
 * Image preview for one workspace file.
 *
 * Audio and video are not implemented yet. They belong here as sibling
 * exports (`WorkspaceAudioPreview` / `WorkspaceVideoPreview`) taking the
 * same `path` + `content` props, dispatched from `content.mimeType`, so
 * `WebuiFilePreview` never needs to learn about a new media kind.
 *
 * Returns `null` when the content carries no `previewDataUrl`, so a caller
 * that branches on it never renders an empty media element.
 */
export function WorkspaceMediaPreview({ path, content }: {
  /** The file path the preview tab was opened with, used for `alt` text. */
  readonly path: string;
  /** The file content as `readWorkspaceFile` returned it. */
  readonly content: WebuiWorkspaceFileContent;
}): ReactElement | null {
  if (!content.previewDataUrl) return null;
  return <img className="webui-workspace-image-preview" src={content.previewDataUrl} alt={path.split("/").at(-1) ?? path} data-testid="workspace-image-preview" />;
}
