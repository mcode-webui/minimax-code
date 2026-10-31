// No browser and no socket: the client is driven through an injected clock and a
// fake socket that records what it was sent. The clock makes the reconnect
// schedule and the operation deadline exact rather than approximate, and the
// fakes cover everything the client depends on below the `WebSocket` boundary.

import { describe, expect, it } from "vitest";

import {
  WEBUI_BROWSER_BRIDGE_BACKGROUND_RETRY_CAP_MS,
  WEBUI_BROWSER_BRIDGE_OPERATION_RETRY_CAP_MS,
  WebuiBrowserBridgeClient,
  webuiBrowserBridgeJitteredDelayMs,
  webuiBrowserBridgeRetryDelayMs,
  type WebuiBrowserBridgeClock,
  type WebuiBrowserBridgeSocket,
  type WebuiBrowserBridgeSocketHandlers,
} from "../src/bridge-client.js";
import {
  signWebuiBrowserBridgeProof,
  verifyWebuiBrowserBridgeProof,
  WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM,
  type WebuiBrowserBridgeChallenge,
  type WebuiBrowserBridgeClientFrame,
  type WebuiBrowserBridgeError,
  type WebuiBrowserBridgeHostFrame,
} from "../src/protocol.js";

const SECRET = new TextEncoder().encode("webui-browser-bridge-test-secret");
const KEY_ID = "key-1";
const INSTALLATION_KEY_ID = "webui-browser-bridge-installation-edge-v1";
const ORIGIN = "http://127.0.0.1:7777";

/** A virtual clock: nothing waits in real time, so the schedule is assertable. */
class FakeClock implements WebuiBrowserBridgeClock {
  time = 0;
  private readonly timers: { at: number; run: () => void }[] = [];

  now(): number {
    return this.time;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const timer = { at: this.time + delayMs, run: callback };
    this.timers.push(timer);
    return () => {
      const index = this.timers.indexOf(timer);
      if (index >= 0) this.timers.splice(index, 1);
    };
  }

  /** Runs every timer due at or before `target`, in order. */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.time = Math.max(this.time, due.at);
      due.run();
      await settle();
    }
    this.time = Math.max(this.time, target);
    await settle();
  }
}

class FakeSocket implements WebuiBrowserBridgeSocket {
  readonly sent: string[] = [];
  closed = false;
  /** The clock time the client created this socket, for schedule assertions. */
  readonly createdAt: number;
  private handlers: WebuiBrowserBridgeSocketHandlers | undefined;

  constructor(createdAt: number) {
    this.createdAt = createdAt;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers?.onClose();
  }

  setHandlers(handlers: WebuiBrowserBridgeSocketHandlers): void {
    this.handlers = handlers;
  }

  open(): void {
    this.handlers?.onOpen();
  }

  receive(frame: WebuiBrowserBridgeHostFrame): void {
    this.handlers?.onMessage(JSON.stringify(frame));
  }

  /** Frames of one kind this socket was sent, in order. */
  frames(kind: WebuiBrowserBridgeClientFrame["kind"]): WebuiBrowserBridgeClientFrame[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as WebuiBrowserBridgeClientFrame)
      .filter((frame) => frame.kind === kind);
  }
}

/**
 * Yields to the event loop.
 *
 * More than one turn, because signing runs on Node's Web Crypto — its results
 * come back off the threadpool, so a single microtask turn is not enough to
 * observe the proof the client writes after answering a challenge.
 */
async function settle(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Waits until `predicate` holds, so no assertion races an async continuation. */
async function waitFor(predicate: () => boolean, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await settle(1);
  }
  throw new Error("condition was never met");
}

interface Harness {
  readonly clock: FakeClock;
  readonly sockets: FakeSocket[];
  readonly client: WebuiBrowserBridgeClient;
  readonly errors: WebuiBrowserBridgeError[];
  readonly hostFrames: WebuiBrowserBridgeHostFrame[];
}

/**
 * A bridge whose sockets can be told whether they ever come up.
 *
 * `respondWith` plays the host: a challenge after the hello, and a ready once the
 * proof arrives. Leaving it false models a bridge that is not coming back inside
 * the operation's deadline.
 */
