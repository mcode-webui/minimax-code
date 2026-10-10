// Test the WebUI internal dependency-direction rules (ADR 0014, plan §3/§7.5).
//
// These fixtures exist because `check:webui-boundary` (the esbuild metafile
// check) cannot catch what this check catches: it sees a build input only if it
// reaches the bundle, it cannot see `import type` edges at all (they are erased
// from build output), and it proves *presence*, never direction. Every negative
// fixture below is written to a temporary directory and parsed and resolved by
// the same code path the CLI uses, so the assertion is about real AST resolution
// rather than a hand-built adjacency list.
//
// The fixtures live under the OS temp directory, never in the repository, so
// `scripts/source-inventory.mjs` never sees them.

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import {
  BROWSER_ONLY_MODULES_RE,
  KNOWN_AMBIGUOUS_FILES,
  buildDependencyGraph,
  canonicalCycle,
  classifyLayers,
  collectModuleReferences,
  compareBaseline,
  detectCycles,
  evaluateGraph,
  isAllowedEdge,
  normaliseSourcePath,
  pairKey,
  toBaselineShape,
} from "../../../../scripts/lib/webui-dependency-rules.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const cliPath = path.join(repoRoot, "scripts/check-webui-dependency.mjs");
const realBaselinePath = path.join(
  repoRoot,
  "scripts/lib/webui-dependency-baseline.json",
);

// Resolution options for the synthetic trees. Bundler resolution mirrors the
// client program and maps the `.js` specifiers these fixtures use onto `.ts`
// sources, exactly as the real tsconfig does.
const compilerOptions: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  allowImportingTsExtensions: true,
};

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

/**
 * Writes a synthetic `${repositoryRoot}/packages/webui/src` tree and returns the
 * parsed, resolved evaluation, using the same builder and rules as the CLI.
 */
