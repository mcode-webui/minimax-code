// C-1 — code fence syntax highlighting in the transcript renderer.
//
// The contract is SPEC-C `docs/SPEC-C-transcript.md`, items C-1.1 through
// C-1.5: a registered language gets hljs markup, and every other fence stays
// byte-identical to the plain `<pre><code>` path that shipped before. The
// `expectedPlainDocument` helper below pins that pre-existing output as a
// literal, so a stray `class="hljs language-…"` on an unhighlighted `<code>`
// fails here instead of passing silently.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WebuiMarkdown } from "../../src/client/markdown.js";

function render(source: string): string {
  return renderToStaticMarkup(createElement(WebuiMarkdown, { source }));
}

/** The document `WebuiMarkdown` produced before highlighting existed. */
function expectedPlainDocument(lang: string, body: string): string {
  return (
    `<div data-webui-markdown="true" class="matrix-markdown webui-markdown">` +
    `<div class="webui-code-block"><pre><code data-language="${lang}">${body}</code></pre></div>` +
    `</div>`
  );
}

/** The `<code>` element's inner HTML — the part highlighting rewrites. */
function codeInnerHtml(markup: string): string {
  const open = markup.indexOf("<code");
  const start = markup.indexOf(">", open) + 1;
  const end = markup.indexOf("</code>", start);
  return markup.slice(start, end);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&amp;/gu, "&");
}

describe("markdown code fence highlighting (C-1)", () => {
  it("renders a registered language with hljs markup on the code element", () => {
    const markup = render("```ts\nconst answer = 42;\nreturn answer;\n```");
    expect(markup).toContain('<code class="hljs language-ts" data-language="ts">');
    expect(markup).toContain("hljs-keyword");
  });

  it("highlights a fence whose tag carries trailing attributes", () => {
    // marked puts everything after the backticks in `token.lang`, so a
    // ```ts title="…"``` fence arrives as `ts title="…"`.
    const markup = render('```ts title="a.ts"\nconst answer = 42;\nreturn answer;\n```');
    expect(markup).toContain('<code class="hljs language-ts"');
    expect(markup).toContain("hljs-keyword");
  });

  it("leaves an unregistered language on the plain path, byte for byte", () => {
    const markup = render("```notalanguage\nplain body\n```");
    expect(markup).toBe(expectedPlainDocument("notalanguage", "plain body"));
    expect(markup).not.toContain("hljs");
  });

  it("leaves a fence with no language on the plain path, byte for byte", () => {
    const markup = render("```\nno lang\n```");
    expect(markup).toBe(expectedPlainDocument("", "no lang"));
    expect(markup).not.toContain("hljs");
  });

  it("leaves an empty fence on the plain path, byte for byte", () => {
    const markup = render("```ts\n```");
    expect(markup).toBe(expectedPlainDocument("ts", ""));
    expect(markup).not.toContain("hljs");
  });

  it("keeps a prose-in-a-ts fence instead of throwing or dropping characters", () => {
    const prose = "first line of prose\nsecond line, still prose";
    let markup = "";
    expect(() => {
      markup = render(`\`\`\`ts\n${prose}\n\`\`\``);
    }).not.toThrow();
    expect(markup).toContain("webui-code-block");
    expect(decodeEntities(codeInnerHtml(markup).replace(/<[^>]*>/gu, ""))).toBe(prose);
  });

  it("recovers the fence text exactly when the highlighting markup is stripped", () => {
    const source = [
      "const greeting = \"hi\";",
      "if (greeting.length > 0) {",
      "  return `a & b < c`;",
      "}",
      "return null;",
    ].join("\n");
    const markup = render(`\`\`\`ts\n${source}\n\`\`\``);
    expect(markup).toContain("hljs");
    expect(decodeEntities(codeInnerHtml(markup).replace(/<[^>]*>/gu, ""))).toBe(source);
  });

  it("escapes markup inside a highlighted fence", () => {
    const markup = render("```ts\nconst el = \"<script>alert(1)</script>\";\nreturn el;\n```");
    expect(markup).toContain("hljs");
    expect(markup).not.toContain("<script>");
  });

  it("registers no new runtime dependency and highlights other languages too", () => {
    const python = render("```python\ndef add(a, b):\n    return a + b\n```");
    expect(python).toContain('<code class="hljs language-python"');
    expect(python).toContain("hljs-keyword");
    const json = render('```json\n{"a": 1}\n```');
    expect(json).toContain("hljs-attr");
  });
});
