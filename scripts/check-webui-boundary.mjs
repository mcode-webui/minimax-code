// Boundary check for the WebUI build graph (ADR 0005).
//
// The graph lives at `dist-webui/metafile.json` once `scripts/build-webui.mjs`
// has run. The pure rules live in `scripts/lib/webui-boundary.mjs` so tests can
// drive each rule with a fixture (RED-GREEN) without having to build the
// package first — importing this script never throws.
//
// Rules asserted:
//   * Server entry and client entry both appear in the build graph.
//   * No retired source path is reachable from the build graph (the same
//     set `check:standalone` uses; see `scripts/lib/retired-sources.mjs`).
//   * No terminal renderer dependency: nothing resolves into
//     `packages/tui/src/tui/`.
//   * No forbidden internal addresses, credentials, or private service
//     references in any input that the build actually pulled in.
//   * No server-side call back into the CLI: the server's emitted module
//     graph never imports any CLI entry point declared by
//     `scripts/build.mjs`.
//   * Every input is either the process-local WebUI fixture, a published
//     workspace package export, or a third-party dependency under
//     `node_modules/`.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  rewriteInputs,
  rules,
} from "./lib/webui-boundary.mjs";
import {
  WEBUI_DIST_DIRECTORY,
  WEBUI_METAFILE_BASENAME,
} from "./lib/webui-boundary-constants.mjs";
import { readExtraction } from "./lib/release-metadata.mjs";
import { packageExportEntries } from "./lib/package-exports.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { packageRoots } = readExtraction(root);
const packageExports = new Set(
  packageExportEntries(root, packageRoots).map(({ file }) => file),
);

// Standalone entry — runs all rules against the built metafile when this
// file is invoked directly. Tests import the individual rule functions
// from `scripts/lib/webui-boundary.mjs` to drive each rule with a fixture.
const metaPath = path.join(root, WEBUI_DIST_DIRECTORY, WEBUI_METAFILE_BASENAME);
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!existsSync(metaPath)) {
    throw new Error(
      `WebUI metafile missing at ${path.relative(root, metaPath)}; ` +
        `run \`pnpm build:webui\` first.`,
    );
  }
  const metafile = JSON.parse(readFileSync(metaPath, "utf8"));
  const buildInputs = rewriteInputs(metafile.inputs);
  const failureMessages = [];
  for (const rule of rules) {
    const result = rule(buildInputs, packageExports);
    if (result.pass) continue;
    for (const message of result.violations)
      failureMessages.push(message);
  }
  if (failureMessages.length) {
    throw new Error(
      `WebUI build boundary check failed:\n${failureMessages.join("\n")}`,
    );
  }
  console.log(
    `WebUI build boundary passed: ${Object.keys(buildInputs).length} inputs, ${rules.length} rules.`,
  );
}
