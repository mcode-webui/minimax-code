// The adversarial cases the acceptance matrix names.
//
// A bridge that only meets well-behaved peers proves nothing about the peers
// that are not well-behaved. These are the cases a person on the other side
// of the socket can produce on purpose, and each one has an answer:
//
//   * an **oversized frame** — the socket is closed, and the host survives it;
//   * a **malformed frame** — the socket is closed, and the host survives it;
//   * a **duplicate connection** from the same extension — the earlier session
//     is replaced rather than left alive beside the newer one;
//   * a **revocation while an action is in flight** — the action fails
//     instead of hanging or completing.
//
// The host surviving is the point of the first two: a bridge that fell over
// on one bad frame would be a bridge anybody could take down.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  BrowserBridgeServer,
  createInMemorySecureCredentialStore,
} from "../../src/server/browser-bridge/index.js";
import { WebuiWebSocketServer } from "../../src/server/websocket-server.js";
import { WEBUI_BROWSER_BRIDGE_PATH } from "../../src/shared/contracts/browser-bridge.js";
import { createWebuiCredential } from "../../src/server/credentials.js";

const EDGE_EXTENSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
const BROWSER_ID = "edge-instance-1";
const TARGET_ID = "TAB-1";

interface Harness {
  readonly bridge: BrowserBridgeServer;
  readonly httpServer: Server;
  readonly wsServer: WebuiWebSocketServer;
  readonly port: number;
  close(): Promise<void>;
}

const openHarnesses: Harness[] = [];

afterEach(async () => {
  while (openHarnesses.length > 0) {
    await openHarnesses.pop()?.close();
  }
});

