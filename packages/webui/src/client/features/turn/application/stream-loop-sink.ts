// The Turn-owned delivery sink.
//
// This is the only module that turns a delivery attempt's frames, history and
// outcomes into changes to the session's stream record. The loop in
// `client/conversation/stream-loop.ts` says "this frame arrived" and "this
// attempt failed because the aggregate threw"; everything a user *sees* is
// decided here, where the aggregate's own vocabulary lives:
//
//   - what a phase is, and when one replaces another;
//   - which messages an attaching attempt should seed;
//   - that a `sink` failure after accepted frames means the transcript may be
//     short, while a `transport` or `recovery` failure does not.
//
// That last one is why the loop reports an origin instead of a message. Both
// facts — how the attempt ended, and how many frames the aggregate had already
// accepted — are known to the loop; neither is the loop's to interpret. The
// interpretation lives with the record it describes.
//
// The generation fence travels with the writer: the sink is built from the
// writer's own `setStream`, so a superseded attempt cannot write over the turn
// that replaced it.

import type { WebuiStreamFrame } from "../../../../shared/contracts/stream.js";
import type {
  WebuiDeliveryFailure,
  WebuiDeliverySink,
} from "../../../../shared/contracts/delivery.js";
import { isWebuiLeaseGenerationCurrent } from "../../../conversation/stream-lease.js";
import type {
  WebuiClientMessage,
  WebuiClientMessageLoader,
} from "../../transcript/contracts/message-view.js";
import type {
  WebuiStreamState,
  WebuiStreamSubscription,
} from "../contracts/stream-state.js";
import type { WebuiStreamLoopExtra } from "../contracts/stream-loop.js";
import { streamRecoveryProjection } from "../projection/stream-recovery.js";
import { streamStateBundle } from "./stream-state-bundle.js";

/**
 * Applies a {@link WebuiStreamLoopExtra} to a stream state.
 *
 * The declared fields are copied one by one rather than spread, so an
 * undeclared key — from a plain-JavaScript caller or a cast — cannot reach any
 * other field of the slice. A field absent from `extra` is left untouched, which
 * keeps the "seed, do not patch" semantics the spread had for these fields.
 */
export function applyWebuiStreamLoopExtra(
  current: WebuiStreamState,
  extra: WebuiStreamLoopExtra,
): WebuiStreamState {
  const has = (key: keyof WebuiStreamLoopExtra): boolean =>
    Object.prototype.hasOwnProperty.call(extra, key);
  return {
    ...current,
    ...(has("contextUsage") ? { contextUsage: extra.contextUsage } : {}),
    ...(has("processingStartedAtMs")
      ? { processingStartedAtMs: extra.processingStartedAtMs }
      : {}),
    ...(has("resumeRequired") ? { resumeRequired: extra.resumeRequired } : {}),
    ...(has("refusal") ? { refusal: extra.refusal } : {}),
  };
}

/** The history page shape this adapter reads. The loop hands it over raw. */
interface HistoryPage {
  readonly messages?: readonly WebuiClientMessage[];
  readonly contextSnapshot?: Record<string, unknown>;
}

/**
 * Build the Turn-owned sink for one delivery attempt.
 *
 * `setStream` is the writer's own store update, and `bundle` is where the
 * generation counter, the frame reducer and the scoped release live. Both are
 * required here rather than reached for, so a caller that forgets one is a
 * compile error rather than a sink that silently reduces nothing.
 */
