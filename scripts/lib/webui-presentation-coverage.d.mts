// Types for `webui-presentation-coverage.mjs`, the presentation-coverage gate
// (ADR 0028).
//
// The module is plain JavaScript, so the shapes it hands to its test
// (`packages/webui/test/gates/webui-presentation-coverage.test.ts`) and to its
// CLI (`scripts/check-webui-presentation.mjs`) are declared here instead of
// arriving at every call site as `any`.

/** Client source directory whose presentation modules the check covers. */
export const CLIENT_SOURCE_DIRECTORY: string;

/** Suffixes that make a presentation module. */
export const MODULE_SUFFIXES: readonly string[];

/** The eight families of ADR 0028. */
export const FAMILIES: readonly string[];

/** The four dispositions an entry may carry. */
export const DISPOSITIONS: readonly string[];

/** What an entry classifies: a rendered surface, or one presentation concern. */
export const KINDS: readonly string[];

/** Current inventory schema version. */
export const INVENTORY_VERSION: number;

/** Repository-relative path of the inventory the gate reads. */
export const INVENTORY_FILE: string;

/** Is this client-relative path a client UI source module? */
export function isPresentationModule(relativePath: string): boolean;

/** Every presentation module under `clientRoot`, as client-relative POSIX paths. */
export function discoverPresentationModules(clientRoot: string): string[];

/**
 * A digest over what a module exports and what it renders — the vocabulary a
 * new surface inside an already classified module would be built from.
 */
export function surfaceSignature(source: string, filename: string): string;

/** One recorded classification. */
export interface PresentationEntry {
  readonly path: string;
  readonly label: string;
  readonly kind: string;
  readonly families: readonly string[];
  readonly disposition: string;
  readonly reason?: string;
}

/** The inventory as the gate reads it. */
export interface PresentationInventory {
  readonly version?: number;
  readonly entries?: readonly PresentationEntry[];
  readonly reviewed?: Readonly<Record<string, string>>;
}

/** A module discovered on disk with its current signature. */
export interface PresentationModule {
  readonly path: string;
  readonly signature: string;
}

/** One condition that makes the classification untrue. */
export interface PresentationFailure {
  readonly kind: string;
  readonly path: string;
  readonly detail: string;
}

/** One module whose rendered vocabulary moved since it was classified. */
export interface PresentationReview {
  readonly path: string;
  readonly recorded: string | null;
  readonly current: string;
  readonly detail: string;
}

/** The counts the gate prints, and the two completion claims it separates. */
export interface PresentationCoverageSummary {
  readonly modules: number;
  readonly entries: number;
  readonly classifiedModules: number;
  readonly dispositions: Record<string, number>;
  readonly families: Record<string, number>;
  readonly unclassified: number;
  readonly pending: number;
  readonly inventoryComplete: boolean;
  readonly unificationComplete: boolean;
  readonly reviewRequired: number;
}

export interface PresentationCoverageResult {
  readonly failures: PresentationFailure[];
  readonly reviews: PresentationReview[];
  readonly summary: PresentationCoverageSummary;
}

export function evaluatePresentationCoverage(options: {
  modules: readonly PresentationModule[];
  inventory: PresentationInventory;
}): PresentationCoverageResult;

/** Serialise the inventory in its reviewed form: one entry per line. */
export function serializeInventory(inventory: PresentationInventory): string;

export function parseInventory(text: string): PresentationInventory;

/** Record current signatures for `paths`; the classification is untouched. */
export function recordReviewedSignatures(
  inventory: PresentationInventory,
  modules: readonly PresentationModule[],
  paths: readonly string[],
): PresentationInventory & { readonly reviewed: Record<string, string> };
