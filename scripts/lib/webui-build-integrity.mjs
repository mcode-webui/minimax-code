import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { rewriteInputs } from "./webui-boundary.mjs";

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const filesUnder = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? filesUnder(file) : [file];
});

export function recordBuildIntegrity(root, metafile) {
  const inputs = rewriteInputs(metafile.inputs, { rootDir: root });
  const files = [...Object.keys(inputs), ...Object.keys(metafile.outputs).map((p) => path.relative(root, path.resolve(root, "packages/webui", p)))];
  if (metafile.artifactRoot) {
    for (const directory of [path.resolve(root, metafile.artifactRoot), path.join(root, "packages/webui/src")]) {
      files.push(...filesUnder(directory).filter((p) => p !== path.resolve(root, metafile.artifactRoot, "metafile.json")).map((p) => path.relative(root, p)));
    }
    files.push("package.json", "release/extraction.json", "release/webui-npm/package.json", "packages/webui/tailwind.config.cjs",
      "scripts/build-webui.mjs", "scripts/build-webui-styles.mjs", "scripts/package-webui-npm.mjs",
      "scripts/lib/workspace-sources-plugin.mjs", "scripts/lib/webui-build-integrity.mjs", "scripts/lib/webui-build-check.mjs");
  }
  const hashes = {};
  for (const file of files) hashes[file.replaceAll("\\", "/")] = digest(path.resolve(root, file));
  return hashes;
}

export function verifyBuildIntegrity(root, metafile) {
  if (!metafile.integrity || !Object.keys(metafile.integrity).length) throw new Error("WebUI build integrity record missing; rebuild the artifact");
  const measured = recordBuildIntegrity(root, metafile);
  for (const [file, hash] of Object.entries(measured)) {
    if (metafile.integrity[file] !== hash) throw new Error(`Stale or modified WebUI build input/output: ${file}; rebuild the artifact`);
  }
  if (Object.keys(measured).length !== Object.keys(metafile.integrity).length) throw new Error("WebUI build integrity file set changed");
}
