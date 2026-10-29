import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { inventoryPath, readExtraction } from "./lib/release-metadata.mjs";
import { retiredSourceRoots } from "./lib/retired-sources.mjs";
import { readSuites, suiteInventoryViolations } from "./lib/vitest-suites.mjs";
import {
  INTERNAL_HOST_RE,
  CREDENTIAL_RE,
  WEBUI_DIST_DIRECTORY,
  WEBUI_PACKAGE_DIST_DIRECTORY,
} from "./lib/webui-boundary-constants.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const skipped = new Set([
  ".git",
  "node_modules",
  "dist",
  WEBUI_DIST_DIRECTORY,
  WEBUI_PACKAGE_DIST_DIRECTORY,
  ".cache",
  // The development plans are tracked: a ticket has to be readable from a
  // worktree, and a worktree only carries tracked files. Their content is
  // scanned like any other file, so a plan cannot carry a credential or an
  // internal host into the published projection.
  ".pnpm-store",
  ".turbo",
  ".idea",
  ".DS_Store",
  // A machine-local code index, in the same category as `.idea` and `.cache`
  // above: a per-machine database that git ignores and that is not source. It
  // carries its own `.gitignore`, so the directory is invisible to `git status`
  // but not to this scan, and without the entry any developer who happens to have
  // the tool installed fails `check:source` over a file they never wrote.
  ".codegraph",
]);
/**
 * The unpacked store builds, by name.
 *
 * A store build is built into its own directory beside `dist/`, because the
 * packaged build's manifest carries the store's public key and the development
 * build's does not. They are build outputs and they are machine-local, in the
 * same way the archives beside them are.
 */
const STORE_BUILD_DIRECTORIES = new Set(["dist-store-chrome", "dist-store-edge"]);

/**
 * Whether a name is a build output rather than source.
 *
 * The packaged store archives are named after the directory they are built
 * into (`dist-chrome.zip`, `dist-edge.zip`). They are build outputs, not
 * source, and they are machine-local: the archive the store takes is
 * produced by the build, not committed. Leaving them in would make the
 * inventory record a file the export does not carry, and the export gate
 * would fail with a difference that no one can act on.
 */
function isBuildOutput(name) {
  if (STORE_BUILD_DIRECTORIES.has(name)) return true;
  return name.startsWith("dist-") && name.endsWith(".zip");
}

function filesIn(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      skipped.has(entry.name) ||
      entry.name.endsWith(".tsbuildinfo") ||
      isBuildOutput(entry.name)
    )
      return [];
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Source symlink requires explicit review: ${relative}`);
    return entry.isDirectory()
      ? filesIn(path.join(directory, entry.name), relative)
      : [relative];
  });
}
const files = filesIn(root).sort();
const violations = suiteInventoryViolations(files, readSuites(root));
// Standard MIT text with the reviewed first-party attribution.
// Source: https://opensource.org/license/mit
const rootLicenseSha256 =
  "28bb5c2948742f9f8d27ed84882844d09dff07cb5df64f20729875e8582a18ea";
if (
  createHash("sha256")
    .update(readFileSync(path.join(root, "LICENSE")))
    .digest("hex") !== rootLicenseSha256
)
  violations.push(
    "LICENSE: expected MIT text with the reviewed MiniMax Code attribution",
  );
for (const file of files) {
  if (retiredSourceRoots.some((prefix) => file.startsWith(prefix)))
    violations.push(`${file}: retired source`);
  if (/^(?:.*\/)?\.env(?:\.|$)/u.test(file) && !file.endsWith(".env.example"))
    violations.push(`${file}: environment file`);
  if (file === "scripts/source-inventory.mjs") continue;
  let content = readFileSync(path.join(root, file));
  if (file.endsWith(".gz")) content = gunzipSync(content);
  const text = content.toString("utf8");
  if (INTERNAL_HOST_RE.test(text))
    violations.push(`${file}: internal source reference`);
  if (CREDENTIAL_RE.test(text))
    violations.push(`${file}: possible embedded credential`);
}
const { packageRoots } = readExtraction(root);
const packages = packageRoots.map((directory) => ({
  directory,
  manifest: JSON.parse(
    readFileSync(path.join(root, directory, "package.json"), "utf8"),
  ),
}));
const names = new Set(packages.map(({ manifest }) => manifest.name));
for (const { directory, manifest } of packages) {
  if (!manifest.license || manifest.license === "UNLICENSED")
    violations.push(`${directory}: missing open-source license`);
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version.startsWith("workspace:") && !names.has(name))
        violations.push(`${directory}: unknown workspace ${name}`);
    }
  }
  for (const [name, entry] of Object.entries(manifest.exports ?? {})) {
    const target =
      typeof entry === "string"
        ? entry
        : (entry.types ?? entry.import ?? entry.default);
    if (!target) continue;
    const source = target
      .replace(/^\.\/dist\//u, "./src/")
      .replace(/\.d\.ts$/u, ".ts")
      .replace(/\.js$/u, ".ts");
    if (!existsSync(path.resolve(root, directory, source)))
      violations.push(`${directory}: missing export ${name}`);
  }
}
const native = JSON.parse(
  readFileSync(
    path.join(root, "third_party/sandbox-runtime/native-integrity.json"),
    "utf8",
  ),
);
for (const entry of native.files) {
  const bytes = readFileSync(
    path.join(root, "third_party/sandbox-runtime", entry.path),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
    violations.push(`${entry.path}: native helper integrity mismatch`);
}

// The public Plugin contract is validated by the same code path an external
// author runs. Keeping it inside check:source stops the published schemas and
// the public validator from drifting apart.
const { validatePluginContract } = await import(
  new URL("../tools/plugins/validate-plugin.mjs", import.meta.url).href
);
for (const problem of validatePluginContract(root))
  violations.push(`plugin contract: ${problem}`);
if (violations.length)
  throw new Error(`Public source check failed:\n${violations.join("\n")}`);
if (process.argv.includes("--write")) {
  const projected = [...new Set([...files, inventoryPath])].sort();
  writeFileSync(
    path.join(root, inventoryPath),
    JSON.stringify({ schemaVersion: 1, files: projected }, null, 2) + "\n",
  );
  console.log(`Recorded ${projected.length} reviewed source paths.`);
} else {
  const expected = JSON.parse(
    readFileSync(path.join(root, inventoryPath), "utf8"),
  ).files;
  const actualSet = new Set(files),
    expectedSet = new Set(expected);
  const missing = expected.filter((file) => !actualSet.has(file));
  const added = files.filter((file) => !expectedSet.has(file));
  if (missing.length || added.length)
    throw new Error(
      `Source inventory changed; review before updating.\nMissing: ${missing.join(", ")}\nAdded: ${added.join(", ")}`,
    );
  console.log(
    `Public source check passed: ${files.length} files, workspace exports and native helper integrity verified.`,
  );
}
