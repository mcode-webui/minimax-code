// Transcript Markdown links must stay single anchors, and ordinary prose must
// not be scanned for file-shaped substrings. File references are covered in
// transcript-file-anchor-anchors.test.tsx through Markdown code spans/links.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WebuiMarkdown } from "../../src/client/features/transcript/ui/markdown.public.js";
import { parseWebuiMessageFileReference } from "../../src/client/features/transcript/projection/message-file-reference.js";

function render(source: string): string {
  return renderToStaticMarkup(createElement(WebuiMarkdown, { source, onOpenFile: () => undefined }));
}

/** Visible text only — an `href` attribute value is not text the reader sees. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/gu, "");
}

function anchorCount(html: string): number {
  return html.match(/<a\b/gu)?.length ?? 0;
}

describe("markdown link rendering", () => {
  it("renders a bare URL as exactly one anchor", () => {
    const html = render("https://example.com/a/b");
    expect(anchorCount(html)).toBe(1);
    expect(html).toContain('href="https://example.com/a/b"');
  });

  it("does not nest an anchor inside the rendered link", () => {
    const html = render("https://example.com/a/b");
    expect(html).toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<\/a>/u);
  });

  it("shows a link's label once instead of duplicating it", () => {
    expect(visibleText(render("https://example.com/a/b"))).toBe("https://example.com/a/b");
  });
});

describe("markdown file references and ordinary text", () => {
  it("returns undefined when the projection parser is handed a whole URL", () => {
    expect(parseWebuiMessageFileReference("https://example.com/pkg/index.ts")).toBeUndefined();
    expect(parseWebuiMessageFileReference("https://example.com/index.ts")).toBeUndefined();
  });

  it("does not turn the dotted tail of a URL into a file reference", () => {
    const html = render("see https://example.com/pkg/index.ts now");
    expect(html).not.toContain("data-webui-file-reference");
    expect(html).not.toContain("webui-message-file-link");
    expect(visibleText(html)).toBe("see https://example.com/pkg/index.ts now");
  });

  it("does not turn a Markdown link's URL into a file reference", () => {
    const html = render("[docs](https://example.com/pkg/index.ts)");
    expect(html).not.toContain("data-webui-file-reference");
    expect(html).not.toContain("com/pkg/index.ts");
  });

  it("does not scan path-looking prose, while Markdown code spans still render as file references", () => {
    for (const source of ["see path/to/file.ts:120 now", "see a/index.ts now", "see index.ts now"]) {
      const html = render(source);
      expect(html, source).not.toContain("data-webui-file-reference");
      expect(anchorCount(html), source).toBe(0);
    }

    const explicitCodePath = render("see `path/to/file.ts:120` now");
    expect(explicitCodePath).toContain('data-webui-file-reference="path/to/file.ts"');
    expect(anchorCount(explicitCodePath)).toBe(1);
  });
});
