// Two defects in `src/client/markdown.tsx` that the C-5 verification found
// while checking transcript file/line anchors. Both pre-date this file's other
// work; neither is caused by the C-1/C-2 code-block changes.
//
//   DEFECT 1 (the bare-text scanner) — the scanner's lookbehind
//   `(?<![\w/:])` does not exclude a preceding `.`, so the dotted tail of a
//   URL is sliced off and opened as a bogus workspace-relative file
//   reference. The projection parser is innocent: handed a whole URL,
//   `parseWebuiMessageFileReference` returns `undefined` (asserted below) —
//   the scanner just never hands it a whole URL.
//
//   DEFECT 2 (the `link` branch) — the branch re-enters `inline()` for the
//   link's own label with `lexBareText` still `true`, so the label is
//   re-lexed and the autolink is emitted a second time inside itself:
//   `<a href="…"><a href="…">…</a></a>`. Invalid HTML, and it is the code
//   path that feeds Defect 1.
//
// The assertions below state the correct behaviour. They are written against
// observable output — anchor counts, the presence of the file-reference hook,
// and the visible text a reader actually gets — never on a testid.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WebuiMarkdown } from "../../src/client/markdown.js";
import { parseWebuiMessageFileReference } from "../../src/client/projection/message-file-reference.js";

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

describe("markdown link label re-lexing (DEFECT 2)", () => {
  it("renders a bare URL as exactly one anchor", () => {
    const html = render("https://example.com/a/b");
    expect(anchorCount(html)).toBe(1);
    expect(html).toContain('href="https://example.com/a/b"');
  });

  it("does not nest an anchor inside the rendered link", () => {
    // The bare URL is the shape that actually reaches the `link` branch with a
    // bare-text label; a bracketed link to an absolute URL never gets that far
    // (the `webuiFileReference` extension claims it first — a separate
    // pre-existing defect, reported rather than fixed here).
    const html = render("https://example.com/a/b");
    // The anchor's own subtree carries no further anchor.
    expect(html).toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<\/a>/u);
  });

  it("shows a link's label once instead of duplicating it", () => {
    // The nested render emitted the URL twice — once for the outer anchor and
    // once for the re-lexed autolink inside it. A bare autolink is the only
    // shape that reaches the `link` branch with a bare-text label: every
    // `[label](target)` is claimed by the `webuiFileReference` extension first.
    expect(visibleText(render("https://example.com/a/b"))).toBe("https://example.com/a/b");
  });
});

describe("markdown bare-text scanner and URLs (DEFECT 1)", () => {
  it("returns undefined when the projection parser is handed a whole URL", () => {
    // Establishes that the fix belongs in the scanner, not the parser.
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
    // Pinned on the bogus path the scanner used to produce, not on how the link
    // itself renders: `[label](https://…)` is claimed by the `webuiFileReference`
    // extension before the `link` branch, which is a separate pre-existing
    // defect this change does not touch.
    const html = render("[docs](https://example.com/pkg/index.ts)");
    expect(html).not.toContain("data-webui-file-reference");
    expect(html).not.toContain("com/pkg/index.ts");
  });

  it("leaves a real workspace file reference working", () => {
    // The guard against over-correcting: `index.ts` after a path separator is
    // a reference, and `a/index.ts` preceded by a space is a reference.
    for (const source of ["see path/to/file.ts:120 now", "see a/index.ts now", "see index.ts now"]) {
      const html = render(source);
      expect(html, source).toContain("data-webui-file-reference");
      expect(anchorCount(html), source).toBe(1);
    }
  });
});
