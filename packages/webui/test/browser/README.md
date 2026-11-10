# WebUI built-client browser tests

One `*.spec.mjs` per surface, plus `harness.mjs` (page helpers) and `fixture.mjs` (the deterministic
in-page transport). Run the directory, not a hand-kept list: Playwright collects every spec in it.

```sh
pnpm build:webui          # the suite drives the built client
pnpm test:webui-browser   # uses the already installed Playwright Chromium; no system-package installation
```

The screenshot comparisons read the fonts in `fonts/`, not the ones the machine has installed: the
fixture serves them as web fonts under the client's first family names, so the typeface is the same
everywhere. The pixels are not: every platform rasterizes those outlines its own way, so the
baselines are per-platform (`-darwin`, `-linux`, `-win32`) and a capture has to be recorded on the
platform whose baseline it replaces. `LICENSE.noto-fonts` covers those files.

How the fixture works, what the suite proves and what it does not, and which environment variables
change its server behaviour are documented in
[`../../docs/verification/browser-suite.md`](../../docs/verification/browser-suite.md).
