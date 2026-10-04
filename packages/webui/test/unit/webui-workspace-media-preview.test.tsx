// Unit tests for the workspace media preview (`WorkspaceMediaPreview.tsx`).
//
// Rendered through `renderToStaticMarkup` — the project's SSR test convention
// (see `workspace-panel-state.test.ts`). That does not run effects, so the
// error path is asserted by invoking the exported notice component directly,
// and everything else by the markup the dispatcher emits.
//
// The clauses these pin shut:
//   * dispatch is decided by `content.mimeType`, falling back to the
//     extension, and the container's call site never changes;
//   * `fileUrl` is the source a media element points at, with
//     `content.previewDataUrl` as an image-only fallback;
//   * audio/video with no `fileUrl` render an unavailable state, never a
//     control bar that cannot scrub;
//   * no media element is emitted with an empty `src`.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isMediaContent,
  WorkspaceAudioPreview,
  WorkspaceMediaNotice,
  WorkspaceMediaPreview,
  WorkspaceVideoPreview,
} from "../../src/client/components/WorkspaceMediaPreview.js";

const FILE_URL = "http://127.0.0.1:8787/workspace-file?token=t";
const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function render(props: {
  readonly path: string;
  readonly mimeType?: string;
  readonly previewDataUrl?: string;
  readonly fileUrl?: string;
}): string {
  const { mimeType, previewDataUrl, ...rest } = props;
  return renderToStaticMarkup(
    createElement(WorkspaceMediaPreview, {
      ...rest,
      content: { type: mimeType ? "binary" : "text", content: "", mimeType, previewDataUrl },
    }),
  );
}

