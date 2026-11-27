import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import spawnCommand from "cross-spawn";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: {
  "package-dir": { type: "string" }, archive: { type: "string" }, "full-access": { type: "boolean", default: false },
} });
if (values.archive && values["package-dir"]) throw new Error("Choose one of --archive or --package-dir");

/**
 * The two extension identities the packaged host is configured with.
 *
 * They are synthetic: nothing signs anything with them and they are only ever
 * compared. A Chrome extension id is 32 letters from `a` to `p`, and the
 * bridge's origin parser rejects anything else, so the shape has to be right
 * for the check to mean anything.
 */
const SELF_HOSTED_EXTENSION_ID = "a".repeat(32);
const DEVELOPMENT_EXTENSION_ID = "b".repeat(32);

/**
 * The store public key the package is built with.
 *
 * A published extension id is derived from this key, so the package knows the
 * identity it admits before anybody installs it. The key is a synthetic one —
 * it signs nothing, and nothing compares against it but the derivation — but
 * it is a real RSA key, because the derivation takes a real key's bytes.
 */
const STORE_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnOhYRa1KUfkMMF25O1aGxrQTooncMH0Yt3CqWq1AcZNkZ5+ACczWCI9/BknmlyFIk1sRYt9fouhB/PEIeVu1TCW+1xq7zds7Trp7kdXl35YMR6yb98EGVmbVlgO1xTZOEBWaC1vhNLElJn16VVcozt5uMSePNQUPOogABfjIQCgpa44D9Bn77H6YovXgzphziIXZd9Z+F5akDfAZlsMtI7hYe/nNWSDvLPrIhc6pb0IZ/4gxIIkslgHaXxknc7Aj5Xfz0xkfkj5ccGfV6OYlgIs4JpjmzGRfoeyQxO4rSYTmYZXkMOtPSTkoGv7o2Ixs14B1pHm0PjHwbCR/svH7aQIDAQAB";

