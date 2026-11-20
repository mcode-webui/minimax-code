# Third-party notices

- **Pi**: `third_party/pi-mono` and derived terminal code, MIT. Full notices are in `third_party/pi-mono/LICENSE` and `packages/tui/THIRD_PARTY_NOTICES.md`. Local modifications are recorded in `third_party/pi-mono/MINIMAX_CHANGES.md`.
- **Sandbox Runtime**: `third_party/sandbox-runtime`, Apache-2.0. See its README, LICENSE, and upstream.json for the upstream version, source revision, fork changes, and native build instructions.
- **models.dev**: the bundled provider / model catalog snapshot, MIT; notices are in `packages/tui/THIRD_PARTY_NOTICES.md`.
- **Bundled assets**: LICENSE, NOTICE, and file-level declarations in each asset directory retain their original attribution.
- **npm dependencies**: versions and declared licenses are recorded in `release/dependency-licenses.json`; `pnpm-lock.yaml` is authoritative for dependency resolution and integrity.
- **AI Node Canvas 1.22.9**: native WebUI Design derives its node forms, graph actions, templates, generation orchestration and media tools from this MIT-licensed Mini App. Native runtime adapters, persistence and React presentation are local modifications. Source notices are retained in `packages/webui/src/shared/design/LICENSE` and `packages/webui/src/runtime/design/LICENSE`. The license below also accompanies the packaged WebUI bundles.
- **mcode-tools 0.0.4**: extracted unchanged from the public `@minimax-ai/code@0.3.11` package during the build. Its distribution manifest declares MIT; archive and CLI hashes are pinned in `scripts/lib/mcode-tools-artifact.mjs`. The tool's own manifest is retained, and the original distribution's third-party notices are copied to `dist/MCODE_TOOLS_NOTICES.md`. The root license does not replace this artifact's existing declarations.

The root MIT license does not replace these materials' separate licenses or copyright notices.

## AI Node Canvas

MIT License

Copyright (c) 2026 antianqi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
