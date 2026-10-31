import { readFileSync } from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { packageExportEntries } from "./package-exports.mjs";
import { readExtraction } from "./release-metadata.mjs";
import { rewriteInputs, rules, onlyAllowedPublicEntries } from "./webui-boundary.mjs";
import { verifyBuildIntegrity } from "./webui-build-integrity.mjs";

export function checkWebuiBuild(root, metafile, { packaged = false } = {}) {
  verifyBuildIntegrity(root, metafile);
  const { packageRoots } = readExtraction(root);
  const exports = packageExportEntries(root, packageRoots);
  const entries = new Set(exports.map((e) => e.file));
  const specifiers = new Set(exports.map((e) => e.specifier));
  const inputs = rewriteInputs(metafile.inputs, { rootDir: root });
  const failures = [];
  for (const rule of rules.slice(0, -1)) failures.push(...rule(inputs, { rootDir: root }).violations);
  if (!inputs["packages/webui/src/runtime/index.ts"]) failures.push("WebUI runtime entry missing");
  // 公开入口只约束跨包的第一跳；合法入口内部的传递实现仍属于该包。
  const allowed = new Set([...entries, ...packageRoots.map((p) => `${p}/`)]);
  failures.push(...onlyAllowedPublicEntries(inputs, allowed).violations);
  for (const [from, value] of Object.entries(inputs)) {
    if (!from.startsWith("packages/webui/")) continue;
    for (const reference of value.imports ?? []) {
      if (reference.external) {
        if (reference.path.startsWith("@mavis/") && (!specifiers.has(reference.path) || packaged)) failures.push(`${from}: invalid external workspace import ${reference.path}`);
        continue;
      }
      const target = Object.keys(rewriteInputs({ [reference.path]: {} }, { rootDir: root }))[0];
      if (target.startsWith("packages/webui/")) continue;
      if (packageRoots.some((p) => target.startsWith(`${p}/`)) && !entries.has(target)) failures.push(`${from}: imports private workspace implementation ${target}`);
    }
  }
  if (packaged) {
    const manifest = JSON.parse(readFileSync(path.join(root, "release/webui-npm/package.json"), "utf8"));
    const externals = new Set([...builtinModules.flatMap((p) => [p, `node:${p}`]), ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
    for (const output of Object.values(metafile.outputs)) for (const reference of output.imports ?? []) {
      if (reference.external && !externals.has(reference.path)) failures.push(`Undeclared packaged external import ${reference.path}`);
    }
  }
  if (failures.length) throw new Error(`WebUI build boundary failed:\n${failures.join("\n")}`);
  return Object.keys(inputs).length;
}
