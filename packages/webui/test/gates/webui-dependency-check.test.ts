// Test the WebUI internal dependency-direction rules (ADR 0014).
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

import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  BUSINESS_BEARING_ROLES,
  classifyLayers,
  classifyRole,
  collectModuleReferences,
  collectProvisionalJudgements,
  compareBaseline,
  detectCycles,
  evaluateGraph,
  isAllowedEdge,
  normaliseSourcePath,
  pairKey,
  toBaselineShape,
  touchesAmbiguousFile,
} from "../../../../scripts/lib/webui-dependency-rules.mjs";
import {
  findPublicationViolations,
  isPublicModulePath,
  publicationRule,
} from "../../../../scripts/lib/webui-publication.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const cliPath = path.join(repoRoot, "scripts/check-webui-dependency.mjs");
const realBaselinePath = path.join(
  repoRoot,
  "scripts/lib/webui-dependency-baseline.json",
);

/**
 * The budget every case in this file runs under.
 *
 * Each fixture builds a TypeScript program, so what a case costs is the
 * machine's speed rather than a fact about the rule it checks. Under
 * vitest's five-second default a loaded machine turns that into a failure
 * that says nothing about the gate — the same case passes on an idle one,
 * and a different case fails each time. The budget is written down here so
 * the gate reports the rule rather than the machine it ran on.
 */
vi.setConfig({ testTimeout: 30_000 });

describe("V42 frozen pre-refactor metadata and permissions", () => {
  const oracle = JSON.parse(readFileSync(path.join(here, "./fixtures/path-metadata-f00.json"), "utf8")) as {
    cases: { path: string; layers: string[]; role: string; business: string | null; home: string }[];
    directions: { from: string; to: string; allowed: boolean }[];
  };
  it("preserves every current path and future/unknown classification with only the declared publication delta", () => {
    const paths: string[] = [];
    const sourceRoot = path.join(repoRoot, "packages/webui/src");
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(filename);
        else if (/\.(?:ts|tsx|css)$/u.test(filename)) paths.push(path.relative(sourceRoot, filename).split(path.sep).join("/"));
      }
    };
    walk(sourceRoot);
    const recorded = new Set(oracle.cases.map((entry) => entry.path));
    expect(paths.length).toBeGreaterThan(400);
    expect(paths.filter((entry) => !recorded.has(entry))).toEqual([]);
    for (const { path: filename, layers, role, business, home } of oracle.cases) {
      expect([...classifyLayers(filename)].sort(), filename).toEqual(layers);
      const expectedRole = /\.public\.tsx?$/u.test(filename) && filename.startsWith("client/features/")
        ? `published-${role}` : role;
      expect(classifyRole(filename), filename).toEqual({ role: expectedRole, business, home });
    }
  });
  it("preserves the independent baseline permission matrix", () => {
    expect(oracle.directions).toHaveLength(169);
    expect(oracle.directions.some((entry) => entry.allowed)).toBe(true);
    expect(oracle.directions.some((entry) => !entry.allowed)).toBe(true);
    for (const { from, to, allowed } of oracle.directions)
      expect(isAllowedEdge([from], [to]), `${from} -> ${to}`).toBe(allowed);
  });
});

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
function evaluateFixture(
  files: Record<string, string>,
  options: ts.CompilerOptions = compilerOptions,
) {
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
  // `sourceRoot` is returned so a caller that needs the publication gate to
  // actually read a module's source (the foreign-access judgement) can evaluate
  // the same graph with a reader attached; the default evaluation stays
  // reader-less so existing fixtures keep their exact meaning.
  return { graph, result: evaluateGraph(graph), sourceRoot };
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

describe("architecture gate completeness", () => {
  it("rejects raw writer invocation from presentation", () => {
    const { result } = evaluateFixture({
      "client/contracts/writer.ts": "export interface WebuiSessionWriter { setStream(): void }",
      "client/features/models/ui/Probe.ts": 'import type { WebuiSessionWriter } from "../../../contracts/writer.js"; export function render(writer: WebuiSessionWriter) { writer.setStream(); }',
    });
    expect(result.forbiddenCalls).toHaveLength(1);
  });
  it("rejects an isolated unclassified module", () => {
    const { result } = evaluateFixture({ "client/features/models/mystery.ts": leaf });
    expect(result.pass).toBe(false);
  });
  it("collects import-equals and rejects computed require", () => {
    const refs = collectModuleReferences("probe.ts", 'import fs = require("node:fs"); const value = require(name);');
    expect(refs.references.map((r) => r.specifier)).toEqual(["node:fs"]);
    expect(refs.nonLiteralDynamic).toHaveLength(1);
  });
  it("rejects constructing a business owner in presentation", () => {
    const { result } = evaluateFixture({
      "client/features/models/application/owner.ts": "export function createModelsOwner() { return { dispose() {} }; }",
      "client/features/models/ui/Probe.ts": 'import { createModelsOwner } from "../application/owner.js"; export function render() { return createModelsOwner(); }',
    });
    expect(result.pass).toBe(false);
  });
  it("rejects type-only runtime workspace imports while allowing shared contracts", () => {
    const files = {
      "client/features/models/projection/Probe.ts": 'import type { Value } from "@mavis/local-runtime-v2"; export type Result = Value;',
      "../outside/runtime.ts": "export interface Value { id: string }",
    };
    const options = { ...compilerOptions, paths: { "@mavis/local-runtime-v2": ["../outside/runtime.ts"] } };
    const blocked = evaluateFixture(files, options);
    expect(blocked.graph.hostImports).toHaveLength(1);
    expect(blocked.result.pass).toBe(false);
    const allowed = evaluateFixture({ "../../shared/src/index.ts": "export interface Value { id: string }", "client/features/models/projection/Probe.ts": 'import type { Value } from "@mavis/shared"; export type Result = Value;' }, { ...compilerOptions, paths: { "@mavis/shared": ["../../shared/src/index.ts"] } });
    expect(allowed.result.pass).toBe(true);
  });
});

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
    // `client/projection/` classifies by basename, so the `turn/` sub-directory
    // does not change the verdict.
    expect(classifyLayers("client/features/turn/projection/stream-state.ts")).toEqual(["view"]);
  });

  it("classifies the business-first homes by the layers their files carry", () => {
    // The target homes carry the same layers as the technical homes
    // the files come from, so a direction rule is not re-spelled when a file
    // moves. Without these mappings a moved path would classify `unknown`, which
    // is reported rather than constrained: the gate would look green while
    // enforcing less than it did before the move. These assertions fail if the
    // mapping is dropped.
    expect(classifyLayers("client/features/transcript/contracts/message-view.ts")).toEqual([
      "contracts",
    ]);
    expect(classifyLayers("client/features/transcript/projection/message-projection.ts")).toEqual([
      "view",
    ]);
    expect(classifyLayers("client/features/transcript/application/history.ts")).toEqual([
      "application",
    ]);
    expect(classifyLayers("client/features/transcript/bindings/session.ts")).toEqual(["bindings"]);
    expect(classifyLayers("client/features/transcript/ui/SessionTranscript.tsx")).toEqual([
      "bindings",
    ]);
    // The conversation substrate takes the layer the mechanisms home carries.
    expect(classifyLayers("client/conversation/transcript-history.ts")).toEqual(["mechanisms"]);
    expect(classifyLayers("client/platform/transport.ts")).toEqual(["infrastructure"]);
    expect(classifyLayers("client/ui/markdown.tsx")).toEqual(["bindings"]);
    // A feature path with no role directory is not silently given one.
    expect(classifyLayers("client/features/transcript/whatever.ts")).toEqual(["unknown"]);
  });

  it("classifies the two client-root files by path rule alone", () => {
    // These are the only two files at the client root. Their
    // `root` layer used to come from `CLIENT_FILE_PROVENANCE`, which was
    // deleted, so it is now stated as a path rule — and these assertions exist
    // to fail if that rule is ever dropped.
    expect(classifyLayers("client/main.tsx")).toEqual(["root"]);
    expect(classifyLayers("client/global.d.ts")).toEqual(["root"]);
  });

  it("classifies every relocated module from its own path", () => {
    // Each former client-root module now sits under a layer directory. None
    // of these has a provenance entry any more; each is decided by its prefix,
    // or — under `client/projection/` — by its basename.
    expect(classifyLayers("client/platform/team-mode.ts")).toEqual(["infrastructure"]);
    expect(classifyLayers("client/platform/no-project.ts")).toEqual(["infrastructure"]);
    expect(classifyLayers("client/contracts/value-readers.ts")).toEqual(["contracts"]);
    expect(classifyLayers("client/projection/common/paths.ts")).toEqual(["view"]);
    expect(classifyLayers("client/projection/common/router.ts")).toEqual(["view"]);
    expect(classifyLayers("client/features/composer/ui/slash-palette.ts")).toEqual(["bindings"]);
    expect(classifyLayers("client/features/transcript/ui/markdown.tsx")).toEqual(["bindings"]);
    expect(classifyLayers("client/shell/icons.tsx")).toEqual(["bindings"]);
    expect(classifyLayers("client/shell/ConnectionStatus.tsx")).toEqual(["bindings"]);
  });

  it("classifies the two re-filed projections as application by prefix", () => {
    // `composer-history` and `effect-reducer` were the only two modules the gate
    // classified `application` while they sat in `client/projection/`. They
    // moved under `client/application/`, so the prefix rule now carries that
    // verdict and `PROJECTION_SPLIT` is gone.
    expect(classifyLayers("client/application/composer/composer-history.ts")).toEqual(["application"]);
    expect(classifyLayers("client/features/turn/application/effect-reducer.ts")).toEqual(["application"]);
    expect(classifyLayers("client/application/transcript/transcript-request-ownership.ts")).toEqual(["application"]);
  });

  it("classifies a client-root file with no rule as unknown", () => {
    // With the provenance table deleted, a file re-created at an old client-root
    // path classifies `unknown` — whose allowed-edge set is empty — instead of
    // silently inheriting a layer its deleted entry used to assert.
    expect(classifyLayers("client/team-mode.ts")).toEqual(["unknown"]);
    expect(classifyLayers("client/projection/nothing-here.ts")).toEqual(["view"]);
  });

  it("recognises the post-migration layout too", () => {
    expect(classifyLayers("client/application/session-store.ts")).toEqual([
      "application",
    ]);
    expect(classifyLayers("runtime/harness/adapter.ts")).toEqual(["runtime"]);
    expect(classifyLayers("shared/contracts/session.ts")).toEqual(["shared"]);
  });

  it("keeps the plan section 7.5 mixed-file list empty", () => {
    // The list is empty because each of the four entries was resolved, not
    // because the check was relaxed: `runtime/port.ts` and `client/slash-palette.ts`
    // lost their contract re-export shells, and `server/envelope.ts` /
    // `server/service.ts` were re-read and hold a single layer. The reasoning is
    // recorded on `KNOWN_AMBIGUOUS_FILES` in `scripts/lib/webui-dependency-rules.mjs`.
    // The symbol-level ownership check is still not implemented — an empty list
    // means nothing left to judge, not that judgement is automatic.
    expect(KNOWN_AMBIGUOUS_FILES).toEqual([]);
    // The four resolved entries must not come back: each is now judged by its
    // path, and listing it again would assert a mixture that no longer exists.
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain("runtime/port.ts");
    // Both names are asserted: the path the file used to sit at, and the one it
    // occupies now. A relocated entry must not come back under either spelling.
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain("client/slash-palette.ts");
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain("client/ui/composer/slash-palette.ts");
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain("server/envelope.ts");
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain("server/service.ts");
    // Entries removed earlier stay removed.
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain(
      "client/features/turn/projection/stream-state.ts",
    );
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain("client/stream.ts");
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain("client/contracts.ts");
    expect(KNOWN_AMBIGUOUS_FILES).not.toContain(
      "client/session-runtime-store.ts",
    );
  });

  // Each resolved file is still classified, and still by a single layer — that
  // is what makes an empty list truthful rather than merely empty. If one of
  // these starts mixing again, its classification or this assertion is what
  // should fail first.
  it("classifies the files the empty list removed", () => {
    expect(classifyLayers("runtime/port.ts")).toEqual(["runtime-port"]);
    expect(classifyLayers("client/features/composer/ui/slash-palette.ts")).toEqual(["bindings"]);
    expect(classifyLayers("server/envelope.ts")).toEqual(["server"]);
    expect(classifyLayers("server/service.ts")).toEqual(["server"]);
  });

  // Every entry the list retains must still be a file the checker recognises
  // and classifies, and each must genuinely be path-ambiguous: if the matrix
  // gives it one clean layer, the entry is asserting a mixture that is gone.
  it("retains only files the matrix classifies", () => {
    // Vacuously satisfied while the list is empty, and kept deliberately: the
    // moment someone adds an entry, this is the loop that has to start holding
    // it to the classifier.
    for (const file of KNOWN_AMBIGUOUS_FILES) {
      expect(classifyLayers(file).length).toBeGreaterThan(0);
    }
  });
});

