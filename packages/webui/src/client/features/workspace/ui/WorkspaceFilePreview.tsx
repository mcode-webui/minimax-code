// A file's content, as the workspace panel's file tab shows it.
//
// This is a content view, not panel layout: it decides which of the archive,
// HTML, media, binary or text projections answers a path, and how a text file's
// lines are numbered and highlighted. It was `WebuiFilePreview` inside
// `WorkspacePanels.tsx`, next to the panel's tab state, sizing and resize
// gestures, which are the layout's business.
//
// The highlighting it reads is `projection/file-highlight.ts`'s; the archive,
// HTML and media branches keep their own components beside it.

import type { ReactElement } from "react";
import { WebuiMarkdown } from "../../transcript/ui/markdown.public.js";
import type { WebuiWorkspaceFileContent } from "../../../../shared/contracts/workspace.js";
import type { WebuiWorkspaceTabContent } from "../projection/workspace-panel-state.js";
import { isWorkspaceArchivePath, isWorkspaceHtmlPath } from "../projection/panel-projection.js";
import { highlightFileLine, webuiFileLanguage } from "../projection/file-highlight.js";
import { isMediaContent } from "../projection/media-preview.js";
import { webuiFileLineTargetId } from "../../../bindings/browser-effects.js";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";
import { useWebuiToastError } from "../../../ui/toast.js";
import { WorkspaceArchiveView } from "./WorkspaceArchiveView.js";
import { WorkspaceHtmlPreview } from "./WorkspaceHtmlPreview.js";
import { WorkspaceMediaPreview } from "./WorkspaceMediaPreview.js";

export function WebuiFilePreview({ tabId, content, result, codeMode, workspaceFileUrl, }: {
  readonly tabId: string;
  readonly content: Extract<WebuiWorkspaceTabContent, { readonly kind: "file-preview" }>;
  readonly result?: { readonly loading: boolean; readonly content?: WebuiWorkspaceFileContent; readonly error?: string };
  readonly codeMode: boolean;
  readonly workspaceFileUrl?: (request: { readonly workspaceDir: string; readonly path: string }) => string;
}): ReactElement {
  const filePath = result?.content?.resolvedPath ?? content.path;
  const previewMarkdown = /\.md$/iu.test(filePath) && !codeMode;
  const text = result?.content?.content ?? "";
  const language = webuiFileLanguage(filePath);
  // The read failed, or the content came back carrying an error of its own:
  // both are said once, as toasts, and neither is drawn in the layout.
  useWebuiToastError(result?.error);
  useWebuiToastError(result?.content?.error);
  // Dispatched ahead of the read result on purpose: an archive never becomes
  // text, and an HTML preview is a stream the browser fetches rather than a
  // string the panel holds. Waiting on `readWorkspaceFile` first would either
  // flash a binary error or buffer a document nobody will read.
  const archive = isWorkspaceArchivePath(filePath)
    ? <WorkspaceArchiveView workspaceDir={content.workspaceDir} path={filePath} />
    : undefined;
  const html = !archive && isWorkspaceHtmlPath(filePath) && workspaceFileUrl
    ? <WorkspaceHtmlPreview path={filePath} fileUrl={workspaceFileUrl({ workspaceDir: content.workspaceDir, path: filePath })} content={result?.content} />
    : undefined;
  return <div className="webui-workspace-file-document" data-testid="workspace-file-preview" data-file-path={content.path}>
      {archive ?? html
        /* 加载文件是一条播报；播报通道交给共享契约。`.webui-workspace-file-document > p`
           靠元素名命中，契约多了一层 div，等价的间距与颜色留在里面的 p 上。 */
        ?? (result?.loading ? <FeedbackLiveRegion><p className="m-spacing_16 text-text_default_tertiary">正在加载文件…</p></FeedbackLiveRegion>
          : result?.error || result?.content?.error ? null
          : result?.content && isMediaContent(result.content, filePath) ? <WorkspaceMediaPreview path={filePath} content={result.content} fileUrl={workspaceFileUrl?.({ workspaceDir: content.workspaceDir, path: filePath })} />
            : result?.content?.type === "binary" ? <p>无法在文本预览中显示二进制文件。</p>
              : result?.content ? previewMarkdown ? <WebuiMarkdown source={text} /> : <pre className="webui-file-code"><code className={language ? `hljs language-${language}` : ""}>{text.split("\n").map((line, index) => {
                const lineNumber = index + 1;
                const highlighted = highlightFileLine(line, language);
                return <span key={lineNumber} id={lineNumber === content.lineStart ? webuiFileLineTargetId(tabId, lineNumber) : undefined} tabIndex={lineNumber === content.lineStart ? -1 : undefined} data-line={lineNumber} data-scroll-target-line={lineNumber === content.lineStart ? "true" : undefined} className={`webui-file-code-line ${lineNumber >= (content.lineStart ?? 0) && lineNumber <= (content.lineEnd ?? content.lineStart ?? 0) ? "webui-file-preview-line-active" : ""}`} data-line-number={lineNumber} {...(highlighted !== undefined ? { dangerouslySetInnerHTML: { __html: highlighted || " " } } : {})}>{highlighted === undefined ? line || " " : undefined}</span>;
              })}</code></pre>
                : <p>文件读取能力暂不可用。</p>)}
  </div>;
}
