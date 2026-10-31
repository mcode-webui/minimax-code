// The loopback WebSocket client, its reconnect policy and its deadlines.
//
// Two retry regimes run here, and they differ only in what they are waiting for.
//
// * While an operation is in flight the client retries on the schedule the ADR
//   fixes — 250 ms, 500 ms, 1 s, 2 s, 4 s, capped at 5 s — for at most 15 s.
//   When that deadline passes, the operation fails explicitly with
//   `browser_operation_timeout` and is **not** replayed: a command that reached
//   the page may already have acted, and sending it twice is not a retry.
// * In the background, while the person still has that browser switched on, the
//   client keeps reconnecting with the same doubling capped at 30 s, so an
//   extension that was asleep for an hour rejoins without help.
//
// Nothing here picks a different tab, browser or surface when a connection fails.
// A dropped socket is reported; substituting something else would leave the panel
// and the Agent looking at different pages, which is the failure this whole
// protocol exists to make impossible.

import {
  exportWebuiBrowserBridgeEcdhPublicKey,
  generateWebuiBrowserBridgeEcdhKeyPair,
  parseWebuiBrowserBridgeHostFrame,
  webuiBrowserBridgeError,
  webuiBrowserBridgeUrl,
  type WebuiBrowserBridgeChallenge,
  type WebuiBrowserBridgeClientFrame,
  type WebuiBrowserBridgeEcdhPublicKey,
  type WebuiBrowserBridgeError,
  type WebuiBrowserBridgeHostFrame,
  type WebuiBrowserBridgePair,
  type WebuiBrowserBridgeProof,
} from "./protocol.js";

/** How long one operation may spend waiting for a session. */
export const WEBUI_BROWSER_BRIDGE_OPERATION_DEADLINE_MS = 15_000;
/** The first retry delay; every later one doubles from it. */
export const WEBUI_BROWSER_BRIDGE_RETRY_BASE_MS = 250;
/** The cap while an operation is in flight. */
export const WEBUI_BROWSER_BRIDGE_OPERATION_RETRY_CAP_MS = 5_000;
/** The cap while merely staying connected. */
export const WEBUI_BROWSER_BRIDGE_BACKGROUND_RETRY_CAP_MS = 30_000;

/**
 * The retry delay for the nth failed attempt.
 *
 * Exported on its own so the schedule can be asserted exactly without running a
 * socket: 250, 500, 1000, 2000, 4000, then 5000 for every attempt after that.
 */
export function webuiBrowserBridgeRetryDelayMs(attempt: number, capMs: number): number {
  return Math.min(WEBUI_BROWSER_BRIDGE_RETRY_BASE_MS * 2 ** attempt, capMs);
}

/**
 * The retry delay with jitter.
 *
 * The jitter only ever delays, by up to a tenth of the delay, so the schedule the
 * ADR pins stays inspectable in a log while a room full of extensions does not
 * reconnect in lockstep.
 */
export function webuiBrowserBridgeJitteredDelayMs(
  attempt: number,
  capMs: number,
  random: () => number,
): number {
  const delay = webuiBrowserBridgeRetryDelayMs(attempt, capMs);
  return delay + Math.round(delay * 0.1 * random());
}

export interface WebuiBrowserBridgeClock {
  now(): number;
  /** Returns a canceller for the callback. */
  schedule(callback: () => void, delayMs: number): () => void;
}

export const webuiBrowserBridgeSystemClock: WebuiBrowserBridgeClock = {
  now: () => Date.now(),
  schedule: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
};

export interface WebuiBrowserBridgeSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
}

export interface WebuiBrowserBridgeSocket {
  send(data: string): void;
  close(): void;
  setHandlers(handlers: WebuiBrowserBridgeSocketHandlers): void;
}

export type WebuiBrowserBridgeSocketFactory = (url: string) => WebuiBrowserBridgeSocket;

