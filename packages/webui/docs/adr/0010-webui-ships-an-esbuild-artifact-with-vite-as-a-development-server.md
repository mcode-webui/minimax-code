# The WebUI ships an esbuild artifact and takes Vite only as a development server

The WebUI's published artifact is produced by `scripts/build-webui.mjs` with esbuild, in the
shape ADR 0005 requires: `dist-webui/` with its own metafile, which
`scripts/check-webui-boundary.mjs` reads. Vite's role is limited to a development server for the
browser client. Styling is Tailwind, compiled as its own step into one stylesheet that both the
development server and the packaged artifact consume.

The reason is where the risk sits. The boundary check is the gate ADR 0005 names, and it is only
as good as the build graph it reads. esbuild's metafile hands the check a complete input list; a
Vite production build does not, so letting Vite own the artifact would mean re-implementing graph
extraction as a plugin whose correctness the check would then depend on — replacing a verified
gate with a new one that itself needs verification, in exchange for development-time convenience.
Vite's value here is hot module replacement while editing the client, which does not have to own
the artifact that verification exercises. Tailwind does not decide the question: the token names
in [`design-language.md`](../design/design-language.md) are utility names
(`bg-bg_default_primary`, `rounded-radius_8`), so a Tailwind step is required under every option.

## Considered Options

- **Vite owns development and the artifact** — rejected for now: the boundary check would have to
  be re-derived from Rollup's module graph, and the graph would become an artifact this repository
  maintains rather than the bundler's own record. Revisit if "what the developer sees is what
  ships" becomes a hard requirement; that is its own change with its own tests, not a slice of a
  feature ticket.
- **esbuild only, with no development server** — rejected: rebuilding the client costs about
  50 ms, so the cost is not build time but the loss of hot module replacement and of page state
  while the interface is built, which is most of the remaining work.
- **Tailwind compiled through a Vite pipeline** — rejected: it binds the stylesheet to the choice
  rejected above for no benefit; a standalone compile produces the same CSS for both consumers.

## Consequences

- Two tools, one authority: only the esbuild artifact is verified and shipped. The development
  server is not a verification surface, and a check that only passes there proves nothing.
- The Tailwind step must produce the same stylesheet for the development server and the packaged
  artifact. A difference between them is a defect, not a preference.
- The token surface has its own structural check:
  `test/unit/webui-design-tokens.test.ts` asserts the ramps, the scale tokens and the 211 semantic
  tokens with their light and dark bindings. Dropping or renaming a token in `tokens.css` fails
  there. The values themselves are owned by [`../design/design-language.md`](../design/design-language.md).
- If a later decision gives the artifact to Vite, ADR 0005's boundary check moves to Vite's build
  graph in that same change, with its own tests written red first.
