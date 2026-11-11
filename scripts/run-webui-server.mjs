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
  // The child owns the shutdown. It runs in this process group, so the
  // terminal's Ctrl+C reaches it directly, and the parent must not die first:
  // a parent that exits while the child lives leaves the server orphaned. It
  // keeps the port bound and keeps logging, so the next start fails on an
  // address nobody released — and the person is told the restart happened
  // when it did not.
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    // A child that cannot stop itself must not keep the parent alive either:
    // the whole point of the signal is that the port comes back.
    const force = setTimeout(() => child.kill("SIGKILL"), 20_000);
    force.unref?.();
    child.on("exit", () => clearTimeout(force));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
} else {
  const os = await import("node:os");
  const path = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const { createWebuiRuntimeHost, createHarnessPortFromHost, createBrowserAdapter, WebuiTerminalManager } =
    await import("../packages/webui/src/runtime/index.ts");
  const {
    WebuiService,
    createOperationRegistry,
    createMiniAppProxyRegistry,
    createMiniAppPresenter,
    createWebuiCredential,
  } = await import("../packages/webui/src/server/index.ts");
  const { BrowserBridgeServer, WebuiBrowserExtensionPackage } =
    await import("../packages/webui/src/server/browser-bridge/index.ts");
  const dataDir =
    process.env.MINIMAX_DATA_DIR?.trim() || path.join(os.homedir(), ".minimax");
  const tcpPort = Number(process.env.WEBUI_SERVER_PORT ?? 2233);
  // The port every Mini App is published on: one port for all of them, so a
  // Mini App that arrives in the store does not ask for another port forward.
  const miniappPort = Number(process.env.WEBUI_MINIAPP_PORT ?? 49152);
  // The address the service binds to. Loopback is the default; a wider
  // address publishes the WebUI beyond this machine, which ADR 0031 allows
  // and gates: a request that did not arrive over loopback presents the
  // per-start credential, so the printed URL carries it.
  const bindHost = process.env.WEBUI_HOST?.trim() || "127.0.0.1";
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
  //
  // The development host does not need that allowlist at all: it learns the
  // identity of an extension from the extension itself, once that extension
  // has proved the surface's installation key, and remembers it under the
  // data directory. An unpacked build's id is derived from the folder it was
  // loaded from, so it differs on every machine, and asking the person to
  // name it is asking for something they cannot know.
  /**
   * The extension build this host speaks to.
   *
   * The peer announces its own version in the handshake, and the two are
   * compared when a command comes back unanswered: an extension older than
   * this build cannot read the frames this build sends and hangs up rather
   * than refusing them, so the version is what lets the host say "your
   * extension is older than this build" instead of "it timed out".
   */
  function readExtensionVersion() {
    try {
      const manifest = JSON.parse(
        readFileSync(
          new URL("../packages/browser-extension/manifest.json", import.meta.url),
          "utf8",
        ),
      );
      return typeof manifest.version === "string" && manifest.version.trim()
        ? manifest.version.trim()
        : undefined;
    } catch {
      // A host with no extension package has no version to hold the peer to.
      return undefined;
    }
  }
  const extensionVersion = readExtensionVersion();
  const browserBridge = new BrowserBridgeServer({
    host: "127.0.0.1",
    dev: true,
    dataDir,
    ...(extensionVersion ? { expectedExtensionVersion: extensionVersion } : {}),
  });
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
  // The credential is created here because two listeners need it: the WebUI
  // service, which issues it, and the Mini App proxies, which ask for it when
  // they are bound beyond loopback (ADR 0031).
  const credential = createWebuiCredential();
  const miniappProxies = createMiniAppProxyRegistry({
    host: bindHost,
    port: miniappPort,
    credential,
  });
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
    host: bindHost,
    tcpPort,
    credential,
    dev: true,
    clientDir,
    browserBridge,
    // The person downloads the extension from Settings, and the package has to
    // be the one this host speaks to: the sources are here, so the build is
    // redone when they are newer than what was built.
    browserExtensionPackage: new WebuiBrowserExtensionPackage({
      packageDir: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../packages/browser-extension",
      ),
      scratchDir: path.join(dataDir, "tmp"),
    }),
    // The service closes every Mini App proxy on the way down; a leaked listener
    // holds a plugin's derived port, which would make that Mini App unstartable.
    miniappProxies,
    // The standalone host owns the process; HTTP shutdown uses the same
    // bounded cleanup as Ctrl+C. Repeated requests do not force a second exit.
    requestShutdown: () => {
      if (!stopping) shutdown();
    },
  });
  const close = async () => {
    await service.close();
    await browser.close();
  };
  // Ctrl+C has to end the process, and it has to be bounded. The close is
  // graceful — the extensions get their `closed` frame and the listeners are
  // released — but a peer that never answers, or a handle that never drains,
  // must not keep the port bound. A server that cannot be stopped is a server
  // that cannot be restarted, and the next start fails on the address it
  // still holds.
  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      // The second signal is the person saying they meant it.
      process.exit(130);
    }
    stopping = true;
    const force = setTimeout(() => process.exit(130), 15_000);
    force.unref?.();
    void close().then(
      () => {
        clearTimeout(force);
        process.exit(0);
      },
      () => {
        clearTimeout(force);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Register cleanup before accepting a shutdown request from the page.
  const info = await service.start();
  // The Mini App listener is bound before the first Mini App opens, so the
  // runtime cannot take this port for one of its own Mini Apps first.
  await miniappProxies.prepare();
  console.log(`[webui] server listening at ${info.boundUrl}`);
  console.log(`[webui] Mini App port: ${miniappPort}`);
  printAccess(info, bindHost);

  /**
   * The path a person opens, with the per-start credential on it.
   *
   * The token is not decoration: a request that did not arrive over loopback
   * has to present it, so the printed path is the one that works from every
   * address the service answers at.
   */
  function accessUrl(host, port, token) {
    const literal = host.includes(":") ? `[${host}]` : host;
    return `http://${literal}:${port}/?token=${token}`;
  }

  /**
   * Print how to reach the service.
   *
   * A loopback bind is one address; a wildcard bind is every address this
   * machine has. Either way the printed path carries the credential.
   */
  function printAccess(info, bindHost) {
    const port = info.tcpPort;
    const token = info.credential.token;
    console.log(`[webui] credential token: ${token}`);
    if (isWildcardBindAddress(bindHost)) {
      console.log(`[webui] open ${accessUrl("127.0.0.1", port, token)}`);
      const addresses = lanAddresses();
      if (addresses.length === 0) {
        console.log("[webui] no LAN address found; set WEBUI_HOST to the address to publish.");
      }
      for (const address of addresses) {
        console.log(`[webui] open ${accessUrl(address, port, token)}`);
      }
      return;
    }
    console.log(`[webui] open ${accessUrl(bindHost, port, token)}`);
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
}