/** Adapts the platform `WebSocket` to the socket shape the client uses. */
export function webuiBrowserBridgeWebSocketFactory(url: string): WebuiBrowserBridgeSocket {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    setHandlers(handlers) {
      socket.addEventListener("open", () => handlers.onOpen());
      socket.addEventListener("message", (event: MessageEvent) => handlers.onMessage(String(event.data)));
      socket.addEventListener("close", () => handlers.onClose());
    },
  };
}

export type WebuiBrowserBridgeStatus = "idle" | "connecting" | "connected" | "stopped";

export interface WebuiBrowserBridgeClientOptions {
  readonly browser: "edge" | "chrome";
  readonly browserId: string;
  readonly extensionVersion: string;
  /** The loopback origin the bridge is served from, without the bridge path. */
  readonly origin: string;
  readonly answerChallenge: (challenge: WebuiBrowserBridgeChallenge) => Promise<WebuiBrowserBridgeProof>;
  /**
   * Decrypts and stores the host's credential.
   *
   * Called once per connection, on the worker's end, when the host sends a
   * `pair` frame. The client never looks at the secret itself — keeping the
   * raw bytes out of the bridge state is the point — so this is the whole of
   * the extension's side of the transfer.
   *
   * The host sends a `pair` on every `hello`, so a credential that was
   * rotated by a switch off/on reaches here without anyone doing anything.
   * When the host sends none (its own surface is off, or it does not
   * recognise the id) this is never called and `answerChallenge` has to fall
   * back to whatever storage holds — or report that it holds nothing, rather
   * than hanging.
   */
  readonly applyPairCredential: (
    cipher: WebuiBrowserBridgePair,
    ownPrivateKey: CryptoKey,
  ) => Promise<void>;
  readonly createSocket?: WebuiBrowserBridgeSocketFactory;
  readonly clock?: WebuiBrowserBridgeClock;
  readonly random?: () => number;
  readonly operationDeadlineMs?: number;
  /** Frames the extension sends on its own initiative. */
  readonly onFrame?: (frame: WebuiBrowserBridgeClientFrame) => void;
  /** Frames the host sends that the client does not handle itself. */
  readonly onHostFrame?: (frame: WebuiBrowserBridgeHostFrame) => void;
  readonly onStatus?: (status: WebuiBrowserBridgeStatus) => void;
  readonly onError?: (error: WebuiBrowserBridgeError) => void;
}

/** One operation whose outcome the host is waiting to hear. */
interface InFlightOperation {
  deadlineAt: number;
  cancelDeadline: () => void;
  resolve: () => void;
  reject: (error: WebuiBrowserBridgeError) => void;
}

/** A caller blocked on the next session, bounded by a deadline. */
interface SessionWaiter {
  cancelDeadline: () => void;
  resolve: () => void;
  reject: (error: WebuiBrowserBridgeError) => void;
}

export class WebuiBrowserBridgeClient {
  private readonly clock: WebuiBrowserBridgeClock;
  private readonly random: () => number;
  private readonly createSocket: WebuiBrowserBridgeSocketFactory;
  private readonly deadlineMs: number;
  private status: WebuiBrowserBridgeStatus = "idle";
  private socket: WebuiBrowserBridgeSocket | undefined;
  private attempt = 0;
  private cancelReconnect: (() => void) | undefined;
  private readonly operations = new Set<InFlightOperation>();
  private readonly sessionWaiters = new Set<SessionWaiter>();

  constructor(private readonly options: WebuiBrowserBridgeClientOptions) {
    this.clock = options.clock ?? webuiBrowserBridgeSystemClock;
    this.random = options.random ?? Math.random;
    this.createSocket = options.createSocket ?? webuiBrowserBridgeWebSocketFactory;
    this.deadlineMs = options.operationDeadlineMs ?? WEBUI_BROWSER_BRIDGE_OPERATION_DEADLINE_MS;
  }

  /** Whether a session is up. */
  get connected(): boolean {
    return this.status === "connected";
  }

