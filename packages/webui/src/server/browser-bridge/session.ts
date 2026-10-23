// One bridge session = one connected extension on the `/browser-bridge`
// WebSocket.
//
// A session owns the lifecycle that the admission path deliberately does
// NOT handle:
//
//   1. The host sends a fresh challenge immediately after the upgrade
//      accepts.
//   2. The extension answers with a proof; the session verifies it.
//   3. On success the host emits `ready` and the session is open.
//   4. The host sends `input` commands and awaits `input-result` from the
//      extension for each one. The deadline distinguishes "the bridge is
//      unreachable" (timeout) from "the extension refused this command"
//      (an explicit `accepted: false` result).
//   5. The session closes when the socket closes or a fatal condition
//      happens (revocation, repeated bad proof, store unavailable).
//
// The session is deliberately unaware of the registry: it does not know
// which browser it serves, only which pairing. That decoupling lets the
// registry rotate pairings without managing the wire state itself.

import { EventEmitter } from "node:events";
import type { WebSocket, RawData } from "ws";

import {
  type WebuiBrowserBridgeChallenge,
  type WebuiBrowserBridgeClientFrame,
  type WebuiBrowserBridgeEcdhPublicKey,
  type WebuiBrowserBridgeHostFrame,
  type WebuiBrowserBridgeImageFrame,
  type WebuiBrowserBridgeInputCommand,
  type WebuiBrowserBridgeProof,
  type WebuiBrowserBridgeTarget,
} from "../../shared/contracts/browser-bridge.js";
import type { WebuiBridgeBrowserSurface } from "../../shared/contracts/browser.js";

import {
  PairingSwitchedOffError,
  BrowserBridgePairing,
  type BrowserBridgeProofRefusal,
} from "./pairing.js";
import {
  bridgeOperationReconnectDelayMs,
  withBridgeOperationRetry,
  BridgeOperationError,
} from "./reconnect.js";

const DEFAULT_OPERATION_DEADLINE_MS = 15_000;

/**
 * How long a peer has to open with a `hello`.
 *
 * The same fifteen seconds the operation deadline gives: a peer that cannot
 * open a conversation in that time is not going to.
 */
const DEFAULT_HELLO_DEADLINE_MS = 15_000;
const DEFAULT_PING_INTERVAL_MS = 10_000;
const MAX_INFLIGHT_COMMANDS = 32;

/** The shape of a single command's outcome. */
export type BrowserBridgeCommandOutcome =
  | {
      readonly kind: "accepted";
      readonly commandId: string;
      /** The command's result, when the command produced one. */
      readonly result?: unknown;
    }
  | {
      readonly kind: "rejected";
      readonly commandId: string;
      readonly reason: string;
      /**
       * Whether the command is one the peer will never run.
       *
       * It is reported separately from a failure that might, because the two
       * mean different things to a caller: an unsupported command is a dead
       * end, and a failure may not be.
       */
      readonly unsupported?: boolean;
    }
  | { readonly kind: "timeout"; readonly commandId: string; readonly reason: string };

/** Frames the host receives from the extension, exposed via the session. */
export interface BrowserBridgeSessionEvents {
  /** A `targets` frame arrived. The current target list replaces the prior. */
  targets: (browserId: string, targets: readonly BrowserBridgeBridgeTargetExport[]) => void;
  /** A `frame` arrived carrying an image. */
  frame: (image: BrowserBridgeBridgeImageFrameExport) => void;
  /** The session was closed. */
  closed: (reason: BrowserBridgeSessionCloseReason) => void;
  /** The session is fully open and the host can send commands. */
  ready: () => void;
}

/** The minimum `WebuiBrowserBridgeTarget` shape other modules consume. */
export interface BrowserBridgeBridgeTargetExport {
  readonly browserId: string;
  readonly targetId: string;
  readonly title: string;
  readonly url: string;
  readonly faviconUrl?: string;
  readonly generation: number;
}

/** The minimum `WebuiBrowserBridgeImageFrame` shape other modules consume. */
export interface BrowserBridgeBridgeImageFrameExport {
  readonly browserId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly data: string;
  readonly format: "png" | "jpeg";
  readonly sequence: number;
}

