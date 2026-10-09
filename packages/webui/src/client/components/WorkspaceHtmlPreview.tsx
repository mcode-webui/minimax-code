// Owns the workspace HTML-preview feature (rendering an .html file inside
// the workspace panel). The dispatch in `WebuiFilePreview` routes
// `.html`/`.htm` here before the read result is consulted; nothing else in
// the panel needs to know this component exists.
//
// The document is rendered by pointing an `<iframe src={fileUrl}>` at the
// `/workspace-file` route, and that is the whole isolation story. The route
// answers `text/html` with `Content-Security-Policy: sandbox allow-scripts`,
// which puts the framed document in an opaque origin: its scripts run, but it
// cannot read `window.__WEBUI_CONFIG__.token` off the page that framed it,
// cannot touch the panel's DOM, and cannot use the WebUI's origin for storage.
//
// Two things follow, and both are load-bearing:
//
//   * No `sandbox` attribute here. The header already sandboxes the document.
//     A second layer on the iframe cannot be relaxed later without an edit to
//     this file, and while both exist it is impossible to tell which one is
//     actually holding — so a future reader cannot audit the boundary. One
//     layer, in one place (the server), is auditable.
//   * Never `srcdoc`, never a blob URL, never `dangerouslySetInnerHTML`. A
//     `srcdoc` document inherits the *parent* document's policy, which is the
//     WebUI itself — inlining the bytes would silently discard the server's
//     CSP and hand the artifact the same origin as the token. The cost of
//     that mistake is the whole WebUI session, so the document never becomes
//     a string this component renders.
//
// What the opaque origin costs is relative URLs: an `<img src="logo.png">`
// resolves against the route, not against the file's directory, and 404s. The
// frame is therefore always accompanied by a note saying so, and the note is
// sharper when the read result shows a relative reference.

import { useEffect, useState, type ReactElement } from "react";
import type { WebuiWorkspaceFileContent } from "../../shared/contracts/workspace.js";

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

const HTML_PREVIEW_COPY = {
  loading: "正在加载 HTML 预览…",
  loadFailed: "HTML 预览加载失败：文件接口没有返回可显示的文档。",
  relativeDetected: "检测到文档引用了相对路径资源。预览运行在隔离来源中，相对路径会解析到文件接口而不是文件所在目录，因此这些资源不会显示。",
  relativeUndetected: "预览运行在隔离来源中。文档内的相对路径资源会解析到文件接口而不是文件所在目录，可能无法显示；文档脚本无法访问 WebUI 的会话凭据。",
  openOutside: "在浏览器中打开",
} as const;

/**
 * The frame's own load state. `onLoad`/`onError` are the only observable
 * signals available: the document is in an opaque origin, so the panel cannot
 * reach into it to ask whether it rendered, and a silent empty frame is the
 * failure mode this exists to prevent.
 */
type WorkspaceHtmlFrameState = "loading" | "loaded" | "failed";