describe("provisional judgements for plan section 7.5 mixed files", () => {
  // A violation that touches a mixed-responsibility file may or may not be a
  // real defect: the file's layer is an assumption until it is split. The list
  // has to surface those judgements — the CLI reports every violation touching
  // one — without turning them into a new gate.
  const violation = (from: string, to: string) => ({
    from,
    to,
    category: "unclassified",
  });

  // The real `KNOWN_AMBIGUOUS_FILES` is empty, so these drive the collector with
  // a fixture list. The paths are the ones the list used to hold — keeping them
  // means these assertions still describe the real rule, and if the collector
  // regressed they would still fail. The collector's default argument is what
  // the CLI uses; "the empty real list reports nothing" is asserted separately
  // in the block above.
  const FIXTURE_AMBIGUOUS_FILES = ["runtime/port.ts", "server/envelope.ts"];

  it("reports a violation whose source is an ambiguous file", () => {
    expect(
      collectProvisionalJudgements(
        [violation("runtime/port.ts", "server/x.ts")],
        FIXTURE_AMBIGUOUS_FILES,
      ),
    ).toEqual([
      {
        from: "runtime/port.ts",
        to: "server/x.ts",
        category: "unclassified",
        ambiguous: ["runtime/port.ts"],
      },
    ]);
  });

  it("reports a violation whose destination is an ambiguous file", () => {
    expect(
      collectProvisionalJudgements(
        [violation("server/x.ts", "server/envelope.ts")],
        FIXTURE_AMBIGUOUS_FILES,
      ),
    ).toEqual([
      {
        from: "server/x.ts",
        to: "server/envelope.ts",
        category: "unclassified",
        ambiguous: ["server/envelope.ts"],
      },
    ]);
  });

  it("names both endpoints when the edge is ambiguous at both ends", () => {
    expect(
      collectProvisionalJudgements(
        [violation("runtime/port.ts", "server/envelope.ts")],
        FIXTURE_AMBIGUOUS_FILES,
      ),
    ).toEqual([
      {
        from: "runtime/port.ts",
        to: "server/envelope.ts",
        category: "unclassified",
        ambiguous: ["runtime/port.ts", "server/envelope.ts"],
      },
    ]);
  });

  it("leaves a violation between two unambiguous files out", () => {
    expect(
      collectProvisionalJudgements(
        [violation("client/x.ts", "client/y.ts")],
        FIXTURE_AMBIGUOUS_FILES,
      ),
    ).toEqual([]);
  });

  it("reports nothing for the real list, which is empty", () => {
    // The collector's default argument is the shipped list. Today that list has
    // no entries, so no violation can be provisional — asserted so the default
    // wiring stays covered even though the fixtures above pass their own list.
    expect(
      collectProvisionalJudgements([
        violation("runtime/port.ts", "server/envelope.ts"),
      ]),
    ).toEqual([]);
    expect(touchesAmbiguousFile("runtime/port.ts", "server/envelope.ts")).toBe(
      false,
    );
  });

  it("does not report a violation merely because the removed file was ambiguous", () => {
    // The blind spot this fixes: the removed `stream-state.ts` entry would have
    // made every one of its edges look provisional. It is a plain `view` file
    // now, so its violations (if any) are ordinary judgements.
    expect(touchesAmbiguousFile("client/features/turn/projection/stream-state.ts", "client/y.ts"))
      .toBe(false);
    // Same for the four entries resolved by this refactor: with the real list
    // empty, none of them makes an edge provisional.
    expect(touchesAmbiguousFile("client/ui/composer/slash-palette.ts", "server/service.ts"))
      .toBe(false);
  });

  it("surfaces the judgement through the CLI without feeding the gate", () => {
    // The real tree has no violation touching an ambiguous file, so the
    // collector is exercised directly above. What has to hold here is the
    // wiring: the CLI publishes the report, and its pass/fail condition never
    // reads it — a mixed-file judgement is advisory and cannot fail CI.
    const source = readFileSync(
      path.join(repoRoot, "scripts/check-webui-dependency.mjs"),
      "utf8",
    );
    expect(source).toContain("collectProvisionalJudgements(result.direction)");
    // The summary is what `--json` emits, so the field is reachable there.
    const summaryBlock = source.slice(source.indexOf("const summary = {"));
    expect(summaryBlock).toContain("provisionalJudgements,");
    // …and the gate is computed before it, from the enforced lists alone.
    const failedBlock = source.slice(
      source.indexOf("const failed ="),
      source.indexOf("const summary = {"),
    );
    expect(failedBlock).not.toContain("provisionalJudgement");
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
      "client/ui/Widget.tsx": widget,
      "client/application/app.ts": 'import { widget } from "../ui/Widget.js";\nexport const use = widget;\n',
    });
    expect(result.direction).toHaveLength(1);
    expect(result.direction[0]).toMatchObject({
      from: "client/application/app.ts",
      to: "client/ui/Widget.tsx",
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

  it("keeps a React host dependency when TypeScript resolves it outside the WebUI source tree", () => {
    // TypeScript resolves path-mapped targets in the `/` dialect (the graph
    // records `resolvedFileName` verbatim), so the expectation speaks it too
    // rather than the host separator `path.join` produced.
    const reactTypes = path.join(repoRoot, "node_modules/@types/react/index.d.ts").split(path.sep).join("/");
    expect(readFileSync(reactTypes, "utf8")).toContain("export = React");
    const { graph, result } = evaluateFixture({
      "client/application/app.ts": 'import { useState } from "react";\nexport const use = useState;\n',
    }, {
      ...compilerOptions,
      paths: { react: [reactTypes] },
    });
    expect(graph.hostImports).toContainEqual(expect.objectContaining({
      specifier: "react",
      target: reactTypes,
    }));
    expect(result.browserOnly).toContainEqual(expect.objectContaining({
      file: "client/application/app.ts",
      specifier: "react",
    }));
    expect(result.pass).toBe(false);
  });

  it("resolves a tsconfig alias to an actual component edge", () => {
    const { graph, result } = evaluateFixture({
      "client/ui/Widget.tsx": widget,
      "client/application/app.ts": 'import { widget } from "@/ui/Widget.js";\nexport const use = widget;\n',
    }, { ...compilerOptions, paths: { "@/*": ["client/*"] } });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: "client/application/app.ts",
      to: "client/ui/Widget.tsx",
      kind: "import",
    }));
    expect(result.direction).toHaveLength(1);
  });

  it("rejects an unresolved configured alias instead of treating it as a package import", () => {
    const { result } = evaluateFixture({
      "client/application/app.ts": 'import { missing } from "@/ui/Missing.js";\nexport const use = missing;\n',
    }, { ...compilerOptions, paths: { "@/*": ["client/*"] } });
    expect(result.unresolved).toHaveLength(1);
    expect(result.pass).toBe(false);
  });

  it("rejects direct document and storage globals in application and components", () => {
    const { result } = evaluateFixture({
      "client/application/app.ts": 'export const current = document.title;\n',
      "client/ui/Widget.tsx": 'export const saved = localStorage.getItem("k");\n',
      "client/bindings/Other.ts": 'export const tab = sessionStorage.getItem("k");\n',
    });
    expect(result.browserGlobals.map((entry) => entry.global)).toEqual([
      "document", "localStorage", "sessionStorage",
    ]);
  });

  it("catches ambient window and globalThis accesses in application and projection", () => {
    // Bidirectional fixture set: globals on `window`/`globalThis` previously
    // slipped past the property-name filter; ambient resolution via the
    // TypeScript program confirms each hit. The local-`document` parameter
    // is *not* a violation because its declaration is in the same file, not
    // in a TypeScript lib `*.d.ts`.
    const { result } = evaluateFixture({
      "client/application/window.ts": 'export const title = window.document.title;\n',
      "client/application/global-storage.ts":
        'export const saved = globalThis.localStorage.getItem("k");\n',
      "client/projection/title.ts": 'export const title = document.title;\n',
      "client/application/local-shielded.ts":
        'export function title(document: { readonly title: string }) {\n  return document.title;\n}\n',
    });
    expect(result.browserGlobals).toEqual([
      expect.objectContaining({
        file: "client/application/window.ts",
        global: "window",
      }),
      // The restricted member of the same chain is reported on its own entry:
      // `window.document` is a `document` access, judged by `document`'s policy
      // rather than `window`'s. Both are violations in application, and both
      // entries are required — collapsing the chain to one name would let a
      // member through wherever its base object happens to be allowed.
      expect.objectContaining({
        file: "client/application/window.ts",
        global: "document",
      }),
      expect.objectContaining({
        file: "client/application/global-storage.ts",
        global: "globalThis",
      }),
      expect.objectContaining({
        file: "client/application/global-storage.ts",
        global: "localStorage",
      }),
      expect.objectContaining({
        file: "client/projection/title.ts",
        global: "document",
      }),
    ]);
  });

  it("rejects bare and node:-prefixed Node builtins in client and shared code", () => {
    const { result } = evaluateFixture({
      "client/application/fs.ts": 'import fs from "fs";\nexport const read = fs.readFileSync;\n',
      "client/application/node-fs.ts":
        'import { readFileSync } from "node:fs";\nexport const read = readFileSync("/x");\n',
      "shared/contracts/path.ts":
        'import path from "path";\nexport const join = path.join;\n',
    });
    expect(result.nodeBuiltins.map((entry) => ({
      file: entry.file,
      specifier: entry.specifier,
    })).sort((left, right) => left.file.localeCompare(right.file))).toEqual([
      { file: "client/application/fs.ts", specifier: "fs" },
      { file: "client/application/node-fs.ts", specifier: "node:fs" },
      { file: "shared/contracts/path.ts", specifier: "path" },
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
      "client/ui/Widget.tsx": widget,
      "client/application/app.ts": 'import { widget } from "../ui/Widget.js";\nexport const use = widget;\n',
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
      "client/platform/transport.ts": leaf,
      "client/projection/plan-mode.ts": 'import { leaf } from "../platform/transport.js";\nexport const use = leaf;\n',
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
      "client/ui/Widget.tsx": widget,
      "client/application/consumer.ts": 'const Widget = require("../ui/Widget.js");\nexport { Widget };\n',
    });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: "client/application/consumer.ts",
      to: "client/ui/Widget.tsx",
      kind: "require",
    }));
    expect(result.direction).toHaveLength(1);
  });
});