/** Why a session closed. */
export type BrowserBridgeSessionCloseReason =
  | { readonly kind: "remote" }
  | { readonly kind: "proof_failed" }
  /**
   * The peer presented an allowlisted origin but could not prove either
   * anchor. `reason` names which one was missing or wrong — a generic
   * "pairing failed" would leave the person unable to tell "paste your
   * installation key" from "your host rotated and you already hold the old
   * one".
   */
  | { readonly kind: "pairing_refused"; readonly reason: BrowserBridgeProofRefusal }
  | { readonly kind: "switched_off" }
  | { readonly kind: "store_unavailable" }
  | { readonly kind: "host_revoked" }
  /**
   * The surface is already served by another browser.
   *
   * A surface is one browser. A second live session on the same surface would
   * be a browser the host cannot address — the panel and the tools have one
   * provider per surface — so the second connection is refused rather than
   * allowed to take the surface away from the first.
   */
  | { readonly kind: "surface_busy" }
  | { readonly kind: "host_error"; readonly error: string };

/** The session's dependencies. */
export interface BrowserBridgeSessionOptions {
  /**
   * The pairings this peer's identity is admitted on.
   *
   * Usually one. More than one is possible, and is not a mistake: an unpacked
   * build has a single identity, and a person who loads it in both Edge and
   * Chrome lists that identity on both surfaces. The identity therefore
   * cannot say which surface the peer is on — the peer's own `hello` names
   * the browser it runs in, and the pairing for that browser is the one that
   * authenticates it.
   */
  readonly pairings: readonly BrowserBridgePairing[];
  /** The underlying WebSocket the admission path handed us. */
  readonly socket: WebSocket;
  /**
   * Operation deadline in milliseconds — the bridge's "we still think it
   * might come back" window per the ADR. Defaults to 15 seconds.
   */
  readonly operationDeadlineMs?: number;
  /**
   * Liveness ping cadence.
   *
   * The session emits `ping` and awaits `pong` within one interval. A missed
   * pong means the socket looks open but the browser behind it is gone, so the
   * session closes — and the extension's reconnect ladder takes it from there.
   * The close is a transient retry at the system level, not a fatal error:
   * nothing is lost, because the peer's state lives in its own storage.
   */
  readonly pingIntervalMs?: number;
  /**
   * How long the peer has to open with a `hello`.
   *
   * A peer that never says anything holds an upgraded socket and the host's
   * attention for as long as it likes. The deadline bounds that.
   */
  readonly helloDeadlineMs?: number;
  /**
   * Wall-clock source; tests inject a deterministic clock.
   */
  readonly now?: () => number;
  /**
   * Sleep function; tests inject a deterministic sleeper.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The id the host assigns to the session. Surfaced in the `ready` frame
   * so the client can correlate events.
   */
  readonly sessionId: string;
}

/**
 * One connected extension. The session is an `EventEmitter` so wiring
 * code can subscribe to inbound events without rebuilding the registry for
 * each new piece of behaviour.
 */
export class BrowserBridgeSession extends EventEmitter {
  readonly sessionId: string;

  private readonly socket: WebSocket;
  private readonly operationDeadlineMs: number;
  private readonly pingIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly helloDeadlineMs: number;
  /** The timer that closes a session whose peer never says hello. */
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  /** The timer that sends the liveness ping. */
  private livenessTimer: ReturnType<typeof setTimeout> | undefined;
  /** The pairings this peer's identity is admitted on. */
  private readonly candidatePairings: readonly BrowserBridgePairing[];
  /** The pairing this session authenticates against, once the peer named its browser. */
  private resolvedPairing: BrowserBridgePairing | undefined;

  /** The current challenge nonce, or `undefined` while the session is open. */
  private activeChallenge: WebuiBrowserBridgeChallenge | undefined;
  /** Whether the session has been fully admitted. */
  private admitted = false;
  /** The hello frame the extension opens with, cached so the pairing can run. */
  private helloFrame:
    | {
        readonly publicKey?: WebuiBrowserBridgeEcdhPublicKey;
        /** The browser the peer says it runs in. */
        readonly browser: string;
      }
    | undefined;
  /** Why the session closed, captured for `closed` emission. */
  private closeReason: BrowserBridgeSessionCloseReason | undefined;
  /** The set of command ids awaiting an `input-result` reply. */
  private readonly inflight = new Map<
    string,
    { resolve: (outcome: BrowserBridgeCommandOutcome) => void; reject: (error: Error) => void; deadline: number }
  >();
  /** Ping nonce → resolver. A pong answers the latest ping. */
  private readonly pendingPings = new Map<string, () => void>();
  /** The counter behind the DevTools command ids. */
  private cdpCommandCounter = 0;
  /** The counter behind the liveness pings' nonces. */
  private pingCounter = 0;