// `src`/`href`/`poster` values, `srcset` candidate lists, and `url()` in
// inline CSS. All read-only: the document is never rewritten, only reported
// on. `srcset` is scanned separately because it is the one attribute whose
// value is a comma-separated list — splitting `data:` URLs on their comma
// would report a false positive on a fully absolute reference.
const ASSET_ATTRIBUTE_PATTERN = /(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;
const SRCSET_PATTERN = /srcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;
const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/giu;

/**
 * Whether a reference is resolved against the frame's base URL.
 *
 * That base is the `/workspace-file` route, so both `logo.png` and
 * `/logo.png` miss: the document's own directory is not on the URL at all.
 * A scheme (`https:`, `data:`, `blob:`, `mailto:`) and a same-document
 * fragment are the two cases that still resolve to something intended.
 */
function isRelativeReference(value: string): boolean {
  const reference = value.trim();
  if (!reference || reference.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(reference)) return false;
  if (reference.startsWith("//")) return false;
  return true;
}

function firstCapture(match: RegExpMatchArray): string {
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/**
 * Whether a document's own text shows a relative asset reference.
 *
 * Best-effort by construction: it is a report on the source, not a proof
 * about the rendered frame — an unread file, a reference built at runtime, or
 * a `<base href>` that redirects resolution are all invisible here. That is
 * exactly why the note stays visible when this returns `false`.
 */
export function hasRelativeDocumentReference(source: string): boolean {
  for (const match of source.matchAll(SRCSET_PATTERN)) {
    // Each `srcset` candidate is a URL followed by a descriptor.
    for (const candidate of firstCapture(match).split(",")) {
      if (isRelativeReference(candidate.trim().split(/\s+/u)[0] ?? "")) return true;
    }
  }
  for (const match of source.matchAll(ASSET_ATTRIBUTE_PATTERN)) {
    if (isRelativeReference(firstCapture(match))) return true;
  }
  for (const match of source.matchAll(CSS_URL_PATTERN)) {
    if (isRelativeReference(firstCapture(match))) return true;
  }
  return false;
}

/**
 * Live HTML preview for one workspace file.
 *
 * Three states before the frame, none of which may be an empty element: the
 * file is not `text/html` according to the runtime, there is no file URL to
 * point at, or the frame has not loaded (or failed to).
 */
export function WorkspaceHtmlPreview({ path, fileUrl, content }: WorkspaceHtmlPreviewProps): ReactElement {
  const fileName = path.split("/").at(-1) ?? path;
  const [frameState, setFrameState] = useState<WorkspaceHtmlFrameState>("loading");

  // A new URL is a new document: the previous file's outcome says nothing
  // about this one, and a stale "loaded" would hide the loading state.
  useEffect(() => {
    setFrameState("loading");
  }, [fileUrl]);

  // The extension chose the route, so the runtime is the only thing that
  // knows what the bytes are. A `.html` that reads back as `text/plain`
  // would otherwise be framed as a document the server never agreed to
  // isolate — the CSP branch is keyed on `text/html` too.
  const mimeType = content?.mimeType?.trim().toLowerCase();
  if (mimeType && !mimeType.startsWith("text/html")) {
    return <div className="webui-workspace-files-empty" data-testid="workspace-html-preview-refused" role="alert">
      <strong>不作为 HTML 预览打开</strong>
      <p>{`文件扩展名是 .html，但运行时报告的类型是 ${mimeType}，服务端不会以隔离文档的策略回答它。`}</p>
    </div>;
  }

  if (!fileUrl) {
    return <div className="webui-workspace-files-empty" data-testid="workspace-html-preview-unavailable" role="status">
      <strong>无法预览 HTML</strong>
      <p>缺少文件地址，面板没有可加载的文档。</p>
    </div>;
  }

  const relativeReference = content?.type === "text" ? hasRelativeDocumentReference(content.content) : false;

  return <div data-testid="workspace-html-preview" style={{ display: "flex", height: "100%", minWidth: 0, minHeight: 0, flexDirection: "column" }}>
    {frameState === "loaded" ? null : <p className="webui-workspace-review-status" data-testid="workspace-html-preview-status" role={frameState === "failed" ? "alert" : "status"}>
      {frameState === "failed" ? HTML_PREVIEW_COPY.loadFailed : HTML_PREVIEW_COPY.loading}
    </p>}
    <p className="webui-workspace-review-status" data-testid="workspace-html-preview-isolation-note">
      {relativeReference ? HTML_PREVIEW_COPY.relativeDetected : HTML_PREVIEW_COPY.relativeUndetected}
      {" "}
      <a className="webui-button-secondary" data-testid="workspace-html-preview-open-outside" href={fileUrl} target="_blank" rel="noreferrer noopener">{HTML_PREVIEW_COPY.openOutside}</a>
    </p>
    {/* No `sandbox` here: the server header is the one layer, and it is the
        only one that can be audited from the response. */}
    <div style={{ flex: "1 1 auto", minHeight: 0 }}>
      <iframe
        title={`HTML 预览：${fileName}`}
        src={fileUrl}
        data-testid="workspace-html-preview-frame"
        onLoad={() => { setFrameState("loaded"); }}
        onError={() => { setFrameState("failed"); }}
        style={{ display: "block", width: "100%", height: "100%", minHeight: 240, border: 0, background: "transparent" }}
      />
    </div>
  </div>;
}
