// Pure-function WebUI internal dependency-direction rules.
//
// `scripts/check-webui-dependency.mjs` is the CLI entry; it builds the resolved
// source import graph and hands it to the rules below. Tests import the rules
// directly so this module stays free of side effects at import time: nothing
// here reads the filesystem or the repository until a function is called, and
// the only module-level state is the declared layer matrix and provenance table.
//
// This check is deliberately separate from `scripts/lib/webui-boundary.mjs`
// (the esbuild metafile check). The metafile cannot see `import type` edges —
// they are erased from build output — and it proves an input is *present*, not
// that its dependency *direction* is legal. The layers and their provenance
// come from `docs/webui/webui-runtime-layer-plan.md` section 7.1; the allowed
// edges come from the same plan's section 3 ("Dependency direction and machine
// enforcement") and ADR 0014.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

// Registered Node builtin module names. Used by the node-builtin rule to
// detect `import "fs"`-style specifiers in client / shared code that the
// previous `node:`-prefixed rule missed.
const BUILTIN_NODE_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

// The Typescript compiler drives parsing and module resolution. Importing it is
// side-effect-free; it is only *used* when `buildDependencyGraph` runs.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
/** @type {typeof import("typescript")} */
const ts = require("typescript");
// Names whose resolution to a TypeScript lib `*.d.ts` declaration is the
// signal of an ambient access. Local parameters or destructured fields with
// the same identifier are filtered out below; this set is the candidate set,
// not the verdict.
const BROWSER_GLOBAL_CANDIDATES = new Set([
  "document",
  "localStorage",
  "sessionStorage",
  "window",
  "globalThis",
]);

/** Directory (repository-relative) whose source files this check covers. */
export const WEBUI_SOURCE_DIRECTORY = "packages/webui/src";

/** Source suffixes in scope. `.js` sources are excluded on purpose (plan §7.5). */
export const SOURCE_SUFFIXES = Object.freeze([".ts", ".tsx", ".d.ts"]);

// ---------------------------------------------------------------------------
// Layers and the allowed-edge matrix
// ---------------------------------------------------------------------------

/**
 * Declared target layers. Assignment is by *target* layer, never by the current
 * directory: `classifyLayers` maps each source path through the provenance table
 * in plan §7.1/§7.2/§7.3.
 */
export const LAYERS = Object.freeze([
  "root",
  "bindings",
  "application",
  "infrastructure",
  "mechanisms",
  "view",
  "domain",
  "contracts",
  "shared",
  "server",
  "runtime-port",
  "runtime",
  "unknown",
]);

/**
 * Allowed forward edges between declared layers. An edge is legal when the
 * target layer appears here for the source layer (identity is always allowed).
 * This is a matrix, not a directory-name denylist: nothing is forbidden merely
 * because a directory is called "components".
 *
 * Provenance for each denial is plan §3: domain/view must not reach React,
 * components, application, concrete transport, server or Node; application must
 * not reach components/React/DOM/concrete transport/server or the Node runtime
 * port; browser infrastructure must not reach components or application
 * implementation; Node runtime must not reach browser, React, DOM or storage;
 * shared contracts reach neither execution side; contract declarations are
 * leaves and cannot import projection implementation.
 *
 * `root` is the browser and server composition root and may join every layer.
 */
export const ALLOWED_EDGES = Object.freeze({
  root: Object.freeze([
    "bindings",
    "application",
    "infrastructure",
    "mechanisms",
    "view",
    "domain",
    "contracts",
    "shared",
    "server",
    "runtime-port",
    "runtime",
  ]),
  bindings: Object.freeze([
    "application",
    "view",
    "domain",
    "contracts",
    "shared",
    "infrastructure",
    "mechanisms",
  ]),
  application: Object.freeze([
    "view",
    "domain",
    "contracts",
    "shared",
    "mechanisms",
  ]),
  infrastructure: Object.freeze([
    "contracts",
    "shared",
    "mechanisms",
    "view",
    "domain",
  ]),
  mechanisms: Object.freeze(["contracts", "shared"]),
  view: Object.freeze(["domain", "contracts", "shared"]),
  domain: Object.freeze(["view", "contracts", "shared"]),
  contracts: Object.freeze(["shared"]),
  shared: Object.freeze([]),
  server: Object.freeze(["shared", "runtime-port"]),
  "runtime-port": Object.freeze(["shared", "runtime"]),
  runtime: Object.freeze(["shared", "runtime-port"]),
  unknown: Object.freeze([]),
});

/**
 * The files plan §7.5 marks as mixing responsibilities: their layer is
 * provisional and cannot be judged from the path alone until they are split.
 * They are still classified (by destination) so their existing edges are
 * counted, but the CLI reports every violation that touches one of them so a
 * reviewer can see the provisional judgement instead of a silent pass.
 *
 * `client/contracts.ts` used to be listed here. The stage-1 contracts split
 * replaced it with leaf `client/contracts/*.ts` capability/view modules, so
 * the path no longer exists to be judged and the entry was removed rather than
 * left pointing at a missing file.
 *
 * `client/session-runtime-store.ts` used to be listed here too. It had no
 * remaining importer, so the ticket-#45 slice deleted it and the entry was
 * removed for the same reason: there is no file left to judge.
 *
 * `client/connection-health.ts` and `server/session-transfer.ts` were the two
 * entries that outlived their files: `connection-health.ts` moved to
 * `client/infrastructure/` and `server/session-transfer.ts` became
 * `runtime/session-transfer.ts`. `client/stream-instrumentation.ts` moved to
 * `client/mechanisms/`, where the directory decides its layer, so its entry is
 * obsolete too. All three are removed here rather than left pointing at paths
 * that no longer exist.
 *
 * The same rule applies to `CLIENT_FILE_PROVENANCE` below: an entry for a file
 * that no longer sits at that path is deleted, so a re-created file at the old
 * path classifies as `unknown` and is reported instead of silently inheriting a
 * stale layer.
 */
