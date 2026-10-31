// The delivery loop.
//
// One loop owns a delivery attempt from the first frame to its settlement: the
// cursor it last saw, which recovery to attempt when the transport drops, and
// the moment the attempt is over. It knows nothing about what a frame *means*.
//
// That separation is the point. The loop used to carry Turn and Transcript
// vocabulary — a phase, a message setter, a refusal string, a
// `transcriptIncomplete` flag — and imported their contracts to type them. So
// the mechanism could name the outcome a user sees, and "what does this frame
// change" was decided in two places: here, and again in the reducer the sink
// called. Worse, the loop had to decide *where the failure came from* to know
// whether the transcript might now be short, which is a question about the
// user's data that only the aggregate owns.
//
// So the loop says three things, in its own words:
//
//   - `accept(frame)` — the transport handed me this frame;
//   - `anchor`/`replace` — history arrived, here is the raw page;
//   - `fail(origin, reason, acceptedFrames)` — the attempt ended, and *how*.
//
// `fail`'s origin is the whole trick. A sink that threw after frames were
// accepted means the visible transcript may be short; a transport that dropped,
// or a history reload that failed, is an ordinary refusal even though frames
// had arrived — the frames were not lost, the *request* was. The loop knows which
// of the three happened because it is the one that observed them, so it reports
// the origin and the adapter decides what a user should be told. It never
// decides it here.
//
// Settlement is a void promise that never rejects: a sink whose every callback
// throws still has to settle, because the caller has a `finally` that would
// otherwise lose the turn's state.

import type {
  WebuiDeliveryArgs,
  WebuiDeliveryDeps,
  WebuiDeliveryFailure,
  WebuiDeliveryFailureOrigin,
  WebuiDeliverySignal,
  WebuiDeliverySink,
} from "../../shared/contracts/delivery.js";
import type { WebuiStreamFrame } from "../../shared/contracts/stream.js";

/**
 * Every callback the loop can make, named for the failure report.
 *
 * The list is the loop's own vocabulary. It has no "refuse", no "setPhase" and
 * no "setMessages" in it — which is how the aggregate's decisions stopped being
 * reachable from here.
 */
type DeliveryCallbackName =
  | "claim"
  | "accept"
  | "begin"
  | "recovering"
  | "anchor"
  | "replace"
  | "complete"
  | "fail";

interface DeliveryCallbackFailure {
  readonly label: DeliveryCallbackName;
  readonly error: Error;
}

function describeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Every callback, wrapped so a throw never escapes the loop.
 *
 * The first failure disables the rest: a half-broken aggregate must not
 * cascade into a dozen exceptions, and must not be able to record a *normal*
 * completion after it has already failed. `release` is deliberately outside this
 * rule — see {@link WebuiDeliverySink.release}.
 */
function guardedSink(sink: WebuiDeliverySink): {
  readonly safe: WebuiDeliverySink;
  readonly firstFailure: () => DeliveryCallbackFailure | undefined;
  readonly reportFailure: (failure: WebuiDeliveryFailure) => void;
} {
  let first: DeliveryCallbackFailure | undefined;
  const safe: WebuiDeliverySink = {
    claim: (owner, attachId) => {
      if (first) return undefined;
      try {
        return sink.claim(owner, attachId);
      } catch (error) {
        first = { label: "claim", error: describeError(error) };
        return undefined;
      }
    },
    accept: (frame) => {
      if (first) return;
      try {
        sink.accept(frame);
      } catch (error) {
        first = { label: "accept", error: describeError(error) };
      }
    },
    begin: () => {
      if (first) return;
      try {
        sink.begin();
      } catch (error) {
        first = { label: "begin", error: describeError(error) };
      }
    },
    recovering: () => {
      if (first) return;
      try {
        sink.recovering();
      } catch (error) {
        first = { label: "recovering", error: describeError(error) };
      }
    },
    anchor: (page) => {
      if (first) return;
      try {
        sink.anchor(page);
      } catch (error) {
        first = { label: "anchor", error: describeError(error) };
      }
    },
    replace: (page) => {
      if (first) return;
      try {
        sink.replace(page);
      } catch (error) {
        first = { label: "replace", error: describeError(error) };
      }
    },
    complete: () => {
      if (first) return;
      try {
        sink.complete();
      } catch (error) {
        first = { label: "complete", error: describeError(error) };
      }
    },
    fail: (failure) => {
      if (first) return;
      try {
        sink.fail(failure);
      } catch (error) {
        first = { label: "fail", error: describeError(error) };
      }
    },
    release: sink.release,
  };
  return {
    safe,
    firstFailure: () => first,
    reportFailure: (failure) => {
      // Direct, unwrapped. If `fail` is itself the broken callback this throws,
      // and the caller falls back to the console. The failure has been observed
      // by then, which is the part that matters.
      try {
        sink.fail(failure);
      } catch (error) {
        try {
          // eslint-disable-next-line no-console
          console.error("[webui] delivery failure could not be recorded:", failure.reason, error);
        } catch {
          // console.error can throw too. Nothing further to try.
        }
      }
    },
  };
}

