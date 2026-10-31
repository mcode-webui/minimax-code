// The dedicated `/browser-bridge` upgrade branch.
//
// This file is the headline proof for F3: the bridge is reachable from the
// running WebUI's upgrade path, AND the generic path's development-mode
// bypass provably does not admit an unauthenticated extension. Both
// composition roots run with `dev: true`, so a bypass here would hand every
// Browser Use call to any unpacked extension during a mis-served dev cycle.
//
// The harness stands up the real chain the composition root builds — an
// `http.Server`, the production `WebuiWebSocketServer` with the bridge in its
// context, and the real `BrowserBridgeServer` — so the branch under test is
// the one that ships, not a re-implementation of it.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  BrowserBridgeServer,
  createInMemorySecureCredentialStore,
  exportWebuiBrowserBridgeEcdhPublicKey,
  generateWebuiBrowserBridgeEcdhKeyPair,
  type WebuiBrowserBridgeEcdhPublicKey,
} from "../../src/server/browser-bridge/index.js";
import { WebuiWebSocketServer } from "../../src/server/websocket-server.js";
import { WEBUI_BROWSER_BRIDGE_PATH } from "../../src/shared/contracts/browser-bridge.js";
import { createWebuiCredential } from "../../src/server/credentials.js";

const KNOWN_EDGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
const KNOWN_CHROME_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba";
const UNKNOWN_EXTENSION_ID = "cccccccccccccccccccccccccccccccd";

