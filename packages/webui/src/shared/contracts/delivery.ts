// The delivery port: what one attempt hands a transport, and what it reports
// back to whoever owns the record.
//
// These declarations live in `shared/` for a structural reason. The loop in
// `client/conversation/stream-loop.ts` is a mechanism and must import nothing
// from Turn or Transcript; the command views that publish a `createSink` factory
// live in the `contracts` layer, which the package's direction matrix lets reach
// `shared` and nothing else. `shared/contracts/` is therefore the one home both
// sides can name, and it is already where `WebuiStreamFrame` — the other half of
// this conversation — is declared.
//
// Nothing here says what a frame *means* or what a user should be told. That is
// the adapter's: the loop reports the mechanism's own facts, and the Turn-owned
// sink decides the consequence.

import type { WebuiAttachmentInput } from "./messages.js";
import type { WebuiStreamFrame } from "./stream.js";

/**
 * What a frame asks the loop to do next.
 *
 * The mechanism's own word for "the server says your view is too far behind".
 * The recognition itself is the adapter's — it knows what a payload means — but
 * the *consequence* is the loop's: reload history and start a fresh
 * subscription. Naming it here rather than importing the view's own enum keeps
 * one place that knows what the consequence is.
 */
export type WebuiDeliverySignal =
  | { readonly kind: "continue" }
  | { readonly kind: "reload_history" };

/**
 * How an attempt ended, when it ended badly.
 *
 * - `sink` — a callback into the aggregate threw. If frames had already been
 *   accepted, what the user can see may no longer match what the turn produced;
 *   that is a fact about the user's data and the adapter decides how to say it.
 * - `transport` — the send or resume dropped. The frames that arrived are
 *   exactly the frames the turn produced up to the drop; nothing is missing that
 *   we know of, so this is an ordinary refusal.
 * - `recovery` — reloading history after a resume overflow failed. Also ordinary:
 *   the visible transcript is the last good one, not a truncated one.
 */
export type WebuiDeliveryFailureOrigin = "sink" | "transport" | "recovery";

/** Why a delivery attempt ended badly. */
export interface WebuiDeliveryFailure {
  readonly origin: WebuiDeliveryFailureOrigin;
  readonly reason: string;
  /**
   * How many frames the aggregate had already accepted when this failed.
   *
   * Reported, not interpreted. It is the difference between "the transcript may
   * be incomplete" and "the request failed", and only the adapter knows which of
   * the two a user should be told.
   */
  readonly acceptedFrames: number;
}

/**
 * The loop's half of a delivery attempt.
 *
 * Every callback is optional where the loop has a fallback, and every one may
 * throw: the loop contains those throws and reports the attempt as a `sink`
 * failure, because a store that cannot record a frame is exactly the case where
 * the turn must not silently look complete.
 */
export interface WebuiDeliverySink {
  /**
   * Take ownership of the attempt, once.
   *
   * Returns the generation claimed, so the caller can still recognise its own
   * writes after a later attempt supersedes it. A repeat claim returns the first
   * generation: a second claim would mint a new one and write it, which is the
   * whole escalation the fence exists to stop.
   */
  claim(owner: string, attachId?: string): number | undefined;
  /** One frame the transport accepted. */
  accept(frame: WebuiStreamFrame): void;
  /** The attempt is producing frames. */
  begin(): void;
  /** The attempt is recovering — about to resume or reload. */
  recovering(): void;
  /**
   * Attaching to a turn this client did not start: here is the history page the
   * transport just read, so the aggregate can seed what the user should see.
   */
  anchor(page: unknown): void;
  /** The server says our view fell behind: here is the authoritative history. */
  replace(page: unknown): void;
  /** The attempt finished normally. */
  complete(): void;
  /** The attempt ended badly, and this is which kind of badly. */
  fail(failure: WebuiDeliveryFailure): void;
  /**
   * Release ownership. Must survive every other callback being broken: a stuck
   * lease is a spinner that never goes away, so cleanup cannot be governed by
   * the rule that protects the render path.
   */
  release(): void;
}

/** What the loop needs from the outside world to run one attempt. */
export interface WebuiDeliveryTransports {
  readonly sendMessage?: (
    request: {
      readonly id: string;
      readonly content: string;
      readonly clientIntent?: string;
      readonly attachments?: readonly WebuiAttachmentInput[];
    },
    onFrame: (frame: WebuiStreamFrame) => void,
  ) => Promise<void>;
  readonly resumeSession?: (
    request: {
      readonly id: string;
      readonly afterCursor?: string;
      readonly afterMsgId?: string;
    },
    onFrame: (frame: WebuiStreamFrame) => void,
  ) => Promise<void>;
  /**
   * Read this session's history.
   *
   * Returns the raw page. Projecting it is the adapter's work: the loop has no
   * opinion about which messages a user should see when attaching to a turn it
   * did not start, and guessing here would put that decision in two places.
   */
  readonly loadHistory?: (request: { readonly id: string }) => Promise<unknown>;
  /**
   * Decide whether a frame asks for a history reload.
   *
   * Injected because recognising a payload is the adapter's knowledge; the
   * consequence of it is the loop's.
   */
  readonly classify?: (frame: WebuiStreamFrame) => WebuiDeliverySignal;
}

export interface WebuiDeliveryArgs {
  readonly sessionId: string;
  /** Omitted when attaching to a turn the server started on its own. */
  readonly message?: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
  /** The turn being attached to, so the attempt starts out identified. */
  readonly attachId?: string;
  /** Resume point to reuse instead of re-anchoring from history. */
  readonly afterCursor?: string;
}

export interface WebuiDeliveryDeps extends WebuiDeliveryTransports {
  /**
   * Used only when `classify` was not supplied, so a caller that always attaches
   * does not have to inject a recogniser it will never be asked about.
   */
  readonly classify?: (frame: WebuiStreamFrame) => WebuiDeliverySignal;
}