export const KNOWN_AMBIGUOUS_FILES = Object.freeze([
  "runtime/port.ts",
  "client/projection/stream-state.ts",
  "client/slash-palette.ts",
  "server/service.ts",
  "server/envelope.ts",
]);

/**
 * Baseline categories, each keyed to a migration stage from plan §7.7 (the
 * stage by which the exception must be gone). `stage` and `reason` are copied
 * into every baseline entry so a later slice is forced to delete it.
 */
export const CATEGORIES = Object.freeze({
  "client-to-server-port": Object.freeze({
    stage: 1,
    description:
      "A browser layer imports the Node capability port (`runtime/port.ts`). Stage 1 requires the client to import no server module; consumers move to client contracts or shared DTOs.",
  }),
  "projection-to-components": Object.freeze({
    stage: 1,
    description:
      "A pure view/domain projection imports a React component. Presentation-owned types must move below their consumers (plan §3), removing the component dependency.",
  }),
  "contract-to-projection": Object.freeze({
    stage: 1,
    description:
      "A leaf client contract imports projection implementation. Contract declarations are leaves; the stage-1 contracts split removes the edge.",
  }),
  "runtime-to-client-contracts": Object.freeze({
    stage: 2,
    description:
      "A runtime-mapped file pulls browser contract declarations into the Node graph. Runtime extraction plus shared DTO placement removes it.",
  }),
  "runtime-to-server-envelope": Object.freeze({
    stage: 2,
    description:
      "The runtime-mapped harness host reaches the server envelope module. After extraction the runtime depends on shared contracts, not server code.",
  }),
  "server-operation-to-runtime": Object.freeze({
    stage: 2,
    description:
      "A server operation module imports runtime implementation. After extraction the operations are protocol validators; the server consumes only runtime capabilities.",
  }),
  "server-barrel-to-runtime": Object.freeze({
    stage: 2,
    description:
      "The server public barrel re-exports runtime implementation. The barrel must export the network entry only.",
  }),
  "stream-loop-to-projection": Object.freeze({
    stage: 4,
    description:
      "The mechanism-mapped stream loop reaches into projection. Stage 4 injects the pure transforms (plan §7.2) so the mechanism no longer imports projection.",
  }),
  unclassified: Object.freeze({
    stage: 6,
    description:
      "A matrix violation that does not match a recorded category. Treat as a new direction failure.",
  }),
});

// ---------------------------------------------------------------------------
// Provenance: current path -> target layer(s)
// ---------------------------------------------------------------------------

// Explicit provenance for current `client/*` top-level files that move or split.
// Values are arrays because a split file genuinely has more than one target
// layer; the plan names the destinations (§7.1, §7.2, §7.3).
const CLIENT_FILE_PROVENANCE = Object.freeze({
  "main.tsx": ["root"],
  "global.d.ts": ["root"],
  "team-mode.ts": ["infrastructure"],
  "no-project.ts": ["infrastructure"],
  "value-readers.ts": ["contracts"],
  "rail-buckets.ts": ["view"],
  "router.ts": ["view"],
  "slash-palette.ts": ["bindings"],
  "markdown.tsx": ["bindings"],
  "icons.tsx": ["bindings"],
  "ConnectionStatus.tsx": ["bindings"],
});

// `client/projection/*` classification, from plan §2's "Required module
// classification" table. Files not listed here are pure view projections.
// `session-activity` is the relocated pure activity rules (plan §7.3, ticket
// #49): it moved from `client/session-activity.ts` (classified `domain`) to
// `client/projection/session-activity.ts`, keeping that layer.
const PROJECTION_DOMAIN = new Set([
  "action-requests",
  "context-usage",
  "event-parsers",
  "goal-state",
  "model-favorites",
  "model-reorder",
  "plan-mode",
  "questionnaire-state",
  "session-activity",
  "thinking-control",
  "token-plan-model",
  "workspace-progress",
  "worktree-state",
]);
const PROJECTION_SPLIT = Object.freeze({
  "composer-history": ["application"],
  "effect-reducer": ["application"],
  "transcript-request-ownership": ["application"],
  "file-line-navigation": ["bindings"],
  // `stream-state.ts` is the pure frame reducer split out of `client/stream.ts`
  // (plan §7.3). Its predecessor carried a `mechanisms` classification because
  // the stream loop and the test-only instrumentation consumed it directly; both
  // now take it by injection instead (plan §7.2), so the module is a pure `view`
  // projection and no mechanism reaches into it. The state shapes it operates on
  // live in `client/contracts/stream-state.ts` for the same reason.
  "stream-state": ["view"],
});

// Current `server/*` files whose destination is `runtime/`. Everything else
// under `server/` stays the loopback network layer.
const SERVER_RUNTIME_PROVENANCE = new Set([
  "host.ts",
  "assembly.ts",
  "auth-context.ts",
  "account-login.ts",
  "usage-quota.ts",
  "check-in.ts",
  "runtime-environment.ts",
  "profile-files.ts",
  "workspace-archive.ts",
  "mcode-tools.ts",
  "mcode-tools-entry.ts",
  "mcode-tools-environment.ts",
  "commands/descriptors.ts",
  "commands/runner.ts",
]);

function basenameWithoutExtension(relative) {
  return path.basename(relative).replace(/\.(d\.ts|tsx|ts)$/u, "");
}

/**
 * Maps a source path (relative to `packages/webui/src`) to one or more target
 * layers. Both the current layout (via the provenance table above) and the
 * post-migration target layout (via directory) are recognised, so the same
 * checker works before, during and after the migration.
 *
 * @param {string} relative
 * @returns {string[]}
 */
