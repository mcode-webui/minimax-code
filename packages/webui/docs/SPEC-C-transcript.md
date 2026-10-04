# SPEC-C — Transcript message stream

Baseline: `mcode-webui/minimax-code`, branch `webui`, HEAD `83321d0`
(2026-09-30, Jiaxiaoyuan). This spec covers module C of the roadmap
`mcode-webui-roadmap` (Feishu doc `BBu7dwPTCo5Ryix2MG7ctlAwndg`).

Everything here was established by reading the source at that commit, not by
trusting the roadmap's verdict — two of its five items turned out to be
mis-stated, in both directions.

## Precedence

The roadmap's ✅/🟡/❌/➖ column is a report, not the contract. Where the source
disagrees with the report, the source wins and the report gets corrected. Each
item below says which it is.

---

## C-1 — Code block syntax highlighting

**Roadmap says: ❌ not met.** Confirmed — and cheaper to fix than that implies.

`client/markdown.tsx` renders every fence as

```tsx
<pre><code data-language={token.lang ?? undefined}>{token.text}</code></pre>
```

Plain text, no highlighter, no `hljs` import.

The cost is lower than the report implies: `highlight.js@10.7.3` is **already a
declared dependency of this package**, `components/WorkspacePanels.tsx` already
registers 15 languages against `highlight.js/lib/core`, and the module types are
already declared in `client/global.d.ts`. The roadmap's "依赖缓存 grep 全空" is
wrong for `packages/webui/package.json`; the highlighter exists, it is simply
not wired to the transcript renderer.

### Spec

1. A fence whose language is registered with the local hljs core is rendered
   with hljs markup (the `hljs-*` class on `<code>`).
2. A fence whose language is unknown, absent, or empty falls back to the
   current plain `<pre><code>` output — **byte-identical to today's output**.
3. `ignoreIllegals: true`, so a fence tagged `ts` containing prose does not
   throw and does not drop characters.
4. No new dependency. Reuse the `highlight.js/lib/core` + per-language
   registration already proven in `WorkspacePanels.tsx`; do not import the full
   `highlight.js` bundle.
5. Highlighting must not change the text content — only wrap it. Stripping the
   markup must recover `token.text` exactly.

### Accept

- A test that renders a ` ```ts ` fence and asserts an `hljs-*` class appears.
- A test that renders a fence tagged with an unregistered language and asserts
  the output equals the plain path.
- `typecheck:client` clean.

---

## C-2 — Code block line numbers

**Roadmap says: ❌ not met.** Confirmed — no gutter exists.

### Spec

1. A fence with **two or more** lines renders a line-number gutter, `1..N`, one
   entry per line, in document order.
2. The gutter is a sibling of the `<pre>`, not inside it, so a copied code
   block does not carry the numbers.
3. A fence whose body is empty or whitespace-only renders no gutter, and
   neither does a single-line fence.
4. The gutter is present with or without highlighting (C-1 and C-2 are
   independent; a test must cover plain-highlight fences too).
5. The gutter must survive `pre` wrapping/overflow: it does not scroll
   horizontally with the code. (Layout is CSS; this is the acceptance hook.)

> **Correction, 2026-10-03.** An earlier draft of clause 1 said "one or more
> lines", which contradicts the single-line exclusion below. The exclusion wins:
> a one-line snippet rendered with a lone `1` beside it is noise, and the rule
> is now stated once, in clause 1, so there is nothing to contradict.
> Implemented at `markdown.tsx:76` with the threshold named in a comment.

### Accept

- A test asserting gutter entries `1..N` for an N-line fence, N ≥ 2.
- A test asserting no gutter for an empty fence.
- A test asserting no gutter for a single-line fence.

---

## C-3 — Stop, and sending after stop

**Roadmap says: ➖ not verified** ("验收通过"). This spec turns the
un-verified into verified, or reports that it does not hold.

`client/stream.ts` and `client/stream-loop.ts` hold the frame reduction and the
send/resume loop. Per `AGENTS.md`, tests drive them **directly** — no DOM.

### Spec to verify

1. Interrupting a turn preserves the order of already-received frames; a frame
   that arrives after the interrupt does not splice itself before them.
2. A message sent after a stop starts a new turn rather than resuming the
   aborted one, and does not inherit the aborted turn's partial text.

### Accept

- Direct tests against `reduceWebuiStreamFrame` / `runWebuiStreamLoop`.
- If the behaviour does not hold, that is a finding, not a reason to change
  the test. Report it.

---

## C-4 — Mixed media and retry

**Roadmap says: ➖ not verified.** Existing suites:
`output-error.test.tsx`, `message-attachments.test.tsx`, `message-parts.test.ts`.

### Spec to verify

1. A failed turn surfaces a retry affordance, and retrying re-sends the same
   user input.
2. A rate-limit response surfaces as a distinct message from a generic failure
   (`OutputError` already exists — check what actually distinguishes them).
3. Image and text in one assistant message render together, in order.

### Accept

- A test per behaviour above. Coverage already present counts only if the test
  actually asserts the behaviour rather than the component's existence.

---

## C-5 — Message file/line anchors

**Roadmap says: ➖ not verified, "代码有附件卡片" (code has attachment cards).**
This is the one place the report understates the source: the anchor feature is
**implemented**, not merely scaffolded.

`client/markdown.tsx` already has:

- a `webuiFileReference` marked-extension registered on `marked` (line ~48),
- `fileReferenceAnchor()` (line ~71) which renders a clickable anchor,
- call sites in `inline()` (lines ~85, ~105, ~120, ~144) that parse
  `parseWebuiMessageFileReference` from `./projection/message-file-reference.js`
  and open the file on click.

### Spec to verify

1. A reference of the form `path/to/file.ts:120` renders as a clickable anchor
   carrying the line number, not as literal text.
2. Clicking it invokes the `onOpenFile` callback with the parsed reference.
3. A bare `file.ts` without a line number is still a valid reference.
4. A string that merely contains a colon is not turned into a reference.

### Accept

- Tests for all four, in the file that already covers the projection
  (`message-parts.test.ts` or a new sibling).

---

## Out of scope

Rendering, katex math, tables, turn navigation, and the tool cards are already
✅ in the report and are not touched here. This spec adds no runtime
dependency and changes no public contract.

## Definition of done

`pnpm test` in `packages/webui` green, `typecheck:client` clean, and each item
above carrying the test that proves it. A claim without a test is not done.
