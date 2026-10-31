// Builds the extension into something a browser can actually load.
//
// A browser extension runtime executes **JavaScript only**. The extension's
// source is TypeScript, so loading the source directory registers a service
// worker that then cannot run — the extension looks installed and does
// nothing. A probe against a real Chrome showed exactly that:
// `.plan/board/validation/extension-load-evidence.json`.
//
// So the source directory is not the loadable artefact. This script produces
// `dist/`, which is:
//
//   dist/manifest.json                  the manifest, with the built paths
//   dist/background/service-worker.js   the bundled service worker
//   dist/options.html, dist/options.js  the bundled options page
//
// Load `dist/` as an unpacked extension. The source `manifest.json` stays the
// single declaration of the extension's metadata; this script only rewrites
// the two paths that point at source, and it says so where it rewrites them.

import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where this build goes.
 *
 * `--out <dir>`, relative to the package root. The default is `dist`. A store
 * build wants its own directory: a packaged build and a development build
 * cannot share one directory, because the packaged build's manifest carries the
 * store's public key and the development build's does not, and a build that
 * overwrote the other would make the identity of the loaded extension depend
 * on which suite ran last.
 */
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex >= 0 ? join(packageRoot, process.argv[outIndex + 1]) : join(packageRoot, "dist");

/**
 * The store this build is for, when it is a packaged build.
 *
 * `--store chrome` or `--store edge`. A packaged build embeds the store's
 * public key, which fixes the extension's identity: an unpacked build derives
 * its id from the directory it is loaded from, and that id is different for
 * every path and therefore not an identity anyone can rely on.
 */
const store = process.argv.includes("--store")
  ? process.argv[process.argv.indexOf("--store") + 1]
  : undefined;

/** The browser this targets. The manifest's `minimum_chrome_version` says the same. */
const BROWSER_TARGET = ["chrome116", "edge116"];

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "background"), { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: BROWSER_TARGET,
  // The service worker runs as a module, so the bundle must be an ES module
  // and the manifest's `background.type` must stay "module".
  sourcemap: false,
  minify: false,
  legalComments: "none",
};

await build({
  ...common,
  entryPoints: [join(packageRoot, "src/background/service-worker.ts")],
  outfile: join(outDir, "background/service-worker.js"),
});

await build({
  ...common,
  entryPoints: [join(packageRoot, "src/options.ts")],
  outfile: join(outDir, "options.js"),
});

// The options page is HTML; its script reference has to point at the bundle.
const optionsHtml = await readFile(join(packageRoot, "options.html"), "utf8");
const rewrittenOptions = optionsHtml.replace(
  /(src\s*=\s*)["'][^"']*options[^"']*["']/u,
  '$1"options.js"',
);
await writeFile(join(outDir, "options.html"), rewrittenOptions, "utf8");

// The manifest is copied with the two source paths rewritten to the built
// ones. Nothing else about it changes: it is the single declaration of the
// extension's metadata, and the build only relocates it.
const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"));
if (manifest.background?.service_worker) {
  manifest.background.service_worker = "background/service-worker.js";
}
if (manifest.options_ui?.page) {
  manifest.options_ui.page = "options.html";
}
if (store) {
  // The store's public key fixes the identity. It is the same key the store
  // holds, so the id the extension gets is the id the store issued.
  const keyEnv = `MAVIS_BROWSER_STORE_${store.toUpperCase()}_PUBLIC_KEY`;
  const publicKey = process.env[keyEnv];
  if (!publicKey) {
    throw new Error(
      `a packaged build needs the store's public key in ${keyEnv}; ` +
        "a packaged build without a fixed identity is not a packaged build.",
    );
  }
  manifest.key = publicKey;
}
await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// The manifest's icon, if the extension ever has one, is copied verbatim.
if (manifest.icons) {
  for (const icon of Object.values(manifest.icons)) {
    await cp(join(packageRoot, icon), join(outDir, icon));
  }
}

process.stdout.write(`Built the extension into ${outDir}\n`);

if (store) {
  // The store takes a zip of the unpacked directory. The name carries the
  // store, so the two artifacts cannot be confused for one another.
  const archive = join(packageRoot, `dist-${store}.zip`);
  await rm(archive, { force: true });
  await run("zip", ["-r", "-q", archive, "."], { cwd: outDir });
  process.stdout.write(`Packaged the ${store} build as ${archive}\n`);
}
