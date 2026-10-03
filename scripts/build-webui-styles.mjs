// Compile the WebUI stylesheet (ADR 0009, ADR 0010).
//
// Tailwind v3 reads `packages/webui/tailwind.config.cjs` and processes
// `packages/webui/src/client/styles/index.css` into a single stylesheet under
// `dist-webui/client/styles.css`. The same artifact is consumed by both the
// Vite development server and the packaged esbuild bundle, so a difference
// between the two consumers is impossible by construction.
//
// `tailwindcss build` invokes PostCSS + autoprefixer via its built-in
// pipeline, which keeps the install footprint at three JS-only dev
// dependencies and avoids the native-engine binary that Tailwind v4 ships.
//
// The output directory mirrors the esbuild layout under `dist-webui/` so the
// index.html the build script copies next to it can refer to `./styles.css`
// without any path translation.

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEBUI_DIST_DIRECTORY } from "./lib/webui-boundary-constants.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageDir = path.join(root, "packages/webui");
const outdir = path.join(root, WEBUI_DIST_DIRECTORY, "client");
mkdirSync(outdir, { recursive: true });

const inputCss = path.join(packageDir, "src/client/styles/index.css");
const outputCss = path.join(outdir, "styles.css");

if (!existsSync(inputCss)) {
  throw new Error(
    `WebUI styles entry missing at ${path.relative(root, inputCss)}`,
  );
}

// Invoke the Tailwind CLI through its JavaScript entry with the running
// Node executable. The `.bin` shims are POSIX shell scripts on POSIX and
// `.CMD` batch files on Windows; `spawnSync` cannot execute the former on
// Windows (exit null) without a shell, and shelling out would make every
// argument subject to platform quoting. The JS entry sidesteps both.
const tailwindCli = path.join(root, "node_modules/tailwindcss/lib/cli.js");
const result = spawnSync(
  process.execPath,
  [
    tailwindCli,
    "build",
    "--input",
    inputCss,
    "--output",
    outputCss,
    "--config",
    path.join(packageDir, "tailwind.config.cjs"),
  ],
  { stdio: "inherit", cwd: packageDir },
);

if (result.status !== 0) {
  throw new Error(
    `Tailwind build for the WebUI failed (exit ${result.status})`,
  );
}

console.log(
  `Built WebUI stylesheet at ${path.relative(root, outputCss)}`,
);