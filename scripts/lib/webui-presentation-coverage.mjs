// Coverage classification for the WebUI presentation layer (ADR 0028).
//
// The ADR states the obligation this module measures: every client UI source
// module — a file under a business's `ui/`, a file under `shell/`, and a file
// under the shared `ui/` — is classified, and the classification is recorded
// where the gate that reads it can find it. Coverage is an adoption
// obligation, not a claim a gate can prove: this check proves that every
// module has been *decided on*, and it cannot see a surface added inside an
// already classified module. That is why a change to a classified module's
// rendered vocabulary is reported for review rather than accepted, and why a
// pending disposition is a valid classification that marks the programme
// unfinished.
//
// `scripts/check-webui-presentation.mjs` is the CLI entry. Tests import the
// functions below directly, so nothing here reads the filesystem at import
// time.

import { readdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** @type {typeof import("typescript")} */
const ts = require("typescript");

/** Client source directory whose presentation modules this check covers. */
export const CLIENT_SOURCE_DIRECTORY = "packages/webui/src/client";

/**
 * The shared home, relative to the client source directory.
 *
 * A module under it *is* the shared layer; a module outside it is a caller.
 */
export const SHARED_HOME_DIRECTORY = "ui";

/** Suffixes that make a presentation module. Stylesheets are out of scope. */
export const MODULE_SUFFIXES = Object.freeze([".ts", ".tsx"]);

/**
 * The eight families of ADR 0028. A module's entry names the families it
 * belongs to; the family contracts themselves live in
 * `packages/webui/docs/design/design-language.md`.
 */
export const FAMILIES = Object.freeze([
  "foundations",
  "controls-and-form-composition",
  "navigation-and-selection",
  "overlays",
  "structure",
  "surfaces-and-content",
  "feedback-and-recovery",
  "conversation-and-workspace-interaction",
]);

/**
 * The five dispositions. Every entry carries exactly one.
 *
 * `composition` is for a module that renders no presentation surface of its own —
 * a hook, a pure projection, a scaffold that only arranges other modules. Its
 * obligation is discharged by what it mounts, not by adopting a contract it never
 * renders, and calling it an exception would be wrong in the other direction: it
 * is not declining the contract, it has nothing to decline.
 */
export const DISPOSITIONS = Object.freeze([
  "existing-shared-contract",
  "newly-adopted-contract",
  "composition",
  "business-exception",
  "pending-contract-decision",
]);

/** What an entry classifies: a rendered surface, or one presentation concern. */
export const KINDS = Object.freeze(["surface", "concern"]);

/** Current inventory schema version. */
export const INVENTORY_VERSION = 1;

/** Repository-relative path of the inventory the gate reads. */
export const INVENTORY_FILE = "scripts/lib/webui-presentation-inventory.json";

/**
 * Is `relativePath` (relative to the client source directory) a client UI
 * source module?
 *
 * The three homes are the business presentation directory, the shell and the
 * shared presentation home. Role directories are flat, so a file below a
 * deeper directory is not a presentation module.
 */
export function isPresentationModule(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) return false;
  if (!MODULE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  if (relativePath.endsWith(".d.ts")) return false;
  const segments = relativePath.split("/");
  if (segments.length === 2 && segments[0] === "ui") return true;
  if (segments.length === 2 && segments[0] === "shell") return true;
  return (
    segments.length === 4 &&
    segments[0] === "features" &&
    segments[1].length > 0 &&
    segments[2] === "ui"
  );
}

/**
 * Discover every presentation module under `clientRoot`.
 *
 * Returns client-relative POSIX paths, sorted. A missing directory is an empty
 * set rather than an error, so a fixture tree needs only the homes it uses.
 */
export function discoverPresentationModules(clientRoot) {
  const found = [];
  const walk = (relativeDirectory) => {
    let entries;
    try {
      entries = readdirSync(path.join(clientRoot, relativeDirectory), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) walk(relativePath);
      else if (isPresentationModule(relativePath)) found.push(relativePath);
    }
  };
  walk("ui");
  walk("shell");
  walk("features");
  return found.filter((relativePath) => isPresentationModule(relativePath)).sort();
}

function tagNameText(tagName) {
  if (!tagName) return null;
  if (ts.isIdentifier(tagName)) return tagName.text;
  return tagName.getText();
}

/**
 * The surface signature of a module: a digest over what the module exports and
 * what it renders.
 *
 * Coverage cannot see a surface added inside an already classified module, so
 * the gate reports a module whose signature moved. The signature covers the
 * module's explicit export names, the JSX element names it renders and the
 * values of its `role` attributes — the vocabulary a new surface is built
 * from. A comment, a class name or a prop value does not move it, so the
 * report stays about surfaces rather than about every edit.
 */
export function surfaceSignature(source, filename) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const vocabulary = new Set();
  const isExported = (node) =>
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  // A default export is a published name too, so it is recorded as one.
  const recordDefaultExport = (node) => {
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      vocabulary.add("export:default");
    }
  };
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      isExported(node)
    ) {
      if (node.name) vocabulary.add(`export:${node.name.text}`);
      recordDefaultExport(node);
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) vocabulary.add(`export:${declaration.name.text}`);
      }
    }
    if (ts.isExportAssignment(node)) vocabulary.add("export:default");
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagNameText(node.tagName);
      if (tag) vocabulary.add(`tag:${tag}`);
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const attributeName = attribute.name.getText();
        if (attributeName !== "role") continue;
        const value = attribute.initializer;
        const text =
          value && ts.isStringLiteral(value) ? value.text : value ? value.getText() : "";
        vocabulary.add(`role:${text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const canonical = [...vocabulary].sort().join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compare the inventory with the modules on disk.
 *
 * `modules` is `[{ path, signature }]` for every discovered module. The result
 * separates `failures` — conditions that make the classification untrue — from
 * `reviews`, which are reported and never fail: a module whose rendered
 * vocabulary moved since it was classified must be looked at again, but a
 * green gate must not pretend it was.
 */
/**
 * The names a module imports from the shared home *as values*.
 *
 * A type-only import is a dependency on a shape, not on a contract: importing
 * `WebuiContextMenuItem` tells you what a menu row looks like, it does not make
 * the caller render one. The thin-adopter rule counts only the value imports,
 * because a module that claims to have adopted a contract has to depend on
 * something it can actually render or call.
 *
 * The shared home is found by resolving the import, not by looking for a
 * `ui/` segment in the specifier: every business has a `ui/` directory of its
 * own, and `features/transcript/ui/GreetingSkeleton.js` is not the shared
 * layer.
 */
export function sharedHomeValueImports(source, filename) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const directory = filename.split("/").slice(0, -1).join("/");
  const names = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const resolved = path.posix.normalize(path.posix.join(directory, specifier));
    if (!resolved.startsWith(`${SHARED_HOME_DIRECTORY}/`)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    // `import { type X }` and `import type { X }` are shapes, not contracts.
    if (clause.name) names.push(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        names.push(element.name.text);
      }
    }
  }
  return names;
}

export function evaluatePresentationCoverage({ modules, inventory }) {
  const failures = [];
  const reviews = [];
  const modulePaths = new Set(modules.map((module) => module.path));
  const inventoryEntries = isPlainObject(inventory) ? inventory.entries : undefined;
  const reviewed = isPlainObject(inventory?.reviewed) ? inventory.reviewed : {};

  if (!Array.isArray(inventoryEntries)) {
    failures.push({
      kind: "invalid-inventory",
      path: INVENTORY_FILE,
      detail: "the inventory has no `entries` array",
    });
    return { failures, reviews, summary: buildSummary({ modules, entries: [], failures, reviews }) };
  }

  const classifiedPaths = new Set();
  const moduleByPath = new Map(modules.map((module) => [module.path, module]));
  for (const entry of inventoryEntries) {
    if (!isPlainObject(entry) || typeof entry.path !== "string") {
      failures.push({
        kind: "invalid-entry",
        path: typeof entry?.path === "string" ? entry.path : "(unknown)",
        detail: "an entry is not an object with a `path` string",
      });
      continue;
    }
    const { path: entryPath } = entry;
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    const revisit = typeof entry.revisit === "string" ? entry.revisit.trim() : "";
    if (!modulePaths.has(entryPath)) {
      failures.push({
        kind: "stale",
        path: entryPath,
        detail: `classified module does not exist: ${entryPath}`,
      });
      continue;
    }
    classifiedPaths.add(entryPath);
    if (!DISPOSITIONS.includes(entry.disposition)) {
      failures.push({
        kind: "invalid-disposition",
        path: entryPath,
        detail: `invalid disposition ${JSON.stringify(entry.disposition)} — one of ${DISPOSITIONS.join(", ")}`,
      });
    }
    // An exception is a reviewed decision, so it states both halves of the
    // decision: the reason it is exempt today, and the condition that reopens
    // it. Without the condition the exemption can only be re-litigated by
    // whoever notices it again, which is how a reviewed exception turns into
    // permanent drift. Both halves are reported as one failure per entry, so a
    // row missing both names both instead of appearing twice in the report.
    if (entry.disposition === "business-exception") {
      const missing = [];
      if (reason.length === 0) missing.push("a recorded reason");
      if (revisit.length === 0) missing.push("the condition under which it is revisited");
      if (missing.length > 0) {
        failures.push({
          kind: "invalid-disposition",
          path: entryPath,
          detail: `a business exception carries ${missing.join(" and ")}`,
        });
      }
    }
    if (!KINDS.includes(entry.kind)) {
      failures.push({
        kind: "invalid-kind",
        path: entryPath,
        detail: `invalid kind ${JSON.stringify(entry.kind)} — one of ${KINDS.join(", ")}`,
      });
    }
    const families = Array.isArray(entry.families) ? entry.families : [];
    if (families.length === 0) {
      failures.push({
        kind: "invalid-family",
        path: entryPath,
        detail: "an entry names at least one family",
      });
    }
    for (const family of families) {
      if (!FAMILIES.includes(family)) {
        failures.push({
          kind: "invalid-family",
          path: entryPath,
          detail: `invalid family ${JSON.stringify(family)} — one of ${FAMILIES.join(", ")}`,
        });
      }
    }
    if (typeof entry.label !== "string" || entry.label.trim().length === 0) {
      failures.push({
        kind: "invalid-entry",
        path: entryPath,
        detail: "an entry carries a non-empty `label`",
      });
    }
    // The thin-adopter rule. A module classified as having adopted a contract
    // has to depend on the shared home with something it can render or call. A
    // type-only import is a dependency on a shape: it tells the caller what a
    // contract looks like without the caller rendering one, and a classification
    // that claims adoption without it is a classification that is not true.
    if (
      entry.disposition === "newly-adopted-contract" &&
      !entryPath.startsWith(`${SHARED_HOME_DIRECTORY}/`)
    ) {
      const adopted = moduleByPath.get(entryPath)?.sharedHomeValues ?? [];
      if (adopted.length === 0) {
        failures.push({
          kind: "thin-adopter",
          path: entryPath,
          detail:
            "classified as newly-adopted-contract but renders or calls nothing from the shared home — adopt the contract or record the module as a business exception or a composition",
        });
      }
    }
  }

  for (const module of modules) {
    if (!classifiedPaths.has(module.path)) {
      failures.push({
        kind: "unclassified",
        path: module.path,
        detail: `unclassified client UI module: ${module.path}`,
      });
      continue;
    }
    const recorded = reviewed[module.path];
    if (typeof recorded !== "string") {
      reviews.push({
        path: module.path,
        recorded: null,
        current: module.signature,
        detail: "classified but has no recorded signature — review and record it",
      });
      continue;
    }
    if (recorded !== module.signature) {
      reviews.push({
        path: module.path,
        recorded,
        current: module.signature,
        detail: "rendered vocabulary changed since classification — review and record it",
      });
    }
  }

  return {
    failures,
    reviews,
    summary: buildSummary({
      modules,
      entries: inventoryEntries.filter(
        (entry) => isPlainObject(entry) && typeof entry.path === "string",
      ),
      failures,
      reviews,
    }),
  };
}

function buildSummary({ modules, entries, failures, reviews }) {
  const counts = Object.fromEntries(DISPOSITIONS.map((disposition) => [disposition, 0]));
  const familyCounts = Object.fromEntries(FAMILIES.map((family) => [family, 0]));
  for (const entry of entries) {
    if (DISPOSITIONS.includes(entry.disposition)) counts[entry.disposition] += 1;
    for (const family of Array.isArray(entry.families) ? entry.families : []) {
      if (FAMILIES.includes(family)) familyCounts[family] += 1;
    }
  }
  const classifiedModules = new Set(
    entries
      .filter((entry) => DISPOSITIONS.includes(entry.disposition))
      .map((entry) => entry.path),
  ).size;
  const pending = counts["pending-contract-decision"];
  return {
    modules: modules.length,
    entries: entries.length,
    classifiedModules,
    dispositions: counts,
    families: familyCounts,
    unclassified: modules.length - classifiedModules,
    pending,
    // The gate proves the inventory is complete. A zero pending count is
    // necessary but not sufficient for unification: #294's coverage review
    // confirms the adopted contracts and their verification.
    inventoryComplete: failures.length === 0 && classifiedModules === modules.length,
    unificationComplete: pending === 0,
    reviewRequired: reviews.length,
  };
}

/**
 * Serialise the inventory in its reviewed form: one entry per line and one
 * signature per line, so a change to a single module is a single-line diff and
 * the file stays readable as a list.
 */
export function serializeInventory(inventory) {
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
  const reviewed = isPlainObject(inventory?.reviewed) ? inventory.reviewed : {};
  const entryLine = (entry) => `    ${JSON.stringify(entry)}`;
  const lines = [
    "{",
    `  "version": ${JSON.stringify(inventory?.version ?? INVENTORY_VERSION)},`,
    '  "entries": [',
    entries.map(entryLine).join(",\n"),
    "  ],",
    '  "reviewed": {',
    Object.keys(reviewed)
      .sort()
      .map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(reviewed[key])}`)
      .join(",\n"),
    "  }",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

/** Read an inventory file's text into the object form the gate evaluates. */
export function parseInventory(text) {
  return JSON.parse(text);
}

/**
 * Record current signatures for the given paths, returning a new inventory.
 * Only `reviewed` changes; the classification is never rewritten by the CLI.
 */
export function recordReviewedSignatures(inventory, modules, paths) {
  const wanted = new Set(paths);
  const reviewed = { ...(isPlainObject(inventory?.reviewed) ? inventory.reviewed : {}) };
  for (const module of modules) {
    if (!wanted.has(module.path)) continue;
    reviewed[module.path] = module.signature;
  }
  const ordered = Object.fromEntries(
    Object.keys(reviewed)
      .sort()
      .map((key) => [key, reviewed[key]]),
  );
  return { ...inventory, reviewed: ordered };
}
