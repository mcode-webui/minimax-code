#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  WebuiService,
  createOperationRegistry,
  BrowserBridgeServer,
  createMiniAppProxyRegistry,
  createMiniAppPresenter,
} from "../server/server.js";
import {
  WebuiTerminalManager,
  createBrowserAdapter,
  createHarnessPortFromHost,
  createWebuiRuntimeHost,
} from "../server/runtime.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(packageRoot, "server/package-info.json"), "utf8"));
const portValue = process.env.WEBUI_SERVER_PORT?.trim() || "8787";
const tcpPort = Number(portValue);
if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
  throw new Error("WEBUI_SERVER_PORT must be an integer between 1 and 65535");
}

const dataDir = process.env.MINIMAX_DATA_DIR?.trim() || path.join(os.homedir(), ".minimax");
process.env.MAVIS_BUILTIN_AGENTS_V2_DIR ??= path.join(packageRoot, "assets/agents");
process.env.MAVIS_BUILTIN_AGENTS_DIR ??= path.join(packageRoot, "assets/agents");
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
const browserBridge = new BrowserBridgeServer({
  host: "127.0.0.1",
  dev: true,
  packaged: true,
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
const miniappProxies = createMiniAppProxyRegistry();
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
  host: "127.0.0.1",
  tcpPort,
  dev: true,
  clientDir: path.join(packageRoot, "client"),
  browserBridge,
  // Closed on shutdown: a leaked Mini App listener holds a plugin's derived port.
  miniappProxies,
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
  // dev mode keeps the per-start credential off, so the shell page and its
  // assets load without a query token. info.boundUrl is the bare ws://
  // endpoint; browsers need the http:// origin.
  const browserUrl = `http://${info.host}:${info.tcpPort}/`;
  console.log(`[mcode-webui] WebUI running at ${browserUrl}`);
  console.log("Press Ctrl+C to stop the server.");
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
} catch (error) {
  await close();
  throw error;
}