  constructor(options: BrowserBridgeSessionOptions) {
    super();
    this.candidatePairings = options.pairings;
    this.socket = options.socket;
    this.sessionId = options.sessionId;
    this.operationDeadlineMs =
      options.operationDeadlineMs ?? DEFAULT_OPERATION_DEADLINE_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.helloDeadlineMs = options.helloDeadlineMs ?? DEFAULT_HELLO_DEADLINE_MS;
    this.socket.on("message", (data, isBinary) => {
      void this.handleMessage(data, isBinary);
    });
    // The peer has to open with a `hello`. A socket that never does is closed
    // rather than left holding the connection.
    this.helloTimer = setTimeout(() => {
      this.close({ kind: "host_error", error: "the peer did not open with a hello frame" });
    }, this.helloDeadlineMs);
    this.helloTimer.unref?.();
    this.socket.on("close", () => {
      if (!this.closeReason) this.closeReason = { kind: "remote" };
      this.teardown();
    });
    this.socket.on("error", (error) => {
      if (!this.closeReason) this.closeReason = { kind: "host_error", error: error.message };
      this.teardown();
    });
    // The challenge is gated on the extension's `hello`: a `pair` frame has
    // to leave ahead of it, and that needs the extension's public key.
  }

  /**
   * Boots the post-hello handshake.
   *
   * The session is constructed on the upgrade, but the handshake waits until
   * the extension's `hello` arrives so the host can see the peer's ephemeral
   * public key before it seals anything — and so the host can settle which
   * surface the peer is on.
   */
  beginHelloGatedHandshake(): void {
    // The pairing is resolved from the peer's `hello`, so a handshake cannot
    // start before it. A caller that got here another way has nothing to
    // challenge against.
    if (!this.resolvedPairing) return;
    void this.sendChallenge();
  }

  /**
   * Issues the challenge. Deliberately sends **no** `pair` frame.
   *
   * The order here is the security property: proof first, credential second.
   * The host used to seal its credential to whatever key the `hello` frame
   * carried and send it immediately, which handed that credential to any local
   * process able to spoof the allowlisted `Origin` header — the origin proves
   * nothing about the peer behind it. Nothing is handed over now until the
   * peer has proved possession of the installation key or of a credential this
   * host already issued; `handleProof` sends the `pair` frame, and only then.
   */
  private async sendChallenge(): Promise<void> {
    const hello = this.helloFrame;
    if (!hello) return;
    if (this.closeReason) return;
    try {
      const challenge = await this.activePairing.issueChallenge();
      this.activeChallenge = challenge;
      this.sendFrameOrClose(challenge);
    } catch (error) {
      if (error instanceof PairingSwitchedOffError) {
        this.close({ kind: "switched_off" });
        return;
      }
      this.close({ kind: "host_error", error: errorMessage(error) });
    }
  }

  /**
   * Whether the session is fully admitted and the host may send commands.
   */
  get isAdmitted(): boolean {
    return this.admitted;
  }

  /**
   * The pairing this session authenticates against.
   *
   * `undefined` until the peer has named the browser it runs in: a peer that
   * has not said which browser it is has not said which pairing it is. The
   * pairing is resolved once and never changes — a session cannot migrate
   * from one surface to another.
   */
  get pairing(): BrowserBridgePairing | undefined {
    return this.resolvedPairing;
  }

  /**
   * The surface this session belongs to, once the peer has named its browser.
   */
  get surface(): WebuiBridgeBrowserSurface | undefined {
    return this.resolvedPairing?.surface;
  }

  /**
   * The resolved pairing, for the paths that run only after the resolution.
   *
   * Every use of it is downstream of the `hello` that resolved it: the
   * challenge, the proof and the sealing all happen after that, and the
   * teardown only forgets a challenge that was issued. A throw here would
   * therefore mean a path that runs before the resolution, which is a bug
   * rather than a state the wire can produce.
   */
  private get activePairing(): BrowserBridgePairing {
    if (!this.resolvedPairing) {
      throw new Error("browser bridge: the pairing was used before it was resolved");
    }
    return this.resolvedPairing;
  }

