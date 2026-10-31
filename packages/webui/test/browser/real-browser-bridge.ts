// The real-browser bridge harness.
//
// The acceptance needs a browser with the built extension loaded, a bridge
// server the extension can reach, and a way to provision the extension the way
// a person does. Both the handshake acceptance and the external-behaviour
// acceptance need the same machinery, so it lives here rather than being
// written twice.

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Duplex } from "node:stream";

import { chromium, type BrowserContext, type Worker } from "@playwright/test";

import {
  BrowserBridgeServer,
  createInMemorySecureCredentialStore,
} from "../../src/server/browser-bridge/index.js";

const run = promisify(execFile);

// The spec lives at packages/webui/test/browser/, so the repository root is
// four levels up from the file's directory.
const repoRoot = resolve(new URL("../../../..", import.meta.url).pathname);
const extensionDist = join(repoRoot, "packages/browser-extension/dist");

/** The storage keys the extension keeps its configuration under. */
export const ORIGIN_STORAGE_KEY = "webui.browserBridge.origin";
export const INSTALLATION_KEY_STORAGE_KEY = "webui.browserBridge.installationKey.v1";

/** How long to wait for the extension to connect before calling it a failure. */
export const CONNECT_TIMEOUT_MS = 20_000;

/**
 * The slice of the extension API the harness uses.
 *
 * The callbacks are serialized and run inside the extension's service worker,
 * where `chrome` exists; the WebUI's test tsconfig does not carry the
 * extension's ambient types.
 */
declare const chrome: {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
    session: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
  runtime: { reload(): Promise<void>; sendMessage(message: unknown): Promise<unknown> };
};

/**
 * Builds the extension.
 *
 * The source directory is not loadable: a browser extension runtime executes
 * JavaScript only, and the source manifest points the service worker at a
 * `.ts` file. The build is what a browser can actually run.
 *
 * A store build is a different artefact, not a different flag on the same one:
 * it embeds the store's public key, so its identity is fixed by that key
 * rather than by the path it is loaded from. It is built into its own
 * directory so the two builds cannot overwrite one another.
 */
export async function buildExtension(
  options: {
    readonly store?: "chrome" | "edge";
    /** The directory to build into, relative to the extension package. */
    readonly out?: string;
    /** The store's public key, for a store build. */
    readonly publicKey?: string;
  } = {},
): Promise<void> {
  const args = ["--filter", "@mavis/browser-extension", "build"];
  if (options.store) args.push("--store", options.store);
  if (options.out) args.push("--out", options.out);
  await run("pnpm", args, {
    cwd: repoRoot,
    timeout: 120_000,
    env: options.store && options.publicKey
      ? {
          ...process.env,
          [`MAVIS_BROWSER_STORE_${options.store.toUpperCase()}_PUBLIC_KEY`]: options.publicKey,
        }
      : process.env,
  });
}

/** The extension's id, read off the service worker's URL. */
function extensionIdOf(worker: Worker): string {
  const match = /^chrome-extension:\/\/([a-p]{32})\//u.exec(worker.url());
  if (!match) throw new Error(`unexpected service worker url: ${worker.url()}`);
  return match[1]!;
}

/**
 * A wait that must not be able to outlive its case.
 *
 * The harness talks to a browser extension, and several of those interactions
 * have no deadline of their own: a service worker that Chrome has reclaimed
 * does not answer, and a message nobody replies to does not settle. A wait
 * that hangs there does not fail the case — it runs into Playwright's own
 * timeout, and the report says only that the test timed out, with nothing
 * about which step stopped.
 *
 * So every wait in this file that can outlive its case is bounded here, and
 * the message names the step that stopped. The bound is generous enough for a
 * slow machine: the Edge handshake takes 22.6 s on a CI runner.
 */
async function bounded<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The losing promise is still pending when the race is decided, and it may
  // reject later; nothing is waiting for it, so its rejection is absorbed
  // here rather than surfacing as an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not finish within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Launches a browser with the built extension loaded.
 *
 * The id of an unpacked extension is derived from its load path, so it is
 * stable for this directory — but it is read at runtime rather than
 * hard-coded, because a different path means a different id and a hard-coded
 * one would silently stop matching the allowlist.
 *
 * A store build is loaded from its own directory, and its id is the one the
 * store's public key determines rather than the one the path determines.
 */
