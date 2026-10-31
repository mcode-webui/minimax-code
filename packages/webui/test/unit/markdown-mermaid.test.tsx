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

import { WebuiMarkdown } from "../../src/client/features/transcript/ui/markdown.public.js";
import {
  isWebuiMermaidFence,
  readWebuiDocumentTheme,
  renderWebuiMermaidSvg,
  sanitizeWebuiMermaidSvg,
  WebuiMermaidBlock,
  type WebuiMermaidState,
} from "../../src/client/features/transcript/ui/webui-mermaid.js";
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

  it("rejects a body that references a remote image, without touching the library", async () => {
    // `@{img: 'https://…'}` makes the real library fetch the image over the
    // network mid-render (the request leaves the page before `render`
    // settles), and `iconify:` does the same through its icon loader. A
    // diagram body is model output, so the render must end before it starts
    // — this path is the plain-fence fallback, same as any other refusal.
    for (const body of [
      "graph TD;\n  A@{img: 'https://evil.example/logo.png'} --> B;",
      'graph TD;\n  A@{img: "iconify:mdi:account"} --> B;',
    ]) {
      await expect(renderWebuiMermaidSvg(body)).rejects.toThrow(/remote image/iu);
    }
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("draws a self-contained data-URI image", async () => {
    // `data:` URIs carry their bytes with them and draw offline — the guard
    // above must not take the one image form that never touches the network.
    renderMock.mockResolvedValue({ svg: '<svg id="webui-mermaid-2"><g></g></svg>' } as never);
    await expect(
      renderWebuiMermaidSvg("graph TD;\n  A@{img: 'data:image/svg+xml;base64,PHN2Zw=='} --> B;"),
    ).resolves.toContain("<svg");
    expect(renderMock).toHaveBeenCalled();
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

describe("the SVG that reaches the DOM", () => {
  /* The diagram body is model output — it can carry whatever the model read —
     and the rendered SVG is injected with `dangerouslySetInnerHTML`. Mermaid
     runs in `securityLevel: "strict"`, which is the primary control; this
     filter is the second layer, and these cases are what make it a property
     of the component rather than of the library version. */
  it("strips scripts, event handlers and script-ish URLs", () => {
    const hostile = [
      '<svg><script>fetch("https://example.invalid")</script>',
      '<g onload="fetch(1)" onclick=\'fetch(2)\'>',
      '<a href="javascript:fetch(3)">x</a>',
      '<image xlink:href="javascript:fetch(4)"/>',
      "</svg>",
    ].join("");
    const clean = sanitizeWebuiMermaidSvg(hostile);
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("javascript:");
    // The drawing itself survives — the filter is not a nuke.
    expect(clean).toContain("<svg");
  });

  it("strips foreign documents, which can carry arbitrary HTML", () => {
    const withForeign = '<svg><foreignObject><body onload="x()"><script>y()</script></body></foreignObject><g/></svg>';
    const clean = sanitizeWebuiMermaidSvg(withForeign);
    expect(clean).not.toContain("foreignObject");
    expect(clean).not.toContain("<script");
    expect(clean).toContain("<g/>");
  });

  it("neutralises CSS imports and off-page url() references, keeping fragment refs and data images", () => {
    // The `<style>` element is kept (it carries the diagram's class CSS);
    // these rules are its backstop. Fragment refs (`url(#…)` — the arrowhead
    // markers) and data: images are drawing, not fetches, and must survive.
    const styled = [
      "<svg><style>",
      ".edge { fill: red; }",
      '@import url("https://evil.example/i.css");',
      ".x { background: url(https://evil.example/b.png); }",
      '.y { background: url("//evil.example/p.png"); }',
      ".marker { fill: url(#arrow); }",
      '.z { background: url("data:image/svg+xml;base64,PHN2Zw=="); }',
      "</style></svg>",
    ].join("");
    const clean = sanitizeWebuiMermaidSvg(styled);
    expect(clean).not.toContain("@import");
    expect(clean).not.toContain("evil.example");
    expect(clean).toContain(".edge { fill: red; }");
    expect(clean).toContain("url(#arrow)");
    expect(clean).toContain("data:image/svg+xml;base64,PHN2Zw==");
  });

  it("leaves an ordinary diagram untouched", () => {
    const plain = '<svg class="flowchart" viewBox="0 0 10 10"><g class="node"><text>开始</text></g></svg>';
    expect(sanitizeWebuiMermaidSvg(plain)).toBe(plain);
  });
});

describe("the theme the diagram is drawn with", () => {
  it("takes the theme from the injected adapter, and light when it cannot", () => {
    // The adapter is the only way in — the dependency rules confine the
    // ambient document to the platform layer, so the component reads the
    // theme through it. The fallback is what keeps a server render (or a
    // test) from throwing; the DOM path itself is covered by the browser
    // case, which draws the same diagram under both themes.
    expect(readWebuiDocumentTheme(() => "dark")).toBe("dark");
    expect(readWebuiDocumentTheme(() => "light")).toBe("light");
    expect(
      readWebuiDocumentTheme(() => {
        throw new Error("no document");
      }),
    ).toBe("light");
  });
});
