// Types for `release-metadata.mjs`, the reader for the machine-read release
// contracts. The module is plain JavaScript and `JSON.parse`s the files at
// runtime, which is why these shapes live here instead of being inherited as
// `any` at every TypeScript call site. Each interface mirrors the named JSON
// file field for field, and they are declared read-only because every consumer
// treats them as build input rather than as an object to mutate.
export interface ExtractionMetadata {
  readonly schemaVersion: number;
  /** Commit the published source is extracted from. */
  readonly sourceRevision: string;
  /** Workspace directories that make up the release package scope. */
  readonly packageRoots: readonly string[];
  readonly productBaseline: string;
  readonly distribution: string;
}

/** `release/public-source.json`: the reviewed list of published source files. */
export interface SourceInventory {
  readonly schemaVersion: number;
  readonly files: readonly string[];
}

export const extractionPath: string;
export const inventoryPath: string;
export const dependencyLicensesPath: string;

/** Parses `extractionPath` under `root`. */
export function readExtraction(root: string): ExtractionMetadata;

/** Parses `inventoryPath` under `root`. */
export function readInventory(root: string): SourceInventory;
