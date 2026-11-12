# Visual implementation and verification

Tokens, scales, per-control contracts and the hierarchy rules are
`packages/webui/docs/design/design-language.md`; read the section for the surface you are touching, plus
the component and CSS actually in the tree. This file holds only the compiler, cascade and measurement
traps that document does not cover. Existing code carries older aliases beside newer semantic tokens — do
not promote an incidental legacy declaration into a new rule.

## Reference captures

Six built-client captures sit in `visuals/`, one per surface and theme (`home`, `conversation`, `settings`,
1440 × 900, reduced motion, Chinese locale). Consult them when page context helps, open the originals
rather than inferring from filenames, and treat them as dated examples rather than pixel contracts — the
provenance is in `visuals/capture-manifest.json`. A screenshot from the user's own baseline takes
precedence over these fixtures. Refresh them deliberately (see [visual acceptance](#visual-acceptance)),
never to hide a regression.

## CSS mechanics that matter

- **Tailwind scans source literals.** Runtime-built classes need full-name maps or a safelist entry, and a
  class present in TSX or CSS input may still have been purged. Arbitrary-value utilities can rewrite
  underscores inside custom-property names, so named component CSS is safer for token-based shadows.
  `test/unit/webui-design-tokens.test.ts` checks token closure and named compiled classes.
- **A cascade change is a resolved-declaration change.** Compare effective declarations including
  specificity, ordering, media/container context and utilities: a later block is not automatically the
  winner. Keep feature imports in `styles/index.css` in their intended order.
- **Global scrollbars and gutters live in `styles/index.css`.** Do not reserve gutters on every element —
  inline SVG's overflow can collapse its paint area — and preserve the horizontal-only opt-outs. Long
  content is handled with `min-w-0`/`min-h-0` and real scroll ownership, not global overflow hiding.
- **Reduced motion goes through the shared tokens**, not per-rule media queries: the families in
  `styles/motion.css` collapse together. A new effect needs a family or a recorded distinct reason. For a
  floating surface start from the existing positioning helpers in `projection/common/` and the
  `client/ui/overlay-coordinator.tsx` registration rather than another window listener.
- **Markdown is a pipeline, not a DOM scan.** `marked` tokens render through React/KaTeX with registered
  highlight.js languages; do not add KaTeX auto-render or a second stylesheet. Read the escaping,
  link and file-reference contracts before touching raw content handling.

## Media elements and measured geometry

A media element that has not loaded has no intrinsic size, which turns two ordinary choices into silent
failures. Load eagerly with `decoding="async"` — `loading="lazy"` on an `<img>` with no bytes lays out at
zero height, the viewport check never fires, and the picture waits for a size it can only get by loading.
Never let one failed load be the last word either: a reply names its file before the write lands, so the
first request legitimately 404s, and the bounded retry that covers it is the transcript contract in
[rendering-surfaces.md](rendering-surfaces.md) — not a local flag. Assert on the element
(`naturalWidth`, `complete`, box), never on the wrapper.

Sizes come from the scale, and whether a change is right is a measurement rather than a screenshot
judgement: twelve versus fourteen pixels does not settle by eye. Read computed values with a throwaway
spec — `packages/webui/test/browser/__tmp-<name>.spec.mjs`, `configureFixture(page, () => undefined)`,
`openApp(page)`, then `page.evaluate` reading `getComputedStyle(el)` for `fontSize`, `lineHeight`,
`fontWeight`, box height and the child `svg` size. Change the source, rebuild, read again, then delete the
file: a leftover `__tmp-` spec joins every later run.

## Visual acceptance

Build first, then exercise the requested states and inspect both themes, a constrained viewport, long
content, scrolling, open overlays, focus and keyboard paths, disabled/busy/error states and reduced motion
where they apply. Choose a matrix that fits the change rather than re-shooting every unrelated screen. DOM
and SSR assertions prove content; computed styles and screenshots prove layout and appearance.

For reusable captures after a successful `pnpm build:webui`:

```bash
node .agents/skills/webui-development/scripts/capture-visuals.mjs /path/to/minimax-code /path/outside/repository/visual-reference
```

The helper serves only the existing build and the repository's synthetic fixture on its own ephemeral
loopback port, starts and closes its own headless browser, never rebuilds, never touches a live app or a
real provider, and reviews page errors into the manifest. It is capture tooling, not a substitute for the
guarded browser suite.

New assets need a provenance and license review plus the source inventory; prefer marks already in
`src/client/assets/`, inspect the original before adapting it, and keep a source→destination filename
manifest for anything added.
