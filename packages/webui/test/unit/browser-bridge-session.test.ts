// End-to-end wire test: a real `ws` server on loopback, a real client,
// and the bridge session handling the post-upgrade exchange. The test
// proves:
//   * A valid challenge and proof results in a `ready` frame and an open
//     session.
//   * A wrong proof never results in `ready`.
//   * `dev: true` on the runtime side does NOT cause an unaccepted
//     extension (one without a proof) to ever receive `ready`.
//
// The test stands up its own loopback HTTP server; it does not touch any
// file owned by other engineers.

import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  BrowserBridgePairing,
  BrowserBridgeSession,
  admitBrowserBridgeUpgrade,
  createInMemorySecureCredentialStore,
  exportWebuiBrowserBridgeEcdhPublicKey,
  generateWebuiBrowserBridgeEcdhKeyPair,
  type BrowserBridgeAdmissionContext,
  type WebuiBrowserBridgeEcdhPublicKey,
} from "../../src/server/browser-bridge/index.js";
import { WEBUI_BROWSER_BRIDGE_PATH } from "../../src/shared/contracts/browser-bridge.js";
import type {
  WebuiBrowserBridgeChallenge,
  WebuiBrowserBridgeClientFrame,
  WebuiBrowserBridgeHostFrame,
} from "../../src/shared/contracts/browser-bridge.js";

const KNOWN_EDGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";

interface Harness {
  url: string;
  readonly close: () => Promise<void>;
  closed: boolean;
  readonly wss: WebSocketServer;
  readonly context: BrowserBridgeAdmissionContext;
  readonly pairing: BrowserBridgePairing;
  readonly sessions: BrowserBridgeSession[];
  readonly receivedClientFrames: WebuiBrowserBridgeClientFrame[];
}