const scratch = process.env.MCODE_WEBUI_VERIFY_DIR ?? path.resolve(root, `../${path.basename(root)}-webui-work/package-checks`);
if (!path.relative(root, path.resolve(scratch)).startsWith("..")) throw new Error("WebUI package verification directory must be outside the repository");
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(path.join(scratch, "installed-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, options = {}) {
  const result = spawnCommand.sync(command, args, { cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.error?.message ?? result.stderr ?? result.signal}`);
  return result.stdout;
}
function packCandidate() {
  const packageDir = values["package-dir"] ? path.resolve(values["package-dir"]) : path.join(work, "package");
  // The package is built with the store's public key, so it carries the
  // published identity it admits. That is the point of this acceptance: the
  // person who installs the package configures nothing.
  if (!values["package-dir"]) {
    run(process.execPath, ["scripts/package-webui-npm.mjs", "--outdir", packageDir], {
      env: { ...process.env, MAVIS_BROWSER_STORE_CHROME_PUBLIC_KEY: STORE_PUBLIC_KEY },
    });
  }
  // `npm pack --json` answered with an array before npm 12 and with an object
  // keyed by package name after it, so both shapes are read here.
  const packOutput = JSON.parse(run(npm, ["pack", packageDir, "--json", "--pack-destination", work]));
  const packed = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
  if (packed.length !== 1) throw new Error(`Expected exactly one WebUI npm archive, got ${packed.length}`);
  return path.join(work, packed[0].filename);
}

// A locked file or a slow browser shutdown must not replace the error from the user's action.
async function withCleanup(operation, cleanup) {
  let failure;
  try {
    return await operation();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      if (!failure) throw error;
      console.warn(`Additional cleanup failure: ${error.code ?? error.name}`);
    }
  }
}

let child;
await withCleanup(async () => {
  const archive = values.archive ? path.resolve(values.archive) : packCandidate();
  const prefix = path.join(work, "install");
  // npm 12 blocks dependency install scripts unless they are named, and the
  // native modules this package needs are built by those scripts. A global
  // install is the shape that accepts the flag — npm 12 refuses it for a
  // project-scoped install — so the acceptance installs the way a person must,
  // which is also the only way the startup below can be exercised at all.
  const npmMajor = Number(run(npm, ["--version"]).trim().split(".")[0]);
  const allowScripts = "better-sqlite3,bufferutil,koffi,node-pty,utf-8-validate";
  run(
    npm,
    npmMajor >= 12
      ? ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", `--allow-scripts=${allowScripts}`, archive]
      : ["install", "--prefix", prefix, "--no-audit", "--no-fund", archive],
  );
  const { name } = JSON.parse(readFileSync(path.join(root, "release/webui-npm/package.json"), "utf8"));
  const installed = resolveInstalledPackage(prefix, name);
  const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  const publishedId = readPublishedIds(path.join(installed, "bin", "store-extension-ids.json")).chrome;
  if (!publishedId) throw new Error("The installed WebUI package carries no published extension identity");
  if (process.platform === "win32") {
    const digest = createHash("sha512").update(readFileSync(archive)).digest("base64");
    console.log(`Testing installed ${manifest.name}@${manifest.version} on Windows, sha512-${digest}`);
    await verifyWindowsProjectSelection(installed);
  }
  run(process.execPath, ["--input-type=module", "-e",
    `const sdk = await import("@larksuiteoapi/node-sdk");
    for (const name of ["WSClient", "EventDispatcher"]) {
      if (typeof sdk[name] !== "function") throw new Error(\`Feishu SDK does not export \${name}\`);
    }`,
  ], { cwd: path.join(installed, "server") });
  const launcher = path.join(installed, manifest.bin["mcode-webui"]);
  const helpDataDir = path.join(work, "help-must-not-create-data");
  const infoEnvironment = { ...process.env, MINIMAX_DATA_DIR: helpDataDir, WEBUI_SERVER_PORT: "invalid" };
  const help = run(process.execPath, [launcher, "--help"], { env: infoEnvironment });
  const installedVersion = run(process.execPath, [launcher, "--version"], { env: infoEnvironment });
  if (!help.includes("Usage: mcode-webui") || !help.includes("--full-access") || installedVersion.trim() !== manifest.version || existsSync(helpDataDir)) {
    throw new Error("Installed WebUI help/version must exit without starting the runtime");
  }
  const port = await availablePort();
  const miniappPort = await availablePort();
  child = spawn(process.execPath, [path.join(installed, manifest.bin["mcode-webui"]), ...(values["full-access"] ? ["--full-access"] : [])], {
    cwd: work,
    env: {
      ...process.env,
      MINIMAX_DATA_DIR: path.join(work, "synthetic-data"),
      WEBUI_SERVER_PORT: String(port),
      WEBUI_MINIAPP_PORT: String(miniappPort),
      WEBUI_HOST: "0.0.0.0",
      // The packaged host is configured with both allowlists, on purpose: the
      // store identity has to be admitted and the development identity has to
      // be refused, and the only way to show that is to have both present.
      //
      // The published identity is deliberately NOT among them: it is baked
      // into the package, and the check below is that it is admitted without
      // anybody naming it.
      MAVIS_BROWSER_STORE_CHROME_EXTENSION_IDS: SELF_HOSTED_EXTENSION_ID,
      MAVIS_BROWSER_CHROME_EXTENSION_IDS: DEVELOPMENT_EXTENSION_ID,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
  const lanHost = `192.168.1.20:${port}`;
  const guest = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/`, { headers: { Host: lanHost } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
  if (guest !== (values["full-access"] ? 200 : 401)) throw new Error(`Installed WebUI guest HTTP admission returned ${guest}`);
  const miniappGuest = await fetch(`http://127.0.0.1:${miniappPort}/unregistered-app`, { signal: AbortSignal.timeout(5000) });
  if (miniappGuest.status !== (values["full-access"] ? 404 : 401)) throw new Error(`Installed Mini App guest admission returned ${miniappGuest.status}`);
  await miniappGuest.arrayBuffer();
  if (values["full-access"]) {
    if (!output.includes(`WebUI running at ${origin}/`) || output.includes("?token=") || output.includes("credential token:")) {
      throw new Error("Full-access startup must print token-free access URLs");
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Host: lanHost, Origin: `http://${lanHost}` },
    });
    try {
      await once(ws, "open");
      const reply = once(ws, "message");
      ws.send(JSON.stringify({ protocolVersion: 1, kind: "request", requestId: "full-access-version", operation: "version" }));
      const [raw] = await reply;
      const frame = JSON.parse(raw.toString());
      if (frame.kind !== "response" || frame.requestId !== "full-access-version") throw new Error("Installed full-access WebSocket did not answer version");
    } finally {
      ws.close();
    }
  }
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
  // The published identity, the one the package was built for: it is
  // admitted with nothing configured, because the package knows it.
  const admittedPublished = await bridgeUpgrade(port, publishedId);
  if (!admittedPublished) {
    throw new Error("The installed WebUI refused the published extension identity it was built for");
  }
  // A self-hosted store build, named through the environment, is admitted
  // alongside it.
  const admitted = await bridgeUpgrade(port, SELF_HOSTED_EXTENSION_ID);
  if (!admitted) throw new Error("The installed WebUI refused the store extension identity its environment named");
  const refused = await bridgeUpgrade(port, DEVELOPMENT_EXTENSION_ID);
  if (refused) throw new Error("The installed WebUI accepted a development extension identity");
  const exited = once(child, "exit");
  if (process.platform === "win32") child.send({ type: "mcode-webui:shutdown" });
  else child.kill("SIGTERM");
  const [code, signal] = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Installed WebUI shutdown timed out")), 10_000).unref())]);
  if (code !== 0 || signal !== null) throw new Error(`Installed WebUI shutdown failed: ${code ?? signal}`);
  child = undefined;
  console.log(`Installed WebUI package PASS: ${manifest.name}@${manifest.version}; archive installation, real runtime startup, HTTP assets, full-access=${values["full-access"]}, the packaged bridge's admission and shutdown`);
}, async () => {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
});

async function availablePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function verifyWindowsProjectSelection(installed) {
  // Each entry gets a fresh browser, launcher and project. A broken entry must
  // neither borrow another entry's pairing nor prevent the others from running.
  const failures = [];
  for (const entry of ["terminal", "manual", "desktop-handoff"]) {
    console.log(`Checking Windows project selection from ${entry}.`);
    try {
      await verifyWindowsProjectEntry(installed, entry);
    } catch (error) {
      failures.push(`${entry}: ${error.message}`);
      console.error(`Windows ${entry} project selection failed: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Windows project selection failed:\n${failures.join("\n")}`);
}

async function verifyWindowsProjectEntry(installed, entry) {
  const { launchNativeProjectBrowser } = await import("./lib/webui-native-project-launch.mjs");
  const { verifyNativeProjectJourney } = await import("./lib/webui-native-project-journey.mjs");
  const directory = mkdtempSync(path.join(work, "Project 示例 "));
  const browser = await launchNativeProjectBrowser({ installed, work, port: await availablePort(), miniappPort: await availablePort(), entry });
  const evidenceDir = process.env.WEBUI_BROWSER_OUTPUT_DIR && path.join(process.env.WEBUI_BROWSER_OUTPUT_DIR, entry);
  const driver = path.join(root, "scripts/lib/webui-windows-folder-dialog.ps1");
  const launcherEntry = path.join(installed, "bin/mcode-webui.mjs");
  const driveDialog = async ({ action, signal }) => {
    const args = ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", driver,
      "-LauncherPid", String(browser.launcherPid), "-LauncherEntry", launcherEntry, "-BrowserPid", String(browser.browserPid), "-Action", action];
    if (action === "select") args.push("-Directory", directory);
    const { stdout } = await promisify(execFile)("powershell.exe", args, {
      signal, timeout: 45_000, windowsHide: true,
      env: { ...process.env, WEBUI_BROWSER_OUTPUT_DIR: evidenceDir ?? "" },
    });
    console.log(stdout.trim());
  };
  await withCleanup(async () => {
    try {
      const result = await verifyNativeProjectJourney({
        page: browser.page, directory, driveDialog, beforeChoose: () => driveDialog({ action: "baseline" }),
      });
      console.log(`Windows ${entry} passed: foreground select and cancel; session ${result.sessionId} under ${result.directory} visible before and after reload.`);
      if (evidenceDir) {
        await browser.page.screenshot({ path: path.join(evidenceDir, "windows-project-session.png"), timeout: 5000 })
          .catch(() => console.warn("Could not capture the verified project and session."));
      }
    } catch (error) {
      if (evidenceDir) {
        // Playwright creates the parent directory when saving a screenshot.
        await browser.page.screenshot({ path: path.join(evidenceDir, "windows-project-picker.png"), timeout: 5000 })
          .catch(() => console.warn("Could not capture the isolated WebUI page."));
      }
      throw error;
    }
  }, browser.close);
}

/**
 * Where a prefix install put the package.
 *
 * A project install lands in `<prefix>/node_modules`; a global one lands in
 * `<prefix>/lib/node_modules` on POSIX and in `<prefix>/node_modules` on
 * Windows. Both candidates are tried, so the acceptance does not have to know
 * which npm major installed it.
 */
function resolveInstalledPackage(prefix, name) {
  for (const candidate of [
    path.join(prefix, "lib", "node_modules", name),
    path.join(prefix, "node_modules", name),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`The install did not place ${name} under ${prefix}`);
}

/**
 * The published extension identities a package carries.
 *
 * They are written into the package at package time, because they are a
 * constant of the release rather than a property of the machine it is
 * installed on. A package built without a store public key carries none, and
 * its host then admits nobody.
 */
function readPublishedIds(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const ids = {};
    for (const [surface, value] of Object.entries(parsed)) {
      if (typeof value === "string" && /^[a-p]{32}$/.test(value)) ids[surface] = value;
    }
    return ids;
  } catch {
    return {};
  }
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