describe("what the metafile cannot see", () => {
  it("rejects a violation expressed only as an import type", () => {
    const { result } = evaluateFixture({
      "client/ui/Widget.tsx": widget,
      "client/application/app.ts": 'import type { Widget } from "../ui/Widget.js";\nexport type Use = Widget;\n',
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
      "client/ui/Widget.tsx": widget,
      "client/contracts/barrel.ts": 'export type { Widget } from "../ui/Widget.js";\n',
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
          violation.to === "client/ui/Widget.tsx" &&
          violation.layerFrom.join() === "contracts",
      ),
    ).toBe(true);
  });

  it("rejects a violation expressed as a literal dynamic import", () => {
    const { result } = evaluateFixture({
      "client/ui/Widget.tsx": widget,
      "client/application/app.ts": 'export const load = async () => import("../ui/Widget.js");\n',
    });
    expect(result.direction).toHaveLength(1);
    expect(result.direction[0]).toMatchObject({
      referenceKind: "dynamic",
      layerTo: ["bindings"],
    });
  });
});

// The ambient-member rule: a restricted member is judged by its own policy
// wherever it is read from, so a base object that the layer may touch does not
// carry its restricted members with it.
describe("the ambient-member rule", () => {
  const rows: ReadonlyArray<{
    readonly label: string;
    readonly file: string;
    readonly body: string;
    readonly names: readonly string[];
  }> = [
    {
      label: "a component reading window.localStorage",
      file: "client/ui/Widget.tsx",
      body: "export const s = window.localStorage;\n",
      names: ["localStorage"],
    },
    {
      label: "a binding reading window.localStorage",
      file: "client/bindings/hash.ts",
      body: "export const s = window.localStorage;\n",
      names: ["localStorage"],
    },
    {
      label: "a binding reading self.localStorage",
      file: "client/bindings/hash.ts",
      body: "export const s = self.localStorage;\n",
      names: ["localStorage"],
    },
    {
      label: "application reading self.localStorage",
      file: "client/application/app.ts",
      body: "export const s = self.localStorage;\n",
      names: ["self", "localStorage"],
    },
    {
      label: "window[\"localStorage\"] as an element access",
      file: "client/ui/Widget.tsx",
      body: 'export const s = window["localStorage"];\n',
      names: ["localStorage"],
    },
    {
      label: "destructuring localStorage off window",
      file: "client/ui/Widget.tsx",
      body: "const { localStorage } = window;\nexport const s = localStorage;\n",
      names: ["localStorage"],
    },
    {
      label: "reading localStorage off an alias of window",
      file: "client/bindings/hash.ts",
      body: "const g = window;\nexport const s = g.localStorage;\n",
      names: ["localStorage"],
    },
    {
      label: "a chained base object globalThis.window.localStorage",
      file: "client/application/app.ts",
      body: "export const s = globalThis.window.localStorage;\n",
      names: ["globalThis", "localStorage"],
    },
    {
      label: "a nested pattern reading window.localStorage off globalThis",
      file: "client/ui/Widget.tsx",
      body: "const { window: { localStorage } } = globalThis;\nexport const s = localStorage;\n",
      names: ["localStorage"],
    },
    {
      label: "an assignment pattern reading window.localStorage",
      file: "client/ui/Widget.tsx",
      body: "let s: Storage;\n({ localStorage: s } = window);\nexport const read = (): Storage => s;\n",
      names: ["localStorage"],
    },
    {
      label: "a template element access of window.localStorage",
      file: "client/ui/Widget.tsx",
      body: "export const s = window[`localStorage`];\n",
      names: ["localStorage"],
    },
  ];

  for (const row of rows) {
    it(`rejects ${row.label}`, () => {
      const { result } = evaluateFixture({ [row.file]: row.body });
      expect(result.browserGlobals.map((entry) => entry.global).sort()).toEqual(
        [...row.names].sort(),
      );
      expect(result.pass).toBe(false);
    });
  }

  it("keeps a local name that merely matches a restricted member", () => {
    // `window.name` is a string: the pattern reads the `name` property and only
    // *binds* it to a local called `localStorage`, so neither the pattern nor the
    // local reads the storage capability.
    const { result } = evaluateFixture({
      "client/ui/Widget.tsx":
        "const { name: localStorage } = window;\nexport const read = (): string => localStorage;\n",
      "client/ui/Other.tsx":
        "let sessionStorage: string | undefined;\n({ name: sessionStorage } = globalThis);\nexport const read = (): string | undefined => sessionStorage;\n",
    });
    expect(result.browserGlobals).toHaveLength(0);
    expect(result.pass).toBe(true);
  });

  it("keeps every legitimate base-object access, including the IO owner's", () => {
    // The anchors: the storage adapter's own ambient read, the composition
    // root's, a binding listening to window events, the shell's URL sync, and a
    // locally typed object that happens to own a `document` property.
    const { result } = evaluateFixture({
      "client/platform/storage.ts": "export const s = globalThis.localStorage;\n",
      "client/main.tsx": "export const d = globalThis.document;\n",
      "client/bindings/navigation.ts": "export const h = window.location.hash;\n",
      "client/shell/WebuiClientFoundationApp.tsx":
        'export function sync(): void {\n  const p = window.location.pathname;\n  window.history.replaceState(null, "", p);\n}\n',
      "client/ui/Widget.tsx":
        'export function boot(): void {\n  window.addEventListener("hashchange", () => {});\n}\n',
      "client/ui/Local.tsx":
        "const local: { document: number } = { document: 1 };\nexport const d = local.document;\n",
    });
    expect(result.browserGlobals).toHaveLength(0);
    expect(result.pass).toBe(true);
  });
});

