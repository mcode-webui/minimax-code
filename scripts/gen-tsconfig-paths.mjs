import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExtraction, extractionPath } from "./lib/release-metadata.mjs";
import { packageExportEntries } from "./lib/package-exports.mjs";

// The type-check path map is derived from the package scope in
// `release/extraction.json` plus each package's own `exports`, so adding a package
// or an export subpath never requires hand-editing 100+ path entries. Run with
// `--write` after changing package scope or exports; the default check mode fails
// when the committed map has drifted.
//
// Every consumer inside the repository has to resolve workspace packages to their
// TypeScript source, because a source checkout never builds the `dist/` that the
// published `exports` point at. The esbuild build, the dev server and Vitest get
// that mapping from `package-exports.mjs` via the Vite alias in
// `packages/webui/vite.config.ts`; TypeScript needs the same map in `paths`, and
// `extends` does not merge it, so each configuration that type-checks workspace
// source owns a copy. Deriving every copy here is what keeps the type-check map
// and the runtime resolver from disagreeing about the same package.
const root = fileURLToPath(new URL("../", import.meta.url));
const { packageRoots } = readExtraction(root);

// `packages/webui` deliberately keeps its own TypeScript configuration instead of
// extending the standalone one (ADR 0005: the standalone config type-checks the
// CLI entry points, so "the paths were regenerated" is not "the WebUI
// type-checks"). Its `baseUrl` is therefore the repository root as well, which is
// what lets both copies reuse one entry table verbatim.
const targets = [
  { configPath: "tsconfig.standalone.json", baseUrl: "." },
  {
    configPath: "packages/webui/tsconfig.paths.json",
    baseUrl: "../..",
    template: { extends: "../../tsconfig.node.json" },
  },
];

const paths = {};
for (const { specifier, file } of packageExportEntries(root, packageRoots)) {
  if (paths[specifier])
    throw new Error(
      `Duplicate export specifier ${specifier} in ${paths[specifier][0]} and ./${file}`,
    );
  paths[specifier] = [`./${file}`];
}
const expected = Object.fromEntries(
  Object.keys(paths)
    .sort()
    .map((specifier) => [specifier, paths[specifier]]),
);

const serialize = (value) => JSON.stringify(value, null, 2) + "\n";
const write = process.argv.includes("--write");
const drifted = [];

for (const { configPath, baseUrl, template } of targets) {
  const absolute = path.join(root, configPath);
  const config = existsSync(absolute)
    ? JSON.parse(readFileSync(absolute, "utf8"))
    : { ...template };

  if (write) {
    config.compilerOptions = { ...config.compilerOptions, baseUrl, paths: expected };
    writeFileSync(absolute, serialize(config));
    console.log(
      `Recorded ${Object.keys(expected).length} package paths in ${configPath}.`,
    );
    continue;
  }

  const actual = config.compilerOptions?.paths ?? {};
  if (config.compilerOptions?.baseUrl !== baseUrl)
    drifted.push(
      `${configPath}: baseUrl is ${config.compilerOptions?.baseUrl ?? "unset"}, expected ${baseUrl}`,
    );
  const stale = [
    ...Object.keys(expected)
      .filter((key) => serialize(actual[key]) !== serialize(expected[key]))
      .map(
        (key) =>
          `${key}: expected ${expected[key][0]}, found ${actual[key]?.[0] ?? "nothing"}`,
      ),
    ...Object.keys(actual)
      .filter((key) => !(key in expected))
      .map((key) => `${key}: not declared by any package in ${extractionPath}`),
  ];
  for (const entry of stale) drifted.push(`${configPath} ${entry}`);

  if (!drifted.some((entry) => entry.startsWith(configPath)))
    console.log(
      `${configPath} paths match ${Object.keys(expected).length} package exports.`,
    );
}

if (drifted.length)
  throw new Error(
    `Type-check path maps are stale; run \`pnpm gen:tsconfig\`:\n${drifted.join("\n")}`,
  );
