// Build the WebUI package separately from the CLI bundle.
//
// ADR 0005 says the WebUI gets its own build graph and metafile so the
// standalone CLI entry points stay untouched. The server module is
// bundled with esbuild for Node; the client module with esbuild for the
// browser; both emit a metafile that `scripts/check-webui-boundary.mjs`
// inspects.
//
// Vite's own bundler is not invoked here on purpose: ticket 01 ships
// without a transport, so the client bundle is a single JS file plus the
// HTML wrapper, and adding a second tool with its own metafile format
// would defeat the boundary check.

import { build } from "esbuild";
import {
  rmSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageDir = path.join(root, "packages/webui");
const outdir = path.join(root, "dist-webui");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const server = await build({
  absWorkingDir: packageDir,
  entryPoints: {
    server: "src/server/index.ts",
    shared: "src/shared/placeholder.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outdir: path.join(outdir, "server"),
  metafile: true,
  logLevel: "info",
});

const client = await build({
  absWorkingDir: packageDir,
  entryPoints: { client: "src/client/main.tsx" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: path.join(outdir, "client"),
  metafile: true,
  jsx: "automatic",
  loader: { ".html": "text" },
  logLevel: "info",
});

// Merge the two metafiles into one: every input the build ever reached
// must be visible to the boundary check. esbuild's outputs side is
// dropped; the boundary check only needs inputs and the warnings list.
const merged = {
  inputs: { ...server.metafile.inputs, ...client.metafile.inputs },
  outputs: { ...server.metafile.outputs, ...client.metafile.outputs },
};

writeFileSync(
  path.join(outdir, "metafile.json"),
  JSON.stringify(merged, null, 2) + "\n",
);

const htmlSource = path.join(packageDir, "src/client/index.html");
if (existsSync(htmlSource))
  cpSync(htmlSource, path.join(outdir, "client/index.html"));

console.log(
  `Built WebUI foundation. ` +
    `server inputs: ${
      Object.keys(server.metafile.inputs).length
    }; ` +
    `client inputs: ${
      Object.keys(client.metafile.inputs).length
    }; total: ${Object.keys(merged.inputs).length}.`,
);