async function startHarness(
  options: {
    readonly maxMessageBytes?: number;
    /**
     * Which allowlists carry the extension's identity.
     *
     * `both` is the configuration a person ends up in for real: an unpacked
     * build has one identity, and loading it in Edge and Chrome means the
     * same identity is listed on both surfaces.
     */
    readonly allowlist?: "edge" | "both";
  } = {},
): Promise<Harness> {
  const bridge = new BrowserBridgeServer({
    host: "127.0.0.1",
    dev: true,
    credentialStore: createInMemorySecureCredentialStore(),
    env:
      options.allowlist === "both"
        ? {
            MAVIS_BROWSER_EDGE_EXTENSION_IDS: EDGE_EXTENSION_ID,
            MAVIS_BROWSER_CHROME_EXTENSION_IDS: EDGE_EXTENSION_ID,
          }
        : { MAVIS_BROWSER_EDGE_EXTENSION_IDS: EDGE_EXTENSION_ID },
    ...(options.maxMessageBytes ? { maxMessageBytes: options.maxMessageBytes } : {}),
  });
  await bridge.start();
  await bridge.enableSurface("edge");
  if (options.allowlist === "both") await bridge.enableSurface("chrome");
  const httpServer = createServer();
  const wsServer = new WebuiWebSocketServer({
    maxMessageBytes: options.maxMessageBytes ?? 256 * 1024,
    heartbeatIntervalMs: 15_000,
    host: "127.0.0.1",
    boundTcpPort: () => (httpServer.address() as AddressInfo | null)?.port,
    credential: createWebuiCredential(),
    dev: true,
    operations: new Map(),
    isAccepting: () => true,
    browserBridge: bridge,
  });
  httpServer.on("upgrade", wsServer.handleUpgrade);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const harness: Harness = {
    bridge,
    httpServer,
    wsServer,
    port: (httpServer.address() as AddressInfo).port,
    close: async () => {
      await bridge.close();
      wsServer.closeConnections();
      await wsServer.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
  openHarnesses.push(harness);
  return harness;
}

interface BridgeFrame {
  readonly kind: string;
  readonly [key: string]: unknown;
}

interface BridgeClient {
  readonly socket: WebSocket;
  readonly frames: BridgeFrame[];
  readonly opened: Promise<void>;
  readonly closed: Promise<{ readonly code: number }>;
  waitFor<T extends object>(kind: string, timeoutMs?: number): Promise<T & BridgeFrame>;
}

function connectClient(harness: Harness): BridgeClient {
  const frames: BridgeFrame[] = [];
  const socket = new WebSocket(
    `ws://127.0.0.1:${harness.port}${WEBUI_BROWSER_BRIDGE_PATH}`,
    { headers: { origin: `chrome-extension://${EDGE_EXTENSION_ID}/` } },
  );
  socket.on("message", (data) => {
    try {
      frames.push(JSON.parse(String(data)) as BridgeFrame);
    } catch {
      // Not a bridge frame; the session reports that itself.
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`upgrade refused with ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
  const closed = new Promise<{ readonly code: number }>((resolve) => {
    socket.once("close", (code) => resolve({ code }));
  });
  const waitFor = async <T extends object>(
    kind: string,
    timeoutMs = 4_000,
  ): Promise<T & BridgeFrame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames.find((frame) => frame.kind === kind);
      if (found) return found as T & BridgeFrame;
      if (Date.now() > deadline) throw new Error(`timed out waiting for a "${kind}" frame`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  };
  return { socket, frames, opened, closed, waitFor };
}

/**
 * Connect as an allowed extension and complete the handshake.
 *
 * The credential the host already issued is used, so the peer is admitted
 * without the installation key exchange.
 */
async function pairEdge(
  harness: Harness,
  options: { readonly browser?: "edge" | "chrome" } = {},
): Promise<BridgeClient> {
  const browser = options.browser ?? "edge";
  const client = connectClient(harness);
  await client.opened;
  client.socket.send(
    JSON.stringify({
      kind: "hello",
      browser,
      browserId: BROWSER_ID,
      extensionVersion: "1.0.0",
    }),
  );
  const pairing = harness.bridge.pairings.get(browser);
  if (!pairing) throw new Error(`no ${browser} pairing`);
  const challenge = await client.waitFor<{ nonce: string; keyId: string }>("challenge");
  const signature = await pairing.signProof(challenge.nonce);
  client.socket.send(
    JSON.stringify({ kind: "proof", keyId: challenge.keyId, nonce: challenge.nonce, signature }),
  );
  await client.waitFor("ready");
  await settle();
  return client;
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
};

function announceTarget(client: BridgeClient, generation: number): void {
  client.socket.send(
    JSON.stringify({
      kind: "targets",
      targets: [
        {
          browserId: BROWSER_ID,
          targetId: TARGET_ID,
          title: "Example",
          url: "https://example.com/",
          generation,
        },
      ],
    }),
  );
}

describe("the browser bridge, against an adversarial peer", () => {
  it("closes an oversized frame and stays healthy", async () => {
    const harness = await startHarness({ maxMessageBytes: 4 * 1024 });
    const attacker = connectClient(harness);
    await attacker.opened;

    // Far past the limit the host declares.
    attacker.socket.send("x".repeat(64 * 1024));

    // The host closes it rather than reading it.
    const close = await attacker.closed;
    expect(close.code).toBeGreaterThan(0);

    // The host is still serving: a well-behaved peer still pairs.
    const client = await pairEdge(harness);
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(true);
    client.socket.terminate();
  });

  it("closes a malformed frame and stays healthy", async () => {
    const harness = await startHarness();
    const attacker = connectClient(harness);
    await attacker.opened;

    // Not JSON at all.
    attacker.socket.send("this is not a bridge frame");

    const close = await attacker.closed;
    expect(close.code).toBeGreaterThan(0);

    // The host is still serving.
    const client = await pairEdge(harness);
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(true);
    client.socket.terminate();
  });

  it("replaces the earlier session when the same extension connects again", async () => {
    const harness = await startHarness();
    const first = await pairEdge(harness);
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(true);

    // The same extension, connecting again. The second connection is the live
    // one; the first must not be left alive beside it, or the host would have
    // two sessions answering for one browser.
    const second = await pairEdge(harness);
    const firstClosed = await first.closed;
    expect(firstClosed.code).toBeGreaterThan(0);

    // The surface is still live, and it is the new session that holds it.
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(true);
    const provider = harness.bridge.createProvider("edge");
    expect(provider).toBeDefined();
    second.socket.terminate();
  });

  it("fails an action that was in flight when the credential was revoked", async () => {
    const harness = await startHarness();
    const client = await pairEdge(harness);
    announceTarget(client, 1);
    await settle();

    const provider = harness.bridge.createProvider("edge");
    expect(provider).toBeDefined();
    const targets = await provider!.listTargets();
    expect(targets).toHaveLength(1);

    // A command the peer never answers. It is in flight when the revocation
    // lands, so it has to fail rather than hang.
    const inFlight = provider!.sendCommand(targets[0]!.id, "Runtime.evaluate", {
      expression: "1",
      returnByValue: true,
    });
    await settle();

    // The switch goes off: the credential is revoked and the sessions close.
    await harness.bridge.disableSurface("edge");

    await expect(inFlight).rejects.toBeDefined();
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(false);
    client.socket.terminate();
  });

  it("puts each browser on its own surface when one identity is listed on both", async () => {
    // The configuration a person ends up in for real: an unpacked build has one
    // identity, and loading it in Edge and Chrome lists that identity on both
    // surfaces. The identity alone cannot say which browser is connecting, so
    // the peer names the browser it runs in and the host answers with that
    // surface's pairing. Taking the first match instead would put the Chrome
    // browser on the Edge pairing, and report the Edge surface as connected
    // while the person is looking at Chrome.
    const harness = await startHarness({ allowlist: "both" });
    const edge = await pairEdge(harness, { browser: "edge" });
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(true);
    expect(harness.bridge.snapshot().surfaces.chrome.connected).toBe(false);

    const chrome = await pairEdge(harness, { browser: "chrome" });
    expect(harness.bridge.snapshot().surfaces.chrome.connected).toBe(true);
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(true);

    // Each surface's provider belongs to that surface.
    expect(harness.bridge.createProvider("chrome")?.surface).toBe("chrome");
    expect(harness.bridge.createProvider("edge")?.surface).toBe("edge");
    edge.socket.terminate();
    chrome.socket.terminate();
  });

  it("refuses a peer that names a browser this host does not admit", async () => {
    // The chrome surface is not configured here, so a peer that says it is
    // Chrome is refused rather than attached to the Edge pairing.
    const harness = await startHarness();
    const client = connectClient(harness);
    await client.opened;
    client.socket.send(
      JSON.stringify({
        kind: "hello",
        browser: "chrome",
        browserId: BROWSER_ID,
        extensionVersion: "1.0.0",
      }),
    );

    const closed = await client.waitFor<{ reason: string }>("closed", 5_000);
    expect(closed.reason).toContain("not registered on this host");
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(false);
    expect(harness.bridge.snapshot().surfaces.chrome.connected).toBe(false);
    client.socket.terminate();
  });

  it("refuses a peer that names a browser it cannot prove", async () => {
    // The name in the `hello` frame selects *which* secret the peer has to
    // prove; it does not stand in for the proof. A peer that calls itself
    // Edge and answers the Edge challenge with the Chrome surface's
    // installation key is refused, because the Edge pairing checks the Edge
    // surface's own key.
    const harness = await startHarness({ allowlist: "both" });
    const client = connectClient(harness);
    await client.opened;
    client.socket.send(
      JSON.stringify({
        kind: "hello",
        browser: "edge",
        browserId: BROWSER_ID,
        extensionVersion: "1.0.0",
      }),
    );
    const challenge = await client.waitFor<{ nonce: string }>("challenge", 5_000);
    // The Chrome pairing's installation key, answering an Edge challenge.
    const chrome = harness.bridge.pairings.get("chrome");
    if (!chrome) throw new Error("no chrome pairing");
    const signature = await chrome.signInstallationKeyProof(challenge.nonce);
    const chromeKeyId = chrome.installationKeyId;
    client.socket.send(
      JSON.stringify({
        kind: "proof",
        keyId: chromeKeyId,
        nonce: challenge.nonce,
        signature,
      }),
    );

    const closed = await client.waitFor<{ reason: string }>("closed", 5_000);
    // The Edge pairing does not hold the Chrome installation key, so the
    // proof cannot be answered with it — whatever the peer called itself.
    expect(closed.reason).toContain("a key this host does not hold for this surface");
    // And no surface took the connection.
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(false);
    expect(harness.bridge.snapshot().surfaces.chrome.connected).toBe(false);
    client.socket.terminate();
  });

  it("refuses a second browser on a surface that is already served", async () => {
    // A surface is one browser: the panel and the Agent's tools have one
    // provider per surface, so a second live session would be a browser the
    // host could not address. The session that is already live keeps it.
    const harness = await startHarness();
    const first = await pairEdge(harness);
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(true);

    const second = connectClient(harness);
    await second.opened;
    second.socket.send(
      JSON.stringify({
        kind: "hello",
        browser: "edge",
        browserId: "edge-instance-2",
        extensionVersion: "1.0.0",
      }),
    );
    const pairing = harness.bridge.pairings.get("edge");
    if (!pairing) throw new Error("no edge pairing");
    const challenge = await second.waitFor<{ nonce: string; keyId: string }>("challenge", 5_000);
    const signature = await pairing.signProof(challenge.nonce);
    second.socket.send(
      JSON.stringify({ kind: "proof", keyId: challenge.keyId, nonce: challenge.nonce, signature }),
    );

    const closed = await second.waitFor<{ reason: string }>("closed", 5_000);
    expect(closed.reason).toContain("already served by another browser");
    // The first browser still holds the surface.
    expect(harness.bridge.snapshot().surfaces.edge.connected).toBe(true);
    first.socket.terminate();
    second.socket.terminate();
  });
});
