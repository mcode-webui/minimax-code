// Types for `webui-dependency-rules.mjs`, the pure WebUI internal
// dependency-direction rules. The module is plain JavaScript, so its shapes
// live here instead of being inherited as `any` at every call site: the
// dependency test drives the rules and the graph builder through this
// declaration, and `scripts/check-webui-dependency.mjs` reads the same exports.
//
// Every export below is side-effect-free to import; the functions that touch
// the filesystem do so only when called.

import type * as TypeScript from "typescript";

export const WEBUI_SOURCE_DIRECTORY: string;
export const SOURCE_SUFFIXES: readonly string[];
export const LAYERS: readonly string[];

/** Allowed forward edges, keyed by source layer. */
export const ALLOWED_EDGES: Readonly<Record<string, readonly string[]>>;

/** Files plan §7.5 marks as mixing responsibilities (provisional layer). */
export const KNOWN_AMBIGUOUS_FILES: readonly string[];

export interface CategoryDefinition {
  readonly stage: number;
  readonly description: string;
}

export const CATEGORIES: Readonly<Record<string, CategoryDefinition>>;

/** Maps a source path (relative to `packages/webui/src`) to target layers. */
export function classifyLayers(relative: string): string[];

/** Normalises an absolute path to the src-relative POSIX form, or `null`. */
export function normaliseSourcePath(
  repositoryRoot: string,
  absolutePath: string,
): string | null;

/** True when some (from, to) target-layer pair is permitted. */
export function isAllowedEdge(
  fromLayers: readonly string[],
  toLayers: readonly string[],
): boolean;

export function touchesAmbiguousFile(from: string, to: string): boolean;

export function categoriseViolation(
  from: string,
  to: string,
  fromLayers: readonly string[],
  toLayers: readonly string[],
): string;

export interface ModuleReference {
  readonly specifier: string;
  readonly line: number;
  readonly kind: string;
}

/**
 * A text-anchored ambient-browser occurrence. The `position` is the character
 * offset the ambient/local judgement resolves against the TypeScript program; it
 * is carried out of the collector rather than recomputed.
 *
 * `access` says how the pass must resolve it: `"base"` is a base object read as
 * a value (`window`, `self`, `globalThis`, `document`, `localStorage`,
 * `sessionStorage`), resolved through the identifier's own symbol; `"member"` is
 * a restricted member *named* rather than read (`window.localStorage`,
 * `window["localStorage"]`, `const { localStorage } = window`), whose own
 * identifier is a property name or a local binding and is therefore resolved
 * through the object it is read off.
 */
export interface CollectedBrowserGlobalCandidate {
  readonly name: string;
  readonly line: number;
  readonly position: number;
  readonly access: "base" | "member";
}

/** A call whose callee is a property access, anchored by its start offset. */
export interface CollectedCallCandidate {
  readonly line: number;
  readonly position: number;
}

/**
 * What {@link collectModuleReferences} returns. The two candidate lists are the
 * raw material for the later program pass, not verdicts: `browserGlobalCandidates`
 * still contains local parameters with a matching name, and `callCandidates`
 * contains every property-access call. The ambient-vs-local and
 * writer-vs-action decisions are made against the TypeScript checker in
 * `resolveAmbientFacts`.
 */
export interface CollectedReferences {
  readonly references: readonly ModuleReference[];
  readonly nonLiteralDynamic: readonly { readonly line: number }[];
  readonly browserGlobalCandidates: readonly CollectedBrowserGlobalCandidate[];
  readonly callCandidates: readonly CollectedCallCandidate[];
}

export function collectModuleReferences(
  fileName: string,
  sourceText: string,
): CollectedReferences;

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly kind: string;
  readonly specifier: string;
}

export interface GraphUnresolved {
  readonly file: string;
  readonly specifier: string;
  readonly line: number;
  readonly kind: string;
}

export interface GraphNonLiteral {
  readonly file: string;
  readonly line: number;
}

export interface GraphHostImport {
  readonly from: string;
  readonly specifier: string;
  readonly line: number;
  readonly kind: string;
  /** Present when the specifier resolved outside the package (a package entry). */
  readonly target?: string;
}

export interface GraphBrowserGlobalUse {
  readonly file: string;
  readonly name: string;
  readonly line: number;
}

/**
 * A property-access call whose receiver's declared type came from the
 * TypeScript checker. `receiver` is the declared interface name and
 * `methodSource` the file the method was declared in, so a stale rename or an
 * accidentally shared interface surfaces instead of silently matching.
 */
