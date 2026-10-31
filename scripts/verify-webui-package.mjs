import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { once } from "node:events";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { "package-dir": { type: "string" } } });

/**
 * The two extension identities the packaged host is configured with.
 *
 * They are synthetic: nothing signs anything with them and they are only ever
 * compared. A Chrome extension id is 32 letters from `a` to `p`, and the
 * bridge's origin parser rejects anything else, so the shape has to be right
 * for the check to mean anything.
 */
const STORE_EXTENSION_ID = "a".repeat(32);
const DEVELOPMENT_EXTENSION_ID = "b".repeat(32);

const scratch = process.env.MCODE_WEBUI_VERIFY_DIR ?? path.resolve(root, `../${path.basename(root)}-webui-work/package-checks`);
if (!path.relative(root, path.resolve(scratch)).startsWith("..")) throw new Error("WebUI package verification directory must be outside the repository");
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(path.join(scratch, "installed-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.error?.message ?? result.stderr ?? result.signal}`);
  return result.stdout;
}
let child;
try {
  const packageDir = values["package-dir"] ? path.resolve(values["package-dir"]) : path.join(work, "package");
  if (!values["package-dir"]) run(process.execPath, ["scripts/package-webui-npm.mjs", "--outdir", packageDir]);
  const packed = JSON.parse(run(npm, ["pack", packageDir, "--json", "--pack-destination", work]));
  if (packed.length !== 1) throw new Error("Expected exactly one WebUI npm archive");
  const prefix = path.join(work, "install");
  run(npm, ["install", "--prefix", prefix, "--no-audit", "--no-fund", path.join(work, packed[0].filename)]);
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const installed = path.join(prefix, "node_modules", manifest.name);
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  child = spawn(process.execPath, [path.join(installed, manifest.bin["mcode-webui"])], {
    cwd: work,
    env: {
      ...process.env,
      MINIMAX_DATA_DIR: path.join(work, "synthetic-data"),
      WEBUI_SERVER_PORT: String(port),
      // The packaged host is configured with both allowlists, on purpose: the
      // store identity has to be admitted and the development identity has to
      // be refused, and the only way to show that is to have both present.
      MAVIS_BROWSER_STORE_CHROME_EXTENSION_IDS: STORE_EXTENSION_ID,
      MAVIS_BROWSER_CHROME_EXTENSION_IDS: DEVELOPMENT_EXTENSION_ID,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-32_768); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-32_768); });
  let startupError;
  child.on("error", (error) => { startupError = error; });
  const deadline = Date.now() + 45_000;
  while (!output.includes("WebUI running at")) {
    if (startupError || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`Installed WebUI startup failed: ${startupError?.message ?? output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const origin = `http://127.0.0.1:${port}`;
  const html = await fetch(origin, { signal: AbortSignal.timeout(5000) });
  if (!html.ok || !(await html.text()).includes("webui-root")) throw new Error("Installed WebUI did not serve the built HTML");
  for (const asset of ["client.js", "styles.css"]) {
    const response = await fetch(`${origin}/${asset}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || (await response.arrayBuffer()).byteLength === 0) throw new Error(`Installed WebUI asset missing: ${asset}`);
  }
  // The packaged host's bridge has to be a **packaged** host: it admits the
  // store identity and refuses the development one, even though both are
  // configured. The bridge's own path is checked here, against the process
  // that was actually started, rather than against a bridge the test built
  // itself.
  const admitted = await bridgeUpgrade(port, STORE_EXTENSION_ID);
  if (!admitted) throw new Error("The installed WebUI refused the store extension identity");
  const refused = await bridgeUpgrade(port, DEVELOPMENT_EXTENSION_ID);
  if (refused) throw new Error("The installed WebUI accepted a development extension identity");
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code, signal] = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Installed WebUI shutdown timed out")), 10_000).unref())]);
  if (code !== 0 || signal !== null) throw new Error(`Installed WebUI shutdown failed: ${code ?? signal}`);
  child = undefined;
  console.log(`Installed WebUI package PASS: ${manifest.name}@${manifest.version}; archive installation, real runtime startup, HTTP assets, the packaged bridge's admission and shutdown`);
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  rmSync(work, { recursive: true, force: true });
}

/**
 * Whether the bridge admitted an extension with this identity.
 *
 * `true` means the upgrade was accepted — the socket opened — and `false`
 * means the upgrade was refused. The first frame the host sends is a
 * `challenge`, or a `closed` frame when the surface's switch is off; either
 * one proves the identity got past admission, because a refused identity
 * never gets a socket at all.
 */
async function bridgeUpgrade(port, extensionId) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/browser-bridge`, {
      origin: `chrome-extension://${extensionId}/`,
    });
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The error listener stays attached: tearing a socket down mid-handshake
      // reports an error, and an unhandled one would take the process down.
      try {
        socket.terminate();
      } catch {
        // The socket is already gone; nothing to close.
      }
      resolve(value);
    };
    const timer = setTimeout(() => settle(false), 10_000);
    socket.once("open", () => settle(true));
    socket.once("error", () => settle(false));
    // A refused upgrade never opens a socket: the host answers the upgrade
    // request itself with a status line.
    socket.once("unexpected-response", () => settle(false));
  });
}
