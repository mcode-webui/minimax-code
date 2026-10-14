// Mermaid fences in the transcript renderer — the "markdown-图表(mmd)" row of
// SPEC-C's acceptance table.
//
// The row said "通过" while the source had zero Mermaid support; this file
// pins the behaviour that closes it. `markdown-codeblock-c1-highlight.test.tsx`
// and `markdown-codeblock-c2-line-numbers.test.tsx` are the regression
// guardrails for every other fence language — their exact-literal assertions
// on the plain and highlighted paths are what proves a Mermaid fence did not
// disturb them — so this file covers the Mermaid surface itself:
//
//   1. `mermaid` and `mmd` fences (with or without tag attributes, in any
//      case) take the Mermaid branch and produce a `webui-mermaid` container,
//      never a `webui-code-block`.
//   2. An empty body, invalid syntax, a thrown render and a render that
//      outlives the timeout all reject out of `renderWebuiMermaidSvg`, and
//      the failed state renders the plain fence with the original text one
//      character unchanged.
//   3. Other languages stay byte-identical, asserted here against the same
//      literal the pre-Mermaid renderer produced.
//
// On the environment: the webui suite runs in Node with no jsdom, and
// `renderToStaticMarkup` renders once without running effects. So the async
// pipeline is driven directly against a stubbed `mermaid` module, the three
// states are rendered as plain props of `WebuiMermaidBlock`, and the effect
// that wires them together in a browser is covered by
// `test/webui-browser/transcript.spec.mjs` — the same split
// `review-panel.test.tsx` documents for its component.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiMarkdown } from "../../src/client/components/transcript/markdown.js";
import {
  isWebuiMermaidFence,
  renderWebuiMermaidSvg,
  WebuiMermaidBlock,
  type WebuiMermaidState,
} from "../../src/client/components/transcript/webui-mermaid.js";
import mermaid from "mermaid";

// The real library needs a browser; every test below drives the stub. The
// default export is the documented surface (`initialize` + `render`).
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

const renderMock = vi.mocked(mermaid.render);

function render(source: string): string {
  return renderToStaticMarkup(createElement(WebuiMarkdown, { source }));
}

function renderBlock(state: WebuiMermaidState, text: string, lang?: string): string {
  return renderToStaticMarkup(createElement(WebuiMermaidBlock, { state, text, lang }));
}

/** The `<code>` element's inner HTML — the part a fallback must preserve. */
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

/** The document `WebuiMarkdown` produced for a plain fence before Mermaid existed. */
function expectedPlainDocument(lang: string, body: string): string {
  return (
    `<div data-webui-markdown="true" class="matrix-markdown webui-markdown">` +
    `<div class="webui-code-block"><pre><code data-language="${lang}">${body}</code></pre></div>` +
    `</div>`
  );
}

afterEach(() => {
  renderMock.mockReset();
});

describe("which fences take the Mermaid branch", () => {
  it("recognises mermaid and mmd in any letter case", () => {
    expect(isWebuiMermaidFence("mermaid")).toBe(true);
    expect(isWebuiMermaidFence("mmd")).toBe(true);
    expect(isWebuiMermaidFence("Mermaid")).toBe(true);
    expect(isWebuiMermaidFence("MMD")).toBe(true);
  });

  it("recognises a tag whose attributes were stripped to its first word", () => {
    // marked puts everything after the backticks in `token.lang`, so
    // ```mermaid title="a.mmd"``` arrives here as the bare language word.
    expect(isWebuiMermaidFence("mermaid")).toBe(true);
  });

  it("leaves every other fence language alone", () => {
    expect(isWebuiMermaidFence("ts")).toBe(false);
    expect(isWebuiMermaidFence("math")).toBe(false);
    expect(isWebuiMermaidFence("notalanguage")).toBe(false);
    expect(isWebuiMermaidFence(undefined)).toBe(false);
  });
});

