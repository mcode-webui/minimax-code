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

/** Target roles (plan §5.1/§5.3): the ownership-bearing dimension. */
export const ROLES: readonly string[];

/** Which home a path sits in, so a rule can be scoped to the migrated part. */
export const HOMES: readonly string[];

export interface RoleClassification {
  readonly role: string;
  readonly business: string | null;
  readonly home: string;
}

/**
 * Maps a source path to the role it owns, the business that owns it and the home
 * it sits in. Both the current technical homes and the target business-first
 * homes are recognised.
 */
export function classifyRole(relative: string): RoleClassification;

/** True when a path is presentation (a feature's `ui/`, generic `ui/`, shell). */
export function isPresentationRole(relative: string): boolean;

export function validateExceptionLedger(entries: unknown, required: readonly string[]): void;

/** One role-rule finding. `rule` names which role judgement produced it. */
export interface RoleViolation {
  readonly kind: "role";
  readonly rule: "duplicate-owner" | "role-import" | "private-peer-import";
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly line?: number;
  readonly detail: string;
}

/**
 * The role rules: duplicate live owners, role-forbidden imports and unapproved
 * cross-business imports. `approved` defaults to the reviewed list on disk and
 * exists so fixtures can drive the rule with their own approvals.
 */
export function roleRule(
  graph: DependencyGraph,
): { readonly pass: boolean; readonly violations: readonly RoleViolation[] };

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

/**
 * A call whose callee is a property access, element access or identifier,
 * anchored by the span of the call expression.
 *
 * Both offsets are needed: a capability call whose result is chained
 * (`port.m().then(cb)`) and the call nested inside it share a start offset, so
 * a start-only anchor made the resolving pass judge only the outer chain and
 * leave the capability call unjudged.
 */
export interface CollectedCallCandidate {
  readonly line: number;
  readonly position: number;
  readonly end: number;
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
export function sourceFingerprint(fileName: string, sourceText: string): string;

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
  readonly expression?: string;
  readonly sourceFingerprint?: string;
}

export interface GraphHostImport {
  readonly from: string;
  readonly specifier: string;
  readonly line: number;
  readonly kind: string;
  /** Present when the specifier resolved outside the package (a package entry). */
  readonly target?: string;
  readonly workspacePath?: string;
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
  readonly expression?: string;
  readonly sourceFingerprint?: string;
  readonly file?: string;
  readonly line?: number;
  readonly global?: string;
  readonly specifier?: string;
  /** `Interface.method` for a forbidden capability call (`forbidden-call`). */
  readonly target?: string;
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
  readonly roleViolations: readonly RoleViolation[];
  /** What a `.public` module may contain: no export-star, no foreign
   *  re-export, no foreign namespace, default or dynamic access. Empty when the
   *  caller supplied no `sourceRoot`, because a gate with nothing to read
   *  reports nothing rather than guessing a path. */
  readonly publicationViolations: readonly RoleViolation[];
  readonly sharedNodeBuiltins: readonly NodeBuiltinViolation[];
  readonly unresolved: readonly GraphViolation[];
  readonly nonLiteralDynamic: readonly GraphViolation[];
  readonly cycles: readonly GraphViolation[];
}

export function evaluateGraph(
  graph: DependencyGraph,
  options?: {
    /** Where the package's sources live, so the publication gate can read them. */
    readonly sourceRoot?: string;
  },
): GraphEvaluation;

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

/**
 * The three members the collector reads. Deliberately narrower than
 * {@link DirectionViolation}, which satisfies it structurally: the judgement
 * only needs the endpoints and the category, so a caller that has no more than
 * those can still ask for one.
 */
export interface ProvisionalJudgementSource {
  readonly from: string;
  readonly to: string;
  readonly category: string;
}

/**
 * One measured violation whose judgement rests on a provisional layer, i.e. a
 * file listed in `KNOWN_AMBIGUOUS_FILES`. Reported, never enforced.
 */
export interface ProvisionalJudgement {
  readonly from: string;
  readonly to: string;
  readonly category: string;
  readonly ambiguous: readonly string[];
}

export function collectProvisionalJudgements(
  violations: readonly ProvisionalJudgementSource[],
  ambiguousFiles?: readonly string[],
): ProvisionalJudgement[];

/**
 * The feature roles that carry a business owner. The role matrix uses this set
 * to tell "no business here" from "two homes for the same business"; roles
 * outside it (shell, ui, conversation, platform, …) are ownerless by design.
 */
export const BUSINESS_BEARING_ROLES: ReadonlySet<string>;
