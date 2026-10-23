# WebUI built-client browser tests

One `*.spec.mjs` per surface, plus `harness.mjs` (page helpers) and `fixture.mjs` (the deterministic
in-page transport). Run the directory, not a hand-kept list: Playwright collects every spec in it.

```sh
pnpm build:webui          # the suite drives the built client
pnpm test:webui-browser   # installs the pinned Chromium revision and, on Linux, its system dependencies
```

How the fixture works, what the suite proves and what it does not, and which environment variables
change its server behaviour are documented in
[`../../docs/verification/browser-suite.md`](../../docs/verification/browser-suite.md).