describe("renderWebuiMermaidSvg", () => {
  it("returns the library's SVG for a valid diagram", async () => {
    renderMock.mockResolvedValue({ svg: '<svg id="webui-mermaid-1"><g></g></svg>' } as never);
    await expect(renderWebuiMermaidSvg("graph TD; A-->B;")).resolves.toContain("<svg");
  });

  it("rejects an empty body without touching the library", async () => {
    await expect(renderWebuiMermaidSvg("")).rejects.toThrow(/empty/iu);
    await expect(renderWebuiMermaidSvg("   \n  \n")).rejects.toThrow(/empty/iu);
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("rejects invalid syntax", async () => {
    renderMock.mockRejectedValue(new Error("Parse error"));
    await expect(renderWebuiMermaidSvg("this is not a diagram @@")).rejects.toThrow(/Parse error/iu);
  });

  it("rejects a render that outlives the timeout", async () => {
    // A real clock with an injected budget: faking timers here would put the
    // rejection inside a timer-advance window, which Vitest reports as an
    // unhandled rejection even though the assertion passes.
    renderMock.mockImplementation(() => new Promise(() => {}) as never);
    await expect(
      renderWebuiMermaidSvg("graph TD; A-->B;", { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/iu);
  });
});

describe("WebuiMermaidBlock", () => {
  const body = "graph TD; A-->B;";

  it("shows the container and the raw diagram while pending, with no code block", () => {
    const markup = renderBlock({ status: "pending" }, body, "mermaid");
    expect(markup).toContain('class="webui-mermaid"');
    expect(markup).toContain('data-webui-mermaid-state="pending"');
    expect(markup).not.toContain("webui-code-block");
    // The pending state carries the diagram source, escaped like any text node.
    expect(decodeEntities(markup.replace(/<[^>]*>/gu, ""))).toBe(body);
  });

  it("injects the library's SVG once rendered", () => {
    const markup = renderBlock({ status: "rendered", svg: '<svg id="d1"><g></g></svg>' }, body, "mermaid");
    expect(markup).toContain('class="webui-mermaid"');
    expect(markup).toContain('data-webui-mermaid-state="rendered"');
    expect(markup).toContain('<svg id="d1">');
  });

  it("falls back to the plain fence, one character unchanged, with no gutter", () => {
    const markup = renderBlock({ status: "failed" }, body, "mermaid");
    expect(markup).toContain('class="webui-code-block"');
    expect(markup).not.toContain("webui-code-block--numbered");
    expect(markup).not.toContain("webui-code-gutter");
    expect(decodeEntities(codeInnerHtml(markup))).toBe(body);
  });

  it("keeps markup-bearing diagram text exact through the fallback", () => {
    const tricky = "graph TD; A-->B; Note[\"a & b < c\"];";
    const markup = renderBlock({ status: "failed" }, tricky, "mermaid");
    // The raw substring must not survive unescaped anywhere in the markup.
    expect(markup).not.toContain('a & b < c');
    expect(decodeEntities(codeInnerHtml(markup))).toBe(tricky);
  });

  it("carries the fence tag, attributes included, as the code element's language", () => {
    const markup = renderBlock({ status: "failed" }, body, 'mermaid title="a.mmd"');
    expect(markup).toContain('data-language="mermaid title=&quot;a.mmd&quot;"');
  });
});

describe("WebuiMarkdown renders a Mermaid fence", () => {
  const body = "graph TD; A-->B;";

  it("produces the webui-mermaid container and no code block", () => {
    const markup = render(`\`\`\`mermaid\n${body}\n\`\`\``);
    expect(markup).toContain('class="webui-mermaid"');
    expect(markup).not.toContain("webui-code-block");
  });

  it("recognises the mmd alias and a tag carrying attributes", () => {
    for (const tag of ["mmd", 'mermaid title="a.mmd"', "MERMAID"]) {
      const markup = render(`\`\`\`${tag}\n${body}\n\`\`\``);
      expect(markup, tag).toContain('class="webui-mermaid"');
      expect(markup, tag).not.toContain("webui-code-block");
    }
  });

  it("does not crash on an empty fence", () => {
    let markup = "";
    expect(() => {
      markup = render("```mermaid\n```");
    }).not.toThrow();
    expect(markup).toContain('class="webui-mermaid"');
  });

  it("does not crash on a single-line fence", () => {
    let markup = "";
    expect(() => {
      markup = render("```mermaid\ngraph TD;A-->B;\n```");
    }).not.toThrow();
    expect(markup).toContain('class="webui-mermaid"');
    expect(decodeEntities(markup.replace(/<[^>]*>/gu, ""))).toContain("graph TD;A-->B;");
  });
});

describe("every other fence language is untouched", () => {
  it("keeps the plain path byte for byte", () => {
    expect(render("```notalanguage\nplain body\n```")).toBe(expectedPlainDocument("notalanguage", "plain body"));
    expect(render("```\nno lang\n```")).toBe(expectedPlainDocument("", "no lang"));
    expect(render("```ts\n```")).toBe(expectedPlainDocument("ts", ""));
  });

  it("keeps the highlighted path's shape and text for registered languages", () => {
    // The C-1 suite pins these literals against the pre-Mermaid renderer;
    // this is the same contract restated so a Mermaid-side regression fails
    // here too.
    const cases: readonly [string, string][] = [
      ["ts", "const answer = 42;"],
      ["python", "print('hi')"],
      ["bash", "echo hi"],
    ];
    for (const [lang, body] of cases) {
      const markup = render(`\`\`\`${lang}\n${body}\n\`\`\``);
      expect(markup, lang).toContain(`<code class="hljs language-${lang}" data-language="${lang}">`);
      expect(markup, lang).not.toContain("webui-mermaid");
      expect(decodeEntities(codeInnerHtml(markup).replace(/<[^>]*>/gu, "")), lang).toBe(body);
    }
  });
});