/**
 * Drives one delivery attempt to settlement.
 *
 * Resolves with the generation this attempt claimed, or `undefined` if it never
 * claimed one — the caller needs that to answer "is my post-loop cleanup still
 * mine to do?", because an attempt that finished late must not clear the
 * sending flag of a turn that started after it.
 *
 * Never rejects.
 */
export function runWebuiStreamLoop(
  deps: WebuiDeliveryDeps,
  args: WebuiDeliveryArgs,
  sink: WebuiDeliverySink,
): Promise<number | undefined> {
  const claimed: { value: number | undefined } = { value: undefined };
  const observed: WebuiDeliverySink = {
    ...sink,
    claim: (owner, attachId) => {
      claimed.value = sink.claim(owner, attachId);
      return claimed.value;
    },
  };
  return drive(deps, args, observed).then(() => claimed.value);
}

async function drive(
  deps: WebuiDeliveryDeps,
  args: WebuiDeliveryArgs,
  sink: WebuiDeliverySink,
): Promise<void> {
  const { sendMessage, resumeSession, loadHistory } = deps;
  const { sessionId, message } = args;
  const classify = deps.classify ?? (() => ({ kind: "continue" }) as const);
  // No message means we are attaching to a turn the server started. Both modes
  // share this loop so there is exactly one place that owns an attempt, its
  // recovery and its ownership.
  const attaching = message === undefined;
  const framesAccepted = { value: 0 };
  const guarded = guardedSink(sink);
  const safe = guarded.safe;

  let cursor: string | undefined;
  let nextAction: "resume" | "resync" | undefined;
  let sent = false;
  let released = false;

  /**
   * Ends the attempt with the given origin.
   *
   * Ownership goes first, through the raw sink: cleanup must not be governed by
   * the rule that disables callbacks after a failure, because the moment that
   * rule exists is the moment the store is least likely to answer.
   */
  const end = (origin: WebuiDeliveryFailureOrigin, reason: string): void => {
    release();
    const failure: WebuiDeliveryFailure = {
      origin,
      reason,
      acceptedFrames: framesAccepted.value,
    };
    if (guarded.firstFailure() === undefined) {
      // Direct, unwrapped: the attempt is over, so there is no cascade to guard
      // against, and refusing through a disabled callback would drop the failure
      // the user most needs to see.
      guarded.reportFailure(failure);
      return;
    }
    guarded.reportFailure({
      origin: "sink",
      reason: `Delivery callback "${guarded.firstFailure()!.label}" failed: ${guarded.firstFailure()!.error.message}`,
      acceptedFrames: framesAccepted.value,
    });
  };

  const release = (): void => {
    if (released) return;
    released = true;
    try {
      sink.release();
    } catch (error) {
      try {
        // eslint-disable-next-line no-console
        console.error("[webui] delivery release failed:", error);
      } catch {
        // Give up; the attempt still has to settle.
      }
    }
  };

  const captureFrame = (frame: WebuiStreamFrame): void => {
    if (frame.cursor !== undefined) cursor = frame.cursor;
    if (classify(frame).kind === "reload_history") nextAction = "resync";
    // Counted only when the callback actually reached the aggregate. Once a
    // callback has failed the wrapper is disabled, and frames dropped after that
    // are not frames the user saw — which is exactly what the count is for.
    const wasDisabled = guarded.firstFailure() !== undefined;
    safe.accept(frame);
    if (!wasDisabled && guarded.firstFailure() === undefined) framesAccepted.value += 1;
  };

  try {
    // Claim before anything opens, inside the try: a claim that throws is a sink
    // failure like any other, and letting it escape would reject the promise
    // every caller relies on not rejecting. An attachment knows its turn up
    // front; a local send learns it from the stream itself.
    if (attaching) sink.claim("recovered", args.attachId);
    safe.begin();
    while (true) {
      if (nextAction === "resync") {
        nextAction = undefined;
        if (!resumeSession) {
          end("transport", "resumeSession transport is unavailable");
          return;
        }
        // The server told us our view has fallen too far behind. Read the
        // authoritative history and establish a fresh subscription with no
        // cursor so the server replays from the latest persisted point.
        safe.recovering();
        if (loadHistory) {
          let page: unknown;
          try {
            page = await loadHistory({ id: sessionId });
          } catch (error) {
            // A failed reload leaves the last good transcript visible. Nothing
            // is missing from it, so this is `recovery`, not `sink`: the frames
            // that arrived are still exactly what the turn produced.
            end("recovery", error instanceof Error ? error.message : String(error));
            return;
          }
          safe.replace(page);
        }
        cursor = undefined;
        await resumeSession({ id: sessionId }, captureFrame);
        if (!nextAction) break;
        continue;
      }
      if (nextAction === "resume") {
        nextAction = undefined;
        if (!cursor || !resumeSession) {
          end(
            "transport",
            !cursor && !resumeSession
              ? "Cannot resume: no cursor observed before the drop and resumeSession transport is unavailable"
              : !cursor
                ? "Cannot resume: no cursor observed before the drop"
                : "Cannot resume: resumeSession transport is unavailable",
          );
          return;
        }
        safe.recovering();
        await resumeSession({ id: sessionId, afterCursor: cursor }, captureFrame);
        if (!nextAction) break;
        continue;
      }
      if (!sent) {
        sent = true;
        if (attaching) {
          if (!resumeSession) {
            end("transport", "resumeSession transport is unavailable");
            return;
          }
          let anchor: { afterCursor?: string; afterMsgId?: string } = {};
          if (args.afterCursor) {
            anchor = { afterCursor: args.afterCursor };
          } else if (loadHistory) {
            let page: unknown;
            try {
              page = await loadHistory({ id: sessionId });
            } catch (error) {
              end("recovery", error instanceof Error ? error.message : String(error));
              return;
            }
            // Hand the page over rather than picking from it: an unanchored
            // resume makes the runtime skip every frame the turn produced before
            // we subscribed, so the aggregate has to seed first — and which
            // messages that means is its decision, not the loop's.
            safe.anchor(page);
            const last = lastMessageId(page);
            if (last) anchor = { afterMsgId: last };
          }
          try {
            await resumeSession({ id: sessionId, ...anchor }, captureFrame);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (!cursor) {
              end("transport", reason);
              return;
            }
            nextAction = "resume";
            continue;
          }
          if (nextAction) continue;
          break;
        }
        // Reached only when `attaching` is false, which is exactly "a message
        // was supplied". Checked rather than narrowed, because the flag and the
        // field are two facts about the same call and a `?? ""` here would send
        // an empty turn on a bug rather than say so.
        if (!sendMessage || message === undefined) {
          end(
            "transport",
            message === undefined
              ? "sendMessage transport is unavailable for an attachment"
              : "sendMessage transport is unavailable",
          );
          return;
        }
        // Claim before the stream opens. The runtime publishes a start frame for
        // every turn including locally sent ones, so without this lease a second
        // stream would attach to our own turn.
        sink.claim("local-send");
        try {
          await sendMessage(
            {
              id: sessionId,
              content: message,
              ...(args.clientIntent ? { clientIntent: args.clientIntent } : {}),
              ...(args.attachments?.length ? { attachments: args.attachments } : {}),
            },
            captureFrame,
          );
        } catch (error) {
          // Mid-stream drop. The next iteration decides whether the cursor we
          // observed is enough to carry on; a drop with no cursor is not
          // recoverable and must not loop forever.
          const reason = error instanceof Error ? error.message : String(error);
          if (!cursor) {
            end("transport", reason);
            return;
          }
          nextAction = "resume";
          continue;
        }
        if (nextAction) continue;
        break;
      }
      break;
    }
    // Ownership is released before the attempt settles, so a start frame for the
    // next turn that lands in between sees no owner and attaches rather than
    // colliding with a dead one. `release` is raw and idempotent, so this still
    // holds when an earlier callback threw.
    release();
    if (guarded.firstFailure() === undefined) {
      safe.complete();
    } else {
      const failure = guarded.firstFailure()!;
      guarded.reportFailure({
        origin: "sink",
        reason: `Delivery callback "${failure.label}" failed: ${failure.error.message}`,
        acceptedFrames: framesAccepted.value,
      });
    }
  } catch (error) {
    release();
    // A recorded callback failure is the more specific diagnosis: it says which
    // write into the aggregate broke, which a transport error does not.
    if (guarded.firstFailure() === undefined) {
      end("transport", error instanceof Error ? error.message : String(error));
    } else {
      const failure = guarded.firstFailure()!;
      guarded.reportFailure({
        origin: "sink",
        reason: `Delivery callback "${failure.label}" failed: ${failure.error.message}`,
        acceptedFrames: framesAccepted.value,
      });
    }
  }
}

/**
 * The last message id on a history page, if it carries one.
 *
 * The only thing the loop reads from a page, and it reads it for the transport's
 * benefit: anchoring the resume at the newest persisted message is what stops the
 * runtime skipping the turn. Everything else about the page is the adapter's.
 */
function lastMessageId(page: unknown): string | undefined {
  if (!page || typeof page !== "object") return undefined;
  const messages = (page as { readonly messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object") return undefined;
  const msgId = (last as { readonly msgId?: unknown }).msgId;
  return typeof msgId === "string" ? msgId : undefined;
}