export function classifyLayers(relative) {
  const normalized = relative.split(path.sep).join("/");

  // Composition root (browser) — explicit exception per plan §7.5.
  if (normalized === "client/main.tsx") return ["root"];

  // Target layout (post-migration, and the layout fixtures use).
  if (normalized.startsWith("client/components/")) return ["bindings"];
  if (normalized.startsWith("client/bindings/")) return ["bindings"];
  if (normalized.startsWith("client/application/")) return ["application"];
  if (normalized.startsWith("client/infrastructure/")) return ["infrastructure"];
  if (normalized.startsWith("client/mechanisms/")) return ["mechanisms"];
  if (normalized.startsWith("client/contracts/")) return ["contracts"];
  if (normalized.startsWith("shared/")) return ["shared"];
  if (normalized.startsWith("runtime/")) {
    if (normalized === "runtime/port.ts" || normalized.startsWith("runtime/harness/host-contract"))
      return ["runtime-port"];
    return ["runtime"];
  }

  // Current layout: provenance from plan §7.1/§7.2/§7.3.
  if (normalized === "server/envelope.ts") return ["server"];
  if (normalized === "server/session-transfer.ts") return ["runtime"];
  if (normalized.startsWith("server/operation/")) return ["server"];
  if (normalized.startsWith("server/projections/")) return ["server"];
  if (normalized.startsWith("server/")) {
    const rest = normalized.slice("server/".length);
    return SERVER_RUNTIME_PROVENANCE.has(rest) ? ["runtime"] : ["server"];
  }
  if (normalized.startsWith("client/projection/")) {
    const base = basenameWithoutExtension(normalized);
    if (PROJECTION_SPLIT[base]) return [...PROJECTION_SPLIT[base]];
    if (PROJECTION_DOMAIN.has(base)) return ["domain"];
    return ["view"];
  }
  if (normalized.startsWith("client/")) {
    const rest = normalized.slice("client/".length);
    return CLIENT_FILE_PROVENANCE[rest] ? [...CLIENT_FILE_PROVENANCE[rest]] : ["unknown"];
  }
  return ["unknown"];
}

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

/**
 * Normalises an absolute path to the `packages/webui/src`-relative, POSIX form
 * the rules operate on, or returns `null` when the file is outside the package
 * source directory. This is the single place path shapes are reconciled.
 *
 * @param {string} repositoryRoot
 * @param {string} absolutePath
 * @returns {string | null}
 */
export function normaliseSourcePath(repositoryRoot, absolutePath) {
  const sourceRoot = path.join(repositoryRoot, WEBUI_SOURCE_DIRECTORY);
  const relative = path.relative(sourceRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Matrix evaluation
// ---------------------------------------------------------------------------

/**
 * True when any (source target layer, destination target layer) pair is
 * permitted. A file that splits across layers may import a layer if *any* of
 * its destinations may; this is what lets a genuinely shared module keep a
 * legal edge while still forbidding the illegitimate one.
 *
 * @param {readonly string[]} fromLayers
 * @param {readonly string[]} toLayers
 * @returns {boolean}
 */
export function isAllowedEdge(fromLayers, toLayers) {
  for (const from of fromLayers) {
    for (const to of toLayers) {
      if (from !== to && !(ALLOWED_EDGES[from] ?? []).includes(to)) return false;
    }
  }
  return true;
}

const BROWSER_LAYERS = new Set([
  "root",
  "bindings",
  "application",
  "infrastructure",
  "mechanisms",
  "view",
  "domain",
  "contracts",
]);

/** True when either endpoint of a pair is a known-ambiguous file. */
export function touchesAmbiguousFile(from, to) {
  return KNOWN_AMBIGUOUS_FILES.includes(from) || KNOWN_AMBIGUOUS_FILES.includes(to);
}

function allIn(values, set) {
  return values.every((value) => set.has(value));
}

/**
 * Annotates a matrix violation with the plan §7.5 category it belongs to. The
 * matrix decides *whether* an edge is a violation; this only names it so the
 * frozen baseline can carry a stage and a reason.
 */
export function categoriseViolation(from, to, fromLayers, toLayers) {
  if (toLayers.includes("runtime-port") && allIn(fromLayers, BROWSER_LAYERS))
    return "client-to-server-port";
  if (allIn(fromLayers, new Set(["view", "domain"])) && allIn(toLayers, new Set(["bindings"])))
    return "projection-to-components";
  if (allIn(fromLayers, new Set(["contracts"])) && allIn(toLayers, new Set(["view", "domain"])))
    return "contract-to-projection";
  if (
    allIn(fromLayers, new Set(["runtime", "runtime-port"])) &&
    allIn(toLayers, new Set(["contracts"]))
  )
    return "runtime-to-client-contracts";
  if (fromLayers.includes("runtime") && toLayers.includes("server") && /envelope\.ts$/u.test(to))
    return "runtime-to-server-envelope";
  if (
    allIn(fromLayers, new Set(["server"])) &&
    from.startsWith("server/operation/") &&
    toLayers.includes("runtime")
  )
    return "server-operation-to-runtime";
  if (from === "server/index.ts" && toLayers.includes("runtime"))
    return "server-barrel-to-runtime";
  if (from === "client/stream-loop.ts" && allIn(toLayers, new Set(["view", "domain"])))
    return "stream-loop-to-projection";
  return "unclassified";
}

// ---------------------------------------------------------------------------
// Source parsing and module resolution
// ---------------------------------------------------------------------------

/**
 * Collects every module reference in one source file: static imports,
 * re-exports, `import type`, type queries (`import("x")`) and dynamic imports.
 * Non-literal dynamic imports are returned separately because they cannot be
 * resolved and must not become an unchecked escape.
 *
 * Two non-import facts are also collected as text-anchored candidates and
 * resolved later against the TypeScript program: `browserGlobalCandidates`
 * records every identifier whose name matches an ambient browser global so a
 * subsequent symbol check can confirm the access reaches a `lib.dom.d.ts`
 * declaration (filtering out local parameters with the same name); and
 * `callCandidates` records the position of every call expression whose
 * callee is a property access (used to drive the writer-creation /
 * transport-RPC rule).
 *
 * @param {string} fileName
 * @param {string} sourceText
 * @returns {{
 *   references: Array<{specifier: string, line: number, kind: string}>,
 *   nonLiteralDynamic: Array<{line: number}>,
 *   browserGlobalCandidates: Array<{name: string, line: number, position: number}>,
 *   callCandidates: Array<{line: number, position: number}>,
 * }}
 */
export function collectModuleReferences(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const references = [];
  const nonLiteralDynamic = [];
  const browserGlobalCandidates = [];
  const callCandidates = [];
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
        kind: node.importClause?.isTypeOnly ? "import-type" : "import",
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
        kind: node.isTypeOnly ? "export-type" : "export",
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) {
        references.push({ specifier: argument.text, line: lineOf(node), kind: "dynamic" });
      } else {
        nonLiteralDynamic.push({ line: lineOf(node) });
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      references.push({ specifier: node.arguments[0].text, line: lineOf(node), kind: "require" });
    } else if (
      ts.isImportTypeNode(node) &&
      node.argument &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      references.push({
        specifier: node.argument.literal.text,
        line: lineOf(node),
        kind: "type-query",
      });
    }
    collectBrowserGlobalCandidate(node, browserGlobalCandidates, lineOf);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      callCandidates.push({
        line: lineOf(node),
        position: node.getStart(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { references, nonLiteralDynamic, browserGlobalCandidates, callCandidates };
}

/**
 * Records the position of every identifier whose name matches a browser-global
 * candidate, including the *base* identifier of a member expression
 * (`window.document.title` records both `window` and `document`). Local
 * declarations and member-access property names are excluded; the ambient vs.
 * local judgement is left to a later pass that consults the TypeScript
 * symbol's source file, so a parameter named `document` is correctly
 * identified as local.
 */
function collectBrowserGlobalCandidate(node, out, lineOf) {
  if (!ts.isIdentifier(node)) return;
  if (!BROWSER_GLOBAL_CANDIDATES.has(node.text)) return;
  if (isDeclarationOrPropertyName(node)) return;
  out.push({ name: node.text, line: lineOf(node), position: node.getStart() });
}

function isDeclarationOrPropertyName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) &&
    parent.name === node
  ) return true;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
    return true;
  return false;
}

/**
 * Browser-only host modules. A layer other than the React presentation layer
 * (bindings) or a composition root must not import these. DOM globals are held
 * out by the TypeScript `lib` split (`tsconfig.client.json` includes DOM,
 * `tsconfig.server.json` does not); this rule covers the React import edge that
 * the lib split cannot see.
 */
export const BROWSER_ONLY_MODULES_RE = /^(?:react|react-dom)(?:\/|$)/u;
const BROWSER_HOST_LAYERS = new Set(["root", "bindings"]);

function isConfiguredPathAlias(specifier, options) {
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const wildcard = pattern.indexOf("*");
    if (wildcard < 0) return specifier === pattern;
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    return specifier.startsWith(prefix) && specifier.endsWith(suffix) &&
      specifier.length >= prefix.length + suffix.length;
  });
}

