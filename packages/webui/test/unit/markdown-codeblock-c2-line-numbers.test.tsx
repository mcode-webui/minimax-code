// C-2 — code fence line numbers in the transcript renderer.
//
// The contract is SPEC-C `docs/SPEC-C-transcript.md`, items C-2.1 through
// C-2.5. Two of them are load-bearing for the copy behaviour: the gutter is a
// sibling of `<pre>`, not a descendant (C-2.2), and it appears whether or not
// the fence is highlighted (C-2.4, "C-1 and C-2 are independent").

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WebuiMarkdown } from "../../src/client/markdown.js";

function render(source: string): string {
  return renderToStaticMarkup(createElement(WebuiMarkdown, { source }));
}

/** The numbers rendered by the gutter, in document order. */
function gutterEntries(markup: string): string[] {
  const start = markup.indexOf('class="webui-code-gutter"');
  if (start < 0) return [];
  const end = markup.indexOf("</ol>", start);
  return [...markup.slice(start, end).matchAll(/<li>(\d+)<\/li>/gu)].map((entry) => entry[1] ?? "");
}

function preSlice(markup: string): string {
  const start = markup.indexOf("<pre>");
  return markup.slice(start, markup.indexOf("</pre>", start));
}

/** Drop the highlighting spans so only the text a copy would carry remains. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&amp;/gu, "&");
}

describe("markdown code fence line numbers (C-2)", () => {
  it("numbers every line of a multi-line fence, 1..N in document order", () => {
    const markup = render("```ts\nconst a = 1;\nconst b = 2;\nreturn a + b;\n```");
    expect(gutterEntries(markup)).toEqual(["1", "2", "3"]);
  });

  it("puts the gutter beside the pre so a copied block carries no line numbers", () => {
    const code = "const a = 1;\nreturn a;";
    const markup = render(`\`\`\`ts\n${code}\n\`\`\``);
    const gutter = markup.indexOf('class="webui-code-gutter"');
    const pre = markup.indexOf("<pre>");
    expect(gutter).toBeGreaterThan(-1);
    // A sibling: the gutter is emitted before the pre, and selecting the
    // pre's own subtree yields the code text with nothing else in it.
    expect(gutter).toBeLessThan(pre);
    expect(preSlice(markup)).not.toContain("webui-code-gutter");
    expect(stripTags(preSlice(markup))).toBe(code);
  });

  it("marks the numbered variant so the layout can pin the gutter", () => {
    const markup = render("```ts\nconst a = 1;\nreturn a;\n```");
    expect(markup).toContain('class="webui-code-block webui-code-block--numbered"');
  });

  it("numbers a plain fence that gets no highlighting", () => {
    const markup = render("```\nfirst\nsecond\nthird\n```");
    expect(markup).not.toContain("hljs");
    expect(gutterEntries(markup)).toEqual(["1", "2", "3"]);
  });

  it("numbers a highlighted fence as well", () => {
    const markup = render("```ts\nconst a = 1;\nreturn a;\n```");
    expect(markup).toContain("hljs");
    expect(gutterEntries(markup)).toEqual(["1", "2"]);
  });

  it("renders no gutter for an empty fence", () => {
    const markup = render("```ts\n```");
    expect(gutterEntries(markup)).toEqual([]);
    expect(markup).not.toContain("webui-code-gutter");
  });

  it("renders no gutter for a whitespace-only fence", () => {
    const markup = render("```ts\n   \n```");
    expect(gutterEntries(markup)).toEqual([]);
    expect(markup).not.toContain("webui-code-gutter");
  });

  it("renders no gutter for a one-line fence that ends without a newline", () => {
    const markup = render("```ts\nsingle line, never terminated");
    expect(stripTags(preSlice(markup))).toContain("single line, never terminated");
    expect(gutterEntries(markup)).toEqual([]);
    expect(markup).not.toContain("webui-code-gutter");
  });

  it("counts the lines of a fence whose last line has no trailing newline", () => {
    const markup = render("```ts\nfirst\nsecond");
    expect(gutterEntries(markup)).toEqual(["1", "2"]);
  });
});