  /** Opens the connection and keeps it open until `stop()`. */
  start(): void {
    if (this.status === "stopped") return;
    this.openSocket();
  }

  /**
   * Closes the session and fails everything still waiting on one.
   *
   * The person turning a browser switch off is the ordinary reason. Any other
   * reason — a revoked pairing, a host that sent `closed` — is reported to
   * `onHostFrame` first, so the service worker can decide whether to `start()`
   * again rather than the client reconnecting behind the person's back.
   */
  stop(): void {
    if (this.status === "stopped") return;
    this.cancelReconnect?.();
    this.cancelReconnect = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.setStatus("stopped");
    socket?.close();
    this.failPending(
      webuiBrowserBridgeError("browser_operation_cancelled", "browser bridge client stopped", false),
    );
  }

  /** Sends a frame on the current session. No waiting: the caller decided. */
  send(frame: WebuiBrowserBridgeClientFrame): void {
    if (!this.socket || this.status !== "connected") {
      throw webuiBrowserBridgeError(
        "browser_provider_unavailable",
        "browser bridge has no live session",
        true,
      );
    }
    this.write(this.socket, frame);
  }

  /**
   * Publishes a frame, waiting for a session first.
   *
   * Used for frames the extension originates — the target list, an image frame,
   * a pong — where nothing has been delivered yet, so writing the frame exactly
   * once as soon as a session exists is the whole semantics.
   */
  async publish(frame: WebuiBrowserBridgeClientFrame, deadlineMs = this.deadlineMs): Promise<void> {
    await this.waitForSession(deadlineMs, () =>
      webuiBrowserBridgeError(
        "browser_provider_unavailable",
        `browser bridge did not reconnect within ${deadlineMs} ms`,
        true,
      ),
    );
    this.send(frame);
  }

  /**
   * Runs one operation under the ADR's deadline.
   *
   * `body` runs exactly once. Its result frame is written once, when a session
   * exists; if the deadline passes first the operation is rejected with
   * `browser_operation_timeout` and nothing is written. `body` is never called
   * again — whether the page acted on the command is unknowable from here, so a
   * second attempt would be a duplicate action rather than a retry.
   */
  async runOperation(body: () => Promise<WebuiBrowserBridgeClientFrame>): Promise<void> {
    const operation = this.registerOperation();
    const settled = new Promise<void>((resolve, reject) => {
      operation.resolve = resolve;
      operation.reject = reject;
    });
    // A deadline can fire while the caller is still awaiting the body, so the
    // rejection is reported through `onError` as well rather than being left as
    // an unhandled rejection until the caller gets there.
    settled.catch((error: WebuiBrowserBridgeError) => this.options.onError?.(error));
    try {
      const frame = await body();
      await this.waitForSession(operation.deadlineAt - this.clock.now(), () => this.timeoutError());
      // The operation's own deadline can fire while the body was still running.
      // Reporting a result then would be reporting on an operation the host has
      // already given up on.
      if (!this.operations.has(operation)) return;
      this.send(frame);
      operation.resolve();
    } catch (cause) {
      operation.reject(this.asError(cause));
    } finally {
      operation.cancelDeadline();
      this.operations.delete(operation);
    }
    await settled;
  }

  private registerOperation(): InFlightOperation {
    const operation: InFlightOperation = {
      deadlineAt: this.clock.now() + this.deadlineMs,
      cancelDeadline: () => {},
      resolve: () => {},
      reject: () => {},
    };
    operation.cancelDeadline = this.clock.schedule(() => {
      if (!this.operations.delete(operation)) return;
      operation.reject(this.timeoutError());
    }, this.deadlineMs);
    this.operations.add(operation);
    return operation;
  }

  private timeoutError(): WebuiBrowserBridgeError {
    return webuiBrowserBridgeError(
      "browser_operation_timeout",
      `browser bridge operation exceeded its ${this.deadlineMs} ms deadline`,
      true,
    );
  }