function isSourceFile(absolutePath) {
  return SOURCE_SUFFIXES.some((suffix) => absolutePath.endsWith(suffix));
}

function walkSourceFiles(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (isSourceFile(full)) out.push(full);
  }
  return out;
}

/**
 * Builds the resolved, intra-package source import graph.
 *
 * Module specifiers are resolved with the repository's real TypeScript
 * resolver (`ts.resolveModuleName`) using the supplied compiler options, so the
 * result matches what the compiler actually links — including `.js` specifiers
 * that map to `.ts` sources and workspace-path aliases. Only edges whose target
 * is another source file inside `sourceDirectory` are edges; workspace-package
 * and Node builtins are outside this package's boundary.
 *
 * `references` counts every relative reference that resolves to a file inside
 * `sourceDirectory` (module edges plus resource imports such as `.json`), which
 * is the occurrence count the plan's baseline records. `edges` holds only the
 * source-to-source edges the direction matrix is evaluated over.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot
 * @param {import("typescript").CompilerOptions} [options.compilerOptions]
 * @param {(relativePath: string) => import("typescript").CompilerOptions} [options.compilerOptionsFor]
 * @param {string} [options.sourceDirectory]
 * @param {string[]} [options.files] absolute file list (defaults to a walk)
 * @returns {{sourceDirectory: string, files: string[], references: Array<object>, edges: Array<object>, unresolved: Array<object>, nonLiteralDynamic: Array<object>}}
 */
