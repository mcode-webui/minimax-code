// Boundary check for the WebUI build graph (ADR 0005).
//
// The graph lives at `dist-webui/metafile.json` once `scripts/build-webui.mjs`
// has run. The check itself is a series of pure functions so tests can drive
// each rule with a fixture (RED-GREEN) without having to build the package
// first.
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
//     graph never imports from `packages/tui/src/index.ts` or any of its
//     client entry points.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retiredBuildInputs } from "./lib/retired-sources.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Same forbidden text shape `scripts/source-inventory.mjs` uses, plus the
// `mavis://` private protocol marker from in-package wiring.
const INTERNAL_HOST_RE =
  /(?:[\w.-]+\.xaminim\.com|weaver\/idl|@mavis\/thrift-gen|\/Users\/minimax(?:\/|\b)|\/archon\/internal\/api\/|mavis:\/\/)/u;
const CREDENTIAL_RE =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{100,}|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9_-]{32,}/u;

const TERMINAL_RENDERER_RE =
  /^packages\/tui\/src\/tui\//u;

// The WebUI server must not reach back into the CLI binary; the CLI exports
// its public surface through the workspace, but importing its entry point
// would change the wiring the boundary check is supposed to guard.
const CLI_ENTRY_RE =
  /^packages\/tui\/src\/(?:index|cli\/index|host\/image-preview-worker|cli\/mcode-tools-entry)\.ts$/u;

// Inputs are recorded with paths relative to `packages/webui/`. Rewrite
// them against the repository root so the boundary check uses the same
// form `scripts/source-inventory.mjs` and `retired-sources.mjs` use.
const WEBUI_ROOT = "packages/webui/";
function normalise(input) {
  if (input.startsWith(WEBUI_ROOT)) return input;
  if (input.includes("node_modules/")) return input;
  return `${WEBUI_ROOT}${input}`;
}

export function rewriteInputs(rawInputs) {
  const result = {};
  for (const [key, value] of Object.entries(rawInputs)) {
    result[normalise(key)] = value;
  }
  return result;
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

export function forbiddenInternalReferences(inputs) {
  const violations = [];
  for (const [input, value] of Object.entries(inputs)) {
    const text = JSON.stringify(value);
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
    if (CLI_ENTRY_RE.test(input)) violations.push(input);
  }
  return { pass: violations.length === 0, violations };
}

export const rules = [
  serverAndClientEntriesPresent,
  retiredSourcesAbsent,
  terminalRendererAbsent,
  forbiddenInternalReferences,
  noServerCallIntoCli,
];

// Standalone entry — runs all rules against the built metafile when this
// file is invoked directly. Tests import the individual rule functions
// above to drive each rule with a fixture.
const metaPath = path.join(root, "dist-webui/metafile.json");
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
  const result = rule(buildInputs);
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