async function startHarness(
  extensionId: string,
  dev: boolean,
  options: { readonly pingIntervalMs?: number } = {},
): Promise<Harness> {
  const pairing = new BrowserBridgePairing({
    surface: "edge",
    credentialStore: createInMemorySecureCredentialStore(),
    allowedExtensionIds: new Set([extensionId]),
  });
  await pairing.enable();

  const context: BrowserBridgeAdmissionContext = {
    pairings: new Map([["edge", pairing]]),
    host: "127.0.0.1",
    dev,
  };

  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sessions: BrowserBridgeSession[] = [];
  const receivedClientFrames: WebuiBrowserBridgeClientFrame[] = [];

  const harness: Harness = {
    url: "",
    close: async () => {
      for (const session of sessions) session.close({ kind: "host_revoked" });
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      harness.closed = true;
    },
    closed: false,
    wss,
    context,
    pairing,
    sessions,
    receivedClientFrames,
  };

  httpServer.on("upgrade", (request, socket, head) => {
    const rejection = admitBrowserBridgeUpgrade(request, request.url, socket, context);
    if (rejection) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      const session = new BrowserBridgeSession({
        pairings: [pairing],
        socket: ws as unknown as never,
        sessionId: `s-${sessions.length}`,
        ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
      });
      sessions.push(session);
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  harness.url = `ws://127.0.0.1:${port}${WEBUI_BROWSER_BRIDGE_PATH}`;
  return harness;
}

async function connectClient(
  harness: Harness,
  extensionId: string,
  options: { readonly publicKey?: unknown } = {},
): Promise<{ readonly client: WebSocket; readonly frames: WebuiBrowserBridgeHostFrame[] }> {
  const port = new URL(harness.url).port;
  const client = new WebSocket(harness.url, {
    origin: `chrome-extension://${extensionId}/`,
    headers: { host: `127.0.0.1:${port}` },
  });
  const frames: WebuiBrowserBridgeHostFrame[] = [];
  client.on("message", (data: RawData) => {
    frames.push(JSON.parse(data.toString()) as WebuiBrowserBridgeHostFrame);
  });
  await once(client, "open");
  // Send a `hello` so the session can send `pair` and `challenge` together;
  // the production client does this from `WebuiBrowserBridgeClient`. An
  // absent `publicKey` is treated as "this build is too old to pair", and
  // is exercised in another test.
  client.send(
    JSON.stringify({
      kind: "hello",
      browser: "edge",
      browserId: "browser-test-1",
      extensionVersion: "test",
      ...(options.publicKey !== undefined ? { publicKey: options.publicKey } : {}),
    }),
  );
  return { client, frames };
}

describe("WebUI bridge session (wire-level)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness(KNOWN_EDGE_ID, false);
  });

  afterEach(async () => {
    if (!harness.closed) await harness.close();
  });

  it("sends no pair before the proof: a peer that cannot prove gets no credential", async () => {
    const publicKey = await makeClientPublicKey();
    const { client, frames } = await connectClient(harness, KNOWN_EDGE_ID, { publicKey });

    // The order is the security property: `challenge` leaves first and
    // nothing else does. A `pair` frame here would hand this host's
    // credential to anything that could open a socket, which is exactly the
    // defect the installation key exists to close.
    await waitForKind(frames, "challenge");
    expect(frames.some((frame) => frame.kind === "pair")).toBe(false);
    client.close();
  });

  it("emits a challenge after the upgrade and admits a valid proof", async () => {
    const publicKey = await makeClientPublicKey();
    const { client, frames } = await connectClient(harness, KNOWN_EDGE_ID, { publicKey });

    const challengeFrame = await waitForKind(frames, "challenge");
    expect(challengeFrame.kind).toBe("challenge");
    expect(challengeFrame.algorithm).toBe("HMAC-SHA256");
    expect(challengeFrame.installationKeyId).toMatch(/^[!-~]+$/u);
    expect(harness.sessions).toHaveLength(1);
    expect(harness.sessions[0]!.isAdmitted).toBe(false);

    // Answer with the pairing credential this host already issued. That is
    // the "already paired" branch: admitted, and no `pair` frame, because the
    // peer already holds that exact credential.
    const proof = await harness.pairing.signProof(challengeFrame.nonce);
    client.send(
      JSON.stringify({
        kind: "proof",
        keyId: challengeFrame.keyId,
        nonce: challengeFrame.nonce,
        signature: proof,
      }),
    );

    const readyFrame = await waitForKind(frames, "ready");
    expect(readyFrame.kind).toBe("ready");
    expect(frames.some((frame) => frame.kind === "pair")).toBe(false);
    expect(harness.sessions[0]!.isAdmitted).toBe(true);
    client.close();
  });

  it("delivers the sealed credential to a peer that proves the installation key", async () => {
    const publicKey = await makeClientPublicKey();
    const { client, frames } = await connectClient(harness, KNOWN_EDGE_ID, { publicKey });

    const challengeFrame = await waitForKind(frames, "challenge");
    client.send(
      JSON.stringify({
        kind: "proof",
        keyId: challengeFrame.installationKeyId,
        nonce: challengeFrame.nonce,
        signature: await harness.pairing.signInstallationKeyProof(challengeFrame.nonce),
      }),
    );

    // Only now does a credential leave the host.
    const pairFrame = await waitForKind(frames, "pair");
    expect(pairFrame.kind).toBe("pair");
    expect(pairFrame.keyId).toBe(harness.pairing.keyId);
    expect(pairFrame.keyId).toBe(challengeFrame.keyId);
    await waitForKind(frames, "ready");
    client.close();
  });

  it("sends no pair for a hello without a public key, and the handshake cannot complete", async () => {
    // An older extension build sends no public key. The host must still send
    // the challenge — refusing the connection outright would make the
    // incompatibility a silent hang rather than a wrong proof the extension
    // reports on.
    const { client, frames } = await connectClient(harness, KNOWN_EDGE_ID);

    const challengeFrame = await waitForKind(frames, "challenge");
    expect(frames.some((frame) => frame.kind === "pair")).toBe(false);

    // This side never received the credential, so any proof it could write is
    // a guess. The session closes on the wrong proof rather than sitting open.
    client.send(
      JSON.stringify({
        kind: "proof",
        keyId: challengeFrame.keyId,
        nonce: challengeFrame.nonce,
        signature: "an-extension-that-was-never-paired",
      }),
    );
    await once(client, "close");
    expect(frames.some((frame) => frame.kind === "ready")).toBe(false);
  });

  it("refuses a public key that is not a P-256 JWK", async () => {
    const { client, frames } = await connectClient(harness, KNOWN_EDGE_ID, {
      publicKey: { kty: "RSA", crv: "P-256", x: "AAAA", y: "AAAA" },
    });

    await waitForKind(frames, "challenge");
    expect(frames.some((frame) => frame.kind === "pair")).toBe(false);
    client.close();
  });

  it("sends no pair once the surface's switch has been turned off", async () => {
    // The session is already admitted over an open socket, and the person
    // then flips the switch. A NEW connection must not be handed anything.
    await harness.pairing.disable();

    const { client, frames } = await connectClient(harness, KNOWN_EDGE_ID, {
      publicKey: await makeClientPublicKey(),
    });

    // No pair, and no challenge either: the pairing holds no credential, so
    // the session closes rather than inviting a proof it cannot verify.
    await once(client, "close");
    expect(frames.some((frame) => frame.kind === "pair")).toBe(false);
    expect(frames.some((frame) => frame.kind === "challenge")).toBe(false);
  });

  it("the dev: true flag does NOT bypass extension authentication", async () => {
    await harness.close();
    harness = await startHarness(KNOWN_EDGE_ID, true);

    const publicKey = await makeClientPublicKey();
    const { client, frames } = await connectClient(harness, KNOWN_EDGE_ID, { publicKey });
    await waitForKind(frames, "challenge");
    const challengeFrame = frames.find((frame) => frame.kind === "challenge")!;
    // Send a deliberately wrong proof — the extension did NOT authenticate.
    client.send(
      JSON.stringify({
        kind: "proof",
        keyId: challengeFrame.keyId,
        nonce: challengeFrame.nonce,
        signature: "this-is-not-the-proof",
      }),
    );

    // The session must close the socket before any "ready" frame is sent.
    await once(client, "close");

    // No "ready" frame must ever have arrived.
    expect(frames.some((frame) => frame.kind === "ready")).toBe(false);
    // A `closed` frame is the documented refusal at the session level.
    // (Either the host sent it explicitly, or the socket went away; either
    // path is fine — what we care about is that `ready` did not appear.)
    expect(harness.pairing.enabled).toBe(true);
  });

  it("emits a liveness ping and closes the session when the pong does not come", async () => {
    await harness.close();
    harness = await startHarness(KNOWN_EDGE_ID, true, { pingIntervalMs: 60 });

    const publicKey = await makeClientPublicKey();
    const { client, frames } = await connectClient(harness, KNOWN_EDGE_ID, { publicKey });

    // Admit the peer first: the liveness ping belongs to an admitted session.
    const challengeFrame = await waitForKind(frames, "challenge");
    const proof = await harness.pairing.signProof(challengeFrame.nonce);
    client.send(
      JSON.stringify({
        kind: "proof",
        keyId: challengeFrame.keyId,
        nonce: challengeFrame.nonce,
        signature: proof,
      }),
    );
    await waitForKind(frames, "ready");

    // The host pings once the peer is admitted, and the peer here does not
    // answer: a socket that looks open but has nobody behind it is closed,
    // so the extension's reconnect ladder can pick it up.
    const ping = await waitForKind(frames, "ping");
    expect(ping.nonce).toMatch(/^ping-/u);

    const closed = await once(client, "close");
    expect(closed).toBeDefined();
    const closeFrame = frames.find((frame) => frame.kind === "closed");
    expect(closeFrame && "reason" in closeFrame ? closeFrame.reason : "").toContain(
      "liveness ping",
    );
  });
});

/* -------------------------------------------------------------------------- */

async function waitForKind<K extends WebuiBrowserBridgeHostFrame["kind"]>(
  frames: readonly WebuiBrowserBridgeHostFrame[],
  kind: K,
): Promise<Extract<WebuiBrowserBridgeHostFrame, { kind: K }>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = frames.find((frame) => frame.kind === kind) as
      | Extract<WebuiBrowserBridgeHostFrame, { kind: K }>
      | undefined;
    if (found) return found;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for "${kind}" frame after 5s`);
}

/**
 * Build an extension-side ECDH public key for the test. The private half is
 * discarded — the test only exercises the host's encrypt side, never the
 * decrypt side, and not keeping it makes that intent obvious.
 */
async function makeClientPublicKey(): Promise<WebuiBrowserBridgeEcdhPublicKey> {
  const { publicKey } = await generateWebuiBrowserBridgeEcdhKeyPair();
  return exportWebuiBrowserBridgeEcdhPublicKey(publicKey);
}

void (null as unknown as void);
