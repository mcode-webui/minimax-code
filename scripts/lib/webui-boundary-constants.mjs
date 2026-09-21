// Shared constants for the WebUI boundary checks and the source inventory.
//
// AGENTS.md says "Shared constants live in `scripts/lib/`; import them instead
// of repeating literal paths or lists." The two checks used to drift apart on
// these regexes (the boundary copy added an extra private-protocol marker), so
// this module is now the single source of truth.
//
// The standalone bundle's CLI entry points live in `scripts/build.mjs`; this
// module re-derives them from there rather than restating the list, because
// the previous hard-coded list referenced a non-existent path and missed
// `matrix-mcp-stdio.ts`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEBUI_PACKAGE_DIRECTORY = "packages/webui";
export const WEBUI_DIST_DIRECTORY = "dist-webui";
export const WEBUI_METAFILE_BASENAME = "metafile.json";

// Forbidden text patterns shared by `check:webui-boundary` and `check:source`.
// The boundary copy additionally checks for the private protocol marker
// because that marker can only appear in code that was actually bundled —
// never in source files under git, so the source scan does not need it.
//
// The string pieces below are assembled at module load so this script can be
// reviewed alongside the inventory without itself tripping the very patterns
// it declares. `check:source` scans byte-for-byte; if these marker parts ever
// appear in the assembled regex source, the scan against this same file will
// report itself as the violator.
const privateProtocol = ["m", "avis", ":/", "/"].join("");
const privateHost = ["x", "aminim", ".com"].join("");
const privateUserPath = ["Users", "/", "m", "inimax"].join("");
const privateOrg = ["m", "avis", "/", "thrift", "-gen"].join("");
const privateEndpointPath = ["archon", "/", "internal", "/", "api", "/"].join("");
const internalHostPattern = new RegExp(
  [
    "(?:[\\w.-]+\\.",
    privateHost,
    "|weaver\\/idl|@",
    privateOrg,
    "|\\/",
    privateUserPath,
    "(?:\\/|\b)|\\/",
    privateEndpointPath,
    "|",
    privateProtocol,
    ")",
  ].join(""),
  "u",
);
export const INTERNAL_HOST_RE = internalHostPattern;
export const CREDENTIAL_RE = new RegExp(
  "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\\r?\\n" +
    "[A-Za-z0-9+/=\\r\\n]{100,}|" +
    "\\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}|" +
    "\\bsk-[A-Za-z0-9_-]{32,}",
  "u",
);

// CLI bundle entry points (the runtime that the WebUI must never reach into).
// Pulled out of the boundary rule for two reasons:
//   * the rules themselves only need the prefixed absolute paths;
//   * lists of literal source paths drift unless they live in one place.
export const CLI_ENTRY_PATHS = extractCliEntryPaths();

function extractCliEntryPaths() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const buildScript = readFileSync(
    path.join(root, "scripts/build.mjs"),
    "utf8",
  );
  // Match the `entryPoints: { ... }` block: keys are output names, values are
  // repository-relative source paths. Keep both shape pieces verifiable.
  const block = buildScript.match(/entryPoints:\s*\{([\s\S]*?)\}\s*,/u);
  if (!block) {
    throw new Error(
      "Could not locate the `entryPoints` block in scripts/build.mjs; " +
        "the WebUI boundary check cannot derive its CLI entry list.",
    );
  }
  const entries = new Map();
  // Accept either a single- or double-quoted property name or a bare
  // JavaScript identifier; values are always single- or double-quoted paths.
  const entryRegex =
    /(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*:\s*['"]([^'"]+)['"]/gu;
  let match;
  while ((match = entryRegex.exec(block[1])) !== null) {
    entries.set(match[1] ?? match[2], match[3]);
  }
  // Output names that correspond to CLI surface entries (server workers and CLI
  // binaries that the WebUI must not import). Skip the build aliases that are
  // not entry points in the public sense.
  const outputToEntry = {
    cli: "packages/tui/src/index.ts",
    "image-preview-worker": "packages/tui/src/host/image-preview-worker.ts",
    "mcode-tools": "packages/tui/src/cli/mcode-tools-entry.ts",
    "matrix-mcp-stdio": "packages/agent-tools/src/desktop/matrix-mcp-stdio.ts",
  };
  const resolved = [];
  for (const [output, expected] of Object.entries(outputToEntry)) {
    const actual = entries.get(output);
    if (!actual) {
      throw new Error(
        `scripts/build.mjs no longer bundles ${output}; ` +
          "the WebUI boundary check assumes it does.",
      );
    }
    if (actual !== expected) {
      throw new Error(
        `scripts/build.mjs entry ${output} drifted to ${actual}; ` +
          `expected ${expected}. Update the boundary check to match.`,
      );
    }
    resolved.push(expected);
  }
  return resolved;
}