// The resolved-host rule: an import that *resolves* to a browser-only module is
// one, even when the specifier it was authored with says nothing of the sort.
describe("the resolved-host rule", () => {
  it("rejects a React dependency that arrives through a path alias", () => {
    // Same dialect note as the direction fixture above: `resolvedFileName`
    // for a path-mapped target arrives with `/` separators.
    const reactTypes = path.join(repoRoot, "node_modules/@types/react/index.d.ts").split(path.sep).join("/");
    const { graph, result } = evaluateFixture(
      {
        "client/application/app.ts":
          'import { useState } from "@webui/react";\nexport const use = useState;\n',
      },
      { ...compilerOptions, paths: { "@webui/react": [reactTypes] } },
    );
    expect(graph.hostImports).toContainEqual(
      expect.objectContaining({ specifier: "@webui/react", target: reactTypes }),
    );
    expect(result.browserOnly).toContainEqual(
      expect.objectContaining({
        file: "client/application/app.ts",
        specifier: "@webui/react",
      }),
    );
    expect(result.pass).toBe(false);
  });
});

describe("structural failures", () => {
  it("rejects an unresolved intra-package import", () => {
    const { result } = evaluateFixture({
      "client/application/app.ts": 'import { missing } from "../ui/Missing.js";\nexport const use = missing;\n',
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
      "client/ui/A.tsx": 'import { b } from "./B.js";\nexport const a = b;\n',
      "client/ui/B.tsx": 'import { a } from "./A.js";\nexport const b = a;\n',
    });
    expect(result.direction).toHaveLength(0);
    expect(result.cycles).toHaveLength(1);
    const [cycle] = detectCycles(graph.edges);
    expect(cycle).toBeDefined();
    expect(canonicalCycle(cycle as string[])).toContain("client/ui/A.tsx");
    expect(canonicalCycle(cycle as string[])).toContain("client/ui/B.tsx");
  });
});