  /**
   * Picks the pairing this peer authenticates against.
   *
   * The peer's identity can be admitted on more than one surface, so the
   * identity alone is not enough to say which one it is: the peer names the
   * browser it runs in, and the host answers with the pairing for that
   * browser. A peer that names a browser this host does not know is refused,
   * rather than attached to whichever pairing happened to come first in the
   * list — which would put a Chrome browser on the Edge pairing, and report
   * the Edge surface as connected while the person is looking at Chrome.
   *
   * **The name selects the secret; it does not substitute for it.** Each
   * surface has its own installation key and its own credential, and the
   * challenge this pairing issues is verified against that surface's own
   * secret. A peer that claims to be Edge and answers with the Chrome
   * surface's installation key is refused with `installation_key_mismatch`,
   * whatever it called itself. The name only says *which* secret the peer has
   * to prove; it cannot produce one.
   */
  #resolvePairing(claimedBrowser: string | undefined): boolean {
    const match = claimedBrowser
      ? this.candidatePairings.find((pairing) => pairing.surface === claimedBrowser)
      : undefined;
    if (!match) {
      this.close({ kind: "pairing_refused", reason: "unknown_browser" });
      return false;
    }
    this.resolvedPairing = match;
    return true;
  }

  /** Why the session closed, if it has. */
  get lastCloseReason(): BrowserBridgeSessionCloseReason | undefined {
    return this.closeReason;
  }

  /**
   * Send an input command and wait for the extension's reply. The deadline
   * is per the bridge's "we still think it might come back" window — when
   * it expires we report a timeout, not a refusal. A reply that names the
   * same `commandId` with `accepted: false` is reported as a rejection
   * WITHOUT retry, since the extension has spoken and there is nothing to
   * recover.
   */
  async sendInput(
    command: WebuiBrowserBridgeInputCommand,
    options?: { readonly deadlineMs?: number },
  ): Promise<BrowserBridgeCommandOutcome> {
    if (!this.admitted) {
      return {
        kind: "timeout",
        commandId: commandIdOf(command),
        reason: "session is not yet admitted",
      };
    }
    if (this.inflight.size >= MAX_INFLIGHT_COMMANDS) {
      return {
        kind: "rejected",
        commandId: commandIdOf(command),
        reason: "too many in-flight commands on this session",
      };
    }
    const commandId = commandIdOf(command);
    const deadline = options?.deadlineMs ?? this.operationDeadlineMs;
    const deadlineAt = this.now() + deadline;
    const result = await withBridgeOperationRetry<BrowserBridgeCommandOutcome>(
      (attempt) => this.singleAttempt(commandId, command, attempt, deadlineAt),
      { deadlineMs: deadline, now: this.now, sleep: this.sleep },
    );
    if (result.kind === "timeout" && result.commandId === commandId) {
      return { kind: "timeout", commandId, reason: result.reason };
    }
    return result;
  }

  /**
   * Send a raw DevTools command and wait for the extension's reply.
   *
   * The deadline, the in-flight cap and the retry policy are the ones the
   * input path uses: a command is a command, and the only difference is what
   * the extension does with it. A refusal is terminal — the extension has
   * spoken, and there is nothing to recover by asking again.
   */
  async sendCdp(
    command: {
      readonly targetId: string;
      readonly generation: number;
      readonly method: string;
      readonly params: Record<string, unknown>;
    },
    options?: { readonly deadlineMs?: number },
  ): Promise<BrowserBridgeCommandOutcome> {
    const commandId = this.nextCdpCommandId();
    if (!this.admitted) {
      return { kind: "timeout", commandId, reason: "session is not yet admitted" };
    }
    if (this.inflight.size >= MAX_INFLIGHT_COMMANDS) {
      return {
        kind: "rejected",
        commandId,
        reason: "too many in-flight commands on this session",
      };
    }
    const deadline = options?.deadlineMs ?? this.operationDeadlineMs;
    const deadlineAt = this.now() + deadline;
    const result = await withBridgeOperationRetry<BrowserBridgeCommandOutcome>(
      (attempt) => this.singleCdpAttempt(commandId, command, attempt, deadlineAt),
      { deadlineMs: deadline, now: this.now, sleep: this.sleep },
    );
    if (result.kind === "timeout" && result.commandId === commandId) {
      return { kind: "timeout", commandId, reason: result.reason };
    }
    return result;
  }

  private nextCdpCommandId(): string {
    this.cdpCommandCounter += 1;
    return `cdp-${this.cdpCommandCounter}`;
  }

  private async singleCdpAttempt(
    commandId: string,
    command: {
      readonly targetId: string;
      readonly generation: number;
      readonly method: string;
      readonly params: Record<string, unknown>;
    },
    _attempt: number,
    deadlineAt: number,
  ): Promise<
    | { readonly kind: "success"; readonly value: BrowserBridgeCommandOutcome }
    | { readonly kind: "transient"; readonly message: string }
    | { readonly kind: "terminal"; readonly reason: "refused" | "cancelled" | "unknown"; readonly message: string }
  > {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) {
      return { kind: "terminal", reason: "unknown", message: "deadline already elapsed" };
    }
    try {
      this.sendFrame({ kind: "cdp", commandId, ...command });
    } catch (error) {
      return { kind: "transient", message: errorMessage(error) };
    }
    const outcome = await new Promise<BrowserBridgeCommandOutcome>((resolve, reject) => {
      this.inflight.set(commandId, { resolve, reject, deadline: deadlineAt });
    });
    // A refusal is an **answer**, not a transport failure. The extension has
    // spoken, and the caller — the provider — turns that answer into the
    // stable error code the contract promises. Reporting it as terminal here
    // throws it past the provider as a generic failure, and the caller loses
    // the difference between "the peer refused" and "the peer could not be
    // reached" — which is the difference between a dead end and a retry.
    return { kind: "success", value: outcome };
  }

  private async handleCdpResult(
    frame: {
      readonly kind: "cdp-result";
      readonly commandId: string;
      readonly accepted: boolean;
      readonly result?: unknown;
      readonly error?: string;
      readonly unsupported?: boolean;
    },
  ): Promise<void> {
    const pending = this.inflight.get(frame.commandId);
    if (!pending) return;
    this.inflight.delete(frame.commandId);
    if (frame.accepted) {
      pending.resolve({
        kind: "accepted",
        commandId: frame.commandId,
        result: frame.result,
      });
      return;
    }
    pending.resolve({
      kind: "rejected",
      commandId: frame.commandId,
      reason: frame.error ?? "the extension refused the command",
      ...(frame.unsupported ? { unsupported: true } : {}),
    });
  }

  /**
   * Send a `closed` frame and terminate the underlying socket with the
   * given reason. Idempotent.
   */
  close(reason: BrowserBridgeSessionCloseReason): void {
    if (this.closeReason) return;
    this.closeReason = reason;
    const body: WebuiBrowserBridgeHostFrame = { kind: "closed", reason: describeClose(reason) };
    try {
      this.sendFrame(body);
    } catch {
      // The socket may already be torn down; the close itself will follow.
    }
    this.teardown();
  }

  /* ---------------------------------------------------------------------- */
  /* Wire protocol                                                          */
  /* ---------------------------------------------------------------------- */

  private async handleMessage(data: RawData, _isBinary: boolean): Promise<void> {
    const text = messageToText(data);
    if (text === undefined) {
      this.close({ kind: "host_error", error: "non-text frame" });
      return;
    }
    let frame: WebuiBrowserBridgeClientFrame;
    try {
      frame = JSON.parse(text) as WebuiBrowserBridgeClientFrame;
    } catch {
      this.close({ kind: "host_error", error: "invalid JSON frame" });
      return;
    }
    switch (frame.kind) {
      case "proof":
        await this.handleProof(frame);
        break;
      case "hello":
        // Capture the public key and the browser once. A second `hello` is
        // ignored: the session's identity is the first one, and any later
        // frame would either say the same thing or be a downgrade.
        if (!this.helloFrame) {
          if (this.helloTimer) {
            clearTimeout(this.helloTimer);
            this.helloTimer = undefined;
          }
          this.helloFrame = {
            publicKey: isEcdhPublicKey(frame.publicKey) ? frame.publicKey : undefined,
            browser: frame.browser,
          };
          // The pairing is settled here, before the challenge goes out: the
          // challenge is signed by the pairing, so the host has to know which
          // pairing this peer is before it asks the peer to prove anything.
          if (!this.#resolvePairing(frame.browser)) break;
          this.beginHelloGatedHandshake();
        }
        break;
      case "targets":
        this.emit(
          "targets",
          frame.targets[0]?.browserId ?? "",
          frame.targets.map(toTargetExport),
        );
        break;
      case "frame":
        this.emit("frame", toFrameExport(frame.frame));
        break;
      case "input-result":
        await this.handleInputResult(frame);
        break;
      case "cdp-result":
        await this.handleCdpResult(frame);
        break;
      case "pong":
        this.handlePong(frame.nonce);
        break;
      default: {
        const exhaustive: never = frame;
        void exhaustive;
      }
    }
  }

  private async handleProof(proof: WebuiBrowserBridgeProof): Promise<void> {
    if (!this.activeChallenge) {
      this.close({ kind: "proof_failed" });
      return;
    }
    // The proof carries no `algorithm` field — the algorithm is implied by
    // the challenge it answers. (`verifyWebuiBrowserBridgeProof` already
    // runs HMAC-SHA256 over the canonical material.) A future-proof design
    // might pin the algorithm again here; the contract does not require it
    // today and we follow the wire.
    const challengeNonce = this.activeChallenge.nonce;
    const outcome = await this.activePairing.verifyProof(proof);
    if (outcome.kind === "refused") {
      // Forget the nonce so it cannot be replayed later; the extension gets
      // one shot per challenge and the host does not chase further.
      this.activePairing.forgetChallenge(challengeNonce);
      this.activeChallenge = undefined;
      // The reason is specific on purpose: "pairing proof failed" does not
      // tell the person whether to paste an installation key, re-paste one,
      // or fix a host that no longer holds their credential.
      this.close({ kind: "pairing_refused", reason: outcome.reason });
      return;
    }
    this.activeChallenge = undefined;
    if (outcome.kind === "installation_key") {
      // The peer proved possession of the installation key — the only thing a
      // local process cannot hold — so it is now entitled to the credential.
      // It is sent here, after the proof, and nowhere earlier in the flow.
      const handedOver = await this.deliverPairingCredential();
      if (!handedOver) return;
    }
    // `pairing_credential`: the peer proved a credential this host issued and
    // the peer already holds, so no `pair` frame is sent. Re-sealing it would
    // put the credential on the wire again for no gain, and would blur the one
    // property that matters here: a `pair` frame is sent only to a peer that
    // has proved the installation key.
    this.admitted = true;
    this.startLiveness();
    const ready: WebuiBrowserBridgeHostFrame = { kind: "ready", sessionId: this.sessionId };
    try {
      this.sendFrame(ready);
      this.emit("ready");
    } catch (error) {
      this.close({ kind: "host_error", error: errorMessage(error) });
    }
  }

  /**
   * Seals the pairing credential to this peer's ephemeral public key and sends
   * it. Returns `false` when the session has already been closed, so the
   * caller stops rather than sending `ready` on a dead socket.
   */
  private async deliverPairingCredential(): Promise<boolean> {
    const hello = this.helloFrame;
    if (!hello?.publicKey) {
      // The peer proved the installation key but sent no key to seal to, so
      // it cannot be given the credential. Refused rather than admitted: the
      // handshake is incomplete, and "admitted" would be a lie.
      this.close({ kind: "pairing_refused", reason: "no_peer_public_key" });
      return false;
    }
    const sealed = await this.activePairing.sealCredentialForExtension(hello.publicKey);
    if (sealed.kind !== "sealed") {
      this.close({ kind: "switched_off" });
      return false;
    }
    this.sendFrameOrClose({
      kind: "pair",
      keyId: sealed.keyId,
      publicKey: sealed.publicKey,
      salt: sealed.salt,
      payload: sealed.payload,
    });
    return !this.closeReason;
  }

  private async handleInputResult(
    frame: { readonly kind: "input-result"; readonly commandId: string; readonly accepted: boolean; readonly error?: string },
  ): Promise<void> {
    const pending = this.inflight.get(frame.commandId);
    if (!pending) return;
    this.inflight.delete(frame.commandId);
    if (frame.accepted) {
      pending.resolve({ kind: "accepted", commandId: frame.commandId });
    } else {
      pending.resolve({
        kind: "rejected",
        commandId: frame.commandId,
        reason: frame.error ?? "extension refused the command",
      });
    }
  }

  private async singleAttempt(
    commandId: string,
    command: WebuiBrowserBridgeInputCommand,
    _attempt: number,
    deadlineAt: number,
  ): Promise<
    | { readonly kind: "success"; readonly value: BrowserBridgeCommandOutcome }
    | { readonly kind: "transient"; readonly message: string }
    | { readonly kind: "terminal"; readonly reason: "refused" | "cancelled" | "unknown"; readonly message: string }
  > {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) {
      return { kind: "terminal", reason: "unknown", message: "deadline already elapsed" };
    }
    try {
      this.sendFrame({ kind: "input", commandId, command });
    } catch (error) {
      return { kind: "transient", message: errorMessage(error) };
    }
    const outcome = await new Promise<BrowserBridgeCommandOutcome>((resolve, reject) => {
      this.inflight.set(commandId, {
        resolve,
        reject,
        deadline: deadlineAt,
      });
    });
    // A refusal is an **answer**, not a transport failure. The extension has
    // spoken, and the caller — the provider — turns that answer into the
    // stable error code the contract promises. Reporting it as terminal here
    // throws it past the provider as a generic failure, and the caller loses
    // the difference between "the peer refused" and "the peer could not be
    // reached" — which is the difference between a dead end and a retry.
    return { kind: "success", value: outcome };
  }

  private sendFrame(frame: WebuiBrowserBridgeHostFrame): void {
    const text = JSON.stringify(frame);
    // The frame may carry opaque identifiers; we don't log the body. The
    // brief forbids writing credentials to logs, but the broader rule is
    // "never put session material into a log line", and we apply it to
    // every frame regardless of whether it is sensitive.
    this.socket.send(text);
  }

  /**
   * Same as `sendFrame`, but a throw on a closed socket closes the session
   * with a host error rather than escaping into an unhandled rejection.
   * Used for the gated handshake path so a race against a peer that closed
   * straight after `hello` ends in a clean teardown.
   */
  private sendFrameOrClose(frame: WebuiBrowserBridgeHostFrame): void {
    try {
      this.sendFrame(frame);
    } catch (error) {
      this.close({ kind: "host_error", error: errorMessage(error) });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  private handlePong(nonce: string): void {
    const resolver = this.pendingPings.get(nonce);
    if (resolver) {
      this.pendingPings.delete(nonce);
      resolver();
    }
  }

  /**
   * Starts the liveness ping.
   *
   * A WebSocket can stay open long after the browser behind it is gone — the
   * extension's worker is terminated, the profile is closed, the machine
   * sleeps. The socket's close is then the only signal, and it can take a
   * while to arrive. A ping the peer does not answer is the faster signal,
   * and the extension's reconnect ladder is what picks the session back up.
   */
  private startLiveness(): void {
    if (this.livenessTimer || this.closeReason) return;
    const tick = (): void => {
      if (this.closeReason) return;
      void this.sendPing();
      this.livenessTimer = setTimeout(tick, this.pingIntervalMs);
      this.livenessTimer.unref?.();
    };
    this.livenessTimer = setTimeout(tick, this.pingIntervalMs);
    this.livenessTimer.unref?.();
  }

  /**
   * Sends one ping and waits for its pong.
   *
   * A missed pong closes the session. The peer is not told it is wrong: the
   * socket is the thing that failed, and the extension reconnects on its own.
   */
  private async sendPing(): Promise<void> {
    if (this.closeReason) return;
    const nonce = `ping-${this.pingCounter++}`;
    let answered = false;
    const answeredPromise = new Promise<void>((resolve) => {
      this.pendingPings.set(nonce, () => {
        answered = true;
        resolve();
      });
    });
    try {
      this.sendFrameOrClose({ kind: "ping", nonce });
    } catch {
      return;
    }
    await Promise.race([answeredPromise, this.sleep(this.pingIntervalMs)]);
    this.pendingPings.delete(nonce);
    if (!answered && !this.closeReason) {
      this.close({
        kind: "host_error",
        error: "the peer did not answer a liveness ping",
      });
    }
  }

  private teardown(): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
    }
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = undefined;
    }
    if (!this.admitted && !this.closeReason) {
      this.closeReason = { kind: "remote" };
    }
    if (this.activeChallenge) {
      // The optional call: a challenge is only ever issued after the pairing
      // was resolved, so the pairing is there — but a teardown must never be
      // the thing that throws.
      this.resolvedPairing?.forgetChallenge(this.activeChallenge.nonce);
      this.activeChallenge = undefined;
    }
    for (const [commandId, pending] of this.inflight.entries()) {
      pending.resolve({ kind: "timeout", commandId, reason: "session closed before reply" });
    }
    this.inflight.clear();
    for (const resolver of this.pendingPings.values()) resolver();
    this.pendingPings.clear();
    try {
      this.socket.terminate();
    } catch {
      // already gone
    }
    const reason = this.closeReason ?? { kind: "remote" };
    this.emit("closed", reason);
  }
}