describe("workspace media preview", () => {
  it("renders an image from the file URL and keeps the image test id", () => {
    const markup = render({ path: "docs/diagram.png", mimeType: "image/png", fileUrl: FILE_URL });
    expect(markup).toContain('data-testid="workspace-image-preview"');
    expect(markup).toContain(`src="${FILE_URL}"`);
    expect(markup).toContain('class="webui-workspace-image-preview"');
    // The accessible name is the file name, not the path it was opened with.
    expect(markup).toContain('alt="diagram.png"');
  });

  it("prefers the file URL and falls back to the inline data URL for an image", () => {
    expect(render({ path: "a.png", mimeType: "image/png", fileUrl: FILE_URL, previewDataUrl: DATA_URL })).toContain(
      `src="${FILE_URL}"`,
    );
    const inline = render({ path: "a.png", mimeType: "image/png", previewDataUrl: DATA_URL });
    expect(inline).toContain(`src="${DATA_URL}"`);
    expect(inline).toContain('data-testid="workspace-image-preview"');
  });

  it("renders no image element when neither source is present", () => {
    expect(render({ path: "a.png", mimeType: "image/png" })).toBe("");
    // An empty `fileUrl` is no URL and must not shadow the fallback.
    expect(render({ path: "a.png", mimeType: "image/png", fileUrl: "" })).toBe("");
  });

  it("renders a video player off the file URL with metadata preload and no autoplay", () => {
    const markup = render({ path: "clips/demo.mp4", mimeType: "video/mp4", fileUrl: FILE_URL });
    expect(markup).toContain("<video");
    expect(markup).toContain(`src="${FILE_URL}"`);
    expect(markup).toContain('controls=""');
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain('aria-label="demo.mp4"');
    expect(markup).toContain('data-testid="workspace-video-preview"');
    expect(markup).not.toContain("autoplay");
    expect(markup).not.toContain("<img");
  });

  it("renders an audio player off the file URL with metadata preload and no autoplay", () => {
    const markup = render({ path: "audio/voice.mp3", mimeType: "audio/mpeg", fileUrl: FILE_URL });
    expect(markup).toContain("<audio");
    expect(markup).toContain(`src="${FILE_URL}"`);
    expect(markup).toContain('controls=""');
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain('aria-label="voice.mp3"');
    expect(markup).toContain('data-testid="workspace-audio-preview"');
    expect(markup).not.toContain("autoplay");
  });

  it("routes on the extension when the read result carries no mime type", () => {
    expect(render({ path: "out/demo.webm", fileUrl: FILE_URL })).toContain("<video");
    expect(render({ path: "out/voice.wav", fileUrl: FILE_URL })).toContain("<audio");
    expect(render({ path: "out/photo.avif", fileUrl: FILE_URL })).toContain("<img");
    // The runtime may report a mime in any case; a `VIDEO/MP4` still routes.
    expect(isMediaContent({ mimeType: "VIDEO/MP4" }, "clip.mp4")).toBe(true);
  });

  it("refuses an inline-only audio or video instead of a dead control bar", () => {
    // A base64 `data:` URL cannot be range-requested: the progress bar could
    // not be scrubbed and playback could not start before the whole file was
    // inlined into the document. So no element at all, only the notice.
    const audio = render({ path: "voice.mp3", mimeType: "audio/mpeg", previewDataUrl: "data:audio/mpeg;base64,AAAA" });
    expect(audio).not.toContain("<audio");
    expect(audio).toContain('role="status"');
    expect(audio).toContain("voice.mp3");
    expect(audio).toContain("内联数据");

    const video = render({ path: "demo.mp4", mimeType: "video/mp4", previewDataUrl: "data:video/mp4;base64,AAAA" });
    expect(video).not.toContain("<video");
    expect(video).toContain('role="status"');

    // No source of any kind, and an empty URL, are the same unavailable state.
    expect(render({ path: "demo.mp4", mimeType: "video/mp4" })).not.toContain("<video");
    expect(render({ path: "demo.mp4", mimeType: "video/mp4", fileUrl: "" })).not.toContain("<video");
  });

  it("shows a load failure instead of a silent blank media box", () => {
    // The error is state driven by `onError`, which static rendering never
    // fires, so the message the element hands over to is asserted directly —
    // and the role is what makes it announced rather than merely visible.
    const failed = renderToStaticMarkup(
      createElement(WorkspaceMediaNotice, { name: "demo.mp4", reason: "视频加载失败。", role: "alert" }),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("demo.mp4");
    expect(failed).toContain("视频加载失败。");

    const unavailable = renderToStaticMarkup(
      createElement(WorkspaceMediaNotice, { name: "voice.mp3", reason: "没有可按范围请求的文件地址。" }),
    );
    expect(unavailable).toContain('role="status"');
  });

  it("leaves a non-media file to the caller", () => {
    // The gate in `WorkspacePanels` is the same question `isMediaContent`
    // answers; a file it refuses never reaches the dispatcher, and if it is
    // called anyway it renders nothing rather than pointing a player at it.
    expect(isMediaContent({ mimeType: "application/pdf" }, "docs/spec.pdf")).toBe(false);
    expect(isMediaContent({ mimeType: "application/octet-stream" }, "run.sh")).toBe(false);
    expect(render({ path: "docs/spec.pdf", mimeType: "application/pdf", fileUrl: FILE_URL })).toBe("");
    expect(render({ path: "docs/notes.txt", fileUrl: FILE_URL })).toBe("");
  });

  it("keeps the audio and video siblings renderable on their own props", () => {
    // The container never calls these, but they are the exports a caller
    // building a custom preview would reach for, so their prop contract is
    // asserted rather than left to the dispatcher's spread.
    const video = renderToStaticMarkup(
      createElement(WorkspaceVideoPreview, {
        path: "a/b/clip.mp4",
        content: { type: "binary", content: "", mimeType: "video/mp4" },
        fileUrl: FILE_URL,
      }),
    );
    const audio = renderToStaticMarkup(
      createElement(WorkspaceAudioPreview, {
        path: "a/b/tone.mp3",
        content: { type: "binary", content: "", mimeType: "audio/mpeg" },
        fileUrl: FILE_URL,
      }),
    );
    expect(video).toContain('aria-label="clip.mp4"');
    expect(audio).toContain('aria-label="tone.mp3"');
  });
});
