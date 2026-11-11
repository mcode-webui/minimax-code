// SPEC-C item C-5 — transcript file/line anchors.
//
// `workspace-panel-state.test.ts` already covers the projection parser and the
// presence of `data-webui-file-reference` in rendered markup. What is missing
// there, and what this file pins down, is the four clauses the spec actually
// asks for:
//   1. `path/to/file.ts:120` renders as a clickable anchor carrying the line
//      number, not as literal text.
//   2. Clicking it invokes `onOpenFile` with the parsed reference.
//   3. A bare `file.ts` with no line number is still a valid reference.
//   4. A string that merely contains a colon is not turned into a reference.
//
// `renderToStaticMarkup` drops event handlers, so clause 2 is pinned in two
// halves: what the anchor carries comes from the markup, and the click wiring
// comes from the component's own source — the suite runs in the `node`
// environment and this package has no jsdom/happy-dom.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiMarkdown, WebuiWorkspaceFileUrlProvider, webuiInlineMediaKind } from "../../src/client/features/transcript/ui/markdown.public.js";
import {
  parseWebuiMessageFileReference,
  type WebuiMessageFileReference,
} from "../../src/client/features/transcript/projection/message-file-reference.js";

function render(source: string, onOpenFile?: (reference: WebuiMessageFileReference) => void): string {
  return renderToStaticMarkup(createElement(WebuiMarkdown, { source, onOpenFile }));
}

/** Visible text only — attribute values such as `href` must not count as text. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/gu, "");
}

/**
 * The references the rendered anchors carry: the path from
 * `data-webui-file-reference` and the line from the anchor's own `href`.
 *
 * `WebuiMarkdown` is a `memo(...)` wrapper around a view that uses hooks, so it
 * can no longer be called as a plain function, and `renderToStaticMarkup` drops
 * event handlers. The payload the anchor carries is therefore read from the
 * markup — which is the observable outcome — and the click wiring is pinned
 * from the source below.
 */
function anchorsIn(html: string): WebuiMessageFileReference[] {
  return [...html.matchAll(/<a\b[^>]*>/gu)].flatMap(([tag]) => {
    const path = tag.match(/data-webui-file-reference="([^"]+)"/u)?.[1];
    if (path === undefined) return [];
    const line = /:(\d+)$/u.exec(tag.match(/href="([^"]+)"/u)?.[1] ?? "")?.[1];
    return [line === undefined ? { path } : { path, lineStart: Number(line) }];
  });
}

/** The component's own click wiring, which a server render cannot exercise. */
const markdownSource = readFileSync(
  new URL("../../src/client/features/transcript/ui/markdown.public.tsx", import.meta.url),
  "utf8",
);

