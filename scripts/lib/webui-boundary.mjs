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

export const TERMINAL_RENDERER_RE = /^packages\/tui\/src\/tui\//u;

export function rewriteInputs(rawInputs, { rootDir = repositoryRoot } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(rawInputs)) {
    result[resolveKey(key, rootDir)] = value;
  }
  return result;
}

function resolveKey(key, rootDir) {
  const paths = /^[A-Za-z]:[\\/]/u.test(rootDir) ? path.win32 : path;
  const posix = (value) => value.replaceAll("\\", "/");
  const normalized = posix(key);
  if (normalized === WEBUI_PACKAGE_DIRECTORY || normalized.startsWith(`${WEBUI_PACKAGE_DIRECTORY}/`)) return normalized;
  const absolute = paths.isAbsolute(key) ? key : paths.resolve(rootDir, WEBUI_PACKAGE_DIRECTORY, key);
  const relative = paths.relative(rootDir, absolute);
  return posix(relative.startsWith("..") || paths.isAbsolute(relative) ? absolute : relative);
}

export function serverAndClientEntriesPresent(inputs) {
  const sources = Object.keys(inputs);
  const violations = [];
  if (!sources.includes(`${WEBUI_PACKAGE_DIRECTORY}/src/server/index.ts`))
    violations.push("server entry packages/webui/src/server/index.ts missing");
  if (!sources.includes(`${WEBUI_PACKAGE_DIRECTORY}/src/client/main.tsx`))
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
    if (!existsSync(absolute)) {
      violations.push(`${input}: build input is missing`);
      continue;
    }
    let text;
    try {
      text = readFileSync(absolute, "utf8");
    } catch (error) {
      violations.push(`${input}: cannot read build input (${error.code ?? error.message})`);
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

// Required by `packages/webui/docs/verification/gates.md`: every bundled file must be
// either the
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
    if ([...allowed].some((entry) => entry.endsWith("/") && input.startsWith(entry))) continue;
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