  private async waitForSession(
    budgetMs: number,
    error: () => WebuiBrowserBridgeError,
  ): Promise<void> {
    if (this.status === "connected") return;
    if (this.status === "stopped") {
      // The person turned this browser off. That is a cancellation, not an
      // unreachable provider, and a caller retrying the other way would be
      // chasing the wrong cause.
      throw webuiBrowserBridgeError(
        "browser_operation_cancelled",
        "browser bridge is stopped",
        false,
      );
    }
    if (budgetMs <= 0) throw error();
    await new Promise<void>((resolve, reject) => {
      const waiter: SessionWaiter = { cancelDeadline: () => {}, resolve, reject };
      waiter.cancelDeadline = this.clock.schedule(() => {
        this.sessionWaiters.delete(waiter);
        reject(error());
      }, budgetMs);
      this.sessionWaiters.add(waiter);
    });
  }

  private openSocket(): void {
    if (this.status === "stopped" || this.status === "connecting" || this.status === "connected") return;
    // An ephemeral key pair per connection. The private half never leaves this
    // closure, so a captured `pair` from one connection has no value on the
    // next — and a worker that is terminated leaves no key behind to leak.
    // It is minted before `onOpen` can send `hello`, which is what carries
    // the public key the host needs to build the cipher.
    let handshake:
      | { readonly privateKey: CryptoKey; readonly publicKey: WebuiBrowserBridgeEcdhPublicKey }
      | undefined;
    const ready: Promise<void> = (async () => {
      const { privateKey, publicKey } = await generateWebuiBrowserBridgeEcdhKeyPair();
      handshake = { privateKey, publicKey: await exportWebuiBrowserBridgeEcdhPublicKey(publicKey) };
    })();
    let socket: WebuiBrowserBridgeSocket;
    try {
      socket = this.createSocket(webuiBrowserBridgeUrl(this.options.origin));
    } catch (cause) {
      this.options.onError?.(this.asError(cause));
      this.handleDropped();
      return;
    }
    this.socket = socket;
    this.setStatus("connecting");
    socket.setHandlers({
      onOpen: () => {
        if (this.socket !== socket) return;
        // The key pair is what `hello` carries, so the greeting waits for it
        // rather than going out without one.
        void ready.then(
          () => {
            if (this.socket !== socket || !handshake) return;
            socket.send(
              JSON.stringify({
                kind: "hello",
                browser: this.options.browser,
                browserId: this.options.browserId,
                extensionVersion: this.options.extensionVersion,
                publicKey: handshake.publicKey,
              }),
            );
          },
          (cause: unknown) => {
            this.options.onError?.(this.asError(cause));
            socket.close();
            if (this.socket === socket) this.socket = undefined;
            this.handleDropped();
          },
        );
      },
      onMessage: (data) => {
        const keyPair = handshake;
        if (!keyPair) {
          // A frame before the handshake is ready is a protocol violation: the
          // host cannot answer a hello that has not gone out.
          this.options.onError?.(
            webuiBrowserBridgeError(
              "browser_pairing_rejected",
              "browser bridge: host spoke before the extension's hello",
              false,
            ),
          );
          socket.close();
          if (this.socket === socket) this.socket = undefined;
          this.handleDropped();
          return;
        }
        this.handleMessage(socket, data, keyPair);
      },
      onClose: () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.handleDropped();
      },
    });
  }

  private handleMessage(
    socket: WebuiBrowserBridgeSocket,
    data: string,
    handshake: { readonly privateKey: CryptoKey; readonly publicKey: WebuiBrowserBridgeEcdhPublicKey },
  ): void {
    if (this.socket !== socket) return;
    const parsed = parseWebuiBrowserBridgeHostFrame(data);
    if (!parsed.ok) {
      // The stream can no longer be trusted, so the session ends rather than
      // continuing to read frames from a framing this side does not understand.
      this.options.onError?.(
        webuiBrowserBridgeError(
          "browser_pairing_rejected",
          `protocol violation: ${parsed.reason}`,
          false,
        ),
      );
      socket.close();
      if (this.socket === socket) this.socket = undefined;
      this.handleDropped();
      return;
    }
    const frame = parsed.frame;
    switch (frame.kind) {
      case "pair": {
        void this.applyPair(frame, socket, handshake);
        return;
      }
      case "challenge": {
        void this.answerChallenge(frame, socket);
        return;
      }
      case "ready": {
        this.attempt = 0;
        this.setStatus("connected");
        this.releaseSessionWaiters();
        return;
      }
      case "ping": {
        this.write(socket, { kind: "pong", nonce: frame.nonce });
        return;
      }
      default: {
        void this.options.onHostFrame?.(frame);
      }
    }
  }

  /**
   * Decrypts and stores the host's `pair` frame.
   *
   * Order on the wire is `challenge`, then `proof`, then `pair` — and the
   * `pair` is sent only to a peer that proved the installation key. This
   * method therefore runs *after* the challenge has been answered, not before
   * it. If the decryption fails — a tampered payload, a cipher that came from a
   * different key — we report it and close the socket rather than carry on
   * against a credential we cannot verify.
   */
  private async applyPair(
    frame: WebuiBrowserBridgePair,
    socket: WebuiBrowserBridgeSocket,
    handshake: { readonly privateKey: CryptoKey; readonly publicKey: WebuiBrowserBridgeEcdhPublicKey },
  ): Promise<void> {
    try {
      await this.options.applyPairCredential(frame, handshake.privateKey);
    } catch (cause) {
      this.options.onError?.(this.asError(cause));
      socket.close();
      if (this.socket === socket) this.socket = undefined;
      this.handleDropped();
    }
  }

  private async answerChallenge(
    challenge: WebuiBrowserBridgeChallenge,
    socket: WebuiBrowserBridgeSocket,
  ): Promise<void> {
    try {
      this.write(socket, await this.options.answerChallenge(challenge));
    } catch (cause) {
      this.options.onError?.(this.asError(cause));
      socket.close();
    }
  }

  private handleDropped(): void {
    if (this.status === "stopped") return;
    this.setStatus("idle");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.status === "stopped") return;
    this.cancelReconnect?.();
    // An operation in flight gets the tight cap: it is waiting on a result. With
    // nothing in flight the goal is only to come back eventually.
    const cap = this.operations.size > 0
      ? WEBUI_BROWSER_BRIDGE_OPERATION_RETRY_CAP_MS
      : WEBUI_BROWSER_BRIDGE_BACKGROUND_RETRY_CAP_MS;
    const delay = webuiBrowserBridgeJitteredDelayMs(this.attempt, cap, this.random);
    this.attempt += 1;
    this.cancelReconnect = this.clock.schedule(() => {
      this.cancelReconnect = undefined;
      this.openSocket();
    }, delay);
  }

  private releaseSessionWaiters(): void {
    for (const waiter of [...this.sessionWaiters]) {
      waiter.cancelDeadline();
      this.sessionWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private failPending(error: WebuiBrowserBridgeError): void {
    for (const waiter of [...this.sessionWaiters]) {
      waiter.cancelDeadline();
      this.sessionWaiters.delete(waiter);
      waiter.reject(error);
    }
    for (const operation of [...this.operations]) {
      this.operations.delete(operation);
      operation.cancelDeadline();
      operation.reject(error);
    }
  }

  private write(socket: WebuiBrowserBridgeSocket, frame: WebuiBrowserBridgeClientFrame): void {
    if (this.socket !== socket) return;
    socket.send(JSON.stringify(frame));
    this.options.onFrame?.(frame);
  }

  private setStatus(status: WebuiBrowserBridgeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  private asError(cause: unknown): WebuiBrowserBridgeError {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      "message" in cause &&
      "retryable" in cause
    ) {
      return cause as WebuiBrowserBridgeError;
    }
    return webuiBrowserBridgeError(
      "browser_provider_failed",
      cause instanceof Error ? cause.message : String(cause),
      false,
    );
  }
}