describe("SPEC-C C-5 transcript file/line anchors", () => {
  it("retains an absolute file outside the workspace, including its line target", () => {
    expect(parseWebuiMessageFileReference("/artifacts/design.md:12", "/repo")).toEqual({ path: "/artifacts/design.md", lineStart: 12 });
    expect(parseWebuiMessageFileReference("C:/artifacts/design.md", "C:/repo")).toEqual({ path: "C:/artifacts/design.md" });
    expect(parseWebuiMessageFileReference("/artifacts/../secret.md", "/repo")).toBeUndefined();
    expect(render("[Design](/artifacts/design.md:12)", () => undefined)).toContain('data-webui-file-reference="/artifacts/design.md"');
    expect(render("[Design](C:/artifacts/design.md)", () => undefined)).toContain('data-webui-file-reference="C:/artifacts/design.md"');
  });
  it("renders a recognized inline-code path with a line number as a clickable file reference", () => {
    const html = render("See `path/to/file.ts:120` for the failing case.", () => undefined);

    // A real anchor, marked as a file reference, with the line number attached.
    expect(html).toContain('class="webui-message-file-link"');
    expect(html).toContain('data-webui-file-reference="path/to/file.ts"');
    expect(html).toContain('href="path/to/file.ts:120"');
    expect(html.match(/<a\b/gu)).toHaveLength(1);

    // The line number is not left in the prose: the anchor labels the basename
    // and the surrounding sentence is untouched.
    // The glyph is an SVG, so it contributes no text: what the reader sees in
    // the sentence is the label alone.
    expect(visibleText(html)).toBe("See file.ts for the failing case.");
    expect(html).toContain("tabler-icon-file-type-ts");
  });

  it("carries the parsed reference on the anchor and intercepts the click", () => {
    const html = render("See `path/to/file.ts:120` for the failing case.", () => undefined);

    expect(anchorsIn(html)).toEqual([{ path: "path/to/file.ts", lineStart: 120 }]);
    // A click must not navigate: the component stops it and hands the parsed
    // reference to the caller.
    expect(markdownSource).toContain("event.preventDefault(); onOpenFile(reference);");
  });

  it("keeps a recognized bare filename in inline code as a valid reference", () => {
    expect(parseWebuiMessageFileReference("file.ts")).toEqual({ path: "file.ts" });
    const html = render("`file.ts`", () => undefined);
    expect(html).toContain('class="webui-message-file-link"');
    expect(html).toContain('data-webui-file-reference="file.ts"');
    expect(html).toContain('href="file.ts"');

    const references = anchorsIn(render("`file.ts`", () => undefined));
    expect(references).toEqual([{ path: "file.ts" }]);
    expect(references[0]).not.toHaveProperty("lineStart");
    expect(references[0]).not.toHaveProperty("lineEnd");
  });

  it("does not promote dotted identifiers or unrecognized bare extensions from inline code", () => {
    const source = "`zht_user2.sys_user_identity` and `SysUserIdentity.IdentityTypeEnum` and `report.csv`";
    const html = render(source, () => undefined);

    expect(html).not.toContain("data-webui-file-reference");
    expect(html).not.toContain("webui-message-file-link");
    expect(visibleText(html)).toBe("zht_user2.sys_user_identity and SysUserIdentity.IdentityTypeEnum and report.csv");
    expect(anchorsIn(html)).toEqual([]);
  });

  it("does not scan ordinary prose for path-looking text", () => {
    const source = "See path/to/file.ts:120, index.html, and zht_user2.sys_user_identity.";
    const html = render(source, () => undefined);

    expect(html).not.toContain("data-webui-file-reference");
    expect(html).not.toContain("webui-message-file-link");
    expect(visibleText(html)).toBe(source);
  });

  it("leaves a string that merely contains a colon as plain text", () => {
    // A colon alone is not a reference.
    const prose = [
      "The ratio is 3:1 today.",
      "Meeting at 12:30 — bring notes.",
      "Note: this is prose, not a path.",
    ];

    for (const source of prose) {
      const html = render(source, () => undefined);
      expect(html, source).not.toContain("data-webui-file-reference");
      expect(html, source).not.toContain("webui-message-file-link");
      // Nothing is swallowed or rewritten.
      expect(visibleText(html), source).toBe(source);
      expect(anchorsIn(html), source).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------
  // Two real defects found while verifying C-5. Both lived in
  // `src/client/features/transcript/ui/markdown.tsx`. They were first pinned with `it.fails` so the
  // suite stayed green while the bugs were live; both are now fixed, so the
  // assertions below run as ordinary tests and guard the fix.
  //
  // Covered in depth by `markdown-autolink-double-anchor.test.tsx`, which
  // owns the regression coverage for both.
  // ---------------------------------------------------------------------

  // markdown.tsx — the bare-text scanner's lookbehind `(?<![\w/:])` did not
  // exclude a preceding `.`, so the tail of `example.com/pkg/index.ts`
  // matched and opened as the bogus workspace-relative path
  // `com/pkg/index.ts`. The parser is innocent: handed the whole URL it
  // returns undefined (see workspace-panel-state.test.ts:200), but it is
  // never handed the whole URL — the scanner sliced it first. The lookbehind
  // is now `(?<![\w/.:])`.
  it("does not turn the dotted tail of a URL into a file reference", () => {
    const source = "see https://example.com/pkg/index.ts now";
    const html = render(source, () => undefined);
    expect(html).not.toContain("data-webui-file-reference");
    expect(anchorsIn(html)).toEqual([]);
  });

  // markdown.tsx — the `link` branch re-entered `inline()` for the link's own
  // label with `lexBareText` still true, so the label was re-lexed and the
  // autolink was emitted a second time inside itself: <a> inside <a>. The
  // branch now passes `false`, because marked already tokenized the label.
  it("does not nest an anchor inside a rendered Markdown link", () => {
    const html = render("https://example.com/a/b", () => undefined);
    expect(html.match(/<a\b/gu)).toHaveLength(1);
  });
});

// The transcript can now draw the picture or clip a file link points at. The
// bytes are served by the host through `workspaceFileUrl`, which arrives as a
// context value: without one, a link stays a link.
describe("media file links", () => {
  const build = (path: string) => `/workspace/file?path=${encodeURIComponent(path)}`;

  function renderServed(source: string): string {
    return renderToStaticMarkup(
      createElement(WebuiWorkspaceFileUrlProvider, {
        build,
        children: createElement(WebuiMarkdown, { source, onOpenFile: () => undefined }),
      }),
    );
  }

  it("draws a linked image under its own link, the link intact", () => {
    const html = renderServed("See `out/chart.png` for the shape.");
    expect(html).toContain('data-webui-file-media="image"');
    expect(html).toContain(`<img src="${build("out/chart.png")}"`);
    expect(html).toContain('alt="chart.png"');
    expect(html).toContain('data-webui-file-reference="out/chart.png"');
  });

  it("draws an SVG as an image and an MP4 as a control-bearing video", () => {
    expect(renderServed("`assets/logo.svg`")).toContain('data-webui-file-media="image"');
    const clip = renderServed("`out/demo.mp4`");
    expect(clip).toContain('data-webui-file-media="video"');
    expect(clip).toContain("<video");
    expect(clip).toContain("controls");
  });

  it("leaves a source file as a plain link", () => {
    const html = renderServed("`src/main.ts`");
    expect(html).toContain('data-webui-file-reference="src/main.ts"');
    expect(html).not.toContain("data-webui-file-media");
  });

  it("renders a workspace Markdown image through the same media reader", () => {
    const html = renderServed("![A chart](out/chart.png)");
    expect(html).toContain('data-webui-file-media="image"');
    expect(html).toContain(`<img src="${build("out/chart.png")}"`);
  });

  it("recognizes a bare media filename without turning prose identifiers into files", () => {
    expect(renderServed("`flower.svg`")).toContain('data-webui-file-media="image"');
    expect(renderServed("`song.mp3`")).toContain('data-webui-file-media="audio"');
    expect(renderServed("`schema.table_name`")).not.toContain("data-webui-file-media");
  });

  it("never requests remote, traversing or unsafe image references", () => {
    expect(renderServed("![Remote](https://example.invalid/picture.png)")).not.toContain("<img");
    expect(renderServed("![Outside](../picture.png)")).not.toContain("<img");
    expect(renderServed("![Unsafe](javascript:alert(1))")).not.toContain("<img");
  });

  it("renders music as an inline player and recognizes supported audio extensions", () => {
    for (const extension of ["mp3", "wav", "ogg", "m4a", "aac", "flac"]) {
      expect(webuiInlineMediaKind(`out/song.${extension}`)).toBe("audio");
    }
    const html = renderServed("[Music](out/song.wav)");
    expect(html).toContain('data-webui-file-media="audio"');
    expect(html).toContain(`<audio src="${build("out/song.wav")}"`);
    expect(html).toContain("controls");
    expect(html).not.toContain("autoplay");
  });

  it("keeps the link and draws nothing when the reader cannot serve bytes", () => {
    const html = render("See `out/chart.png`.", () => undefined);
    expect(html).toContain('data-webui-file-reference="out/chart.png"');
    expect(html).not.toContain("<img");
  });

  it("decides by the extension, not by a substring of the path", () => {
    expect(webuiInlineMediaKind("out/Photo.JPG")).toBe("image");
    expect(webuiInlineMediaKind("out/clip.webm")).toBe("video");
    expect(webuiInlineMediaKind("src/png-notes.ts")).toBeUndefined();
    expect(webuiInlineMediaKind("out/notes.txt")).toBeUndefined();
    expect(webuiInlineMediaKind("out/no-extension")).toBeUndefined();
  });
});