export async function launchWithExtension(
  channel: "msedge" | "chromium",
  options: { readonly dist?: string } = {},
): Promise<{
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  profileDir: string;
}> {
  const profileDir = await mkdtemp(join(tmpdir(), "webui-bridge-real-"));
  const dist = options.dist ?? extensionDist;
  const context = await bounded(
    `the ${channel} browser did not start`,
    60_000,
    chromium.launchPersistentContext(profileDir, {
      headless: true,
      // "chromium" is the bundled browser and "msedge" is the installed Edge.
      // The extension is one package for both, and the only thing that differs
      // is the browser it runs in.
      channel,
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    }),
  );
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await bounded(
      `the ${channel} browser did not start the extension's service worker`,
      60_000,
      context.waitForEvent("serviceworker", { timeout: 30_000 }),
    );
  }
  return { context, worker, extensionId: extensionIdOf(worker), profileDir };
}

/**
 * Closes the browser, with a bound.
 *
 * A browser that will not close is a browser that has stopped answering, and
 * the cleanup must not be the thing that hangs the case: a case that fails in
 * its cleanup reports the cleanup, not the step that broke.
 */
export async function closeBrowser(context: BrowserContext): Promise<void> {
  await bounded("the browser did not close", 30_000, context.close());
}

/**
 * Whether this machine has the browser a case needs.
 *
 * The bundled Chromium is installed by the gate itself, so it is always
 * there. **Edge is not**: the acceptance drives the *installed* Edge, and a
 * machine without it — a CI image that does not ship it, a developer's
 * container — cannot run the Edge cases at all. Those cases skip with the
 * reason, rather than failing on a browser that was never there.
 *
 * The acceptance record names the browser each case ran in, and the published
 * matrix names the host, so a skipped case is visible rather than silent.
 */
