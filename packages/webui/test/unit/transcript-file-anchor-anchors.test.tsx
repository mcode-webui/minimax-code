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
// `renderToStaticMarkup` drops event handlers, so clause 2 walks the returned
// React element tree directly and calls the anchor's own `onClick` — the suite
// runs in the `node` environment and this package has no jsdom/happy-dom.

import { describe, it, expect } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiMarkdown } from "../../src/client/markdown.js";
import {
  parseWebuiMessageFileReference,
  type WebuiMessageFileReference,
} from "../../src/client/projection/message-file-reference.js";

function render(source: string, onOpenFile?: (reference: WebuiMessageFileReference) => void): string {
  return renderToStaticMarkup(createElement(WebuiMarkdown, { source, onOpenFile }));
}

/** Visible text only — attribute values such as `href` must not count as text. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/gu, "");
}

function collectElements(node: ReactNode, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child as ReactNode, found);
    return found;
  }
  if (isValidElement(node)) {
    found.push(node);
    const props = node.props as { readonly children?: ReactNode } | null;
    if (props && "children" in props) collectElements(props.children, found);
  }
  return found;
}

/** Clicks every rendered file anchor and reports what the callback received. */
function clickFileAnchors(source: string): {
  readonly references: WebuiMessageFileReference[];
  readonly anchors: number;
  readonly defaultPrevented: boolean;
} {
  const references: WebuiMessageFileReference[] = [];
  let defaultPrevented = false;
  const tree = WebuiMarkdown({
    source,
    onOpenFile: (reference) => {
      references.push(reference);
    },
  });
  const anchors = collectElements(tree).filter(
    (element) =>
      element.type === "a" &&
      typeof (element.props as { readonly onClick?: unknown } | null)?.onClick === "function",
  );
  for (const anchor of anchors) {
    const onClick = (anchor.props as { readonly onClick: (event: unknown) => void }).onClick;
    onClick({
      preventDefault: () => {
        defaultPrevented = true;
      },
    });
  }
  return { references, anchors: anchors.length, defaultPrevented };
}

describe("SPEC-C C-5 transcript file/line anchors", () => {
  it("renders path/to/file.ts:120 as a clickable anchor carrying the line number, not literal text", () => {
    const html = render("See path/to/file.ts:120 for the failing case.", () => undefined);

    // A real anchor, marked as a file reference, with the line number attached.
    expect(html).toContain('class="webui-message-file-link"');
    expect(html).toContain('data-webui-file-reference="path/to/file.ts"');
    expect(html).toContain('href="path/to/file.ts:120"');
    expect(html.match(/<a\b/gu)).toHaveLength(1);

    // The line number is not left in the prose: the anchor labels the basename
    // and the surrounding sentence is untouched.
    const text = visibleText(html);
    expect(text).toBe("See 📘file.ts for the failing case.");
    expect(text).not.toContain("path/to/file.ts");
    expect(text).not.toContain(":120");
  });

  it("invokes onOpenFile with the parsed reference when the anchor is clicked", () => {
    const { references, anchors, defaultPrevented } = clickFileAnchors(
      "See path/to/file.ts:120 for the failing case.",
    );

    expect(anchors).toBe(1);
    expect(references).toEqual([{ path: "path/to/file.ts", lineStart: 120 }]);
    // The click is intercepted, so the browser never navigates to the href.
    expect(defaultPrevented).toBe(true);
  });

  it("keeps a bare file.ts without a line number a valid reference", () => {
    // The projection accepts it …
    expect(parseWebuiMessageFileReference("file.ts")).toEqual({ path: "file.ts" });
    // … and the renderer turns it into an anchor, not a plain string.
    const html = render("file.ts", () => undefined);
    expect(html).toContain('class="webui-message-file-link"');
    expect(html).toContain('data-webui-file-reference="file.ts"');
    expect(html).toContain('href="file.ts"');

    const { references, anchors } = clickFileAnchors("file.ts");
    expect(anchors).toBe(1);
    expect(references).toEqual([{ path: "file.ts" }]);
    expect(references[0]).not.toHaveProperty("lineStart");
    expect(references[0]).not.toHaveProperty("lineEnd");
  });

  it("leaves a string that merely contains a colon as plain text", () => {
    // A colon alone is not a reference. Cases deliberately avoid a bare
    // filename: `config.toml` alone *is* a reference by design (clause 3).
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
      expect(clickFileAnchors(source).references, source).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------
  // Two real defects found while verifying C-5. Both lived in
  // `src/client/markdown.tsx`. They were first pinned with `it.fails` so the
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
    expect(clickFileAnchors(source).references).toEqual([]);
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
