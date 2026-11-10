#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    "full-access": { type: "boolean", default: false },
  },
});
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(packageRoot, "server/package-info.json"), "utf8"));
if (args.help) {
  console.log(`Usage: mcode-webui [--full-access] [--help | --version]

Start the MiniMax Code WebUI. Configuration is read from environment variables:
  MINIMAX_DATA_DIR     Data directory (default: ~/.minimax)
  WEBUI_HOST          Bind address (default: 127.0.0.1)
  WEBUI_SERVER_PORT   WebUI port (default: 2233)
  WEBUI_MINIAPP_PORT  Mini App port (default: 49152)

  -h, --help          Show help without starting the runtime
  -v, --version       Show the installed version
      --full-access  Disable token authentication for WebUI HTTP, WebSocket and Mini App services`);
  process.exit(0);
}
if (args.version) {
  console.log(version);
  process.exit(0);
}

// Help/version must not load native modules, access user data or open listeners.
const {
  WebuiService,
  createOperationRegistry,
  BrowserBridgeServer,
  WebuiBrowserExtensionPackage,
  createMiniAppProxyRegistry,
  createMiniAppPresenter,
  createWebuiCredential,
} = await import("../server/server.js");
const {
  WebuiTerminalManager,
  createBrowserAdapter,
  createHarnessPortFromHost,
  createWebuiRuntimeHost,
} = await import("../server/runtime.js");

const portValue = process.env.WEBUI_SERVER_PORT?.trim() || "2233";
const tcpPort = Number(portValue);
if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
  throw new Error("WEBUI_SERVER_PORT must be an integer between 1 and 65535");
}
// The port every Mini App is published on.
//
// One port for all of them: a Mini App that arrives in the store does not ask
// the deployment for another firewall rule and another port forward. The Mini
// Apps are told apart by the path they are served under.
const miniappPortValue = process.env.WEBUI_MINIAPP_PORT?.trim() || "49152";
const miniappPort = Number(miniappPortValue);
if (!Number.isInteger(miniappPort) || miniappPort < 1 || miniappPort > 65535) {
  throw new Error("WEBUI_MINIAPP_PORT must be an integer between 1 and 65535");
}

const dataDir = process.env.MINIMAX_DATA_DIR?.trim() || path.join(os.homedir(), ".minimax");
// The address the service binds to. Loopback is the default; a wider address
// publishes the WebUI beyond this machine, which ADR 0031 allows and gates:
// a request that did not arrive over loopback presents the per-start
// credential, so the printed URL carries it.
const bindHost = process.env.WEBUI_HOST?.trim() || "127.0.0.1";
process.env.MAVIS_BUILTIN_AGENTS_V2_DIR ??= path.join(packageRoot, "assets/agents");
process.env.MAVIS_BUILTIN_AGENTS_DIR ??= path.join(packageRoot, "assets/agents");

/**
 * Stop before the runtime does when a native module was not built.
 *
 * npm 12 blocks dependency install scripts unless they are named, and this
 * package's SQLite and terminal modules are built by those scripts. When they
 * are skipped the module loads as a package with no binding, and the first thing
 * to notice is a database migration deep inside the runtime: the person sees
 * `current_local_runtime_v2_migration_failed:sqlite:…:Could not locate the
 * bindings file`, which names the migration rather than the skipped build step,
 * and the fix — one install flag — is nowhere in it.
 *
 * The check is here, at the composition root, because it is the last place that
 * knows both the dependency list and the package name a person can reinstall.
 */
const NATIVE_MODULES = ["better-sqlite3", "node-pty"];
/**
 * Load each module the way the runtime will.
 *
 * A plain `require` is not enough for `better-sqlite3`: it resolves its binding
 * lazily, so the module imports cleanly and the missing binding only surfaces
 * when something opens a database. Opening an in-memory database here is the
 * cheapest way to make the check answer the question the person is about to ask.
 */
