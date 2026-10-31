import { build } from "esbuild";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyLocalRuntimeAssets } from "./lib/local-runtime-assets.mjs";
import { copyMcodeToolsArtifact } from "./lib/mcode-tools-artifact.mjs";
import { readExtraction } from "./lib/release-metadata.mjs";
import { createWorkspaceSourcesPlugin } from "./lib/workspace-sources-plugin.mjs";
import { recordBuildIntegrity } from "./lib/webui-build-integrity.mjs";
import { checkWebuiBuild } from "./lib/webui-build-check.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const versionIndex = args.indexOf("--version");
const outputIndex = args.indexOf("--outdir");
if (outputIndex !== -1 && !args[outputIndex + 1]) {
  throw new Error("--outdir requires a directory path");
}
const version = versionIndex === -1
  ? JSON.parse(readFileSync(path.join(root, "release/webui-npm/package.json"), "utf8")).version
  : args[versionIndex + 1];
const outdir = path.resolve(outputIndex === -1 ? path.join(root, "dist-webui-npm") : args[outputIndex + 1]);

if (!version || !/^\d+\.\d+\.\d+-preview\.\d+$/.test(version)) {
  throw new Error(`Expected a preview semver version, got: ${version ?? "<missing>"}`);
}
const webuiDir = path.join(root, "packages/webui");
const packages = new Map(
  readExtraction(root).packageRoots.map((directory) => {
    const manifest = JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8"));
    return [manifest.name, { directory, manifest }];
  }),
);
const workspacePlugin = createWorkspaceSourcesPlugin(packages, root);

rmSync(outdir, { recursive: true, force: true });
mkdirSync(path.join(outdir, "client"), { recursive: true });
mkdirSync(path.join(outdir, "server"), { recursive: true });

const styles = await import("node:child_process").then(({ spawnSync }) =>
  spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/build-webui-styles.mjs"),
      "--outdir", path.join(outdir, "client"),
    ],
    { stdio: "inherit", cwd: webuiDir },
  ),
);
if (styles.status !== 0) throw new Error(`WebUI stylesheet build failed (exit ${styles.status})`);

const server = await build({
  absWorkingDir: webuiDir,
  entryPoints: {
    server: "src/server/index.ts",
    runtime: "src/runtime/index.ts",
    "mcode-tools": "src/runtime/mcode-tools-entry.ts",
    // The Mini App runner starts as its own child process, and the bundled server
    // resolves it beside itself. Without this entry the packaged artifact carries
    // no runner, so every Mini App launch fails with RUNNER_EXITED.
    "host-runner": path.join(
      root,
      "packages/local-runtime-v2/src/service/miniapp/process/node-runtime/host-runner.ts",
    ),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outdir: path.join(outdir, "server"),
  metafile: true,
  external: ["better-sqlite3", "node-pty"],
  // CommonJS dependencies bundled into ESM output (for example ws) call
  // require() at runtime, which esbuild's ESM shim cannot satisfy. Provide a
  // real require so those calls resolve instead of throwing
  // "Dynamic require of X is not supported".
  banner: {
    js: 'import { createRequire as __webuiCreateRequire } from "node:module";\nconst require = __webuiCreateRequire(import.meta.url);',
  },
  plugins: [workspacePlugin],
  logLevel: "info",
});

const client = await build({
  absWorkingDir: webuiDir,
  entryPoints: { client: "src/client/main.tsx" },
  bundle: true,
  format: "esm",
  platform: "browser",
  // Code splitting is load-bearing, not an optimisation: without it esbuild
  // inlines every dynamically imported module into `client.js`. The
  // transcript lazily loads the diagram library (`webui-mermaid.tsx`'s
  // `import("mermaid")`), and the composer's slash palette is already a
  // dynamic import — inlining either would put the whole library in the
  // entry. Chunks land under `assets/`, the prefix the loopback service's
  // static resolver already serves alongside the entry (see
  // `resolveClientAsset` in `packages/webui/src/server/http/client-assets.ts`).
  splitting: true,
  chunkNames: "assets/[name]-[hash]",

  target: "es2022",
  outdir: path.join(outdir, "client"),
  metafile: true,
  jsx: "automatic",
  loader: { ".html": "text" },
  plugins: [workspacePlugin],
  logLevel: "info",
});

cpSync(path.join(webuiDir, "src/client/index.html"), path.join(outdir, "client/index.html"));
cpSync(path.join(webuiDir, "src/client/assets/img"), path.join(outdir, "client/assets/img"), { recursive: true });
cpSync(path.join(webuiDir, "src/client/assets/fonts/katex"), path.join(outdir, "client/fonts"), { recursive: true });
copyLocalRuntimeAssets({ repositoryRoot: root, outputDir: outdir, filter: () => true });
// The bundled server resolves its agent and skill assets relative to its own
// directory (import.meta.url), so it looks for <outdir>/server/assets. Mirror
// the asset tree there as well; without it the packaged CLI cannot find
// assets/agents and aborts at startup.
cpSync(path.join(outdir, "assets"), path.join(outdir, "server/assets"), { recursive: true });
await copyMcodeToolsArtifact(root, path.join(outdir, "server"));
cpSync(path.join(root, "packages/tui/src/cli/mcode-tools-launchers"), path.join(outdir, "server/internal-bin"), { recursive: true });
cpSync(path.join(root, "LICENSE"), path.join(outdir, "LICENSE"));
cpSync(path.join(root, "NOTICE"), path.join(outdir, "NOTICE"));
cpSync(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(outdir, "THIRD_PARTY_NOTICES.md"));
cpSync(path.join(root, "release/webui-npm/README.md"), path.join(outdir, "README.md"));
cpSync(path.join(root, "release/webui-npm/bin"), path.join(outdir, "bin"), { recursive: true });
cpSync(path.join(root, "release/webui-npm/package.json"), path.join(outdir, "package.json"));
const packageJsonPath = path.join(outdir, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
packageJson.version = version;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

writeFileSync(path.join(outdir, "server/package-info.json"), `${JSON.stringify({ version }, null, 2)}\n`);
const metafile = { inputs: { ...server.metafile.inputs, ...client.metafile.inputs }, outputs: { ...server.metafile.outputs, ...client.metafile.outputs } };
metafile.artifactRoot = path.relative(root, outdir);
metafile.integrity = recordBuildIntegrity(root, metafile);
checkWebuiBuild(root, metafile, { packaged: true });
console.log(`Packed ${packageJson.name}@${version} at ${outdir}`);
