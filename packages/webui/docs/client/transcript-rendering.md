# Transcript rendering contracts

What the transcript's markdown renderer guarantees. The implementation is
`client/features/transcript/ui/markdown.public.tsx`; each contract below names the test that pins it.

## Message content and settlement

`projection/transcript-view-model.ts` returns the final user/assistant/questionnaire groups and
activity placement for both stream and historical content. Ordered message parts are projected once
for each changed message. `SessionTranscript` renders those groups; history handoff and retries belong
to the application settlement owner described in [`ownership.md`](ownership.md).

Delivered files remain visible when a completed turn's process disclosure folds. An expanded process
shows them in its ordered activity; a collapsed process keeps the delivered content beside the final
answer. No duplicate file row is rendered. Content retention and media loading are separate: retaining
a file reference does not prove its bytes are available.

Pinned by `test/unit/transcript-fences.test.ts`, `test/unit/transcript-settled-turn.test.ts`,
`test/unit/transcript-shape.test.ts`, and `test/browser/transcript-file-media.spec.mjs`.

## Workspace media

Workspace file references and delivered-file rows share the same inline media reader. Images
(including SVG and PNG), supported video and audio files render their contents in the transcript;
video and audio use native controls without autoplay. Markdown image syntax and recognized bare
media filenames in inline code use the same workspace resource path. Non-media files keep links.
Remote HTTP(S) media are not automatically previewed. Explicit absolute local paths also work
outside the session workspace: the file tab and authenticated media URL use the named file's
containing directory as their read root. Relative traversal paths remain invalid.

Delivered-file rows keep their icon and display name together, including when a reference cannot
be opened. The icon type comes from the source filename, independently of a human-readable caption.

The host serves actual workspace bytes with byte-range support. A transient media load failure
retries a bounded number of times; content synchronization and media-byte availability remain
independent. A tree root can supply the selected workspace even if the current flat page omits it,
and a newly created external session triggers an authoritative catalogue reload.

Pinned by `test/unit/transcript-file-anchor-anchors.test.tsx`, `test/unit/webui-session-catalog.test.ts`,
`test/browser/transcript-file-media.spec.mjs` and the production-runtime client scenarios in
`test/integration/agent-transcript.test.ts`.

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
  or a bare filename with a supported extension. A bare code identifier such as
  `UserTypeEnum` or `schema.table_name` remains code.
- A reference of the form `` `path/to/file.ts:120` `` renders as a clickable anchor carrying the
  line number, not as literal text.
- Clicking it invokes `onOpenFile` with the parsed reference.
- Absolute local references outside the workspace retain their absolute identity until the file
  tab or media URL splits them into directory and filename. Existing workspace-relative references
  keep their original meaning.
- If a relative path with directories is absent, the runtime adapter may complete a unique,
  segment-aligned suffix from workspace search. Ambiguous or truncated search results do not pick
  a file. Bare-filename references retain their existing workspace search behavior.
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
