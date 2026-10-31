// The publication visibility gate.
//
// A `.public.ts` / `.public.tsx` module is a business's published surface, and
// this file decides what may live in one. It exists because the alternative is
// unenforceable: the peer-import ledger recorded *which* cross-business imports
// were tolerated, but not what a module published for everyone had to look like.
// A publication marker with no rules is just a filename.
//
// The rules are bounded on purpose. A published module is a contract, and the
// bounds are what keep it a contract rather than an alias for the private
// module next to it:
//
//   1. Every explicit export is public. There is no symbol-level privacy: the
//      rules cannot distinguish `export const x` from `export const y` on
//      intent, so any module carrying the marker publishes everything it exports.
//   2. No export-star. `export * from "./private"` would republish a private
//      module's whole surface, including anything added to it later.
//   3. No foreign re-export. `export { x } from "../other-business/y"` would
//      make this business the publisher of another one's rule.
//   4. No unsupported foreign namespace, default or dynamic access. The same
//      three escapes, for the same reason.
//
// Recognition is by real path, never by a hand-written list: a list goes stale
// the first time a module is renamed, and a stale list is a gate that passes
// files it should reject. `isPublicModulePath` is the single predicate, and the
// layer classifier uses the same one, so the gate and the layer rules cannot
// disagree about what counts as published.

import { readFileSync } from "node:fs";

/**
 * Whether a source path names a published module.
 *
 * The `.public` marker sits before the extension, so `foo.public.ts` and
 * `foo.public.tsx` are published while `foo.ts` and `public.ts` are not. The
 * extension is checked rather than assumed: a `.d.ts` with the marker carries no
 * runtime surface and must not be treated as one.
 *
 * @param {string} normalized source path relative to the package's src, with
 *   forward slashes
 * @returns {boolean}
 */
export function isPublicModulePath(normalized) {
  return /\.(public)\.(tsx|ts)$/u.test(normalized);
}

/** The published module's kind, which decides what it may export. */
export function publicModuleKind(normalized) {
  return normalized.endsWith(".public.tsx") ? "component" : "derivation";
}

/**
 * Whether an import of `specifier` from a published module reaches *another
 * business*, which is what the namespace and dynamic restrictions are about.
 *
 * The accepted rule restricts foreign access: reaching a peer's surface by a name
 * the gate cannot resolve to a symbol. It explicitly keeps owner-private
 * implementation imports legal, so a published module may reach its own private
 * sibling by namespace or by a literal dynamic import — that is ordinary
 * composition inside one business, not a peer's interface being republished.
 * A blanket syntax ban (which is what this used to be) reported both, so the gate
 * no longer matched the policy it claimed to implement.
 *
 * The judgement is deliberately conservative where it cannot see: a relative
 * module it cannot resolve is treated as foreign, so a resolution failure fails
 * closed rather than granting access. A bare (non-relative) specifier is a
 * package or host import, not a peer business, so the layer rules judge it and
 * this one does not.
 *
 * @param {string} specifier the import specifier as written
 * @param {{
 *   ownerBusiness: string | null,
 *   businessOf: ((relativePath: string) => string | null) | null,
 *   resolveSpecifier: ((specifier: string) => string | null) | null,
 * }} context
 * @returns {boolean}
 */
function isForeignAccess(specifier, context) {
  const { ownerBusiness, businessOf, resolveSpecifier } = context;
  const relative = specifier.startsWith(".");
  if (!relative) {
    // A bare specifier is not automatically out of scope: a workspace alias can point
    // at a peer's published module exactly as a relative path can, and returning early
    // here is what let `@models/...` reach a foreign module with no violation. The
    // resolver has the answer, so ask it — and only when it cannot say (an npm package,
    // a node builtin) is the specifier left alone.
    if (!resolveSpecifier) return false;
    const aliased = resolveSpecifier(specifier);
    if (!aliased) return false;
    const aliasedBusiness = businessOf ? businessOf(aliased) : null;
    if (aliasedBusiness === null) return false;
    return aliasedBusiness !== ownerBusiness;
  }
  if (!resolveSpecifier || !businessOf) return true;
  const target = resolveSpecifier(specifier);
  if (!target) return true;
  const targetBusiness = businessOf(target);
  // A target with no business is not a peer's surface: `shared/`, a leaf
  // contract under `client/contracts/`, and the generic UI home all resolve to
  // `business: null`, and reaching them by namespace is the layer rules' business.
  if (targetBusiness === null) return false;
  return targetBusiness !== ownerBusiness;
}

/**
 * Read the statements a published module may not contain.
 *
 * This is a bounded syntactic pass, not a parser. The gate needs to recognise a
 * small set of escapes — export-star, foreign re-export, foreign namespace
 * access, dynamic import of a peer — and a full AST walk would mean the gate
 * depends on the same `typescript` import the classifier already has, which is
 * fine, but it would also mean every syntactic shape it must know about is
 * specified twice: once in the TypeScript grammar and once here. The statements
 * it looks for are the ones whose *intent* is unambiguous in the source text:
 * `export *`, `export … from`, `import * as`, `export … default`, `import(`
 * with a literal specifier.
 *
 * @param {string} sourceText
 * @returns {Array<{kind: string, detail: string, index: number}>}
 */
