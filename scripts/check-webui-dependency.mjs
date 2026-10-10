// Internal dependency-direction check for `packages/webui/src`.
//
// This is an AST/source-level check. It parses every TypeScript source in the
// package, resolves each static import, re-export, `import type`, type query
// and literal dynamic import with the repository's real TypeScript resolver
// (using the client and server tsconfigs), and evaluates the result against the
// allowed-edge matrix in `scripts/lib/webui-dependency-rules.mjs`. It
// complements `check:webui-boundary`, which reads the esbuild metafile: that
// check can neither see `import type` edges (erased from build output) nor
// prove dependency *direction*.
//
// The check fails on any new violation and on any baseline entry that is no
// longer violated (a stale entry), so each migration slice is forced to delete
// the exceptions it removed. It also rejects unresolved intra-package imports,
// non-literal dynamic imports and import cycles beyond those recorded in the
// frozen baseline.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import {
  buildDependencyGraph,
  compareBaseline,
  evaluateGraph,
  pairKey,
  WEBUI_SOURCE_DIRECTORY,
} from "./lib/webui-dependency-rules.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = fileURLToPath(new URL("../", import.meta.url));
const defaultBaselinePath = path.join(
  root,
  "scripts/lib/webui-dependency-baseline.json",
);

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    baseline: { type: "string" },
  },
  allowPositionals: true,
});

function loadCompilerOptions(configRelative) {
  const configPath = path.join(root, "packages/webui", configRelative);
  let failure;
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        failure = diagnostic;
      },
    },
  );
  if (!parsed || failure) {
    const message = failure
      ? ts.flattenDiagnosticMessageText(failure.messageText, "\n")
      : "unknown configuration error";
    throw new Error(`cannot read ${configRelative}: ${message}`);
  }
  return parsed.options;
}

// Client and server programs share the path map but differ in module settings;
// resolve each file with the program it belongs to.
const clientOptions = loadCompilerOptions("tsconfig.client.json");
const serverOptions = loadCompilerOptions("tsconfig.server.json");
const compilerOptionsFor = (relative) =>
  relative.startsWith("server/") || relative.startsWith("runtime/")
    ? serverOptions
    : clientOptions;

const baselineFile = path.resolve(values.baseline ?? defaultBaselinePath);
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));

const graph = buildDependencyGraph({
  repositoryRoot: root,
  sourceDirectory: WEBUI_SOURCE_DIRECTORY,
  compilerOptionsFor,
});
const result = evaluateGraph(graph);

const { newViolations, staleEntries } = compareBaseline(
  result.direction,
  baseline.entries ?? [],
);

function structuralKey(kind, file, line) {
  return `${kind}:${file}:${line}`;
}
const measuredStructural = [
  ...result.unresolved.map((entry) => ({
    kind: "unresolved",
    file: entry.file,
    line: entry.line,
    detail: entry.detail,
  })),
  ...result.nonLiteralDynamic.map((entry) => ({
    kind: "non-literal-dynamic-import",
    file: entry.file,
    line: entry.line,
    detail: entry.detail,
  })),
];
const allowedStructural = new Map(
  (baseline.allowances ?? []).map((entry) => [
    structuralKey(entry.kind, entry.file, entry.line),
    entry,
  ]),
);
const measuredStructuralKeys = new Set(
  measuredStructural.map((entry) => structuralKey(entry.kind, entry.file, entry.line)),
);
const newStructural = measuredStructural.filter(
  (entry) => !allowedStructural.has(structuralKey(entry.kind, entry.file, entry.line)),
);
const staleAllowances = (baseline.allowances ?? []).filter(
  (entry) => !measuredStructuralKeys.has(structuralKey(entry.kind, entry.file, entry.line)),
);

const baselineCycles = new Map(
  (baseline.cycles ?? []).map((entry) => [entry.canonical, entry]),
);
const measuredCycleKeys = new Set(result.cycles.map((entry) => entry.canonical));
const newCycles = result.cycles.filter((entry) => !baselineCycles.has(entry.canonical));
const staleCycles = (baseline.cycles ?? []).filter(
  (entry) => !measuredCycleKeys.has(entry.canonical),
);

