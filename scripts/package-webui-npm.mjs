import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromPublicKey, readStoreExtensionIds } from "./lib/extension-identity.mjs";
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

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Expected a semver version, got: ${version ?? "<missing>"}`);
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
  // The browser bundle ships the PRODUCTION React build. esbuild leaves
  // `process.env.NODE_ENV` at "development" unless the bundle is minified,
  // and React's development build carries validation the production build
  // does not (jsxDEV, the prop/ARIA/key checks). On a streamed reply those
  // checks are about a quarter of the render cost, because every wire frame
  // is its own render.
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".html": "text" },
  plugins: [workspacePlugin],
  logLevel: "info",
});

cpSync(path.join(webuiDir, "src/client/index.html"), path.join(outdir, "client/index.html"));
cpSync(path.join(webuiDir, "src/client/assets/img"), path.join(outdir, "client/assets/img"), { recursive: true });
cpSync(path.join(webuiDir, "src/client/assets/fonts/katex"), path.join(outdir, "client/fonts"), { recursive: true });
// The wordmark's own font travels with the client: it is the one face that
// has to look the same on every machine, so it cannot be left to the host.
cpSync(path.join(webuiDir, "src/client/assets/fonts/brand"), path.join(outdir, "client/assets/fonts/brand"), { recursive: true });
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

// The extension the WebUI hands out from its own download button.
//
// This package is distributed self-hosted: nobody installs the extension from a
// store, the person downloads it from Settings and loads it unpacked. Two
// consequences follow, and both are this script's job.
//
// The build has to travel with the package. A packaged host has no sources to
// build from, so a package that ships only the server answers the download
// route with 404 and the button in Settings does nothing.
//
// The identity has to be decided here. An extension's id is derived from the
// public key its build carries in `manifest.key`, so a build that carries one
// gets the same id on every machine no matter which directory it is loaded
// from — which is what makes `bin/store-extension-ids.json` able to name it
// without a store and without an operator's configuration.
//
// The build runs here rather than being copied from a working tree: the archive
// a person downloads is then the one this package was made from, and a stale
// `dist/` cannot be shipped by accident.
const extensionSourceDir = path.join(root, "packages/browser-extension");
const extensionBuild = spawnSync(
  process.execPath,
  [path.join(extensionSourceDir, "scripts/build.mjs")],
  { cwd: extensionSourceDir, stdio: "inherit" },
);
if (extensionBuild.status !== 0) {
  throw new Error(`browser extension build failed (exit ${extensionBuild.status ?? "signal"})`);
}
cpSync(path.join(extensionSourceDir, "dist"), path.join(outdir, "extension"), { recursive: true });

// The identities this package admits, with nothing configured.
//
// The extension it ships carries a public key in its manifest, so the id that
// build will have in the person's browser is a build-time constant: it is
// derived here by the same function the host uses to read the same key. A store
// key in the environment is still read, for the case where a package is built
// against a store build instead; the shipped extension wins where the two
// disagree, because it is the extension this package actually hands out.
//
// A package with no identity at all admits nobody, so that is said out loud
// rather than left to be discovered by a refused connection.
const shippedExtensionIds = readShippedExtensionIds(path.join(outdir, "extension/manifest.json"));
const storeExtensionIds = { ...readStoreExtensionIds(process.env), ...shippedExtensionIds };
writeFileSync(
  path.join(outdir, "bin", "store-extension-ids.json"),
  `${JSON.stringify(storeExtensionIds, null, 2)}\n`,
  "utf8",
);
if (Object.keys(storeExtensionIds).length === 0) {
  console.warn(
    "[package-webui-npm] the shipped extension carries no key and no store public key is in the environment, so the package carries no extension identity; the packaged host will refuse every extension until one is provided.",
  );
}
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

/**
 * The identities a package admits because of the extension it ships.
 *
 * `manifest.key` is a public key and the browser derives the extension's id
 * from it, so a build carrying one has the same id everywhere — the derivation
 * is `extensionIdFromPublicKey`, which the host reads the same file with.
 *
 * Both surfaces are named because the same build is loaded in Chrome and in
 * Edge, and a key-derived id is identical in both.
 */
function readShippedExtensionIds(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
  const key = typeof manifest.key === "string" ? manifest.key.trim() : "";
  if (key.length === 0) return {};
  const id = extensionIdFromPublicKey(key);
  return { chrome: id, edge: id };
}