export function buildDependencyGraph(options) {
  const {
    repositoryRoot,
    compilerOptions,
    compilerOptionsFor,
    sourceDirectory = WEBUI_SOURCE_DIRECTORY,
    files,
  } = options;
  if (!compilerOptions && !compilerOptionsFor)
    throw new Error(
      "buildDependencyGraph requires compilerOptions or compilerOptionsFor",
    );
  const optionsFor =
    compilerOptionsFor ?? (() => compilerOptions);
  const sourceRoot = path.join(repositoryRoot, sourceDirectory);
  const sourceFiles = files ? [...files] : walkSourceFiles(sourceRoot);
  const references = [];
  const edges = [];
  const unresolved = [];
  const nonLiteralDynamic = [];
  const hostImports = [];
  // Text-only candidates; the ambient-or-local judgement is resolved once the
  // TypeScript program is built, in `resolveAmbientBrowserGlobals`.
  const browserGlobalCandidates = [];
  // File-anchored receiver calls — methods invoked through a typed expression
  // (`transport.sendMessage(...)`, `store.createSessionWriter(...)`). Resolved
  // by the same program-driven pass; the rule consults the *declared* type of
  // the receiver to decide whether the call is a writer-creation or RPC action.
  const callCandidates = [];

  for (const absoluteFile of sourceFiles) {
    const from = normaliseSourcePath(repositoryRoot, absoluteFile);
    if (from === null) continue;
    let text;
    try {
      text = readFileSync(absoluteFile, "utf8");
    } catch {
      continue;
    }
    const {
      references: fileReferences,
      nonLiteralDynamic: nonLiteral,
      browserGlobalCandidates: globalCandidates,
      callCandidates: calls,
    } = collectModuleReferences(absoluteFile, text);
    for (const entry of globalCandidates) {
      browserGlobalCandidates.push({ file: from, absoluteFile, ...entry });
    }
    for (const entry of calls) {
      callCandidates.push({ file: from, absoluteFile, ...entry });
    }
    for (const entry of nonLiteral)
      nonLiteralDynamic.push({ file: from, line: entry.line });
    for (const reference of fileReferences) {
      const compilerOptions = optionsFor(from);
      const resolved = ts.resolveModuleName(
        reference.specifier,
        absoluteFile,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      const target = resolved?.resolvedFileName;
      if (!target && (reference.specifier.startsWith(".") || isConfiguredPathAlias(reference.specifier, compilerOptions))) {
        unresolved.push({
          file: from,
          specifier: reference.specifier,
          line: reference.line,
          kind: reference.kind,
        });
        continue;
      }
      if (!target) {
        hostImports.push({ from, specifier: reference.specifier, line: reference.line, kind: reference.kind });
        continue;
      }
      const to = normaliseSourcePath(repositoryRoot, target);
      if (to === null) {
        // Resolved package imports are still host dependencies. Resolution is
        // useful for following source aliases, but must not make a React or
        // Node capability disappear from the host-import rules.
        hostImports.push({ from, specifier: reference.specifier, line: reference.line, kind: reference.kind, target });
        continue;
      }
      references.push({
        from,
        to,
        line: reference.line,
        kind: reference.kind,
        specifier: reference.specifier,
      });
      if (!isSourceFile(target)) continue; // resource import (e.g. .json), not a module edge
      edges.push({
        from,
        to,
        line: reference.line,
        kind: reference.kind,
        specifier: reference.specifier,
      });
    }
  }

  const { browserGlobalUses, callSites } = resolveAmbientFacts(
    sourceFiles,
    repositoryRoot,
    optionsFor,
    browserGlobalCandidates,
    callCandidates,
  );

  return {
    sourceDirectory,
    files: sourceFiles
      .map((file) => normaliseSourcePath(repositoryRoot, file))
      .filter((value) => value !== null),
    references,
    edges,
    unresolved,
    nonLiteralDynamic,
    hostImports,
    browserGlobalUses,
    callSites,
  };
}

/**
 * Resolves text-only candidates against the TypeScript program. Two distinct
 * results come out of one program build:
 *
 *  * `browserGlobalUses` keeps only the candidates whose symbol's *declaration*
 *    lives inside a TypeScript lib `*.d.ts` (`lib.dom.d.ts`, `lib.es5.d.ts`).
 *    Local parameters and member-access names never produce such a
 *    declaration, so they are filtered out by construction.
 *  * `callSites` records the calls whose receiver's declared type is one of
 *    the writer-factory / transport-RPC interfaces the plan lists (§7.5,
 *    §7.7). Each entry keeps the method name, the receiver's declared
 *    interface name, and the source file of the declaration so a stale-rename
 *    or an accidentally-shared interface surfaces immediately.
 */
function resolveAmbientFacts(sourceFiles, repositoryRoot, optionsFor, globalCandidates, callCandidates) {
  if (sourceFiles.length === 0) {
    return { browserGlobalUses: [], callSites: [] };
  }
  const groups = new Map();
  const globalByFile = new Map();
  for (const entry of globalCandidates) {
    if (!globalByFile.has(entry.absoluteFile)) globalByFile.set(entry.absoluteFile, []);
    globalByFile.get(entry.absoluteFile).push(entry);
  }
  const callsByFile = new Map();
  for (const entry of callCandidates) {
    if (!callsByFile.has(entry.absoluteFile)) callsByFile.set(entry.absoluteFile, []);
    callsByFile.get(entry.absoluteFile).push(entry);
  }
  for (const absoluteFile of sourceFiles) {
    const relative = normaliseSourcePath(repositoryRoot, absoluteFile) ?? absoluteFile.replaceAll("\\", "/");
    const compilerOptions = optionsFor(relative);
    const signature = JSON.stringify({
      configFilePath: compilerOptions.configFilePath,
      module: compilerOptions.module,
      moduleResolution: compilerOptions.moduleResolution,
      target: compilerOptions.target,
      paths: compilerOptions.paths,
      baseUrl: compilerOptions.baseUrl,
      types: compilerOptions.types,
    });
    if (!groups.has(signature)) groups.set(signature, { options: compilerOptions, files: [] });
    groups.get(signature).files.push(absoluteFile);
  }

  const browserGlobalUses = [];
  const callSites = [];

  for (const { options, files: rootNames } of groups.values()) {
    let program;
    try {
      program = ts.createProgram({
        rootNames,
        options: { ...options, noEmit: true, skipLibCheck: true },
      });
    } catch {
      // Program construction can fail on edge fixtures (e.g. fixtures with no
      // real source set). Treat the candidates as unresolvable rather than
      // crash the gate — the candidates that did resolve still drive the
      // judgements that matter.
      continue;
    }
    const checker = program.getTypeChecker();
    for (const absoluteFile of rootNames) {
      const sourceFile = program.getSourceFile(absoluteFile);
      if (!sourceFile) continue;
      const relative = normaliseSourcePath(repositoryRoot, absoluteFile) ?? absoluteFile.replaceAll("\\", "/");
      const findNodeAt = (position) => {
        let match;
        const visit = (node) => {
          if (match) return;
          if (node.getStart(sourceFile) === position && ts.isIdentifier(node)) {
            match = node;
            return;
          }
          ts.forEachChild(node, visit);
        };
        ts.forEachChild(sourceFile, visit);
        return match;
      };
      const isLibDeclaration = (symbol) => {
        if (!symbol) return false;
        const declarations = symbol.declarations ?? [];
        // `globalThis` is synthesised inside the TypeScript checker rather
        // than declared in any `lib.*.d.ts`. A local user declaration (very
        // rare) shadows it; otherwise the access is ambient.
        if (symbol.name === "globalThis") {
          return !declarations.some((decl) => !decl.getSourceFile().isDeclarationFile);
        }
        return declarations.some((declaration) => {
          const fileName = declaration.getSourceFile().fileName.replaceAll("\\", "/");
          return declaration.getSourceFile().isDeclarationFile
            && /\/typescript\/lib\/lib\.(?:dom|es5|webworker|scripthost|es2020|esnext(?:\.full)?)\.d\.ts$/u.test(fileName);
        });
      };
      for (const candidate of globalByFile.get(absoluteFile) ?? []) {
        const node = findNodeAt(candidate.position);
        if (!node) continue;
        const symbol = checker.getSymbolAtLocation(node);
        if (isLibDeclaration(symbol)) {
          browserGlobalUses.push({ file: relative, name: candidate.name, line: candidate.line });
        }
      }
      for (const candidate of callsByFile.get(absoluteFile) ?? []) {
        // The candidate.position recorded here is the *call expression* start;
        // recurse one step to recover the property-access expression so we can
        // ask the checker about the receiver's declared type. Without this
        // indirection the receiver and method names cannot be resolved.
        const findCallExpression = () => {
          let match;
          const visit = (node) => {
            if (match) return;
            if (node.getStart(sourceFile) === candidate.position && ts.isCallExpression(node)) {
              match = node;
              return;
            }
            ts.forEachChild(node, visit);
          };
          ts.forEachChild(sourceFile, visit);
          return match;
        };
        const call = findCallExpression();
        if (!call || !ts.isPropertyAccessExpression(call.expression)) continue;
        const propertyAccess = call.expression;
        const methodSymbol = checker.getSymbolAtLocation(propertyAccess.name);
        const methodName = propertyAccess.name.text;
        const methodDeclaration = methodSymbol?.valueDeclaration ?? methodSymbol?.declarations?.[0];
        const methodSource = methodDeclaration?.getSourceFile().fileName.replaceAll("\\", "/") ?? "";
        const receiverType = checker.getTypeAtLocation(propertyAccess.expression);
        const receiverSymbol = receiverType.aliasSymbol ?? receiverType.getSymbol();
        const receiverName = receiverSymbol?.name ?? "";
        callSites.push({
          file: relative,
          line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1,
          method: methodName,
          receiver: receiverName,
          methodSource,
        });
      }
    }
  }
  return { browserGlobalUses, callSites };
}

// ---------------------------------------------------------------------------
// Rules (mirror the boundary module's `rules` array shape)
// ---------------------------------------------------------------------------

function directionRule(graph) {
  const violations = [];
  for (const edge of graph.edges) {
    const fromLayers = classifyLayers(edge.from);
    const toLayers = classifyLayers(edge.to);
    if (isAllowedEdge(fromLayers, toLayers)) continue;
    const category = categoriseViolation(edge.from, edge.to, fromLayers, toLayers);
    violations.push({
      kind: "direction",
      from: edge.from,
      to: edge.to,
      line: edge.line,
      referenceKind: edge.kind,
      layerFrom: fromLayers,
      layerTo: toLayers,
      rule: `${fromLayers.join("|")} -> ${toLayers.join("|")}`,
      category,
      detail: `${edge.from} -> ${edge.to}: ${fromLayers.join("|")} may not import ${toLayers.join("|")}`,
    });
  }
  return { pass: violations.length === 0, violations };
}

function browserOnlyRule(graph) {
  const violations = [];
  for (const entry of graph.hostImports) {
    if (!BROWSER_ONLY_MODULES_RE.test(entry.specifier)) continue;
    const layers = classifyLayers(entry.from);
    // Allowed when *any* target layer of the importing file may use the host
    // module (e.g. a file that is both application logic and a React binding).
    if (layers.some((layer) => BROWSER_HOST_LAYERS.has(layer))) continue;
    violations.push({
      kind: "browser-only",
      file: entry.from,
      line: entry.line,
      specifier: entry.specifier,
      layerFrom: layers,
      rule: `${layers.join("|")} -> host:${entry.specifier}`,
      category: "browser-only-host-import",
      detail: `${entry.from}:${entry.line}: ${layers.join("|")} may not import browser-only module "${entry.specifier}"`,
    });
  }
  return { pass: violations.length === 0, violations };
}

function unresolvedRule(graph) {
  const violations = graph.unresolved.map((entry) => ({
    kind: "unresolved",
    file: entry.file,
    line: entry.line,
    detail: `${entry.file}:${entry.line}: unresolved intra-package import "${entry.specifier}"`,
  }));
  return { pass: violations.length === 0, violations };
}

function nonLiteralDynamicRule(graph) {
  const violations = graph.nonLiteralDynamic.map((entry) => ({
    kind: "non-literal-dynamic",
    file: entry.file,
    line: entry.line,
    detail: `${entry.file}:${entry.line}: non-literal dynamic import cannot be checked`,
  }));
  return { pass: violations.length === 0, violations };
}

// Per-name exemption policy for ambient browser globals. Each candidate has
// its own allowed layer set (and an optional path allowlist) so the rule can
// permit bindings that legitimately listen to `window` events without
// letting arbitrary `localStorage` access slip into a component.
//
// `window`/`globalThis` are legitimate in bindings (hashchange, online event
// reconnection), root (composition) and infrastructure (browser IO). Local
// parameters with the same name are still filtered by the AST ambient check.
// `document`/`localStorage`/`sessionStorage` are restricted to a narrow IO
// owner list — they are what the lead flagged as application/projection
// violations and what the storage injection refactor removed from bindings.
const BROWSER_GLOBAL_POLICY = {
  window: { layers: new Set(["root", "bindings", "infrastructure"]) },
  // `globalThis` is also the Node-side ambient object — the runtime and
  // runtime-port layers may legitimately read platform properties from it
  // (fetch, crypto, performance). The browser-specific globals below stay
  // restricted to the browser IO surface.
  globalThis: {
    layers: new Set(["root", "bindings", "infrastructure", "runtime", "runtime-port"]),
  },
  document: {
    layers: new Set(["root", "infrastructure"]),
    files: new Set(["client/infrastructure/storage.ts"]),
  },
  localStorage: {
    layers: new Set(["root", "infrastructure"]),
    files: new Set(["client/infrastructure/storage.ts"]),
  },
  sessionStorage: {
    layers: new Set(["root", "infrastructure"]),
    files: new Set(["client/infrastructure/storage.ts"]),
  },
};

function isBrowserGlobalAllowed(name, file, layers) {
  const policy = BROWSER_GLOBAL_POLICY[name];
  if (!policy) return false;
  if (policy.files?.has(file)) return true;
  return layers.some((layer) => policy.layers.has(layer));
}

function forbiddenGlobalRule(graph) {
  const violations = graph.browserGlobalUses.filter((entry) => {
    const layers = classifyLayers(entry.file);
    // The candidates passed through `resolveAmbientFacts` are already filtered
    // to those whose symbols live in lib.dom.d.ts / lib.es5.d.ts. Local
    // parameters and member-access names never produce such declarations, so
    // they have been dropped before this rule runs.
    return !isBrowserGlobalAllowed(entry.name, entry.file, layers);
  }).map((entry) => ({
    kind: "browser-global",
    file: entry.file,
    line: entry.line,
    global: entry.name,
    detail: `${entry.file}:${entry.line}: ${classifyLayers(entry.file).join("|")} may not access ambient browser capability "${entry.name}" directly`,
  }));
  return { pass: violations.length === 0, violations };
}

// Layers whose modules may import Node builtins directly. Everything else —
// including `client/` packages and `shared/` contracts — must reach the host
// through the harness port / runtime adapter, never through `import "fs"`.
const NODE_BUILTIN_ALLOWED_LAYERS = new Set(["server", "runtime", "runtime-port"]);

function isNodeBuiltinSpecifier(specifier) {
  if (specifier.startsWith("node:")) return true;
  // Bare specifier; only a Node builtin if its name is registered as one and
  // no relative/file path is implied.
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  return BUILTIN_NODE_MODULES.has(specifier);
}

function forbiddenNodeBuiltinRule(graph) {
  const violations = graph.hostImports.filter((entry) => {
    if (!isNodeBuiltinSpecifier(entry.specifier)) return false;
    const layers = classifyLayers(entry.from);
    return layers.every((layer) => !NODE_BUILTIN_ALLOWED_LAYERS.has(layer));
  }).map((entry) => ({
    kind: "node-builtin",
    file: entry.from,
    line: entry.line,
    specifier: entry.specifier,
    detail: `${entry.from}:${entry.line}: ${classifyLayers(entry.from).join("|")} may not import Node builtin "${entry.specifier}"`,
  }));
  return { pass: violations.length === 0, violations };
}

/**
 * Capability interface names whose method invocations are reserved for
 * application / infrastructure code. A `bindings` or `view` layer
 * performing one of these calls is reaching for a writer or a business RPC
 * that belongs inside the application.
 */
const FORBIDDEN_RECEIVER_INTERFACES = new Map([
  // [declaredReceiverName, forbiddenMethodNames]
  ["WebuiSessionStore", new Set(["createSessionWriter", "createInteractionWriter"])],
  ["WebuiTransport", null], // any method call is a business RPC; null = wildcard
  ["SessionPort", null],
  ["ExecutionPort", null],
  ["InteractionPort", null],
  ["WorkspacePort", null],
  ["SettingsPort", null],
  ["AccountPort", null],
  ["PluginPort", null],
  ["TerminalPort", null],
]);

// Layers that must *not* invoke a writer-factory or a business-RPC method.
// The `bindings` layer is intentionally absent: it is the legitimate bridge
// that turns a writer into a command surface (plan §7.2
// `client/bindings/use-session-state.ts`). Lower-level layers
// (view/domain/contracts/shared/mechanisms) do not own capability
// interactions, so a writer or RPC call there is treated as a sign the
// application contract has slipped.
//
// Presentation is the one case the layer set cannot express. `classifyLayers`
// maps `client/components/` to `bindings` — the same layer as the bridge — so a
// layer-only test would exempt every component along with it.
// `CALL_PRESENTATION_PREFIX` below carries that half of the judgement by path.
const CALL_FORBIDDEN_LAYERS = new Set([
  "view",
  "domain",
  "contracts",
  "shared",
  "mechanisms",
]);

/**
 * Paths whose files are presentation and therefore may not hold a capability
 * call, even though their classified layer is `bindings`. This is not a
 * directory denylist for imports (see the `ALLOWED_EDGES` note: nothing is
 * forbidden merely because a directory is named); it is the call-site rule's
 * missing half. The rule asks whether the *caller* owns capability
 * interactions, and the plan answers that per directory: `client/bindings/` is
 * the bridge that converts a writer into a command surface, `client/components/`
 * is the shell and its panels, which submit commands and receive none of the
 * capability objects these methods are reached through.
 */
const CALL_PRESENTATION_PREFIX = "client/components/";

function forbiddenActualCallRule(graph) {
  const violations = [];
  for (const site of graph.callSites ?? []) {
    const allowed = FORBIDDEN_RECEIVER_INTERFACES.get(site.receiver);
    if (allowed === undefined) continue;
    if (allowed !== null && !allowed.has(site.method)) continue;
    const layers = classifyLayers(site.file);
    // A call site fails when the file carries *any* forbidden target layer, or
    // when it is presentation. "Any" is the judgement the previous
    // `layers.every(!has)` test made — `!every(!has)` is `some(has)` — so the
    // split-file behaviour is unchanged; no file currently classifies to more
    // than one target layer, and `classifyLayers` is the only place that could
    // grow a second one.
    const forbiddenLayer = layers.some((layer) => CALL_FORBIDDEN_LAYERS.has(layer));
    const presentation = site.file.startsWith(CALL_PRESENTATION_PREFIX);
    if (!forbiddenLayer && !presentation) continue;
    violations.push({
      kind: "forbidden-call",
      file: site.file,
      line: site.line,
      target: `${site.receiver}.${site.method}`,
      detail: `${site.file}:${site.line}: ${layers.join("|")}${presentation ? " (presentation)" : ""} may not invoke writer or business-RPC method "${site.receiver}.${site.method}"`,
    });
  }
  return { pass: violations.length === 0, violations };
}

/**
 * Returns cycles as canonical rotations (smallest path first, closed back to
 * itself) so a cycle compares stably regardless of where traversal entered.
 */
export function detectCycles(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from).add(edge.to);
  }
  const colour = new Map();
  const seen = new Set();
  const cycles = [];
  const stack = [];
  const visit = (node) => {
    colour.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (colour.get(next) === 1) {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        const key = canonicalCycle(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!colour.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    colour.set(node, 2);
  };
  for (const node of adjacency.keys()) if (!colour.has(node)) visit(node);
  return cycles;
}

/** Canonical, rotation-stable string for a closed cycle path. */
export function canonicalCycle(cycle) {
  const body = cycle.slice(0, -1);
  if (body.length === 0) return "";
  let best = 0;
  for (let i = 1; i < body.length; i += 1) {
    if (body[i] < body[best]) best = i;
  }
  const rotated = body.slice(best).concat(body.slice(0, best));
  return rotated.concat(rotated[0]).join(" -> ");
}

function cycleRule(graph) {
  const violations = detectCycles(graph.edges).map((cycle) => ({
    kind: "cycle",
    cycle,
    canonical: canonicalCycle(cycle),
    detail: `import cycle: ${canonicalCycle(cycle)}`,
  }));
  return { pass: violations.length === 0, violations };
}

/** All rules, in the order the CLI applies them. */
export const rules = Object.freeze([
  directionRule,
  browserOnlyRule,
  forbiddenGlobalRule,
  forbiddenNodeBuiltinRule,
  forbiddenActualCallRule,
  unresolvedRule,
  nonLiteralDynamicRule,
  cycleRule,
]);

/**
 * Runs every rule against a graph and returns a flat, structured result.
 *
 * @param {object} graph
 * @returns {{
 *   pass: boolean,
 *   violations: Array<object>,
 *   direction: Array<object>,
 *   unresolved: Array<object>,
 *   nonLiteralDynamic: Array<object>,
 *   cycles: Array<object>,
 *   nodeBuiltins: Array<object>,
 *   forbiddenCalls: Array<object>,
 * }}
 */
export function evaluateGraph(graph) {
  const results = rules.map((rule) => rule(graph));
  const direction = results[0].violations;
  const browserOnly = results[1].violations;
  const browserGlobals = results[2].violations;
  const nodeBuiltins = results[3].violations;
  const forbiddenCalls = results[4].violations;
  const unresolved = results[5].violations;
  const nonLiteralDynamic = results[6].violations;
  const cycles = results[7].violations;
  const violations = [
    ...direction,
    ...browserOnly,
    ...browserGlobals,
    ...nodeBuiltins,
    ...forbiddenCalls,
    ...unresolved,
    ...nonLiteralDynamic,
    ...cycles,
  ];
  return {
    pass: violations.length === 0,
    violations,
    direction,
    browserOnly,
    browserGlobals,
    nodeBuiltins,
    forbiddenCalls,
    sharedNodeBuiltins: nodeBuiltins,
    unresolved,
    nonLiteralDynamic,
    cycles,
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

/** Stable key for a direction violation / baseline entry. */
export function pairKey(from, to) {
  return `${from} -> ${to}`;
}

/**
 * Compares measured direction violations against the frozen baseline. A
 * violation absent from the baseline is a *new* violation; a baseline entry no
 * longer violated is *stale*. Both fail the check — a stale entry is what
 * forces each migration slice to delete the exception it removed.
 *
 * @param {Array<object>} violations direction violations
 * @param {Array<object>} entries baseline entries
 */
export function compareBaseline(violations, entries) {
  const baseline = new Map(entries.map((entry) => [pairKey(entry.from, entry.to), entry]));
  const measured = new Set();
  const newViolations = [];
  for (const violation of violations) {
    const key = pairKey(violation.from, violation.to);
    // A pair can violate once per reference; collapse to one key.
    if (measured.has(key)) continue;
    measured.add(key);
    if (!baseline.has(key)) newViolations.push(violation);
  }
  const staleEntries = entries.filter(
    (entry) => !measured.has(pairKey(entry.from, entry.to)),
  );
  return { newViolations, staleEntries };
}

/**
 * Collapses measured direction violations to one representative per file pair
 * (occurrence counts are kept), which is the granularity of the baseline.
 *
 * `occurrences` starts at 1 on the entry that represents the pair and is
 * incremented for every further violation of it. The base is set here, at the
 * single insertion point, rather than derived from whatever the entry already
 * held: `undefined + 1` is `NaN`, `NaN + 1` stays `NaN`, and `NaN` has no JSON
 * form (`JSON.stringify` writes `null`), so an entry built that way could never
 * survive a round trip and any equality-based reader saw a field that kept
 * changing. No coalescing fallback (`Number(x) || 0`, `?? 0`) is needed for the
 * same reason it would be harmful: it would turn "an entry was inserted without
 * the count" — a programming error this single insertion point rules out — into
 * a silently wrong number rather than a visible one.
 *
 * @param {Array<object>} violations
 * @returns {Array<object>}
 */
export function toBaselineShape(violations) {
  const byPair = new Map();
  for (const violation of violations) {
    const key = pairKey(violation.from, violation.to);
    const existing = byPair.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    const category = CATEGORIES[violation.category] ?? CATEGORIES.unclassified;
    byPair.set(key, {
      from: violation.from,
      to: violation.to,
      layerFrom: violation.layerFrom.join("|"),
      layerTo: violation.layerTo.join("|"),
      rule: violation.rule,
      category: violation.category,
      stage: category.stage,
      reason: category.description,
      occurrences: 1,
    });
  }
  return [...byPair.values()].sort((a, b) =>
    pairKey(a.from, a.to) < pairKey(b.from, b.to) ? -1 : 1,
  );
}
