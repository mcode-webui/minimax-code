// Types for `webui-boundary.mjs`, the pure WebUI build-boundary rules.
// The module is plain JavaScript, so its rule shapes live here instead of
// being inherited as `any` at every TypeScript call site — the boundary test
// (`packages/webui/test/unit/webui-boundary-check.test.ts`) drives all six
// rules through this declaration, and `scripts/check-webui-boundary.mjs` runs
// the same `rules` array against the built metafile.
//
// Every rule is pure with respect to the graph: they read the *keys* of the
// metafile `inputs` map, and only `forbiddenInternalReferences` reads anything
// else (the text of each named file, off disk). The per-input value is
// therefore declared structurally rather than modelled field-for-field, so a
// fixture built from just the `bytesInOutput` the rules never look at is still
// a legitimate input.

/** One `imports` entry of an esbuild metafile input. */
export interface MetafileImport {
  readonly path: string;
  readonly kind: string;
  readonly external?: boolean;
}

/**
 * The value side of one metafile `inputs` entry. Optional throughout: the
 * boundary rules never read a field, and the metafile emitter omits
 * `imports` for leaf inputs.
 */
export interface MetafileInput {
  readonly bytesInOutput?: number;
  readonly imports?: readonly MetafileImport[];
}

/**
 * An esbuild metafile `inputs` map keyed by build input path. Keys arrive in
 * the forms `rewriteInputs` normalises, so callers hand over the raw map.
 */
export type MetafileInputMap = Record<string, MetafileInput>;

/** The outcome of a single boundary rule. */
export interface BoundaryResult {
  readonly pass: boolean;
  readonly violations: readonly string[];
}

/** Reader options shared by the rules that touch the filesystem. */
export interface BoundaryRuleOptions {
  /** Repository root the normalised keys are relative to. */
  readonly rootDir?: string;
}

/**
 * Element type of {@link rules}. Both callers — the CLI and the test — invoke
 * every rule uniformly as `rule(inputs, packageExports)`, so the second
 * argument is deliberately untyped here: `onlyAllowedPublicEntries` reads the
 * allowlist out of it, `forbiddenInternalReferences` reads `rootDir` off the
 * same slot, and the remaining rules ignore it.
 */
export interface BoundaryRule {
  (inputs: MetafileInputMap, argument?: unknown): BoundaryResult;
}

/** Matches any input that resolved into the terminal renderer. */
export const TERMINAL_RENDERER_RE: RegExp;

/**
 * Normalises raw metafile input keys (pnpm-symlink form, `../` escapes and
 * in-repository absolute paths) to the repository-relative form the rules
 * match on.
 *
 * The return type is a generic passthrough so the caller's own key set
 * survives the rewrite: a widened `MetafileInputMap` return would erase the
 * literal keys that callers read back with `Object.keys`.
 */
export function rewriteInputs<T extends MetafileInputMap>(
  rawInputs: T,
  options?: BoundaryRuleOptions,
): T;

export function serverAndClientEntriesPresent(
  inputs: MetafileInputMap,
): BoundaryResult;

export function retiredSourcesAbsent(inputs: MetafileInputMap): BoundaryResult;

export function terminalRendererAbsent(inputs: MetafileInputMap): BoundaryResult;

export function forbiddenInternalReferences(
  inputs: MetafileInputMap,
  options?: BoundaryRuleOptions,
): BoundaryResult;

export function noServerCallIntoCli(inputs: MetafileInputMap): BoundaryResult;

export function onlyAllowedPublicEntries(
  inputs: MetafileInputMap,
  packageExports?: ReadonlySet<string>,
): BoundaryResult;

/** All six rules, in the order the CLI applies them. */
export const rules: readonly BoundaryRule[];

/** Reader options the CLI entry point passes through unchanged. */
export const defaultOptions: Readonly<{ rootDir: string }>;