function evaluateFixture(files: Record<string, string>, options: ts.CompilerOptions = compilerOptions) {
  const root = mkdtempSync(path.join(os.tmpdir(), "webui-dependency-"));
  temporaryRoots.push(root);
  const sourceRoot = path.join(root, "packages/webui/src");
  const absoluteFiles: string[] = [];
  for (const [relative, body] of Object.entries(files)) {
    const absolute = path.join(sourceRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
    absoluteFiles.push(absolute);
  }
  const graph = buildDependencyGraph({
    repositoryRoot: root,
    compilerOptions: { ...options, baseUrl: options.baseUrl ?? sourceRoot },
    files: absoluteFiles,
  });
  return { graph, result: evaluateGraph(graph) };
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

const widget =
  "export interface Widget { readonly id: string }\nexport const widget = 1;\n";
const leaf = "export const leaf = 1;\n";

describe("layer matrix", () => {
  it("allows application to import its client contracts", () => {
    expect(isAllowedEdge(["application"], ["contracts"])).toBe(true);
  });

  it("denies a pure projection importing a component", () => {
    expect(isAllowedEdge(["view"], ["bindings"])).toBe(false);
    expect(isAllowedEdge(["domain"], ["bindings"])).toBe(false);
  });

  it("denies application and domain reaching the concrete transport", () => {
    expect(isAllowedEdge(["application"], ["infrastructure"])).toBe(false);
    expect(isAllowedEdge(["domain"], ["infrastructure"])).toBe(false);
  });

  it("denies shared contracts reaching either execution side", () => {
    expect(isAllowedEdge(["shared"], ["application"])).toBe(false);
    expect(isAllowedEdge(["shared"], ["server"])).toBe(false);
    expect(isAllowedEdge(["shared"], ["runtime"])).toBe(false);
  });

  it("denies the Node runtime importing a browser-only layer", () => {
    expect(isAllowedEdge(["runtime"], ["bindings"])).toBe(false);
    expect(isAllowedEdge(["runtime"], ["view"])).toBe(false);
  });

  it("requires every classification pair to allow an edge", () => {
    expect(isAllowedEdge(["runtime", "server"], ["server"])).toBe(false);
  });

  it("classifies current paths by their target layer, not the directory", () => {
    expect(classifyLayers("runtime/port.ts")).toEqual(["runtime-port"]);
    expect(classifyLayers("client/contracts/transport.ts")).toEqual(["contracts"]);
    // The reducer is a pure `view` projection now that the stream loop and the
    // test-only instrumentation take it by injection instead of importing it.
    expect(classifyLayers("client/projection/stream-state.ts")).toEqual(["view"]);
    // The migrated modules are decided by their directory now, so no
    // provenance entry is needed for them.
    expect(classifyLayers("client/mechanisms/stream-loop.ts")).toEqual(["mechanisms"]);
    expect(classifyLayers("client/infrastructure/transport.ts")).toEqual([
      "infrastructure",
    ]);
  });

  it("recognises the post-migration layout too", () => {
    expect(classifyLayers("client/application/session-store.ts")).toEqual([
      "application",
    ]);
    expect(classifyLayers("runtime/harness/adapter.ts")).toEqual(["runtime"]);
    expect(classifyLayers("shared/contracts/session.ts")).toEqual(["shared"]);
  });

  it("records the known-ambiguous files from plan section 7.5", () => {
    expect(KNOWN_AMBIGUOUS_FILES).toContain("client/projection/stream-state.ts");
    // `client/stream.ts` was split into the pure frame reducer in
    // `client/projection/stream-state.ts` and the turn-coordinator commands;
    // the original path no longer exists to be judged, so its entry is gone.
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain("client/stream.ts");
    // `client/contracts.ts` was split into leaf contracts in stage 1; the entry
    // is gone because the file no longer exists to be judged.
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain("client/contracts.ts");
    // `client/session-runtime-store.ts` had no remaining importer and was
    // deleted by the ticket-#45 slice; the entry is gone because the file no
    // longer exists to be judged.
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain(
      "client/session-runtime-store.ts",
    );
  });
});

describe("normaliser", () => {
  it("maps an in-package path to a src-relative form and rejects out-of-tree", () => {
    const inside = path.join(
      repoRoot,
      "packages/webui/src/client/main.tsx",
    );
    expect(normaliseSourcePath(repoRoot, inside)).toBe("client/main.tsx");
    expect(normaliseSourcePath(repoRoot, "/tmp/elsewhere.ts")).toBeNull();
  });
});

describe("reference collection", () => {
  it("distinguishes a type-only import from a value import", () => {
    const typed = collectModuleReferences(
      "x.ts",
      'import type { W } from "./w.js";\n',
    );
    expect(typed.references[0]).toMatchObject({
      specifier: "./w.js",
      kind: "import-type",
    });
    const value = collectModuleReferences(
      "x.ts",
      'import { W } from "./w.js";\n',
    );
    expect(value.references[0]?.kind).toBe("import");
  });

  it("records a type query and a non-literal dynamic import", () => {
    const collected = collectModuleReferences(
      "x.ts",
      'type T = import("./w.js").W;\nconst p = name; await import(p);\n',
    );
    expect(collected.references[0]?.kind).toBe("type-query");
    expect(collected.nonLiteralDynamic).toHaveLength(1);
  });

  it("collects literal require calls as module references", () => {
    const collected = collectModuleReferences("x.ts", 'const widget = require("./widget.js");\n');
    expect(collected.references).toContainEqual({ specifier: "./widget.js", line: 1, kind: "require" });
  });
});

describe("direction fixtures", () => {
  it("accepts an allowed application -> contracts edge", () => {
    const { result } = evaluateFixture({
      "client/contracts/session-port.ts": leaf,
      "client/application/app.ts": 'import { leaf } from "../contracts/session-port.js";\nexport const use = leaf;\n',
    });
    expect(result.direction).toHaveLength(0);
    expect(result.pass).toBe(true);
  });

  it("rejects application -> components", () => {
    const { result } = evaluateFixture({
      "client/components/Widget.tsx": widget,
      "client/application/app.ts": 'import { widget } from "../components/Widget.js";\nexport const use = widget;\n',
    });
    expect(result.direction).toHaveLength(1);
    expect(result.direction[0]).toMatchObject({
      from: "client/application/app.ts",
      to: "client/components/Widget.tsx",
      layerFrom: ["application"],
      layerTo: ["bindings"],
    });
  });

  it("rejects an application -> React import", () => {
    const { result } = evaluateFixture({
      "client/application/app.ts": 'import { useState } from "react";\nexport const use = useState;\n',
    });
    expect(result.browserOnly).toHaveLength(1);
    expect(result.browserOnly[0]).toMatchObject({
      kind: "browser-only",
      file: "client/application/app.ts",
      specifier: "react",
    });
    expect(BROWSER_ONLY_MODULES_RE.test("react-dom/client")).toBe(true);
  });

  it("resolves a tsconfig alias to an actual component edge", () => {
    const { graph, result } = evaluateFixture({
      "client/components/Widget.tsx": widget,
      "client/application/app.ts": 'import { widget } from "@/components/Widget.js";\nexport const use = widget;\n',
    }, { ...compilerOptions, paths: { "@/*": ["client/*"] } });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: "client/application/app.ts",
      to: "client/components/Widget.tsx",
      kind: "import",
    }));
    expect(result.direction).toHaveLength(1);
  });

  it("rejects an unresolved configured alias instead of treating it as a package import", () => {
    const { result } = evaluateFixture({
      "client/application/app.ts": 'import { missing } from "@/components/Missing.js";\nexport const use = missing;\n',
    }, { ...compilerOptions, paths: { "@/*": ["client/*"] } });
    expect(result.unresolved).toHaveLength(1);
    expect(result.pass).toBe(false);
  });

  it("rejects direct document and storage globals in application and components", () => {
    const { result } = evaluateFixture({
      "client/application/app.ts": 'export const current = document.title;\n',
      "client/components/Widget.tsx": 'export const saved = localStorage.getItem("k");\n',
      "client/bindings/Other.ts": 'export const tab = sessionStorage.getItem("k");\n',
    });
    expect(result.browserGlobals.map((entry) => entry.global)).toEqual([
      "document", "localStorage", "sessionStorage",
    ]);
  });

  it("rejects a runtime transfer implementation importing the server", () => {
    const { result } = evaluateFixture({
      "server/http/route.ts": leaf,
      "runtime/session-transfer.ts": 'import { leaf } from "../server/http/route.js";\nexport const use = leaf;\n',
    });
    expect(classifyLayers("runtime/session-transfer.ts")).toEqual(["runtime"]);
    expect(result.direction).toHaveLength(1);
    expect(result.direction[0]).toMatchObject({
      from: "runtime/session-transfer.ts",
      to: "server/http/route.ts",
      layerFrom: ["runtime"],
    });
  });

  it("rejects shared Node builtins", () => {
    const { result } = evaluateFixture({
      "shared/contracts/node.ts": 'import { readFileSync } from "node:fs";\nexport const read = readFileSync("/x");\n',
    });
    expect(result.sharedNodeBuiltins).toHaveLength(1);
    expect(result.sharedNodeBuiltins[0]).toMatchObject({
      file: "shared/contracts/node.ts",
      specifier: "node:fs",
    });
  });

  it("keeps the relative component negative control rejected", () => {
    const { result } = evaluateFixture({
      "client/components/Widget.tsx": widget,
      "client/application/app.ts": 'import { widget } from "../components/Widget.js";\nexport const use = widget;\n',
    });
    expect(result.direction).toHaveLength(1);
  });

  it("rejects a runtime -> browser-only import", () => {
    const { result } = evaluateFixture({
      "runtime/harness/adapter.ts": 'import { createElement } from "react";\nexport const use = createElement;\n',
    });
    expect(result.browserOnly).toHaveLength(1);
    expect(result.browserOnly[0]).toMatchObject({ file: "runtime/harness/adapter.ts" });
  });

  it("rejects shared -> client", () => {
    const { result } = evaluateFixture({
      "client/application/app.ts": leaf,
      "shared/contracts/session.ts": 'import { leaf } from "../../client/application/app.js";\nexport const use = leaf;\n',
    });
    expect(result.direction).toHaveLength(1);
    expect(result.direction[0]).toMatchObject({
      layerFrom: ["shared"],
      layerTo: ["application"],
    });
  });

  it("rejects a pure domain projection -> concrete transport", () => {
    const { result } = evaluateFixture({
      "client/infrastructure/transport.ts": leaf,
      "client/projection/plan-mode.ts": 'import { leaf } from "../infrastructure/transport.js";\nexport const use = leaf;\n',
    });
    expect(result.direction).toHaveLength(1);
    expect(result.direction[0]).toMatchObject({
      layerFrom: ["domain"],
      layerTo: ["infrastructure"],
    });
  });
});

