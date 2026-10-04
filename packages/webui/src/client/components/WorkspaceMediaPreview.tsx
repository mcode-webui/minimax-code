// Owns the workspace media-preview feature: the image, audio and video
// branches of the file preview, moved out of `WebuiFilePreview`. A different
// implementer works in this file; `WorkspacePanels.tsx` only imports the
// components from it.

import type { ReactElement } from "react";
import type { WebuiWorkspaceFileContent } from "../../server/port.js";

export type WorkspaceMediaPreviewProps = {
  /** The file path the preview tab was opened with, used for `alt` text. */
  readonly path: string;
  /** The file content as `readWorkspaceFile` returned it. */
  readonly content: WebuiWorkspaceFileContent;
  /**
   * The streamable URL of the same file, credential included, as returned by
   * `transport.workspaceFileUrl`.
   *
   * This is what the media elements point at, and it is why the props are
   * both here. `content.previewDataUrl` is a base64 payload that the runtime
   * never populates — nothing in this repo writes that field — so branching on
   * it alone yields a preview that can never render. The URL route is the one
   * that works, and it is also the only one that can serve `<video>`/`<audio>`
   * at all: a base64 `data:` URL cannot be range-requested, so the browser
   * could not scrub a progress bar or start playback before the whole file
   * arrived.
   *
   * Absent when the transport does not expose the route; render the
   * unavailable state rather than a media element pointed at nothing.
   */
  readonly fileUrl?: string;
};

/**
 * Whether a read result is media this component should render at all.
 *
 * The file URL is derivable for *any* path, so the container cannot gate on
 * "a URL exists" — that would point an `<img>` at an executable and render a
 * broken image. The decision belongs to the runtime's `mimeType` where there
 * is one, and falls back to the extension for the text results that carry no
 * mime, so the same check holds on both sides of the read.
 */
export function isMediaContent(content: Pick<WebuiWorkspaceFileContent, "mimeType">, path: string): boolean {
  const mimeType = content.mimeType?.toLowerCase();
  if (mimeType) return /^(image|video|audio)\//u.test(mimeType);
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|webm|ogv|mov|mp3|wav|ogg|m4a|aac|flac)$/iu.test(path);
}

/**
 * Image preview for one workspace file.
 *
 * Audio and video are not implemented yet. They belong here as sibling
 * exports (`WorkspaceAudioPreview` / `WorkspaceVideoPreview`) taking the same
 * `path` + `content` + `fileUrl` props, dispatched from `content.mimeType`, so
 * `WebuiFilePreview` never needs to learn about a new media kind.
 *
 * Returns `null` when neither source can produce a preview, so a caller that
 * branches on it never renders an empty media element.
 */
export function WorkspaceMediaPreview({ path, content, fileUrl }: WorkspaceMediaPreviewProps): ReactElement | null {
  const source = fileUrl ?? content.previewDataUrl;
  if (!source) return null;
  return <img className="webui-workspace-image-preview" src={source} alt={path.split("/").at(-1) ?? path} data-testid="workspace-image-preview" />;
}
