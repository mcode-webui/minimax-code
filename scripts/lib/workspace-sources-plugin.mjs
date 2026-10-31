// Workspace source resolver plugin shared by `scripts/build.mjs` and
// `scripts/build-webui.mjs`.
//
// Every workspace package in this repository ships its `exports` field pointing
// at a TypeScript source file. The fields intentionally map `dist` to `src`
// (`scripts/lib/package-exports.mjs` derives the same map), so a bundler
// resolving `@mavis/...` against the in-tree source instead of an unbuilt
// `dist/` directory only has to read each package's `package.json` and follow
// the export. Without this plugin neither the CLI build nor the WebUI build
// can resolve a workspace import, because no package in this repository is
// actually built to `dist/` for the source checkout.
//
// Each consumer constructs its own packages map from
// `release/extraction.json`, then passes the resulting plugin into esbuild.

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Build an esbuild plugin that resolves `@mavis/...` (and any future
 * workspace scope) specifiers against the package's TypeScript sources,
 * rewriting `./dist/...` to `./src/...` and `.js` / `.d.ts` to `.ts`.
 *
 * @param {Map<string, { directory: string, manifest: { name: string, exports?: Record<string, unknown>, types?: string } }>} packages
 *   Map keyed by package name (including the scope, e.g. `@mavis/shared`).
 *   `directory` is repository-relative (e.g. `packages/webui`); the plugin
 *   resolves it against `repositoryRoot` so callers do not need to know the
 *   absolute path.
 * @param {string} repositoryRoot
 *   Absolute path to the repository root containing the workspace packages.
 * @param {string[]} [skip]
 *   Specifiers this plugin leaves alone so the bundler resolves them
 *   through its normal mechanism (typically because the caller marked
 *   them `external`). Empty by default.
 */
export function createWorkspaceSourcesPlugin(packages, repositoryRoot, skip = []) {
  const skipSet = new Set(skip);
  return {
    name: "standalone-workspace-sources",
    setup(bundler) {
      bundler.onResolve({ filter: /^[^./]/ }, ({ path: specifier }) => {
        if (skipSet.has(specifier)) return undefined;
        const parts = specifier.split("/");
        const name = specifier.startsWith("@")
          ? parts.slice(0, 2).join("/")
          : parts[0];
        const pkg = packages.get(name);
        if (!pkg) return undefined;
        const subpath =
          specifier === name ? "." : `.${specifier.slice(name.length)}`;
        const exports = pkg.manifest.exports;
        const exported =
          exports?.[subpath] ?? (subpath === "." ? exports : undefined);
        const target =
          (typeof exported === "string"
            ? exported
            : (exported?.types ?? exported?.import ?? exported?.default)) ??
          (subpath === "." ? pkg.manifest.types : undefined);
        if (typeof target !== "string" || !target.startsWith("./"))
          throw new Error(`Unmapped workspace export: ${specifier}`);
        const source = target
          .replace(/^\.\/dist\//, "./src/")
          .replace(/\.d\.ts$/, ".ts")
          .replace(/\.js$/, ".ts");
        const directory = path.join(repositoryRoot, pkg.directory);
        const resolved = path.resolve(directory, source);
        if (
          path.relative(directory, resolved).startsWith("..") ||
          !existsSync(resolved)
        )
          throw new Error(`Missing workspace source: ${specifier}`);
        return { path: resolved };
      });
    },
  };
}