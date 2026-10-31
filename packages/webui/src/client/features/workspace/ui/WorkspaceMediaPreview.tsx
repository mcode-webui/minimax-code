// Owns the workspace media-preview feature: the image, audio and video
// branches of the file preview, moved out of `WebuiFilePreview`.
// `WorkspacePanels.tsx` only imports the components from it.

import { useState, type ReactElement } from "react";
import type { WebuiWorkspaceFileContent } from "../../../../shared/contracts/workspace.js";
import { basenamePath } from "../../../projection/common/paths.js";
import { mediaKind, isMediaContent } from "../projection/media-preview.js";
import { FeedbackError, FeedbackLiveRegion } from "../../../ui/feedback.js";

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

/** The file name a media element is named after; a full path is not a name. */
function mediaName(path: string): string {
  return basenamePath(path);
}

/** Shown instead of a player that cannot work, and after a load failure. */
export function WorkspaceMediaNotice({
  name,
  reason,
  failure = false,
}: {
  readonly name: string;
  readonly reason: string;
  /** A failure is announced; a state that was never available is not. */
  readonly failure?: boolean;
}): ReactElement {
  // A failure is announced, an unavailable state is not: one component that
  // renders both roles is exactly the conflation the family separates.
  const message = `${name} 预览不可用：${reason}`;
  return failure ? (
    <FeedbackError message={message} />
  ) : (
    // 不可用是一条播报；播报通道交给共享契约，内联样式留在承载文字的元素上。
    <FeedbackLiveRegion>
      <p style={{ margin: "var(--spacing_16)", color: "var(--text_default_tertiary)" }}>
        {message}
      </p>
    </FeedbackLiveRegion>
  );
}

/**
 * Why audio and video refuse an inline-only source. Kept here so the image
 * branch can stay the one that accepts `previewDataUrl` without either branch
 * having to re-argue it.
 */
const NO_RANGEABLE_SOURCE =
  "没有可按范围请求的文件地址，只有内联数据，进度条无法拖动也无法起播。";

/**
 * Image preview for one workspace file.
 *
 * The one branch that accepts `content.previewDataUrl`: a browser fetches a
 * `data:` image atomically, so an inline source renders here even though it
 * cannot stream. `fileUrl` wins where both are present.
 *
 * Returns `null` when neither source can produce a preview, so a caller that
 * branches on it never renders an empty media element.
 */
export function WorkspaceImagePreview({ path, content, fileUrl }: WorkspaceMediaPreviewProps): ReactElement | null {
  const [failed, setFailed] = useState(false);
  // `||`, not `??`: an empty `fileUrl` is no URL, and must not shadow the
  // fallback the same way `??` would keep it.
  const source = fileUrl || content.previewDataUrl;
  if (!source) return null;
  const name = mediaName(path);
  if (failed) return <WorkspaceMediaNotice name={name} failure reason="图片加载失败。" />;
  return (
    <img
      className="webui-workspace-image-preview"
      src={source}
      alt={name}
      data-testid="workspace-image-preview"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Video preview for one workspace file.
 *
 * `preload="metadata"` rather than `auto`: the panel should not pull a whole
 * video down to show a tab. No `autoPlay` — a preview that starts making noise
 * when a tab is opened is not a preview.
 */
export function WorkspaceVideoPreview({ path, fileUrl }: WorkspaceMediaPreviewProps): ReactElement {
  const [failed, setFailed] = useState(false);
  const name = mediaName(path);
  if (!fileUrl) return <WorkspaceMediaNotice name={name} reason={NO_RANGEABLE_SOURCE} />;
  if (failed) return <WorkspaceMediaNotice name={name} failure reason="视频加载失败。" />;
  return (
    <video
      // The one existing media rule in the stylesheet is sized and centred for
      // a contained element, which is what a video frame needs; no new class.
      className="webui-workspace-image-preview"
      style={{ width: "100%" }}
      src={fileUrl}
      controls
      preload="metadata"
      aria-label={name}
      data-testid="workspace-video-preview"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Audio preview for one workspace file. Same contract as the video branch:
 * `fileUrl` only, `preload="metadata"`, no autoplay, named after the file.
 */
export function WorkspaceAudioPreview({ path, fileUrl }: WorkspaceMediaPreviewProps): ReactElement {
  const [failed, setFailed] = useState(false);
  const name = mediaName(path);
  if (!fileUrl) return <WorkspaceMediaNotice name={name} reason={NO_RANGEABLE_SOURCE} />;
  if (failed) return <WorkspaceMediaNotice name={name} failure reason="音频加载失败。" />;
  return (
    <audio
      style={{ width: "100%" }}
      src={fileUrl}
      controls
      preload="metadata"
      aria-label={name}
      data-testid="workspace-audio-preview"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Media preview for one workspace file: the dispatcher the container imports.
 *
 * `WorkspacePanels` already gates on `isMediaContent` and already hands the
 * same three props to one component name, so the kind is resolved here rather
 * than at the call site — adding a media kind must not mean editing the
 * container. The child is keyed on `path` so a failed preview does not keep
 * its error while the same tab is pointed at a different file.
 *
 * Returns `null` for a content that is not media at all, so a caller that
 * branches on it never renders an empty media element.
 */
export function WorkspaceMediaPreview(props: WorkspaceMediaPreviewProps): ReactElement | null {
  const kind = mediaKind(props.content, props.path);
  if (kind === "image") return <WorkspaceImagePreview key={props.path} {...props} />;
  if (kind === "video") return <WorkspaceVideoPreview key={props.path} {...props} />;
  if (kind === "audio") return <WorkspaceAudioPreview key={props.path} {...props} />;
  return null;
}