interface Harness {
  readonly bridge?: BrowserBridgeServer;
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

function attachBridge(httpServer: Server, bridge: BrowserBridgeServer | undefined): WebuiWebSocketServer {
  const wsServer = new WebuiWebSocketServer({
    maxMessageBytes: 256 * 1024,
    heartbeatIntervalMs: 15_000,
    host: "127.0.0.1",
    boundTcpPort: () => (httpServer.address() as AddressInfo | null)?.port,
    credential: createWebuiCredential(),
    dev: true,
    operations: new Map(),
    isAccepting: () => true,
    ...(bridge ? { browserBridge: bridge } : {}),
  });
  httpServer.on("upgrade", wsServer.handleUpgrade);
  return wsServer;
}

async function startHarness(options?: {
  readonly dev?: boolean;
  readonly env?: Record<string, string>;
}): Promise<Harness & { readonly bridge: BrowserBridgeServer }> {
  const dev = options?.dev ?? true;
  const bridge = new BrowserBridgeServer({
    host: "127.0.0.1",
    dev,
    credentialStore: createInMemorySecureCredentialStore(),
    env: options?.env ?? { MAVIS_BROWSER_EDGE_EXTENSION_IDS: KNOWN_EDGE_ID },
  });
  await bridge.start();
  // The bridge does not switch a surface on by itself: the browser switches
  // own the pairings, and the service is where the two meet. A test switches
  // on exactly the surfaces its environment configures, which is what the
  // persisted switches do in a running host.
  const configuredEnv = options?.env ?? { MAVIS_BROWSER_EDGE_EXTENSION_IDS: KNOWN_EDGE_ID };
  if (configuredEnv.MAVIS_BROWSER_EDGE_EXTENSION_IDS) await bridge.enableSurface("edge");
  if (configuredEnv.MAVIS_BROWSER_CHROME_EXTENSION_IDS) await bridge.enableSurface("chrome");
  const httpServer = createServer();
  const wsServer = attachBridge(httpServer, bridge);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const harness = track({
    bridge,
    httpServer,
    wsServer,
    port: (httpServer.address() as AddressInfo).port,
    close: async () => {
      await bridge.close();
      wsServer.closeConnections();
      await wsServer.close();
      // A test that failed mid-handshake can leave a half-open socket; the
      // listener would otherwise wait for it for the platform TCP timeout.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  });
  return harness as Harness & { readonly bridge: BrowserBridgeServer };
}

function track(harness: Harness): Harness {
  openHarnesses.push(harness);
  return harness;
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
};

/**
 * Attempt one bridge upgrade and report how the host answered.
 *
 * `ws` surfaces a non-101 answer as `unexpected-response`, which is the
 * refusal carrying its status; a socket destroyed without one surfaces as
 * `error`. Both are refusals — the distinction is only which side spoke first.
 */
async function attemptUpgrade(
  port: number,
  headers: Record<string, string>,
  timeoutMs = 4_000,
): Promise<{ readonly refused: boolean; readonly status?: number }> {
  return await new Promise<{ readonly refused: boolean; readonly status?: number }>((resolve) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}${WEBUI_BROWSER_BRIDGE_PATH}`, {
      headers,
    });
    const finish = (result: { readonly refused: boolean; readonly status?: number }): void => {
      clearTimeout(timer);
      try {
        client.terminate();
      } catch {
        // already gone
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ refused: true }), timeoutMs);
    client.once("open", () => finish({ refused: false }));
    client.once("unexpected-response", (_request, response) => {
      finish({ refused: true, status: response.statusCode });
    });
    client.once("error", () => finish({ refused: true }));
  });
}

interface BridgeFrame {
  readonly kind: string;
  readonly [key: string]: unknown;
}

/** A real extension client that records every frame from the socket's birth. */
function connectClient(port: number, headers: Record<string, string>) {
  const frames: BridgeFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WEBUI_BROWSER_BRIDGE_PATH}`, { headers });
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
  return { socket, frames, opened, waitFor };
}

/** A public key for tests that don't care about pairing, just about the wire shape. */
async function bogusClientPublicKey(): Promise<WebuiBrowserBridgeEcdhPublicKey> {
  const { publicKey } = await generateWebuiBrowserBridgeEcdhKeyPair();
  return exportWebuiBrowserBridgeEcdhPublicKey(publicKey);
}

/** Connect, answer the challenge with the pairing's own secret, wait for ready. */
async function pairExtension(
  harness: Harness & { readonly bridge: BrowserBridgeServer },
  surface: "edge" | "chrome",
  browserId: string,
) {
  const extensionId = surface === "edge" ? KNOWN_EDGE_ID : KNOWN_CHROME_ID;
  const client = connectClient(harness.port, { origin: `chrome-extension://${extensionId}/` });
  await client.opened;
  client.socket.send(
    JSON.stringify({
      kind: "hello",
      browser: surface,
      browserId,
      extensionVersion: "1.0.0",
      publicKey: await bogusClientPublicKey(),
    }),
  );
  const pairing = harness.bridge.pairings.get(surface);
  if (!pairing) throw new Error(`no pairing for ${surface}`);
  const challenge = await client.waitFor<{ nonce: string; keyId: string }>("challenge");
  const signature = await pairing.signProof(challenge.nonce);
  client.socket.send(
    JSON.stringify({ kind: "proof", keyId: challenge.keyId, nonce: challenge.nonce, signature }),
  );
  return client;
}

describe("WebUI browser bridge — the dedicated upgrade branch", () => {
  // The headline: with the WebUI in development mode — which is how both
  // composition roots actually run — the bridge still refuses an extension
  // that has not proved anything. Each case is one way an unauthenticated
  // extension could try to get in.
  it("refuses every unauthenticated extension while the WebUI runs in dev mode", async () => {
    const harness = await startHarness({ dev: true });

    // A loopback HTTP page is what the generic path admits. Here it is not an
    // extension at all, so it is not admitted.
    const wrongOrigin = await attemptUpgrade(harness.port, { origin: "http://127.0.0.1:9999/" });
    expect(wrongOrigin.refused).toBe(true);
    expect(wrongOrigin.status).toBe(403);

    const noOrigin = await attemptUpgrade(harness.port, {});
    expect(noOrigin.refused).toBe(true);

    // A real `chrome-extension://` origin whose id is on nobody's allowlist.
    const unlistedExtension = await attemptUpgrade(harness.port, {
      origin: `chrome-extension://${UNKNOWN_EXTENSION_ID}/`,
    });
    expect(unlistedExtension.refused).toBe(true);
    expect(unlistedExtension.status).toBe(403);

    // A forged Host header is the shape of a DNS-rebinding attempt. The host
    // this service bound to is loopback; anything else is refused before the
    // origin is even read.
    const wrongHost = await attemptUpgrade(harness.port, {
      host: `evil.example.com:${harness.port}`,
      origin: `chrome-extension://${KNOWN_EDGE_ID}/`,
    });
    expect(wrongHost.refused).toBe(true);
    expect(wrongHost.status).toBe(403);

    // An extension that connects but cannot prove possession of the pairing
    // credential never receives `ready`, so it never becomes a live session.
    const client = connectClient(harness.port, {
      origin: `chrome-extension://${KNOWN_EDGE_ID}/`,
    });
    await client.opened;
    // A hello with a valid public key kicks the gated handshake. The
    // extension on this side is a fake that just answers the challenge —
    // the point of the test is what the host does with a WRONG proof.
    client.socket.send(
      JSON.stringify({
        kind: "hello",
        browser: "edge",
        browserId: "edge-bogus",
        extensionVersion: "1.0.0",
        publicKey: await bogusClientPublicKey(),
      }),
    );
    const challenge = await client.waitFor<{ nonce: string; keyId: string }>("challenge");
    client.socket.send(
      JSON.stringify({
        kind: "proof",
        keyId: challenge.keyId,
        nonce: challenge.nonce,
        signature: "not-a-valid-hmac",
      }),
    );
    await settle();
    expect(client.frames.map((frame) => frame.kind)).not.toContain("ready");
    expect(harness.bridge.createProvider("edge")).toBeUndefined();
    client.socket.terminate();
  });

  it("refuses a bridge upgrade with 404 when no bridge is wired", async () => {
    const httpServer = createServer();
    const wsServer = attachBridge(httpServer, undefined);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (httpServer.address() as AddressInfo).port;
    const result = await attemptUpgrade(port, { origin: `chrome-extension://${KNOWN_EDGE_ID}/` });
    expect(result.refused).toBe(true);
    expect(result.status).toBe(404);
    wsServer.closeConnections();
    await wsServer.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it("admits an allowed extension and reports ready after a valid proof", async () => {
    const harness = await startHarness({
      dev: true,
      env: { MAVIS_BROWSER_CHROME_EXTENSION_IDS: KNOWN_CHROME_ID },
    });
    const client = await pairExtension(harness, "chrome", "chrome-1");
    const ready = await client.waitFor<{ sessionId: string }>("ready");
    expect(ready.sessionId).toBeTruthy();
    await settle();
    expect(harness.bridge.createProvider("chrome")).toBeDefined();
    // Edge was never configured, so nothing may pair on it — an absent
    // allowlist fails closed rather than open.
    expect(harness.bridge.createProvider("edge")).toBeUndefined();
    const snapshot = harness.bridge.snapshot();
    expect(snapshot.surfaces.chrome.connected).toBe(true);
    expect(snapshot.surfaces.edge.configured).toBe(false);
    client.socket.terminate();
  });

  it("leaves a surface off when its extension allowlist is empty", async () => {
    const harness = await startHarness({ dev: true, env: {} });
    const snapshot = harness.bridge.snapshot();
    expect(snapshot.surfaces.edge.configured).toBe(false);
    expect(snapshot.surfaces.chrome.configured).toBe(false);
    // The pairing still holds its own minted credential, but no extension id
    // may use it, so admission has nothing to match.
    const refused = await attemptUpgrade(harness.port, {
      origin: `chrome-extension://${KNOWN_EDGE_ID}/`,
    });
    expect(refused.refused).toBe(true);
    expect(refused.status).toBe(403);
  });

  it("does not let a bridge path reach the generic bearer-token admission", async () => {
    const harness = await startHarness({ dev: false });
    // `dev: false` is the production posture: the generic path demands the
    // per-start bearer token. A bridge request must still be judged by the
    // bridge's own rules, never by that one — so an extension with a correct
    // id is judged on the pairing, and the page token is irrelevant either way.
    const refusedWithoutProof = await attemptUpgrade(harness.port, {
      origin: `chrome-extension://${KNOWN_EDGE_ID}/`,
    });
    expect(refusedWithoutProof.refused).toBe(false);
    const client = await pairExtension(harness, "edge", "edge-1");
    await client.waitFor("ready");
    await settle();
    expect(harness.bridge.createProvider("edge")).toBeDefined();
    client.socket.terminate();
  });
});

/**
 * The installation-key exchange, over a real socket.
 *
 * Finding N1: admission trusted the `Origin` header to pick an allowlisted
 * extension id, and the host then sealed its credential to whatever key the
 * peer's `hello` carried. Any local process could spoof that origin, mint its
 * own ECDH key, decrypt the credential and answer the challenge — so "the
 * origin is allowlisted" was doing no work.
 *
 * These tests are the wire-level counterpart. They open an actual `ws` socket
 * with the allowlisted origin, so what is asserted is what a real attacker
 * would observe: the frames that arrive, and the ones that never do.
 */
describe("WebUI browser bridge — the installation key gates the credential", () => {
  /** Hello with the allowlisted origin and a key the host will seal to. */
  async function sayHello(
    harness: Harness & { readonly bridge: BrowserBridgeServer },
    client: ReturnType<typeof connectClient>,
    browserId: string,
  ): Promise<void> {
    client.socket.send(
      JSON.stringify({
        kind: "hello",
        browser: "edge",
        browserId,
        extensionVersion: "1.0.0",
        publicKey: await bogusClientPublicKey(),
      }),
    );
  }

  it("sends no pair frame at all to a peer that cannot prove the installation key", async () => {
    const harness = await startHarness({ dev: true });
    const pairing = harness.bridge.pairings.get("edge")!;

    // The attacker: a local process that knows the allowlisted extension id,
    // spoofs the origin, and holds a secret of its own choosing.
    const client = connectClient(harness.port, {
      origin: `chrome-extension://${KNOWN_EDGE_ID}/`,
    });
    await client.opened;
    await sayHello(harness, client, "edge-attacker");

    const challenge = await client.waitFor<{ nonce: string; keyId: string; installationKeyId: string }>(
      "challenge",
    );

    // It answers with its own key and its own signature. Both halves are
    // wrong: the key id is not one this host issued for that purpose, and the
    // HMAC is not over this host's secret.
    client.socket.send(
      JSON.stringify({
        kind: "proof",
        keyId: challenge.installationKeyId,
        nonce: challenge.nonce,
        signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    await settle();

    // The headline assertion, on the wire: no `pair` frame was ever sent, so
    // there was no sealed credential to decrypt and nothing to replay.
    expect(client.frames.map((frame) => frame.kind)).not.toContain("pair");
    expect(client.frames.map((frame) => frame.kind)).not.toContain("ready");
    // And the refusal names what was missing rather than failing generically.
    const closed = client.frames.find((frame) => frame.kind === "closed") as
      | { readonly reason: string }
      | undefined;
    expect(closed?.reason).toContain("installation key does not match");
    expect(harness.bridge.createProvider("edge")).toBeUndefined();
    // The host still holds its own credential; nothing was leaked or revoked.
    expect(pairing.keyId).toBeTruthy();
    client.socket.terminate();
  });

  it("sends the sealed credential to a peer that proves the installation key", async () => {
    const harness = await startHarness({ dev: true });
    const pairing = harness.bridge.pairings.get("edge")!;

    const client = connectClient(harness.port, {
      origin: `chrome-extension://${KNOWN_EDGE_ID}/`,
    });
    await client.opened;
    await sayHello(harness, client, "edge-real");

    const challenge = await client.waitFor<{ nonce: string; keyId: string; installationKeyId: string }>(
      "challenge",
    );
    expect(challenge.installationKeyId).toBe(pairing.installationKeyId);

    client.socket.send(
      JSON.stringify({
        kind: "proof",
        keyId: challenge.installationKeyId,
        nonce: challenge.nonce,
        signature: await pairing.signInstallationKeyProof(challenge.nonce),
      }),
    );

    // The credential arrives only now, after the proof.
    const pair = await client.waitFor<{ keyId: string; payload: string }>("pair");
    expect(pair.keyId).toBe(pairing.keyId);
    await client.waitFor("ready");
    await settle();
    expect(harness.bridge.createProvider("edge")).toBeDefined();
    client.socket.terminate();
  });

  it("admits a peer that holds the pairing credential without the installation key", async () => {
    const harness = await startHarness({ dev: true });
    const client = await pairExtension(harness, "edge", "edge-already-paired");
    await client.waitFor("ready");
    await settle();
    // Already paired means already holding the credential, so no `pair` frame
    // is re-sent: re-sealing it would put the credential on the wire again for
    // no gain, and would blur the property that `pair` follows the installation
    // key proof.
    expect(client.frames.map((frame) => frame.kind)).not.toContain("pair");
    expect(harness.bridge.createProvider("edge")).toBeDefined();
    client.socket.terminate();
  });

  it("refuses an unknown key id with a reason that names it", async () => {
    const harness = await startHarness({ dev: true });
    const client = connectClient(harness.port, {
      origin: `chrome-extension://${KNOWN_EDGE_ID}/`,
    });
    await client.opened;
    await sayHello(harness, client, "edge-unknown-key");

    const challenge = await client.waitFor<{ nonce: string }>("challenge");
    client.socket.send(
      JSON.stringify({
        kind: "proof",
        keyId: "some-key-this-host-never-issued",
        nonce: challenge.nonce,
        signature: "AAAA",
      }),
    );
    await settle();
    const closed = client.frames.find((frame) => frame.kind === "closed") as
      | { readonly reason: string }
      | undefined;
    expect(closed?.reason).toContain("names a key this host does not hold");
    expect(client.frames.map((frame) => frame.kind)).not.toContain("pair");
    client.socket.terminate();
  });
});