describe("require() direction fixtures", () => {
  it("rejects a cross-layer dependency hidden behind require()", () => {
    const { graph, result } = evaluateFixture({
      "client/components/Widget.tsx": widget,
      "client/application/consumer.ts": 'const Widget = require("../components/Widget.js");\nexport { Widget };\n',
    });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: "client/application/consumer.ts",
      to: "client/components/Widget.tsx",
      kind: "require",
    }));
    expect(result.direction).toHaveLength(1);
  });
});

describe("what the metafile cannot see", () => {
  it("rejects a violation expressed only as an import type", () => {
    const { result } = evaluateFixture({
      "client/components/Widget.tsx": widget,
      "client/application/app.ts": 'import type { Widget } from "../components/Widget.js";\nexport type Use = Widget;\n',
    });
    expect(result.direction).toHaveLength(1);
    expect(result.direction[0]).toMatchObject({
      referenceKind: "import-type",
      layerFrom: ["application"],
      layerTo: ["bindings"],
    });
  });

  it("rejects a forbidden edge hidden behind a type-only re-export barrel", () => {
    const { result } = evaluateFixture({
      "client/components/Widget.tsx": widget,
      "client/contracts/barrel.ts": 'export type { Widget } from "../components/Widget.js";\n',
      "client/application/consumer.ts": 'import type { Widget } from "../contracts/barrel.js";\nexport type Use = Widget;\n',
    });
    // The application -> barrel edge is legal (application may import contracts)…
    expect(
      result.direction.some(
        (violation) => violation.to === "client/contracts/barrel.ts",
      ),
    ).toBe(false);
    // …but the barrel's own type-only re-export of a component is caught.
    expect(
      result.direction.some(
        (violation) =>
          violation.from === "client/contracts/barrel.ts" &&
          violation.to === "client/components/Widget.tsx" &&
          violation.layerFrom.join() === "contracts",
      ),
    ).toBe(true);
  });

  it("rejects a violation expressed as a literal dynamic import", () => {
    const { result } = evaluateFixture({
      "client/components/Widget.tsx": widget,
      "client/application/app.ts": 'export const load = async () => import("../components/Widget.js");\n',
    });
    expect(result.direction).toHaveLength(1);
    expect(result.direction[0]).toMatchObject({
      referenceKind: "dynamic",
      layerTo: ["bindings"],
    });
  });
});