export function buildWebuiStreamLoopSink(
  setStream: (update: (current: WebuiStreamState) => WebuiStreamState) => void,
  bundle: {
    readonly nextSubscriptionGeneration: () => number;
    readonly reduceFrame: (
      state: WebuiStreamState,
      frame: WebuiStreamFrame,
    ) => WebuiStreamState;
    readonly releaseSubscription: (
      state: WebuiStreamState,
      scope?: { readonly generation?: number },
    ) => WebuiStreamState;
  } = streamStateBundle,
  options: { readonly clearRefusalOnAnchor?: boolean } = {},
): WebuiDeliverySink {
  const clearRefusalOnAnchor = options.clearRefusalOnAnchor ?? true;
  // Set when this sink claims ownership. Everything a superseded attempt writes —
  // a late chunk, a late completion, a stray "streaming" that would resurrect the
  // thinking spinner — is dropped here rather than in the shared reducer, because
  // the reducer cannot tell which attempt a frame came from.
  let generation: number | undefined;
  // Fencing is about *other* attempts, not about our own ownership still being
  // visible. A completion releases it mid-attempt and the attempt keeps working,
  // so the test is "am I still the newest claimer", not "do I still hold it".
  // Comparing against ownership instead would re-admit a superseded attempt the
  // moment the newer turn's completion cleared it.
  const mine = (current: WebuiStreamState): boolean =>
    isWebuiLeaseGenerationCurrent(current, generation);

  const refuse = (reason: string, transcriptIncomplete: boolean): void =>
    setStream((current) =>
      mine(current)
        ? { ...current, phase: "refused", refusal: reason, transcriptIncomplete }
        : current,
    );

  return {
    claim: (owner, attachId) => {
      const subscriptionOwner = owner as WebuiStreamSubscription["owner"];
      // Once and only once. A second claim would mint a new generation and write
      // it as the last claim, which is the escalation the fence exists to stop:
      // a superseded attempt still holding its own sink could take ownership back
      // from the turn that replaced it and then write `refused` over that turn's
      // state.
      if (generation !== undefined) return generation;
      const next = bundle.nextSubscriptionGeneration();
      generation = next;
      setStream((current) => ({
        ...current,
        lastClaimedGeneration: next,
        subscription: {
          owner: subscriptionOwner,
          generation: next,
          ...(attachId ? { turnId: attachId } : {}),
        },
      }));
      return next;
    },

    accept: (frame) =>
      setStream((current) =>
        mine(current) ? bundle.reduceFrame(current, frame) : current,
      ),

    begin: () =>
      setStream((current) => (mine(current) ? { ...current, phase: "streaming" } : current)),

    recovering: () =>
      setStream((current) =>
        mine(current) ? { ...current, phase: "reconnecting" } : current,
      ),

    /**
     * Seeding an attempt that attaches to a turn this client did not start.
     *
     * Older history is already served by the transcript's own page, so only the
     * latest user turn and everything after it is projected here. The loop hands
     * over the raw page because this decision — which messages a user should see
     * when joining a turn in progress — belongs with the record, not with the
     * thing that happens to be driving the attempt.
     */
    anchor: (page) => {
      const history = (page as HistoryPage | undefined)?.messages ?? [];
      let latestUserIndex = -1;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role === "user" || message.msgId.startsWith("msg-user-")) {
          latestUserIndex = index;
          break;
        }
      }
      const latestTurn = history.slice(
        latestUserIndex >= 0 ? latestUserIndex : Math.max(0, history.length - 1),
      );
      const anchored = latestTurn.map(streamRecoveryProjection.projectMessage);
      const startedAt = latestTurn.find((message) => message.role === "user")?.timestamp;
      const contextUsage = readContextUsage(page, anchored);
      setStream((current) => {
        if (!mine(current)) return current;
        return applyWebuiStreamLoopExtra(
          {
            ...current,
            messages: anchored,
            phase: "streaming",
          },
          {
            ...(contextUsage ? { contextUsage } : {}),
            processingStartedAtMs:
              typeof startedAt === "number" ? startedAt : Date.now(),
            resumeRequired: false,
            ...(clearRefusalOnAnchor ? { refusal: undefined } : {}),
          },
        );
      });
    },

    /**
     * Replacing the view after the server said it fell too far behind.
     *
     * No processing timestamp and no refusal reset: this is a mid-turn resync, and
     * pretending it is a fresh turn would drop the attempt's own progress.
     */
    replace: (page) => {
      const messages = ((page as HistoryPage | undefined)?.messages ?? []).map(
        streamRecoveryProjection.projectMessage,
      );
      setStream((current) =>
        mine(current) ? { ...current, messages } : current,
      );
    },

    complete: () =>
      setStream((current) => (mine(current) ? { ...current, phase: "done" } : current)),

    /**
     * The interpretation the loop deliberately does not make.
     *
     * A `sink` failure *after* accepted frames means the visible transcript may no
     * longer match what the turn produced — the writes failed, so what is on
     * screen is short of the truth. A `transport` or `recovery` failure is an
     * ordinary refusal even with frames accepted: those frames arrived, and what
     * is missing is the rest of the request, not the history already shown.
     */
    fail: (failure: WebuiDeliveryFailure) =>
      refuse(
        failure.reason,
        failure.origin === "sink" && failure.acceptedFrames > 0,
      ),

    release: () => {
      if (generation === undefined) return;
      setStream((current) => bundle.releaseSubscription(current, { generation }));
    },
  };
}

/**
 * The context usage a seeded turn should show.
 *
 * The page's own snapshot when it carries one, because that is the figure the
 * runtime computed; otherwise the latest figure among the messages we seeded.
 * Both transforms are the existing pure ones, re-used — the adapter owns the
 * *decision between them*, which is why it does not live in the loop.
 */
function readContextUsage(
  page: unknown,
  anchored: ReturnType<typeof streamRecoveryProjection.projectMessage>[],
): Record<string, unknown> | undefined {
  const snapshot = (page as HistoryPage | undefined)?.contextSnapshot;
  return snapshot
    ? streamRecoveryProjection.readContextUsageSnapshot(snapshot)
    : streamRecoveryProjection.latestContextUsage(anchored);
}

/** The message reader the seeding paths need, exposed for the loop's deps. */
export type { WebuiClientMessageLoader };