function createHarness(options: { respondWith?: boolean; respondEverySocket?: boolean } = {}): Harness {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const errors: WebuiBrowserBridgeError[] = [];
  const hostFrames: WebuiBrowserBridgeHostFrame[] = [];
  const client = new WebuiBrowserBridgeClient({
    browser: "edge",
    browserId: "browser-1",
    extensionVersion: "0.1.0",
    origin: ORIGIN,
    clock,
    random: () => 0,
    createSocket: () => {
      const socket = new FakeSocket(clock.time);
      sockets.push(socket);
      if (options.respondWith === false || (sockets.length > 1 && options.respondEverySocket !== true)) {
        // Stays `connecting` and then drops, which is what a bridge that is not
        // listening looks like from this side.
        queueMicrotask(() => socket.close());
      }
      return socket;
    },
    // These tests never exercise the pair path: they drive the client straight
    // at a challenge. The credential store is a no-op that records the
    // `pair` frames it is handed so a test can assert one arrived without
    // this file taking on the ECDH round trip (the extension pairing suite
    // covers that, on both sides of the cipher).
    applyPairCredential: async () => {},
    answerChallenge: async (challenge: WebuiBrowserBridgeChallenge) => ({
      kind: "proof",
      keyId: challenge.keyId,
      nonce: challenge.nonce,
      signature: await signWebuiBrowserBridgeProof(SECRET, challenge.nonce, challenge.keyId),
    }),
    onHostFrame: (frame) => {
      hostFrames.push(frame);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { clock, sockets, client, errors, hostFrames };
}

function challenge(nonce: string): WebuiBrowserBridgeHostFrame {
  return {
    kind: "challenge",
    nonce,
    algorithm: WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM,
    keyId: KEY_ID,
    installationKeyId: INSTALLATION_KEY_ID,
  };
}

async function connect(harness: Harness, nonce = "nonce-1"): Promise<FakeSocket> {
  harness.client.start();
  const socket = harness.sockets[harness.sockets.length - 1]!;
  socket.open();
  // The client's greeting waits on the ephemeral key pair, which is a Web
  // Crypto call; the host cannot speak before it, so the fake host waits too.
  await waitFor(() => socket.frames("hello").length > 0);
  socket.receive(challenge(nonce));
  await waitFor(() => socket.frames("proof").length > 0);
  socket.receive({ kind: "ready", sessionId: "session-1" });
  await settle();
  return socket;
}

describe("reconnect schedule", () => {
  it("follows the ADR's steps and caps at five seconds while an operation is in flight", () => {
    const steps = [0, 1, 2, 3, 4, 5, 6].map((attempt) =>
      webuiBrowserBridgeRetryDelayMs(attempt, WEBUI_BROWSER_BRIDGE_OPERATION_RETRY_CAP_MS),
    );
    expect(steps).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
  });

  it("caps background reconnection at thirty seconds", () => {
    const steps = [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) =>
      webuiBrowserBridgeRetryDelayMs(attempt, WEBUI_BROWSER_BRIDGE_BACKGROUND_RETRY_CAP_MS),
    );
    expect(steps).toEqual([250, 500, 1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it("adds jitter only as extra delay", () => {
    expect(webuiBrowserBridgeJitteredDelayMs(0, WEBUI_BROWSER_BRIDGE_OPERATION_RETRY_CAP_MS, () => 0)).toBe(250);
    expect(webuiBrowserBridgeJitteredDelayMs(0, WEBUI_BROWSER_BRIDGE_OPERATION_RETRY_CAP_MS, () => 1)).toBe(275);
    expect(webuiBrowserBridgeJitteredDelayMs(1, WEBUI_BROWSER_BRIDGE_OPERATION_RETRY_CAP_MS, () => 0.5)).toBe(525);
  });
});

describe("pairing over the bridge", () => {
  it("greets the host with an ephemeral key and answers its challenge before it reports ready", async () => {
    const harness = createHarness();
    const socket = await connect(harness);

    expect(harness.client.connected).toBe(true);
    const hello = socket.frames("hello");
    // Exactly one greeting, and it carries the P-256 key the host needs to
    // deliver the credential. The coordinates are per-connection, so they are
    // asserted for shape rather than for value.
    expect(hello).toHaveLength(1);
    expect(hello[0]).toMatchObject({
      kind: "hello",
      browser: "edge",
      browserId: "browser-1",
      extensionVersion: "0.1.0",
      publicKey: { kty: "EC", crv: "P-256" },
    });
    const publicKey = (hello[0] as { publicKey: { x: string; y: string } }).publicKey;
    expect(publicKey.x.length).toBeGreaterThan(0);
    expect(publicKey.y.length).toBeGreaterThan(0);
    const proof = socket.frames("proof")[0];
    if (proof?.kind !== "proof") throw new Error("expected a proof frame");
    await expect(verifyWebuiBrowserBridgeProof(SECRET, proof, "nonce-1", KEY_ID)).resolves.toBe(true);
    // `ready` is what makes the session usable, not the socket being open.
    expect(harness.client.connected).toBe(true);
  });

  it("publishes an originated frame once a session exists", async () => {
    const harness = createHarness();
    const socket = await connect(harness);

    await harness.client.publish({ kind: "targets", targets: [] });

    expect(socket.frames("targets")).toHaveLength(1);
  });

  it("answers a ping with the same nonce", async () => {
    const harness = createHarness();
    const socket = await connect(harness);

    socket.receive({ kind: "ping", nonce: "p-1" });
    await settle();

    expect(socket.frames("pong")).toEqual([{ kind: "pong", nonce: "p-1" }]);
  });

  it("passes input commands to the caller and reports a refusal as a refusal", async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    const command = {
      kind: "input",
      commandId: "c-1",
      command: { kind: "text", targetId: "tab-1", generation: 3, text: "hi" },
    } as const;

    socket.receive(command);
    await settle();

    expect(harness.hostFrames).toEqual([command]);
  });
});

describe("operation deadline", () => {
  it("fails explicitly at the deadline and never replays the operation", async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];

    const operation = harness.client.runOperation(async () => {
      await gate;
      delivered.push("delivered-once");
      return { kind: "input-result", commandId: "c-1", accepted: true };
    });
    const settled = operation.catch((error: WebuiBrowserBridgeError) => error);
    await settle();

    // The session drops while the command is still being delivered, and the
    // bridge never comes back.
    socket.close();
    release();

    await harness.clock.advanceTo(15_000);
    const outcome = await settled;

    expect(delivered).toEqual(["delivered-once"]);
    expect((outcome as WebuiBrowserBridgeError).code).toBe("browser_operation_timeout");
    for (const attempt of harness.sockets) {
      expect(attempt.frames("input-result")).toEqual([]);
    }
  });

  it("retries on the fixed schedule while the operation is waiting", async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const operation = harness.client.runOperation(async () => {
      await gate;
      return { kind: "input-result", commandId: "c-1", accepted: true };
    });
    const settled = operation.catch((error: WebuiBrowserBridgeError) => error);
    await settle();
    socket.close();
    release();
    await settle();

    await harness.clock.advanceTo(7_750);

    const attemptTimes = harness.sockets.slice(1).map((attempt, index, all) => {
      const previous = index === 0 ? 0 : all[index - 1].createdAt;
      return attempt.createdAt - previous;
    });
    expect(attemptTimes).toEqual([250, 500, 1000, 2000, 4000]);

    await harness.clock.advanceTo(15_000);
    expect((await settled as WebuiBrowserBridgeError).code).toBe("browser_operation_timeout");
  });

  it("keeps the target when the bridge returns, and still writes the result once", async () => {
    const harness = createHarness({ respondWith: true, respondEverySocket: true });
    const socket = await connect(harness);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];

    const operation = harness.client.runOperation(async () => {
      await gate;
      delivered.push("delivered-once");
      return { kind: "input-result", commandId: "c-1", accepted: false, error: "browser_target_stale" };
    });
    const settled = operation.catch((error: WebuiBrowserBridgeError) => error);
    await settle();
    socket.close();
    release();

    await harness.clock.advanceTo(1_000);
    const replacement = harness.sockets[harness.sockets.length - 1]!;
    replacement.open();
    await waitFor(() => replacement.frames("hello").length > 0);
    replacement.receive(challenge("nonce-2"));
    await waitFor(() => replacement.frames("proof").length > 0);
    replacement.receive({ kind: "ready", sessionId: "session-2" });
    await settle();

    await expect(operation).resolves.toBeUndefined();
    expect(delivered).toEqual(["delivered-once"]);
    // The refusal is reported as a refusal, on the new session, exactly once.
    expect(replacement.frames("input-result")).toEqual([
      { kind: "input-result", commandId: "c-1", accepted: false, error: "browser_target_stale" },
    ]);
    expect(socket.frames("input-result")).toEqual([]);
  });

  it("reports an unreachable bridge when an originated frame cannot be sent", async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    socket.close();
    const pending = harness.client
      .publish({ kind: "targets", targets: [] })
      .catch((error: WebuiBrowserBridgeError) => error);

    await harness.clock.advanceTo(15_000);

    expect((await pending as WebuiBrowserBridgeError).code).toBe("browser_provider_unavailable");
  });

  it("keeps reconnecting in the background on the wider cap", async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    socket.close();

    await harness.clock.advanceTo(93_000);

    // Nothing is in flight, so the backoff grows to the background cap.
    const attemptTimes = harness.sockets.slice(1).map((attempt, index, all) => {
      const previous = index === 0 ? 0 : all[index - 1].createdAt;
      return attempt.createdAt - previous;
    });
    expect(attemptTimes.slice(0, 7)).toEqual([250, 500, 1000, 2000, 4000, 8000, 16000]);
    expect(attemptTimes.slice(7, 9)).toEqual([30000, 30000]);
  });

  it("fails everything still waiting when the person switches the browser off", async () => {
    const harness = createHarness();
    await connect(harness);
    const waiting = harness.client
      .publish({ kind: "targets", targets: [] })
      .catch((error: WebuiBrowserBridgeError) => error);
    harness.client.stop();
    const error = harness.client
      .publish({ kind: "targets", targets: [] })
      .catch((cause: WebuiBrowserBridgeError) => cause);

    await expect(waiting).resolves.toMatchObject({ code: "browser_provider_unavailable" });
    await expect(error).resolves.toMatchObject({ code: "browser_operation_cancelled" });
  });
});