export function findPublicationViolations(sourceText, options = {}) {
  const context = {
    ownerBusiness: options.ownerBusiness ?? null,
    businessOf: options.businessOf ?? null,
    resolveSpecifier: options.resolveSpecifier ?? null,
  };
  const violations = [];
  const withoutComments = sourceText
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1 ");

  const starRe = /export\s*\*\s*from\s*["']([^"']+)["']/gu;
  for (const match of withoutComments.matchAll(starRe)) {
    violations.push({
      kind: "export-star",
      detail: `export * from "${match[1]}" republishes a module's whole surface, including anything added to it later.`,
      index: match.index,
    });
  }

  // `export { x } from "…"` / `export { x as y } from "…"` / `export type {…} from`.
  const reExportRe = /export\s+(?:type\s+)?\{[^}]*\}\s*from\s*["']([^"']+)["']/gu;
  for (const match of withoutComments.matchAll(reExportRe)) {
    violations.push({
      kind: "foreign-re-export",
      detail: `export … from "${match[1]}" makes this business the publisher of another one's symbol.`,
      index: match.index,
    });
  }

  const namespaceRe = /import\s+\*\s+as\s+(\w+)\s+from\s*["']([^"']+)["']/gu;
  for (const match of withoutComments.matchAll(namespaceRe)) {
    if (!isForeignAccess(match[2], context)) continue;
    violations.push({
      kind: "foreign-namespace",
      detail: `import * as ${match[1]} from "${match[2]}" reaches a peer's surface by a name this gate cannot resolve.`,
      index: match.index,
    });
  }

  const defaultRe = /export\s+default\s+/gu;
  for (const match of withoutComments.matchAll(defaultRe)) {
    violations.push({
      kind: "foreign-default",
      detail: "a default export names no symbol, so a consumer cannot be checked against what it received.",
      index: match.index,
    });
  }

  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of withoutComments.matchAll(dynamicRe)) {
    if (!isForeignAccess(match[1], context)) continue;
    violations.push({
      kind: "foreign-dynamic",
      detail: `import("${match[1]}") is resolved at runtime, so the edge it creates is invisible to every other judgement in this gate.`,
      index: match.index,
    });
  }

  return violations;
}

/**
 * Judge every published module in a file list.
 *
 * `readFile` is injected so the caller controls filesystem access and the tests
 * can drive the gate without one.
 *
 * @param {object} options
 * @param {readonly string[]} options.files source paths relative to src
 * @param {(absolutePath: string) => string} options.readFile
 * @param {(relativePath: string) => string} options.absolute
 * @param {(from: string, to: string) => {allowed: boolean, rule?: string, detail?: string}} [options.classifyImport]
 *   decides whether an import *out of* a published module is legal. The gate
 *   passes it the resolved source and target so a published module can be held
 *   to the layer rules as well as the syntactic ones.
 * @returns {{pass: boolean, violations: Array<object>}}
 */
export function publicationRule({ files, readFile, absolute, classifyImport, businessOf, resolveSpecifier }) {
  const violations = [];
  for (const file of files) {
    if (!isPublicModulePath(file)) continue;
    let source;
    try {
      source = readFile(absolute(file));
    } catch {
      // A file the walker listed but the reader could not open is the build's
      // problem, not this gate's; silently skipping keeps one unreadable path
      // from reporting every module as clean or dirty.
      continue;
    }
    // The module's own business, and how to resolve one of its specifiers to a
    // source path. Both come from the caller because the role classifier lives in
    // `webui-dependency-rules.mjs` and this module must not import it back.
    const ownerBusiness = businessOf ? businessOf(file) : null;
    for (const violation of findPublicationViolations(source, {
      ownerBusiness,
      businessOf: businessOf ?? null,
      resolveSpecifier: resolveSpecifier ? (specifier) => resolveSpecifier(file, specifier) : null,
    })) {
      violations.push({
        kind: "role",
        rule: `publication-${violation.kind}`,
        file,
        detail: `${file}: ${violation.detail}`,
      });
    }
    if (!classifyImport) continue;
    for (const specifier of publishedModuleImportSpecifiers(source)) {
      const judgement = classifyImport(file, specifier);
      if (judgement.allowed) continue;
      violations.push({
        kind: "role",
        rule: judgement.rule ?? "publication-illegal-import",
        file,
        to: judgement.to,
        detail:
          judgement.detail ??
          `${file}: a published module imports "${specifier}", which ${judgement.rule ?? "is not reachable from a published surface"}.`,
      });
    }
  }
  return { pass: violations.length === 0, violations };
}

/**
 * The module specifiers a published module imports, in source order.
 *
 * Split out so the caller can resolve them against the same module resolution
 * the edge collector uses, rather than this gate re-implementing resolution.
 *
 * @param {string} sourceText
 * @returns {string[]}
 */
export function publishedModuleImportSpecifiers(sourceText) {
  const withoutComments = sourceText
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1 ");
  const specifiers = [];
  const re = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of withoutComments.matchAll(re)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** Read a published module's source, for callers that hold a repository root. */
export function readPublishedModuleSource(absolutePath) {
  return readFileSync(absolutePath, "utf8");
}