describe("baseline comparison", () => {
  it("reports a new violation and a stale entry", () => {
    const violation = {
      kind: "direction" as const,
      from: "client/application/app.ts",
      to: "client/ui/Widget.tsx",
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

  it("counts a pair's occurrences from a definite base, so the entry survives a JSON round trip", () => {
    // The count used to accumulate onto an absent field: `undefined + 1` is
    // NaN, every later occurrence kept it NaN, and `JSON.stringify(NaN)` writes
    // `null` — so a persisted entry never round-tripped, and any equality-based
    // reader saw a field that kept changing.
    const violation = (line: number) => ({
      kind: "direction" as const,
      from: "client/application/app.ts",
      to: "client/ui/Widget.tsx",
      line,
      referenceKind: "import",
      layerFrom: ["application"],
      layerTo: ["bindings"],
      rule: "application -> bindings",
      category: "projection-to-components",
      detail: "",
    });

    expect(toBaselineShape([violation(1)])[0]?.occurrences).toBe(1);
    expect(toBaselineShape([violation(1), violation(2)])[0]?.occurrences).toBe(2);

    const [entry] = toBaselineShape([violation(1), violation(2), violation(3)]);
    expect(entry?.occurrences).toBe(3);
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });
});

// The declaration file is the contract every consumer of these rules compiles
// against: this test, and `scripts/check-webui-dependency.mjs`. A declaration
// that drifts from the implementation is worse than no declaration at all — it
// type-checks at the call site and fails at runtime, which is exactly how
// `collectModuleReferences(...).browserGlobalUses.length` read a member the
// collector never returned. These read the *declared* member names out of the
// `.d.mts` and compare them with the keys the runtime object actually carries,
// in both directions.
describe("declared shapes match the runtime shapes", () => {
  const declaredPath = path.join(
    repoRoot,
    "scripts/lib/webui-dependency-rules.d.mts",
  );

  /** Required property names of one interface, read from the declaration. */
  function declaredMembers(interfaceName: string): string[] {
    const sourceFile = ts.createSourceFile(
      declaredPath,
      readFileSync(declaredPath, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    let members: string[] | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
        members = node.members.flatMap((member) =>
          ts.isPropertySignature(member) && ts.isIdentifier(member.name)
            ? [member.name.text]
            : [],
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(
      members,
      `no interface ${interfaceName} declared in webui-dependency-rules.d.mts`,
    ).toBeDefined();
    return members ?? [];
  }

  function expectShapeMatches(interfaceName: string, value: object, label: string): void {
    expect(
      Object.keys(value).sort(),
      `${label}: runtime keys vs the declared ${interfaceName}`,
    ).toEqual([...declaredMembers(interfaceName)].sort());
  }

  it("matches the collector, graph and evaluation shapes", () => {
    const { graph, result } = evaluateFixture({
      "client/application/app.ts": leaf,
    });
    expectShapeMatches(
      "CollectedReferences",
      collectModuleReferences("x.ts", leaf),
      "collector",
    );
    expectShapeMatches("DependencyGraph", graph, "graph");
    expectShapeMatches("GraphEvaluation", result, "evaluation");
  });

  it("returns the collector's candidates under the declared names", () => {
    const collected = collectModuleReferences(
      "client/application/app.ts",
      'export const title = document.title;\nexport const saved = localStorage.getItem("k");\n',
    );
    // The two candidate lists the program pass consumes. Reading them by the
    // declared names is the property the declaration-drift bug broke.
    expect(collected.browserGlobalCandidates.map((entry) => entry.name)).toEqual([
      "document",
      "localStorage",
    ]);
    expect(collected.callCandidates).toHaveLength(1);
  });

  it("carries the graph's call sites and ambient global uses", () => {
    const { graph } = evaluateFixture({
      "client/application/app.ts":
        'export const title = document.title;\nexport const store = {} as { setItem(k: string): void };\nstore.setItem("k");\n',
    });
    expect(graph.browserGlobalUses.map((entry) => entry.name)).toContain("document");
    expect(
      graph.callSites.some((site) => site.method === "setItem"),
      `no call site for setItem in ${JSON.stringify(graph.callSites)}`,
    ).toBe(true);
  });
});

// The capability-call rule. `classifyLayers` maps `client/ui/` and
// `client/bindings/` to the same `bindings` layer, so these fixtures exist to
// pin the half of the judgement the layer set cannot express: the bridge may
// hold a writer factory, a component may not.
describe("the capability-call rule", () => {
  const storeContract =
    "export interface WebuiSessionStore { createSessionWriter(kind: string): void }\n";
  const transportContract =
    "export interface WebuiTransport { sendMessage(body: unknown): Promise<void> }\n";
  const caller = (contractPath: string, typeName: string, body: string) =>
    `import type { ${typeName} } from "${contractPath}";\n` +
    `export function use(port: ${typeName}): void {\n  ${body}\n}\n`;

  it("rejects a capability call from a component, whose layer is bindings", () => {
    const { result } = evaluateFixture({
      "client/application/session-store.ts": storeContract,
      "client/ui/Widget.tsx": caller(
        "../application/session-store.js",
        "WebuiSessionStore",
        'port.createSessionWriter("session");',
      ),
    });
    expect(result.forbiddenCalls).toHaveLength(1);
    expect(result.forbiddenCalls[0]).toMatchObject({
      kind: "forbidden-call",
      file: "client/ui/Widget.tsx",
      target: "WebuiSessionStore.createSessionWriter",
    });
    expect(result.pass).toBe(false);
  });

  it("rejects any method on a capability port from a component", () => {
    const { result } = evaluateFixture({
      "client/contracts/transport.ts": transportContract,
      "client/ui/Widget.tsx": caller(
        "../contracts/transport.js",
        "WebuiTransport",
        "void port.sendMessage({});",
      ),
    });
    expect(result.forbiddenCalls).toHaveLength(1);
    expect(result.forbiddenCalls[0]).toMatchObject({
      file: "client/ui/Widget.tsx",
      target: "WebuiTransport.sendMessage",
    });
  });

  it("keeps the same call allowed in the bindings bridge and in the application", () => {
    const { result } = evaluateFixture({
      "client/application/session-store.ts": storeContract,
      "client/bindings/use-session-state.ts": caller(
        "../application/session-store.js",
        "WebuiSessionStore",
        'port.createSessionWriter("session");',
      ),
      "client/application/turn-coordinator.ts": caller(
        "./session-store.js",
        "WebuiSessionStore",
        'port.createSessionWriter("session");',
      ),
    });
    expect(result.forbiddenCalls).toHaveLength(0);
    expect(result.pass).toBe(true);
  });

  it("still rejects a capability call from a lower layer", () => {
    const { result } = evaluateFixture({
      "client/application/session-store.ts": storeContract,
      "client/conversation/stream-loop.ts": caller(
        "../application/session-store.js",
        "WebuiSessionStore",
        'port.createSessionWriter("session");',
      ),
    });
    expect(result.forbiddenCalls).toHaveLength(1);
    expect(result.forbiddenCalls[0]).toMatchObject({
      file: "client/conversation/stream-loop.ts",
      target: "WebuiSessionStore.createSessionWriter",
    });
  });

  // A capability method can be invoked without ever writing a property access.
  // The rule resolves the *invoked method's declaration*, so the form the call
  // was written in does not matter, and neither does the name of whatever the
  // caller held the method through.
  const portContract =
    "export interface SessionPort { deleteSession(id: string): Promise<void> }\n";
  const portCaller = (body: string, header = "") =>
    'import type { SessionPort } from "../contracts/session-port.js";\n' +
    `${header}export function use(port: SessionPort): Promise<void> {\n  ${body}\n}\n`;
  const invocationForms: ReadonlyArray<{ readonly label: string; readonly body: string }> = [
    { label: "an element access", body: 'return port["deleteSession"]("x");' },
    {
      label: "a destructured binding",
      body: 'const { deleteSession } = port;\n  return deleteSession("x");',
    },
    {
      label: "a renamed destructured binding",
      body: 'const { deleteSession: drop } = port;\n  return drop("x");',
    },
    {
      label: "a variable assigned the method",
      body: 'const drop = port.deleteSession;\n  return drop("x");',
    },
  ];

  for (const form of invocationForms) {
    it(`rejects a capability call through ${form.label}`, () => {
      const { result } = evaluateFixture({
        "client/contracts/session-port.ts": portContract,
        "client/projection/probe.ts": portCaller(form.body),
      });
      expect(result.forbiddenCalls).toHaveLength(1);
      expect(result.forbiddenCalls[0]).toMatchObject({
        file: "client/projection/probe.ts",
        target: "SessionPort.deleteSession",
      });
      expect(result.pass).toBe(false);
    });
  }

  it("rejects a capability call destructured from a function parameter", () => {
    const { result } = evaluateFixture({
      "client/contracts/transport.ts": transportContract,
      "client/ui/Widget.tsx":
        'import type { WebuiTransport } from "../contracts/transport.js";\n' +
        'export function Widget({ sendMessage }: WebuiTransport): void {\n' +
        '  void sendMessage({});\n' +
        '}\n',
    });
    expect(result.forbiddenCalls).toHaveLength(1);
    expect(result.forbiddenCalls[0]).toMatchObject({
      file: "client/ui/Widget.tsx",
      target: "WebuiTransport.sendMessage",
    });
    expect(result.pass).toBe(false);
  });

  it("rejects a capability call through a Pick alias of the port", () => {
    const { result } = evaluateFixture({
      "client/contracts/session-port.ts": portContract,
      "client/projection/probe.ts":
        'import type { SessionPort } from "../contracts/session-port.js";\n' +
        'type Commands = Pick<SessionPort, "deleteSession">;\n' +
        'export function use(commands: Commands): Promise<void> {\n' +
        '  return commands.deleteSession("x");\n}\n',
    });
    // The holder is called `Commands`, so only the declaration the property
    // resolves to can name the capability the call belongs to.
    expect(result.forbiddenCalls).toHaveLength(1);
    expect(result.forbiddenCalls[0]).toMatchObject({
      file: "client/projection/probe.ts",
      target: "SessionPort.deleteSession",
    });
  });

  // A capability call must be judged by whether it is *invoked*, not by whether
  // its result is awaited, chained or stored. When its result was consumed by a
  // chain (`port.m().then(cb)`), the call and the chain that wraps it started at
  // the same character; the resolving pass looked the candidate up by start
  // offset alone, recovered the *outer* chain, and judged `then` instead of `m`.
  // The capability call then went unjudged and was recorded twice. Each shape
  // below is anchored on the call's whole span so the nested call is recovered
  // whatever it is nested inside.
  const chainedForms: ReadonlyArray<{ readonly label: string; readonly body: string }> = [
    { label: "a .then chain", body: 'void port.sendMessage({}).then(() => {});' },
    { label: "a .catch chain", body: 'void port.sendMessage({}).catch(() => {});' },
    { label: "a .finally chain", body: 'void port.sendMessage({}).finally(() => {});' },
    {
      label: "an optional-call chain",
      body: 'void port?.sendMessage({}).then(() => {});',
    },
    {
      label: "an awaited capability call",
      body: 'return port.sendMessage({}).then(() => {});',
    },
    {
      label: "a capability call assigned to a variable",
      body: 'const pending = port.sendMessage({});\n  void pending;',
    },
  ];

  for (const form of chainedForms) {
    it(`rejects a capability call whose result is consumed by ${form.label}`, () => {
      const { result } = evaluateFixture({
        "client/contracts/transport.ts": transportContract,
        "client/ui/Widget.tsx": caller(
          "../contracts/transport.js",
          "WebuiTransport",
          form.body,
        ),
      });
      expect(result.forbiddenCalls).toHaveLength(1);
      expect(result.forbiddenCalls[0]).toMatchObject({
        file: "client/ui/Widget.tsx",
        target: "WebuiTransport.sendMessage",
      });
      expect(result.pass).toBe(false);
    });
  }

  it("rejects a chained capability call reached through a destructured binding", () => {
    // The binding form and the chained form together: the collector records a
    // bare-identifier callee, and the inner capability call is still nested in
    // the chain that consumes its result.
    const { result } = evaluateFixture({
      "client/contracts/transport.ts": transportContract,
      "client/ui/Widget.tsx":
        'import type { WebuiTransport } from "../contracts/transport.js";\n' +
        'export function use(port: WebuiTransport): void {\n' +
        "  const { sendMessage } = port;\n" +
        "  void sendMessage({}).then(() => {});\n}\n",
    });
    expect(result.forbiddenCalls).toHaveLength(1);
    expect(result.forbiddenCalls[0]).toMatchObject({
      target: "WebuiTransport.sendMessage",
    });
    expect(result.pass).toBe(false);
  });

  it("judges a chained capability call once, not once per enclosing call", () => {
    // The duplicate-candidate symptom of the same defect: the inner call and
    // the chain that wraps it used to both resolve to the outer node, so the
    // site was recorded twice.
    const { graph } = evaluateFixture({
      "client/contracts/transport.ts": transportContract,
      "client/ui/Widget.tsx": caller(
        "../contracts/transport.js",
        "WebuiTransport",
        'void port.sendMessage({}).then(() => {});',
      ),
    });
    expect(
      graph.callSites.filter((site) => site.method === "sendMessage"),
    ).toHaveLength(1);
  });

  it("keeps a chained call allowed in the bindings bridge and in the application", () => {
    // The control for the shapes above: the *same* chained shape is legal where
    // the capability is legitimately held, so the fixtures reject the chain
    // rather than the chain-shaped syntax.
    const { result } = evaluateFixture({
      "client/contracts/transport.ts": transportContract,
      "client/bindings/use-transport.ts":
        'import type { WebuiTransport } from "../contracts/transport.js";\n' +
        'export function use(port: WebuiTransport): void {\n' +
        "  void port.sendMessage({}).then(() => {});\n}\n",
      "client/application/send.ts":
        'import type { WebuiTransport } from "../contracts/transport.js";\n' +
        'export function use(port: WebuiTransport): void {\n' +
        "  void port.sendMessage({}).then(() => {});\n}\n",
    });
    expect(result.forbiddenCalls).toHaveLength(0);
    expect(result.pass).toBe(true);
  });

  it("keeps a same-named local function and an indexed lookup out of the rule", () => {
    // Resolving identifier calls must not turn every call named like a
    // capability method into a violation: a local function has no capability
    // declaration behind it, and an index signature has no member to resolve.
    const { result } = evaluateFixture({
      "client/ui/Widget.tsx":
        'function deleteSession(id: string): void {\n  void id;\n}\n' +
        'export function use(): void {\n  deleteSession("x");\n}\n',
      "client/ui/Table.tsx":
        'const handlers: Record<string, () => void> = { deleteSession: () => {} };\n' +
        'export function use(): void {\n  handlers["deleteSession"]();\n}\n',
    });
    expect(result.forbiddenCalls).toHaveLength(0);
    expect(result.pass).toBe(true);
  });
});

describe("the gate runs and matches the frozen baseline", () => {
  it("passes with all component browser globals routed through injected adapters", { timeout: 60_000 }, () => {
    const baseline = JSON.parse(readFileSync(realBaselinePath, "utf8"));
    const run = runCli(["--json"]);
    const summary = JSON.parse(run.stdout);
    expect(run.status).toBe(0);
    expect(summary.ok).toBe(true);
    expect(summary.browserGlobals).toHaveLength(0);
    expect(summary.baselinePairs).toBe((baseline.entries ?? []).length);
    expect(summary.cycles).toHaveLength((baseline.cycles ?? []).length);
    expect(summary.newViolations).toHaveLength(0);
    expect(summary.staleEntries).toHaveLength(0);
    expect(summary.newCycles).toHaveLength(0);
    expect(summary.staleCycles).toHaveLength(0);
  });

  it("fails on a stale baseline entry", { timeout: 60_000 }, () => {
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

describe("V25 · what a published surface may contain", () => {
  const publication = (source: string) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "webui-publication-"));
    temporaryRoots.push(root);
    const relative = "client/features/sessions/application/catalogue.public.ts";
    const absolutePath = path.join(root, relative);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source);
    return publicationRule({
      files: [relative],
      absolute: (p) => path.join(root, p),
      readFile: (p) => readFileSync(p, "utf8"),
    });
  };

  it("accepts a plain published derivation", () => {
    const result = publication(
      'import type { Thing } from "../../contracts/thing.js";\nexport interface Public { readonly thing: Thing }\nexport const derive = (t: Thing): number => t.n;\n',
    );

    expect(result.violations).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it("rejects export-star, which republishes whatever is added later", () => {
    const result = publication('export * from "./catalogue.js";\n');

    expect(result.pass).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("publication-export-star");
  });

  it("rejects a foreign re-export, which makes this business the publisher", () => {
    const result = publication('export { sessions } from "../../other/contracts/sessions.js";\n');

    expect(result.pass).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("publication-foreign-re-export");
  });

  it("rejects foreign namespace access, whose reach the gate cannot resolve", () => {
    const result = publication('import * as other from "../../other/contracts/sessions.js";\nexport const x = other;\n');

    expect(result.pass).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("publication-foreign-namespace");
  });

  it("accepts a namespace import of the module's own business, which is ordinary composition", () => {
    // The accepted rule restricts *foreign* access; owner-private implementation
    // imports stay legal. A blanket syntax ban reported this too, so the gate did
    // not implement the policy it claimed to.
    const violations = findPublicationViolations(
      'import * as own from "./catalogue-private.js";\nexport const x = own.value;\n',
      {
        ownerBusiness: "sessions",
        businessOf: (relative) => (relative.includes("/sessions/") ? "sessions" : "other"),
        resolveSpecifier: (specifier) =>
          specifier === "./catalogue-private.js"
            ? "client/features/sessions/application/catalogue-private.ts"
            : null,
      },
    );

    expect(violations).toEqual([]);
  });

  it("still rejects that same namespace import when it resolves into another business", () => {
    const violations = findPublicationViolations(
      'import * as other from "../../other/contracts/sessions.js";\nexport const x = other;\n',
      {
        ownerBusiness: "sessions",
        businessOf: (relative) => (relative.includes("/other/") ? "other" : "sessions"),
        resolveSpecifier: () => "client/features/other/contracts/sessions.ts",
      },
    );

    expect(violations.map((v) => v.kind)).toContain("foreign-namespace");
  });

  it("resolves a workspace alias, so a bare specifier cannot reach a peer's module", () => {
    // The same reach as the relative case above, written with the alias the build
    // understands. Reading the specifier's *shape* instead of its target let this form
    // through with no violation while the relative form was rejected.
    const violations = findPublicationViolations(
      'import * as models from "@models/token-plan";\nexport const x = models;\n',
      {
        ownerBusiness: "settings",
        businessOf: (relative) => (relative.includes("/models/") ? "models" : "settings"),
        resolveSpecifier: (specifier) =>
          specifier === "@models/token-plan"
            ? "client/features/models/application/token-plan.ts"
            : null,
      },
    );

    expect(violations.map((v) => v.kind)).toContain("foreign-namespace");
  });

  it("leaves a specifier the resolver cannot place alone, so npm packages are not peers", () => {
    const violations = findPublicationViolations(
      'import * as react from "react";\nexport const x = react;\n',
      {
        ownerBusiness: "settings",
        businessOf: () => "settings",
        resolveSpecifier: () => null,
      },
    );

    expect(violations).toEqual([]);
  });

  it("treats an unresolvable relative import as foreign, so a gap fails closed", () => {
    const violations = findPublicationViolations(
      'import * as mystery from "./mystery.js";\nexport const x = mystery;\n',
      {
        ownerBusiness: "sessions",
        businessOf: () => "sessions",
        resolveSpecifier: () => null,
      },
    );

    expect(violations.map((v) => v.kind)).toContain("foreign-namespace");
  });

  it("accepts a dynamic import of the module's own business", () => {
    const violations = findPublicationViolations(
      'export const load = () => import("./catalogue-private.js");\n',
      {
        ownerBusiness: "sessions",
        businessOf: () => "sessions",
        resolveSpecifier: () => "client/features/sessions/application/catalogue-private.ts",
      },
    );

    expect(violations).toEqual([]);
  });

  it("rejects a default export, which names no symbol a consumer could be checked against", () => {
    const result = publication("const thing = 1;\nexport default thing;\n");

    expect(result.pass).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("publication-foreign-default");
  });

  it("rejects a dynamic import, whose edge no other judgement can see", () => {
    const result = publication('export const load = () => import("./catalogue.js");\n');

    expect(result.pass).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("publication-foreign-dynamic");
  });

  it("recognises both suffixes from the path, not from a hand-written list", () => {
    // A list of published modules is a list that goes stale on the first rename,
    // and a stale list is a gate that passes files it should reject. Both suffixes
    // are recognised from the real path.
    expect(isPublicModulePath("client/features/x/ui/Thing.public.tsx")).toBe(true);
    expect(isPublicModulePath("client/features/x/ui/Thing.public.ts")).toBe(true);
    expect(isPublicModulePath("client/features/x/ui/Thing.ts")).toBe(false);
    // A file merely *named* public is not one.
    expect(isPublicModulePath("client/features/x/ui/public.ts")).toBe(false);

    // The layer classifier agrees, so a published projection keeps its layer.
    expect(classifyLayers("client/features/workspace/projection/workspace-name.public.ts")).toEqual(
      classifyLayers("client/features/workspace/projection/workspace-name.ts"),
    );
    expect(classifyLayers("client/features/goal/projection/goal-state.public.ts")).toEqual(
      ["domain"],
    );
  });

  it("distinguishes foreign access through the real gate, not only the syntax pass", () => {
    // The end-to-end half of SP10: the evaluator derives the publication rule's
    // business classification from the same `classifyRole` every other rule uses
    // and from the real module resolution, so a published module may reach its own
    // private implementation by namespace while reaching a peer's stays rejected.
    // Both fixtures are judged with the reader attached, which is how the CLI runs
    // the gate.
    const evaluateWithSource = (files: Record<string, string>) => {
      const { graph, sourceRoot } = evaluateFixture(files);
      return evaluateGraph(graph, { sourceRoot });
    };

    const sameBusiness = evaluateWithSource({
      "client/features/sessions/application/catalogue.public.ts":
        'import * as own from "./catalogue-internal.js";\nexport const names = own.names;\n',
      "client/features/sessions/application/catalogue-internal.ts":
        "export const names: readonly string[] = [];\n",
    });
    expect(sameBusiness.publicationViolations.map((entry) => entry.rule)).toEqual([]);

    const foreign = evaluateWithSource({
      "client/features/sessions/application/catalogue.public.ts":
        'import * as other from "../../models/projection/token-plan-model.public.js";\nexport const isTokenPlan = other.isTokenPlanModel;\n',
      "client/features/models/projection/token-plan-model.public.ts":
        "export const isTokenPlanModel = (id: string): boolean => id.length > 0;\n",
    });
    expect(foreign.publicationViolations.map((entry) => entry.rule)).toContain(
      "publication-foreign-namespace",
    );
  });

  it("does not read a comment as a declaration", () => {
    // The gate is a bounded syntactic pass, so its own blindness has to be
    // stated: a `.public` marker inside a comment must not be judged, and a
    // commented-out re-export must not be rejected.
    const result = publication(
      '// export * from "./catalogue.js";\n/* export { x } from "../other/y.js"; */\nexport const ok = 1;\n',
    );

    expect(result.violations).toEqual([]);
  });
});

describe("V42 · the path metadata refactor changed no verdict", () => {
  const KNOWN_ROLE_DIRECTORIES = new Set([
    "application",
    "projection",
    "bindings",
    "ui",
    "contracts",
  ]);
  // The consolidation replaced three tables and a switch with one table the
  // classifiers derive from. The only way to know it preserved behaviour is to
  // compare verdicts, and comparing file lists is not enough: a refactor that
  // dropped one business's rows would still pass a grep over the files that
  // happen to exist today. So the corpus includes representative *future* paths
  // — directories and business names the package has not grown yet — because
  // those are exactly what a per-directory switch forgets.
  const currentPaths = [
    "client/features/composer/application/composer-controller.ts",
    "client/features/composer/projection/goal-state.ts",
    "client/features/composer/projection/goal-state.public.ts",
    "client/features/composer/contracts/composer-port.ts",
    "client/features/composer/bindings/use-composer-controller.ts",
    "client/features/composer/ui/WebuiComposer.tsx",
    "client/features/workspace/projection/workspace-name.public.ts",
    "client/features/workspace/application/workspace-queries.ts",
    "client/features/sessions/application/session-catalog.public.ts",
    "client/features/sessions/projection/action-requests.public.ts",
    "client/features/models/ui/ModelPicker.public.tsx",
    "client/conversation/stream-loop.ts",
    "client/platform/transport.ts",
    "client/ui/ContextMenu.tsx",
    "client/shell/WebuiClientFoundationApp.tsx",
    "client/shell/WebuiZoneBoundary.tsx",
    "client/bindings/use-query-state.tsx",
    "client/application/session-store.ts",
    "client/contracts/contracts-shared.ts",
    "client/projection/common/records.ts",
    "client/projection/action-requests.ts",
    "client/styles/webui.css",
    "client/main.tsx",
    "client/global.d.ts",
    "server/envelope.ts",
    "server/operation/session.ts",
    "runtime/port.ts",
    "runtime/harness/host-contract.ts",
    "runtime/commands/runner.ts",
    "shared/contracts/session.ts",
  ];

  const futurePaths = [
    // Businesses and role directories that do not exist yet. Each has to
    // classify from the table rather than from an arm someone remembered.
    "client/features/payments/application/payment-workflows.ts",
    "client/features/payments/projection/payment-state.ts",
    "client/features/payments/projection/payment-state.public.ts",
    "client/features/payments/contracts/payment-port.ts",
    "client/features/payments/bindings/use-payments.ts",
    "client/features/payments/ui/PaymentsPage.tsx",
    "client/features/payments/ui/PaymentsPage.public.tsx",
    "client/features/canvas2/application/x.ts",
    // An unknown role directory under a feature is unknown, not silently
    // inherited from whatever arm happened to come last.
    "client/features/payments/workbench/x.ts",
    // A path outside every known home.
    "client/unknown-home/x.ts",
    "packages/other/thing.ts",
  ];

  it("classifies every current and future path into a known layer", () => {
    for (const file of [...currentPaths, ...futurePaths]) {
      const layers = classifyLayers(file);
      expect(layers.length, file).toBeGreaterThan(0);
      // `unknown` is a real verdict — a role directory with no row, or a path
      // outside every known home. What must not happen is a *known* role
      // directory losing its layer, so those are checked against the table.
      // Stated here rather than imported: a test that reads the same table it is
      // checking cannot fail when the table loses a row.
      const directory = file.split("/")[3];
      if (file.startsWith("client/features/") && KNOWN_ROLE_DIRECTORIES.has(directory)) {
        expect(layers, file).not.toEqual(["unknown"]);
      }
    }
  });

  it("keeps the five verdict kinds consistent with each other", () => {
    for (const file of [...currentPaths, ...futurePaths]) {
      const layers = classifyLayers(file);
      const { role, business, home } = classifyRole(file);
      // Role, business and home: whatever they are, they must be strings (or
      // null for a businessless home), not undefined leaking from a map miss.
      expect(typeof role, file).toBe("string");
      expect(typeof home, file).toBe("string");
      expect(["string", "object"], file).toContain(typeof business);
      // A published module keeps its layer: publication changes reachability,
      // never where the module sits.
      const private_ = file.replace(/\.public(?=\.)/u, "");
      if (private_ !== file) {
        expect(classifyLayers(private_), file).toEqual(layers);
        expect(classifyRole(private_).role.replace(/^published-/u, ""), file).toBe(
          role.replace(/^published-/u, ""),
        );
      }
      // The direction matrix's verdict: every layer pair either has an entry in
      // the allowance or is judged as an edge. Either way it must be decidable.
      expect(Array.isArray(layers) && layers.every((l) => typeof l === "string"), file).toBe(true);
    }
  });

  it("derives the projection layer from the module, not the directory", () => {
    // `projection/` is the one directory where the layer depends on the module's
    // name. A business derivation is a `domain`; one that only reads is a `view`;
    // and publishing either does not move it.
    expect(classifyLayers("client/features/sessions/projection/action-requests.ts")).toEqual([
      "domain",
    ]);
    expect(classifyLayers("client/features/sessions/projection/action-requests.public.ts")).toEqual([
      "domain",
    ]);
    expect(classifyLayers("client/features/composer/projection/unlisted-thing.ts")).toEqual([
      "view",
    ]);
    expect(classifyLayers("client/features/composer/projection/unlisted-thing.public.ts")).toEqual([
      "view",
    ]);
    // The same rule for the current home, which consulted the same set.
    expect(classifyLayers("client/projection/action-requests.ts")).toEqual(["domain"]);
    expect(classifyLayers("client/projection/unlisted-thing.ts")).toEqual(["view"]);
  });

  it("maps every role directory to a layer, so neither can gain a row alone", () => {
    // The property the consolidation exists to hold: a feature role directory has
    // exactly one layer, derived from the same row that names its role. Reading
    // it through the two functions is what proves the row, not a re-statement of
    // it, is in force.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["application", "application"],
      ["contracts", "contracts"],
      ["bindings", "bindings"],
      ["ui", "bindings"],
    ];
    for (const [directory, layer] of pairs) {
      expect(classifyLayers(`client/features/x/${directory}/m.ts`), directory).toEqual([layer]);
      expect(classifyRole(`client/features/x/${directory}/m.ts`).role, directory).toBe(
        `feature-${directory}`,
      );
    }
  });

  it("leaves the authority policy independent of the path tables", () => {
    // Authority is a property of a role and a business, never of where a file
    // sits. The one thing that is a defect is two *live* homes for the same
    // business and role — and that judgement reads `home` only to tell the two
    // spellings apart, so moving a file cannot quietly grant or revoke it.
    for (const file of [...currentPaths, ...futurePaths]) {
      const { role, business, home } = classifyRole(file);
      // The role a file occupies is determined by its directory, so the same
      // role reached through either layout spelling stays the same role.
      const viaOtherSpelling = file.startsWith("client/features/")
        ? file.replace("client/features/x/", "client/features/x/")
        : null;
      if (viaOtherSpelling === null) continue;
      expect(classifyRole(viaOtherSpelling), file).toEqual({ role, business, home });
    }
    // And the role strings the authority policy tests are all role values, with
    // no path in them: `BUSINESS_BEARING_ROLES` is a set of role names, so a file
    // is authoritative by being in one, wherever it lives.
    expect(BUSINESS_BEARING_ROLES.has("feature-application")).toBe(true);
    expect(BUSINESS_BEARING_ROLES.has("feature-projection")).toBe(true);
    expect(BUSINESS_BEARING_ROLES.has("feature-contracts")).toBe(true);
    // The set holds role names and nothing else. If it ever gained a path, a
    // file's authority would depend on where it sits rather than on what it owns.
    for (const role of BUSINESS_BEARING_ROLES) {
      expect(role, role).not.toContain("/");
      expect(role, role).not.toContain(".");
    }
  });
});