const NATIVE_PROBES = {
  "better-sqlite3": (module) => {
    new module(":memory:").close();
  },
  "node-pty": () => {},
};
const unbuilt = [];
for (const name of NATIVE_MODULES) {
  try {
    NATIVE_PROBES[name](createRequire(import.meta.url)(name));
  } catch (error) {
    unbuilt.push(`${name}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}
if (unbuilt.length > 0) {
  const packageName = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ).name;
  console.error("[mcode-webui] a native module this package needs was not built:");
  for (const line of unbuilt) console.error(`  ${line}`);
  console.error("");
  console.error(
    "npm 12 blocks dependency install scripts unless they are allowed, and these modules are",
  );
  console.error("built by their own install scripts. Reinstall with them allowed:");
  console.error("");
  console.error(
    `  npm install -g ${packageName} --allow-scripts=${NATIVE_MODULES.join(",")},bufferutil,utf-8-validate`,
  );
  console.error("");
  console.error("or allow them for every global install:");
  console.error("");
  console.error(
    `  npm config set allow-scripts=${NATIVE_MODULES.join(",")},bufferutil,utf-8-validate --location=user`,
  );
  process.exit(1);
}

/**
 * The published extension identities this package was built for.
 *
 * A store build's identity is derived from the store's public key, so it is
 * known at package time and written into `bin/store-extension-ids.json`. It
 * is a property of the package rather than of the machine it is installed on,
 * which is why it is read from the package and not from the environment.
 *
 * A package built without a store public key carries no identity, and the
 * bridge then admits nobody. The refusal is visible — every extension is
 * turned away at the upgrade — rather than silent.
 */
async function readStoreExtensionIds() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(packageRoot, "bin", "store-extension-ids.json"), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const ids = {};
  for (const [surface, value] of Object.entries(parsed)) {
    if (surface !== "edge" && surface !== "chrome") continue;
    // A Chrome extension id is 32 letters from `a` to `p`. Anything else is
    // not an identity the bridge could ever compare against, so it is dropped
    // rather than carried into the allowlist.
    if (typeof value !== "string" || !/^[a-p]{32}$/.test(value)) continue;
    ids[surface] = [value];
  }
  return ids;
}
// The extension bridge is assembled here, beside the browser adapter, because
// the layer matrix forbids `src/runtime/**` from importing `src/server/**`. This
// file is the composition root: it is the one place that can hand the bridge's
// provider factory to the adapter AND the same instance to the service's
// `/browser-bridge` upgrade branch, so the extension and the browser service
// address one session rather than two. `dev: true` is passed through
// unchanged; the bridge's admission ignores it by design.
//
// `packaged: true` is what makes this the **packaged** entry. A packaged host
// reads the store allowlist (`MAVIS_BROWSER_STORE_EDGE_EXTENSION_IDS`,
// `MAVIS_BROWSER_STORE_CHROME_EXTENSION_IDS`) and never the development one
// (`MAVIS_BROWSER_EDGE_EXTENSION_IDS`, `MAVIS_BROWSER_CHROME_EXTENSION_IDS`).
// The difference matters: an unpacked build's id is derived from the directory
// it was loaded from, so it is not an identity anyone can rely on, and a
// packaged host that accepted those ids would admit whatever unpacked
// extension happened to be present. The development entry
// (`scripts/run-webui-server.mjs`) is the one that reads the development
// allowlist.
//
// The identity of the **published** extension is not read from the
// environment at all: it is a constant of this release, derived from the
// store's public key, and it is written into the package at package time (see
// `scripts/package-webui-npm.mjs`). So the person who installs this package
// configures nothing: the bridge admits the published extension, and the
// environment variables above remain available for a self-hosted store build.
//
// The published identities are read here rather than in the server bundle,
// because they are a property of the **package** — of which store's build it
// ships — and not of the code.
const browserBridge = new BrowserBridgeServer({
  host: "127.0.0.1",
  dev: true,
  packaged: true,
  storeExtensionIds: await readStoreExtensionIds(),
});
await browserBridge.start();
// The browser adapter is built before the runtime host, because the host is
// what takes the browser provider: the adapter reads its authorization
// switches through the host, so the host is attached to it immediately after.
//
// The same binding carries both faces of the one browser session — the port the
// browser operations bind to, and the Agent's browser tools. Building the tool
// adapter anywhere else would put the Agent on a second browser, and the panel
// would show the first.
const browser = createBrowserAdapter({ dataDir, bridge: browserBridge });
const miniAppPresenter = createMiniAppPresenter({});
// The credential is created here because two listeners need it: the WebUI
// service, which issues it, and the Mini App proxies, which ask for it when
// they are bound beyond loopback (ADR 0031).
const credential = createWebuiCredential();
const miniappProxies = createMiniAppProxyRegistry({
  host: bindHost,
  port: miniappPort,
  credential,
  fullAccess: args["full-access"],
});
const assembled = await createWebuiRuntimeHost({
  dataDir,
  appVersion: version,
  browserProvider: {
    adapter: browser.toolAdapter,
    close: () => browser.close(),
  },
  // One compact Browser tool over the restricted command set. The detailed
  // per-action tools would re-offer the same actions under their own names.
  browserToolExposure: "compact",
  // The runtime's Mini App presenter, implemented by this client. Supplied here
  // because the runtime may not import the server that holds it.
  miniAppSurface: miniAppPresenter.presenter,
});
browser.attachHost(assembled.host);
// A session's pages are released when the session ends -- deleted, archived
// or transferred away. The runtime has no per-session lifecycle signal, and
// this is the only place that holds both the harness port and the browser
// service, so the release is wired here rather than on one operation.
const port = createHarnessPortFromHost(assembled.host, {
  onSessionEnded: (sessionId) => browser.releaseSession(sessionId),
  browserPort: browser.port,
});
const terminal = new WebuiTerminalManager();
// The browser port is absent when the host cannot answer the browser
// authorization at all, and the browser operations then stay unregistered.
//
// The bridge's pairings follow the switches, so the persisted authorization has
// to reach them before the service starts serving.
await browser.initialize();
const service = new WebuiService({
  port,
  operations: createOperationRegistry(port, terminal, browser.port, browserBridge, miniappProxies, miniAppPresenter),
  terminal,
  host: bindHost,
  tcpPort,
  credential,
  fullAccess: args["full-access"],
  dev: true,
  clientDir: path.join(packageRoot, "client"),
  browserBridge,
  // The extension this package hands out.
  //
  // Nobody installs it from a store — the person downloads it from Settings and
  // loads it unpacked — so the build ships inside this package and is served
  // from here. A host with no sources to build from points the service at the
  // build it carries (`builtDir`); without this the download route answers 404
  // and the button in Settings does nothing, which reads like a broken page
  // rather than a missing package.
  browserExtensionPackage: new WebuiBrowserExtensionPackage({
    builtDir: path.join(packageRoot, "extension"),
    scratchDir: path.join(dataDir, "tmp"),
  }),
  // Closed on shutdown: a leaked Mini App listener holds a plugin's derived port.
  miniappProxies,
  // The page's own request to stop. The launcher owns the process, so the
  // service asks it and the launcher ends the run the way Ctrl+C does.
  requestShutdown: () => void close().finally(() => process.exit(0)),
});

let closing;
const close = () => {
  closing ??= (async () => {
    await service.close();
    await browser.close();
    await assembled.host.apiHost.close();
  })();
  return closing;
};

try {
  const info = await service.start();
  // Full access prints plain URLs. Otherwise each address carries the credential
  // a non-loopback request needs (ADR 0031).
  const browserUrl = accessUrl(
    isWildcardBindAddress(bindHost) ? "127.0.0.1" : bindHost,
    info.tcpPort,
    args["full-access"] ? "" : info.credential.token,
  );
  // The Mini App listener is bound before the first Mini App opens: the
  // runtime draws its own Mini App ports from the same range, and a listener
  // that waited would lose this one.
  await miniappProxies.prepare();
  console.log(`[mcode-webui] WebUI running at ${browserUrl}`);
  console.log(
    `[mcode-webui] Mini App port: ${miniappPort} — forward it, or a Mini App loads blank`,
  );
  printAccess(info, bindHost);
  openBrowser(browserUrl);
  console.log("Press Ctrl+C to stop the server.");
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  // Windows process.kill cannot deliver a catchable POSIX signal. A Node
  // parent can request the same graceful teardown over its private IPC pipe.
  if (process.send) process.on("message", (message) => {
    if (message?.type === "mcode-webui:shutdown") {
      void close().then(() => process.exit(0), (error) => {
        console.error(error);
        process.exit(1);
      });
    }
  });
} catch (error) {
  await close();
  throw error;
}

/**
 * The path a person opens, with the credential unless full access is enabled.
 */
function accessUrl(host, port, token) {
  const literal = host.includes(":") ? `[${host}]` : host;
  return `http://${literal}:${port}/${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/**
 * Print how to reach the service.
 *
 * A loopback bind is one address; a wildcard bind is every address this
 * machine has. Token-authenticated mode includes the credential on each URL.
 */
function printAccess(info, bindHost) {
  const port = info.tcpPort;
  const token = args["full-access"] ? "" : info.credential.token;
  if (args["full-access"]) console.log("[mcode-webui] full access enabled: token authentication disabled");
  else console.log(`[mcode-webui] credential token: ${token}`);
  if (isWildcardBindAddress(bindHost)) {
    console.log(`[mcode-webui] open ${accessUrl("127.0.0.1", port, token)}`);
    const addresses = lanAddresses();
    if (addresses.length === 0) {
      console.log("[mcode-webui] no LAN address found; set WEBUI_HOST to the address to publish.");
    }
    for (const address of addresses) {
      console.log(`[mcode-webui] open ${accessUrl(address, port, token)}`);
    }
    return;
  }
  console.log(`[mcode-webui] open ${accessUrl(bindHost, port, token)}`);
}

function isWildcardBindAddress(host) {
  return host === "0.0.0.0" || host === "::" || host === "";
}

/** The routable IPv4 addresses of this machine, loopback excluded. */
function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

/**
 * Open the WebUI in the person's default browser.
 *
 * The command exists to bring up a page, so printing a URL for someone to copy
 * is the step it removes. `WEBUI_OPEN_BROWSER` decides it:
 *
 * - unset: open only when stdout is a terminal. A verification run, a CI job or
 *   a supervisor that pipes this process's output must not take over the
 *   desktop, and "piped" is exactly what those look like.
 * - `0` / `false` / `no` / `off` / `never`: never open, even from a terminal.
 * - anything else: open even without a terminal, for a launcher that wants the
 *   page up.
 *
 * A launcher that is missing or refuses the URL is reported and nothing more.
 * The server is already serving by this point, and failing the run because a
 * browser could not start would turn a convenience into an outage.
 */
function openBrowser(url) {
  const setting = process.env.WEBUI_OPEN_BROWSER?.trim().toLowerCase();
  const disabled = setting === "0" || setting === "false" || setting === "no" || setting === "off" || setting === "never";
  const enabled = setting === undefined || setting === "" ? Boolean(process.stdout.isTTY) : !disabled;
  if (!enabled) return;
  // Each platform names its launcher differently, and Windows' `start` is a
  // shell builtin, so it needs a command interpreter in front of it. The empty
  // argument is `start`'s window-title slot: without it a quoted URL is read as
  // the title and no browser opens.
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (error) => {
      console.warn(`[mcode-webui] could not open a browser (${command}): ${error.message}`);
      console.warn(`[mcode-webui] open ${url} yourself, or set WEBUI_OPEN_BROWSER=0 to stop this attempt.`);
    });
    // Detached so the browser is not a child of this server: closing the page
    // must not signal the process, and stopping the server must not close the
    // page the person is still reading.
    child.unref();
  } catch (error) {
    console.warn(`[mcode-webui] could not open a browser (${command}): ${error.message}`);
  }
}
