// Types for `package-exports.mjs`, the single derivation of "package export
// specifier -> source file" for the workspace. The module is plain JavaScript,
// so the entry shape is declared here rather than leaving the `map` callbacks
// and destructuring bindings at the call sites (`packages/webui/vite.config.ts`,
// `scripts/gen-tsconfig-paths.mjs`, `packages/tui/test/unit/tui-image-preview.test.ts`)
// to infer an implicit `any` per binding element.
export interface PackageExportEntry {
  /** Published specifier, for example `@mavis/shared/daily-signin`. */
  readonly specifier: string;
  /** Workspace-relative package directory, for example `packages/shared`. */
  readonly directory: string;
  /** Repository-relative POSIX path to the source entry point. */
  readonly file: string;
}

/**
 * Derives one entry per published `exports` subpath of each package under
 * `packageRoots`, rewriting the published `dist` target to its `src` file.
 */
export function packageExportEntries(
  root: string,
  packageRoots: readonly string[],
): readonly PackageExportEntry[];