export async function isBrowserInstalled(channel: "msedge" | "chromium"): Promise<boolean> {
  if (channel === "chromium") return true;
  const { access } = await import("node:fs/promises");
  for (const candidate of [
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/opt/microsoft/msedge/msedge",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]) {
    try {
      await access(candidate);
      return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

/**
 * The browser's own version.
 *
 * Read from the browser rather than assumed: an acceptance record that says
 * "Chrome" without saying which Chrome is not a record.
 */
export function browserVersionOf(context: BrowserContext): string {
  return context.browser()?.version() ?? "unknown";
}

/**
 * The configuration a bridge case ran under, read from the bridge.
 *
 * The switch states come from the bridge's own snapshot, so the record says
 * what was in force rather than what the test intended. The two switches the
 * bridge does not carry are named as such rather than guessed at: the
 * isolated-Chromium switch belongs to the runtime, and the Full CDP switch is
 * enforced in the runtime service, not in the bridge.
 */
export function bridgeSettings(
  bridge: BrowserBridgeServer,
  surface: "edge" | "chrome",
  allowlist: string,
): Readonly<Record<string, unknown>> {
  const surfaces = bridge.snapshot().surfaces;
  const other = surface === "edge" ? "chrome" : "edge";
  return {
    surface,
    surfaceSwitch: surfaces[surface].enabled,
    otherSurfaceSwitch: surfaces[other].enabled,
    isolatedChromium: "not carried by the bridge",
    fullCdp: "enforced in the runtime service, not in the bridge",
    allowlist,
  };
}

/**
 * Provisions the extension and wakes its service worker.
 *
 * The worker reads the host's address when it starts and exits if there is
 * none, so the storage has to be written *before* the worker next runs. The
 * reconnect message then wakes it, which is what a person pasting into the
 * options page amounts to.
 */
export async function provision(
  worker: Worker,
  context: BrowserContext,
  extensionId: string,
  origin: string,
  installationKey: string | undefined,
): Promise<void> {
  await bounded(
    "the extension's service worker did not accept the host's address",
    30_000,
    worker.evaluate(
      async ({ originKey, keyKey, secret, host }) => {
        // The host is passed in by name. A bare `origin` here would resolve to
        // the *extension's* origin — a service worker has one — and the
        // extension would then try to connect to itself.
        await chrome.storage.local.set({ [originKey]: host });
        if (secret) {
          await chrome.storage.local.set({ [keyKey]: { secret } });
        } else {
          await chrome.storage.local.remove(keyKey);
        }
      },
      {
        originKey: ORIGIN_STORAGE_KEY,
        keyKey: INSTALLATION_KEY_STORAGE_KEY,
        secret: installationKey,
        host: origin,
      },
    ),
  );
  // The message has to come from a *page* — a message sent by the worker is not
  // delivered to the worker's own listener.
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await bounded(
      "the extension did not answer the reconnect message",
      60_000,
      page.evaluate(
        (type) => chrome.runtime.sendMessage({ type }),
        "webui-bridge-reconnect",
      ),
    );
  } finally {
    await page.close();
  }
}

/**
 * The page the external acceptance drives.
 *
 * It is served over `http://127.0.0.1` rather than as a `data:` URL, because
 * the extension's target registry **deliberately** leaves policy-blocked URLs
 * out — and a `data:` URL is one of them. That is the extension behaving
 * correctly: a page the browser refuses to expose is not a target.
 */
export const BRIDGE_TEST_PAGE_HTML = [
  "<!doctype html><title>idle</title>",
  "<input id='field' type='text' autofocus>",
  "<script>",
  "const field = document.getElementById('field');",
  "field.addEventListener('input', (event) => {",
  "  document.title = 'text:' + event.target.value;",
  "});",
  "</script>",
].join("\n");

/**
 * Starts the bridge behind an HTTP server the harness owns.
 *
 * `packaged: true` makes the host read the **store** allowlist instead of the
 * development one, which is what a packaged production entry does. The two
 * are different configurations, and the difference is the point: a packaged
 * host must not accept a development identity.
 *
 * `allowlist` says which variable the id is written into. It is separate from
 * `packaged` on purpose: the interesting case is a packaged host whose
 * development allowlist names the extension — that is the configuration a
 * packaged build has to refuse.
 */
export async function startBridge(
  extensionId: string,
  surface: "edge" | "chrome",
  options: {
    readonly packaged?: boolean;
    readonly allowlist?: "store" | "development" | "both";
  } = {},
): Promise<{
  bridge: BrowserBridgeServer;
  origin: string;
  pageUrl: string;
  close: () => Promise<void>;
}> {
  const allowlist = options.allowlist ?? (options.packaged ? "store" : "development");
  const variable = (kind: "store" | "development", browser: "edge" | "chrome"): string =>
    kind === "store"
      ? `MAVIS_BROWSER_STORE_${browser.toUpperCase()}_EXTENSION_IDS`
      : `MAVIS_BROWSER_${browser.toUpperCase()}_EXTENSION_IDS`;
  const env: Record<string, string> =
    allowlist === "both"
      ? {
          [variable("development", "edge")]: extensionId,
          [variable("development", "chrome")]: extensionId,
        }
      : { [variable(allowlist, surface)]: extensionId };
  const bridge = new BrowserBridgeServer({
    host: "127.0.0.1",
    dev: true,
    ...(options.packaged ? { packaged: true } : {}),
    credentialStore: createInMemorySecureCredentialStore(),
    // The allowlist is per surface, and so is the pairing. A browser running
    // the extension has to be admitted on **its own** surface, or the Edge
    // run would prove nothing about the Edge switch.
    env,
  });
  await bridge.start();
  await bridge.enableSurface(surface);
  // With one identity on both surfaces, both surfaces are switched on: that is
  // the configuration the collision case is about.
  if (allowlist === "both" && surface !== "chrome") await bridge.enableSurface("chrome");

  const http = createServer((request, response) => {
    // The query string is ignored: the harness serves the same page whatever
    // the caller appends.
    if (request.url?.startsWith("/test-page")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(BRIDGE_TEST_PAGE_HTML);
      return;
    }
    response.writeHead(426).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    bridge.handleUpgrade(request, socket, head);
  });
  return {
    bridge,
    // The extension takes the loopback origin in its http form and converts
    // it to ws, the way the WebUI's own workspace-file URL does. It also
    // appends the bridge path itself, so the origin must not carry one.
    origin: `http://127.0.0.1:${port}`,
    // A real http page the extension will report as a target.
    pageUrl: `http://127.0.0.1:${port}/test-page`,
    close: async () => {
      await bounded("the bridge did not close", 30_000, bridge.close());
      // The browser is still running while the harness closes its server, so
      // the browser may still be holding a connection: the extension's socket,
      // or the keep-alive connection the test page was fetched over. A server
      // that waits for a client to go away first cannot close while that
      // client is still running — so the connections are cut here instead.
      http.closeAllConnections();
      await bounded(
        "the bridge's http server did not close",
        30_000,
        new Promise<void>((resolve) => http.close(() => resolve())),
      );
    },
  };
}

export async function waitForConnected(
  bridge: BrowserBridgeServer,
  surface: "edge" | "chrome",
  connected: boolean,
  worker?: Worker,
): Promise<void> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (bridge.snapshot().surfaces[surface].connected === connected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Both sides record what they thought happened; without them a failure here
  // says only "not connected", which is not a diagnosis.
  const snapshot = bridge.snapshot().surfaces[surface];
  const lastError = worker
    ? await bounded(
        "the extension's last error could not be read",
        10_000,
        worker.evaluate(() => chrome.storage.session.get("webui.browserBridge.lastError")),
      ).catch(() => undefined)
    : undefined;
  throw new Error(
    `the surface did not reach connected=${connected}: host=${JSON.stringify(snapshot)} extension=${JSON.stringify(lastError)}`,
  );
}