describe("structural failures", () => {
  it("rejects an unresolved intra-package import", () => {
    const { result } = evaluateFixture({
      "client/application/app.ts": 'import { missing } from "../components/Missing.js";\nexport const use = missing;\n',
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({ kind: "unresolved" });
    expect(result.pass).toBe(false);
  });

  it("rejects a non-literal dynamic import", () => {
    const { result } = evaluateFixture({
      "client/application/app.ts": 'export const load = async (name: string) => import(name);\n',
    });
    expect(result.nonLiteralDynamic).toHaveLength(1);
    expect(result.nonLiteralDynamic[0]).toMatchObject({ kind: "non-literal-dynamic" });
  });

  it("detects an import cycle even when every edge is directionally legal", () => {
    const { graph, result } = evaluateFixture({
      "client/components/A.tsx": 'import { b } from "./B.js";\nexport const a = b;\n',
      "client/components/B.tsx": 'import { a } from "./A.js";\nexport const b = a;\n',
    });
    expect(result.direction).toHaveLength(0);
    expect(result.cycles).toHaveLength(1);
    const [cycle] = detectCycles(graph.edges);
    expect(cycle).toBeDefined();
    expect(canonicalCycle(cycle as string[])).toContain("client/components/A.tsx");
    expect(canonicalCycle(cycle as string[])).toContain("client/components/B.tsx");
  });
});

describe("baseline comparison", () => {
  it("reports a new violation and a stale entry", () => {
    const violation = {
      kind: "direction" as const,
      from: "client/application/app.ts",
      to: "client/components/Widget.tsx",
      line: 1,
      referenceKind: "import",
      layerFrom: ["application"],
      layerTo: ["bindings"],
      rule: "application -> bindings",
      category: "unclassified",
      detail: "",
    };
    const entry = toBaselineShape([violation])[0];
    expect(entry).toBeDefined();
    const staleEntry = {
      ...(entry as NonNullable<typeof entry>),
      from: "client/other.ts",
      to: "client/gone.ts",
    };
    const { newViolations, staleEntries } = compareBaseline(
      [violation],
      [entry as NonNullable<typeof entry>, staleEntry],
    );
    expect(newViolations).toHaveLength(0);
    expect(staleEntries.map((item) => pairKey(item.from, item.to))).toEqual([
      "client/other.ts -> client/gone.ts",
    ]);
    const invented = {
      ...violation,
      from: "client/application/other.ts",
    };
    expect(compareBaseline([violation, invented], [entry as NonNullable<typeof entry>]).newViolations)
      .toHaveLength(1);
  });
});

describe("the gate runs and matches the frozen baseline", () => {
  it("reports existing forbidden browser globals instead of hiding them", () => {
    const baseline = JSON.parse(readFileSync(realBaselinePath, "utf8"));
    const run = runCli(["--json"]);
    const summary = JSON.parse(run.stdout);
    expect(run.status).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.browserGlobals.length).toBeGreaterThan(0);
    expect(summary.baselinePairs).toBe((baseline.entries ?? []).length);
    expect(summary.cycles).toHaveLength((baseline.cycles ?? []).length);
    expect(summary.newViolations).toHaveLength(0);
    expect(summary.staleEntries).toHaveLength(0);
    expect(summary.newCycles).toHaveLength(0);
    expect(summary.staleCycles).toHaveLength(0);
  });

  it("fails on a stale baseline entry", () => {
    const baseline = JSON.parse(
      spawnSync(process.execPath, [
        "-e",
        `process.stdout.write(require("fs").readFileSync(${JSON.stringify(realBaselinePath)},"utf8"))`,
      ], { encoding: "utf8" }).stdout,
    );
    baseline.entries.push({
      from: "client/does-not-exist.ts",
      to: "client/also-missing.ts",
      layerFrom: "view",
      layerTo: "bindings",
      rule: "view -> bindings",
      category: "projection-to-components",
      stage: 1,
      reason: "synthetic stale entry for the stale-entry test",
    });
    const fixtureBaseline = path.join(
      mkdtempSync(path.join(os.tmpdir(), "webui-dependency-baseline-")),
      "baseline.json",
    );
    temporaryRoots.push(path.dirname(fixtureBaseline));
    writeFileSync(fixtureBaseline, JSON.stringify(baseline));
    const run = runCli(["--json", "--baseline", fixtureBaseline]);
    expect(run.status).toBe(1);
    const summary = JSON.parse(run.stdout);
    expect(summary.ok).toBe(false);
    expect(summary.staleEntries.map((entry: { from: string }) => entry.from)).toContain(
      "client/does-not-exist.ts",
    );
  });
});
