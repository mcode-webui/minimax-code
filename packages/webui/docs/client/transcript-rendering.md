# Transcript rendering contracts

What the transcript's markdown renderer guarantees. The implementation is
`client/features/transcript/ui/markdown.tsx`; each contract below names the test that pins it.

## Code fences

| Rule | Detail |
| --- | --- |
| Highlighting | A fence whose language is registered with the local `highlight.js/lib/core` is rendered with hljs markup (the `hljs-*` class on `<code>`). A fence whose language is unknown, absent or empty takes the plain `<pre><code>` path. |
| No extra dependency | The renderer reuses the `highlight.js/lib/core` registration and the per-language imports the file already declares; the full `highlight.js` bundle is never imported. |
| Illegal syntax is tolerated | `ignoreIllegals: true`, so a fence tagged `ts` containing prose does not throw and does not drop characters. |
| Text is preserved | Highlighting wraps the text and never changes it: stripping the markup recovers the fence body exactly. |
| Fence labels | A fence title (```` ```ts title="a.ts" ````) renders as a label; `marked` keeps the text after the backticks, so the label is parsed rather than re-lexed. |

Pinned by `test/unit/markdown-codeblock-c1-highlight.test.tsx`, `test/unit/transcript-fences.test.ts`.

## Line-number gutter

- A fence with **two or more** lines renders a gutter numbered `1..N`, one entry per line, in document
  order.
- A fence whose body is empty or whitespace-only renders no gutter, and neither does a single-line
  fence — including a one-line body that ends without a newline.
- The gutter is a sibling of the `<pre>`, not inside it, so copying the code block does not copy the
  numbers, and it does not scroll horizontally with the code.
- The gutter is independent of highlighting: plain-path fences get one too.

Pinned by `test/unit/markdown-codeblock-c2-line-numbers.test.tsx`.

## File and line references

- File references are recognized in explicit Markdown links and inline-code spans; ordinary prose is
  not scanned for path-shaped substrings.
- An inline-code span renders as a file reference when it contains a path with a filename extension,
  or a bare filename with a Desktop-supported extension. A bare code identifier such as
  `UserTypeEnum` or `schema.table_name` remains code.
- A reference of the form `` `path/to/file.ts:120` `` renders as a clickable anchor carrying the
  line number, not as literal text.
- Clicking it invokes `onOpenFile` with the parsed reference.
- A bare `` `file.ts` `` with no line number is still a valid reference.
- A string that merely contains a colon is not turned into a reference.

The parser is `parseWebuiMessageFileReference`; the anchors are produced by `fileReferenceAnchor` in
the same module. Pinned by `test/unit/transcript-file-anchor-anchors.test.tsx`,
`test/unit/markdown-autolink-double-anchor.test.tsx`.

## Math

`$…$` and `$$…$$` are tokenized by `marked` and rendered with `katex.renderToString`. The renderer
never scans the DOM for math, and `katex/contrib/auto-render` must not be introduced. The KaTeX
stylesheet and fonts arrive through the single compiled stylesheet — see
[`../design/design-language.md`](../design/design-language.md).

## Out of scope here

Tables, turn navigation, tool cards, retry affordances and message shapes have their own suites
(`transcript-shape.test.ts`, `transcript-retry-*.test.tsx`,
`webui-transcript-widgets-integration.test.ts`). Stream/frame semantics — including what a stop does
to already-received frames — are the conversation substrate's contract; see
[`ownership.md`](ownership.md).