const violatingPairs = new Set(
  result.direction.map((violation) => pairKey(violation.from, violation.to)),
).size;

const failed =
  newViolations.length > 0 ||
  staleEntries.length > 0 ||
  newCycles.length > 0 ||
  staleCycles.length > 0 ||
  newStructural.length > 0 ||
  staleAllowances.length > 0 ||
  result.browserOnly.length > 0 ||
  result.browserGlobals.length > 0 ||
  result.nodeBuiltins.length > 0 ||
  result.forbiddenCalls.length > 0;

const summary = {
  ok: !failed,
  sourceFiles: graph.files.length,
  intraPackageReferences: graph.references.length,
  directionViolations: result.direction.length,
  violatingPairs,
  baselinePairs: (baseline.entries ?? []).length,
  newViolations,
  staleEntries,
  browserOnly: result.browserOnly,
  browserGlobals: result.browserGlobals,
  nodeBuiltins: result.nodeBuiltins,
  sharedNodeBuiltins: result.nodeBuiltins,
  forbiddenCalls: result.forbiddenCalls,
  cycles: result.cycles.map((entry) => entry.canonical),
  newCycles: newCycles.map((entry) => entry.canonical),
  staleCycles: staleCycles.map((entry) => entry.canonical),
  structuralExceptions: measuredStructural,
  newStructural,
  staleAllowances,
};

if (values.json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  const lines = [];
  lines.push("WebUI internal dependency check");
  lines.push(
    `  scanned ${graph.files.length} source files, ${graph.references.length} in-package references`,
  );
  lines.push(
    `  direction: ${result.direction.length} violations across ${violatingPairs} pairs (baseline ${(baseline.entries ?? []).length})`,
  );
  lines.push(
    `  cycles: ${result.cycles.length} (baseline ${(baseline.cycles ?? []).length})`,
  );
  lines.push(
    `  structural exceptions: ${measuredStructural.length} (allowed ${(baseline.allowances ?? []).length})`,
  );
  if (result.browserOnly.length) {
    lines.push("");
    lines.push(
      `NEW browser-only imports (${result.browserOnly.length}) — only bindings/root may import React:`,
    );
    for (const violation of result.browserOnly) lines.push(`  ${violation.detail}`);
  }
  for (const violation of [...result.browserGlobals, ...result.nodeBuiltins, ...result.forbiddenCalls])
    lines.push(`  ${violation.detail}`);
  if (newViolations.length) {
    lines.push("");
    lines.push(`NEW violations (${newViolations.length}), not in the baseline:`);
    for (const violation of newViolations)
      lines.push(`  ${violation.from} -> ${violation.to}  [${violation.category}]`);
  }
  if (staleEntries.length) {
    lines.push("");
    lines.push(
      `STALE baseline entries (${staleEntries.length}), no longer violated — delete them:`,
    );
    for (const entry of staleEntries)
      lines.push(`  ${entry.from} -> ${entry.to}  [${entry.category}]`);
  }
  if (newCycles.length || staleCycles.length) {
    lines.push("");
    if (newCycles.length) lines.push(`NEW cycles (${newCycles.length}):`);
    for (const cycle of newCycles) lines.push(`  ${cycle.canonical}`);
    if (staleCycles.length)
      lines.push(`STALE cycle entries (${staleCycles.length}) — delete them:`);
    for (const cycle of staleCycles) lines.push(`  ${cycle.canonical}`);
  }
  if (newStructural.length || staleAllowances.length) {
    lines.push("");
    if (newStructural.length)
      lines.push(`NEW unresolved / non-literal imports (${newStructural.length}):`);
    for (const entry of newStructural) lines.push(`  ${entry.detail}`);
    if (staleAllowances.length)
      lines.push(
        `STALE structural allowances (${staleAllowances.length}) — delete them:`,
      );
    for (const entry of staleAllowances)
      lines.push(`  ${entry.kind}:${entry.file}:${entry.line}`);
  }
  lines.push("");
  lines.push(failed ? "WebUI internal dependency check FAILED." : "WebUI internal dependency check passed.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (failed) process.exitCode = 1;