export interface GraphCallSite {
  readonly file: string;
  readonly line: number;
  readonly method: string;
  readonly receiver: string;
  readonly methodSource: string;
  readonly declaringInterface: string;
}

export interface DependencyGraph {
  readonly sourceDirectory: string;
  readonly files: readonly string[];
  readonly references: readonly GraphEdge[];
  readonly edges: readonly GraphEdge[];
  readonly unresolved: readonly GraphUnresolved[];
  readonly nonLiteralDynamic: readonly GraphNonLiteral[];
  readonly hostImports: readonly GraphHostImport[];
  readonly browserGlobalUses: readonly GraphBrowserGlobalUse[];
  readonly callSites: readonly GraphCallSite[];
}

/** Browser-only host modules (React/ReactDOM) that only bindings/root may import. */
export const BROWSER_ONLY_MODULES_RE: RegExp;

export interface BuildGraphOptions {
  readonly repositoryRoot: string;
  readonly compilerOptions?: TypeScript.CompilerOptions;
  readonly compilerOptionsFor?: (
    relativePath: string,
  ) => TypeScript.CompilerOptions;
  readonly sourceDirectory?: string;
  readonly files?: readonly string[];
}

export function buildDependencyGraph(
  options: BuildGraphOptions,
): DependencyGraph;

export interface DirectionViolation {
  readonly kind: "direction";
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly referenceKind: string;
  readonly layerFrom: readonly string[];
  readonly layerTo: readonly string[];
  readonly rule: string;
  readonly category: string;
  readonly detail: string;
}

export interface GraphViolation {
  readonly kind: string;
  readonly file?: string;
  readonly line?: number;
  readonly global?: string;
  readonly specifier?: string;
  readonly cycle?: readonly string[];
  readonly canonical?: string;
  readonly detail: string;
}

/**
 * A Node-builtin violation. `forbiddenNodeBuiltinRule` always reports the file
 * it was found in and the specifier that named the builtin, so the two fields
 * are required here rather than inherited as optional.
 */
export interface NodeBuiltinViolation extends GraphViolation {
  readonly file: string;
  readonly specifier: string;
}

export interface RuleResult {
  readonly pass: boolean;
  readonly violations: readonly unknown[];
}

/**
 * Element type of {@link rules}. Each rule is invoked uniformly as
 * `rule(graph)`; the concrete violation shapes differ by rule.
 */
export interface DependencyRule {
  (graph: DependencyGraph): {
    readonly pass: boolean;
    readonly violations: readonly unknown[];
  };
}

export const rules: readonly DependencyRule[];

export interface GraphEvaluation {
  readonly pass: boolean;
  readonly violations: readonly unknown[];
  readonly direction: readonly DirectionViolation[];
  readonly browserOnly: readonly GraphViolation[];
  readonly browserGlobals: readonly GraphViolation[];
  readonly nodeBuiltins: readonly NodeBuiltinViolation[];
  readonly forbiddenCalls: readonly GraphViolation[];
  readonly sharedNodeBuiltins: readonly NodeBuiltinViolation[];
  readonly unresolved: readonly GraphViolation[];
  readonly nonLiteralDynamic: readonly GraphViolation[];
  readonly cycles: readonly GraphViolation[];
}

export function evaluateGraph(graph: DependencyGraph): GraphEvaluation;

export function detectCycles(edges: readonly GraphEdge[]): string[][];

export function canonicalCycle(cycle: readonly string[]): string;

export function pairKey(from: string, to: string): string;

export interface BaselineEntry {
  readonly from: string;
  readonly to: string;
  readonly layerFrom: string;
  readonly layerTo: string;
  readonly rule: string;
  readonly category: string;
  readonly stage: number;
  readonly reason: string;
  /**
   * How many reference occurrences the pair had, set by {@link toBaselineShape}
   * when it collapses measured violations to one entry per pair. Optional
   * because the repository's frozen baseline entries do not carry it: they were
   * authored as the comparison input, which never reads this field.
   */
  readonly occurrences?: number;
}

export interface BaselineComparison {
  readonly newViolations: readonly DirectionViolation[];
  readonly staleEntries: readonly BaselineEntry[];
}

export function compareBaseline(
  violations: readonly DirectionViolation[],
  entries: readonly BaselineEntry[],
): BaselineComparison;

export function toBaselineShape(
  violations: readonly DirectionViolation[],
): BaselineEntry[];
