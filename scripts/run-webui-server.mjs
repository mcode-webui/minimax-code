// Development-only WebUI runtime server. Vite serves the browser client; this
// process owns the loopback WebSocket service on WEBUI_SERVER_PORT.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The remote-control bridge logs its own decisions — did the pairing poll run,
// what did it see, why did a credential fail — at the info level, and the
// service drops that level by default because the bridge is chatty. Those lines
// are the evidence a pairing problem turns on, so the development server asks
// for them by name. The child process inherits this.
process.env.WEBUI_REMOTE_CONTROL_VERBOSE ??= "1";

if (!process.env.WEBUI_SERVER_TSX) {
  const tsconfigPath = fileURLToPath(
    new URL("../tsconfig.standalone.json", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", fileURLToPath(import.meta.url)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: tsconfigPath,
        WEBUI_SERVER_TSX: "1",
      },
    },
  );
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  const os = await import("node:os");
  const path = await import("node:path");
  const { createWebuiRuntimeHost, createHarnessPortFromHost, createBrowserAdapter, WebuiTerminalManager } =
    await import("../packages/webui/src/runtime/index.ts");
  const {
    WebuiService,
    createOperationRegistry,
    createMiniAppProxyRegistry,
    createMiniAppPresenter,
  } = await import("../packages/webui/src/server/index.ts");
  const { BrowserBridgeServer } =
    await import("../packages/webui/src/server/browser-bridge/index.ts");
  const dataDir =
    process.env.MINIMAX_DATA_DIR?.trim() || path.join(os.homedir(), ".minimax");
  const tcpPort = Number(process.env.WEBUI_SERVER_PORT ?? 8787);
  const clientDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist-webui/client",
  );
  // The extension bridge is assembled here rather than inside the adapter: the
  // layer matrix forbids `src/runtime/**` from importing `src/server/**`, so
  // this file — outside the layer system — is the one place that can hold the
  // bridge, hand its provider factory to the adapter and give the same instance
  // to the service's `/browser-bridge` upgrade branch. `dev: true` is passed
  // through unchanged; the bridge's admission ignores it by design.
  //
  // This is the **development** entry, so the bridge is not `packaged`: it
  // reads the development allowlist (`MAVIS_BROWSER_EDGE_EXTENSION_IDS`,
  // `MAVIS_BROWSER_CHROME_EXTENSION_IDS`), which is where the ids of unpacked
  // builds belong. The packaged entry
  // (`release/webui-npm/bin/mcode-webui.mjs`) reads the store allowlist and
  // refuses these.
  const browserBridge = new BrowserBridgeServer({ host: "127.0.0.1", dev: true });
  await browserBridge.start();
  // The browser adapter is built before the runtime host, because the host is
  // what takes the browser provider: the adapter reads its authorization
  // switches through the host, so the host is attached to it immediately after.
  //
  // The same binding carries both faces of the one browser session — the port
  // the browser operations bind to, and the Agent's browser tools. Building the
  // tool adapter anywhere else would put the Agent on a second browser, and the
  // panel would show the first.
  const browser = createBrowserAdapter({ dataDir, bridge: browserBridge });
  // The Mini App presenter and the loopback listeners resolve here, and only
  // here: the runtime's presenter port lives in the runtime package and the
  // implementation lives in the server package, which may not import each other,
  // so this file — outside the layer system — is what joins them. The listeners
  // go to both the operation registry and the service, which closes them on the
  // way down.
  const miniAppPresenter = createMiniAppPresenter({});
  const miniappProxies = createMiniAppProxyRegistry();
  const assembled = await createWebuiRuntimeHost({
    dataDir,
    appVersion: "webui-dev",
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
  // The registry and the terminal port are assembled here, by the host, and the
  // network service binds what it was handed (T14). The manager itself belongs to
  // this service's resource scope — one per service, not a host-wide singleton
  // (T15) — and the service ends every PTY it owns in `close()`.
  const terminal = new WebuiTerminalManager();
  // The adapter is absent when the host cannot answer the browser
  // authorization at all, and the browser operations then stay unregistered.
  //
  // The bridge's pairings follow the switches, so the persisted authorization
  // has to reach them before the service starts serving.
  await browser.initialize();
  const service = new WebuiService({
    port,
    operations: createOperationRegistry(port, terminal, browser.port, browserBridge, miniappProxies, miniAppPresenter),
    terminal,
    tcpPort,
    dev: true,
    clientDir,
    browserBridge,
    // The service closes every Mini App proxy on the way down; a leaked listener
    // holds a plugin's derived port, which would make that Mini App unstartable.
    miniappProxies,
  });
  const info = await service.start();
  console.log(`[webui] server listening at ${info.boundUrl}`);
  const close = async () => {
    await service.close();
    await browser.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}
