// Pure-function WebUI boundary rules and the path normaliser.
//
// `scripts/check-webui-boundary.mjs` is the CLI entry; tests import the rules
// below directly so the script can stay side-effect-free.
//
// Inputs are recorded by esbuild with paths relative to `absWorkingDir` =
// `packages/webui`. Real keys therefore arrive as
// `packages/webui/src/...` (in-package), `../tui/src/...` (relative escape),
// `../../node_modules/...` (pnpm-symlink form) and similar. `rewriteInputs`
// resolves every key to the same repository-relative form so the rules below
// can use the literal prefixes declared in `scripts/lib/retired-sources.mjs`
// and `webui-boundary-constants.mjs`.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retiredBuildInputs } from "./retired-sources.mjs";
import {
  CLI_ENTRY_PATHS,
  INTERNAL_HOST_RE,
  CREDENTIAL_RE,
  WEBUI_PACKAGE_DIRECTORY,
} from "./webui-boundary-constants.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const webuiPackagePath = path.join(repositoryRoot, WEBUI_PACKAGE_DIRECTORY);

export const TERMINAL_RENDERER_RE = /^packages\/tui\/src\/tui\//u;

export function rewriteInputs(rawInputs, { rootDir = repositoryRoot } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(rawInputs)) {
    result[resolveKey(key, rootDir)] = value;
  }
  return result;
}

function resolveKey(key, rootDir) {
  if (path.isAbsolute(key)) {
    const relative = path.relative(rootDir, key);
    return relative.startsWith("..") ? key : relative || key;
  }
  if (
    key === WEBUI_PACKAGE_DIRECTORY ||
    key.startsWith(`${WEBUI_PACKAGE_DIRECTORY}/`)
  ) {
    return key;
  }
  // esbuild records every key relative to `absWorkingDir`
  // (`packages/webui/`). Resolve `../...` and `../../node_modules/...` against
  // the package directory so the trailing segments match the literal prefixes
  // declared by the boundary rules below.
  const joined = path.join(webuiPackagePath, key);
  const relative = path.relative(rootDir, joined);
  if (!relative.startsWith("..") && !path.isAbsolute(relative))
    return relative;
  return key;
}

export function serverAndClientEntriesPresent(inputs) {
  const sources = Object.keys(inputs);
  const violations = [];
  if (!sources.some((source) => source.endsWith("/server/index.ts")))
    violations.push("server entry packages/webui/src/server/index.ts missing");
  if (!sources.some((source) => source.endsWith("/client/main.tsx")))
    violations.push("client entry packages/webui/src/client/main.tsx missing");
  return { pass: violations.length === 0, violations };
}

export function retiredSourcesAbsent(inputs) {
  const violations = [];
  for (const input of Object.keys(inputs)) {
    if (retiredBuildInputs.some((prefix) => input.startsWith(prefix)))
      violations.push(input);
  }
  return { pass: violations.length === 0, violations };
}

export function terminalRendererAbsent(inputs) {
  const violations = [];
  for (const input of Object.keys(inputs)) {
    if (TERMINAL_RENDERER_RE.test(input)) violations.push(input);
  }
  return { pass: violations.length === 0, violations };
}

// Inspects the actual text of each non-`node_modules` input. The metafile's
// per-input value only carries `bytesInOutput` and `imports`, so reading the
// file from disk is the only way to detect forbidden internal hosts or
// embedded credentials.
export function forbiddenInternalReferences(
  inputs,
  { rootDir = repositoryRoot } = {},
) {
  const violations = [];
  for (const input of Object.keys(inputs)) {
    if (input.startsWith("node_modules/")) continue;
    const absolute = path.join(rootDir, input);
    if (!existsSync(absolute)) continue;
    let text;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (INTERNAL_HOST_RE.test(text)) {
      violations.push(`${input}: internal host or service reference`);
      continue;
    }
    if (CREDENTIAL_RE.test(text)) {
      violations.push(`${input}: embedded credential`);
    }
  }
  return { pass: violations.length === 0, violations };
}

export function noServerCallIntoCli(inputs) {
  const violations = [];
  for (const input of Object.keys(inputs)) {
    for (const entry of CLI_ENTRY_PATHS) {
      if (input === entry) violations.push(input);
    }
  }
  return { pass: violations.length === 0, violations };
}

// Required by `docs/webui-v1-scope.md`: every bundled file must be either the
// process-local WebUI package, an exported subpath of a public workspace
// package declared in `release/extraction.json`, or a third-party dependency
// under `node_modules/`. The `cli-service` package and the published
// subpaths of every other workspace live behind the latter set, populated by
// the CLI from `scripts/lib/package-exports.mjs`.
export function onlyAllowedPublicEntries(inputs, packageExports) {
  const allowed = packageExports ?? new Set();
  const violations = [];
  for (const input of Object.keys(inputs)) {
    if (input.startsWith("node_modules/")) continue;
    if (input.startsWith(`${WEBUI_PACKAGE_DIRECTORY}/`)) continue;
    if (allowed.has(input)) continue;
    violations.push(`${input}: not an allowed WebUI build entry`);
  }
  return { pass: violations.length === 0, violations };
}

export const rules = [
  serverAndClientEntriesPresent,
  retiredSourcesAbsent,
  terminalRendererAbsent,
  forbiddenInternalReferences,
  noServerCallIntoCli,
  (inputs, packageExports) => onlyAllowedPublicEntries(inputs, packageExports),
];

// Default reader options for `forbiddenInternalReferences` so the CLI entry
// point can pass them through without re-reading the filesystem in a separate
// loop.
export const defaultOptions = { rootDir: repositoryRoot };