/** Look at the math: a typical retry is `delay = 250ms * 2^attempt`, capped. */
void bridgeOperationReconnectDelayMs;

/** Wrap an error without leaking the message text into a log line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? "unknown error" : String(error);
}

/** Decode a `RawData` to UTF-8 text. */
function messageToText(data: RawData): string | undefined {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Compute a deterministic command id from an input command. */
function commandIdOf(command: WebuiBrowserBridgeInputCommand): string {
  // We don't need a cryptographic id; a counter would do. Keeping it human
  // readable makes wire captures (during bring-up) obvious in the logs.
  switch (command.kind) {
    case "pointer":
      return `ptr:${command.targetId}:${command.generation}:${command.action ?? "click"}:${command.x},${command.y}:${command.clickCount ?? ""}:${command.deltaX ?? ""},${command.deltaY ?? ""}`;
    case "key":
      return `key:${command.targetId}:${command.generation}:${command.key}:${command.modifiers.join("+")}`;
    case "text":
      return `text:${command.targetId}:${command.generation}:${command.text}`;
  }
}

/** Convert an inbound target to a less-coupled export shape. */
function toTargetExport(target: WebuiBrowserBridgeTarget): BrowserBridgeBridgeTargetExport {
  return {
    browserId: target.browserId,
    targetId: target.targetId,
    title: target.title,
    url: target.url,
    ...(target.faviconUrl ? { faviconUrl: target.faviconUrl } : {}),
    generation: target.generation,
  };
}

/** Convert an inbound image frame. */
function toFrameExport(frame: WebuiBrowserBridgeImageFrame): BrowserBridgeBridgeImageFrameExport {
  return {
    browserId: frame.browserId,
    targetId: frame.targetId,
    generation: frame.generation,
    data: frame.data,
    format: frame.format,
    sequence: frame.sequence,
  };
}

/** Map a close reason to a wire-safe string. */
function describeClose(reason: BrowserBridgeSessionCloseReason): string {
  switch (reason.kind) {
    case "remote":
      return "remote closed";
    case "proof_failed":
      return "pairing proof failed";
    case "pairing_refused":
      return describeRefusal(reason.reason);
    case "switched_off":
      return "browser switch turned off";
    case "store_unavailable":
      return "credential store unavailable";
    case "host_revoked":
      return "host revoked the session";
    case "surface_busy":
      return "this browser surface is already served by another browser";
    case "host_error":
      return `host error: ${reason.error}`;
  }
}

/**
 * The refusal text the extension shows and logs.
 *
 * Each line names the missing thing rather than reporting a generic failure,
 * because each has a different fix. These strings are part of the wire
 * contract the extension reads, so they are written out in full rather than
 * composed from a code.
 */
function describeRefusal(reason: BrowserBridgeProofRefusal): string {
  switch (reason) {
    case "switched_off":
      return "pairing refused: the browser switch for this surface is turned off";
    case "unknown_nonce":
      return "pairing refused: the proof answers a challenge this host did not issue, or one already answered";
    case "unknown_key_id":
      return "pairing refused: the proof names a key this host does not hold for this surface";
    case "installation_key_mismatch":
      return "pairing refused: this browser's installation key does not match this host — paste the key from the WebUI Settings into the extension options page again";
    case "pairing_credential_mismatch":
      return "pairing refused: this browser holds a pairing credential this host no longer accepts — the host has been re-provisioned, so paste the installation key again";
    case "no_peer_public_key":
      return "pairing refused: this browser proved the installation key but sent no public key, so the credential cannot be sealed to it";
    case "unknown_browser":
      return "pairing refused: this browser is not registered on this host — the host does not accept this extension for the browser it is running in";
  }
}

// Reference symbols that would otherwise be elided by tree-shaking.
void BridgeOperationError;

/**
 * Whether `value` is a structurally valid ECDH public-key JWK.
 *
 * Validation is structural rather than the full JOSE one — `webcrypto`'s own
 * `importKey` would catch the rest, but doing it here turns "host refuses to
 * pair without a public key" from a negative inference into an explicit
 * branch in the right place.
 */
function isEcdhPublicKey(value: unknown): value is WebuiBrowserBridgeEcdhPublicKey {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kty === "EC" &&
    candidate.crv === "P-256" &&
    typeof candidate.x === "string" &&
    candidate.x.length > 0 &&
    typeof candidate.y === "string" &&
    candidate.y.length > 0
  );
}
