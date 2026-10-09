// The composer send/resume loop, extracted from the React component so a
// test can drive it through the WebSocket-drop and `resume_overflow` paths
// without standing up a DOM. Two failure signals share the same control
// flow — both ultimately mean "the current subscription is dead; start a
// new one" — and only the cursor used to resume (or the need to reload
// authoritative history) differs.
//
// `runWebuiStreamLoop` resolves once the user's turn has reached a final
// state (steady-state `[DONE]`, refusal, or a non-resumable failure). The
// returned promise never rejects: sink callback failures are contained
// by `safeSink` and reported through the sink's `refuse` callback (with a
// `console.error` fallback when every callback is broken). This matches
// the React shell's `try/finally` shape at `app.tsx`, which does not
// catch and would otherwise lose a sink-originated rejection.

import type { WebuiClientMessageSender, WebuiClientSessionResumer } from "./contracts/execution-port.js";
import type {
  WebuiClientMessage,
  WebuiClientMessageLoader,
} from "./contracts/message-view.js";

import {
  recogniseWebuiStreamPayload,
  nextWebuiSubscriptionGeneration,
  reduceWebuiStreamFrame,
  releaseWebuiSubscription,
  type WebuiStreamMessage,
  type WebuiStreamState,
  type WebuiStreamSubscription,
} from "./stream.js";
import type { WebuiStreamFrame } from "../shared/contracts/stream.js";
import type { WebuiAttachmentInput } from "../shared/contracts/messages.js";

export interface WebuiStreamLoopDeps {
  readonly sendMessage?: WebuiClientMessageSender;
  readonly resumeSession?: WebuiClientSessionResumer;
  readonly loadMessages?: WebuiClientMessageLoader;
  /**
   * Pure history/context transforms, injected by the caller so this mechanism
   * imports no `projection/` module (plan §7.2). The turn coordinator supplies
   * the existing pure functions — this is not a re-implementation.
   *
   * Required on purpose: the loop no longer carries a runtime fallback for a
   * missing bundle, so forgetting to inject it is a compile error rather than a
   * silently mis-shaped transcript discovered only when a resync/attach path
   * runs. Callers that never traverse those paths still pass a stub.
   */
  readonly projection: StreamRecoveryProjection;
}

/**
 * The pure transforms the loop injects instead of importing `projection/`
 * (plan §7.2). Declared on the mechanism side so no view module is pulled
 * across the boundary; callers pass a structurally compatible bundle.
 */
export interface StreamRecoveryProjection {
  readonly projectMessage: (message: WebuiClientMessage) => WebuiStreamMessage;
  readonly latestContextUsage: (
    messages: readonly WebuiStreamMessage[],
  ) => Record<string, unknown> | undefined;
  readonly readContextUsageSnapshot: (
    snapshot: Record<string, unknown> | undefined,
  ) => Record<string, unknown> | undefined;
}

export interface WebuiStreamLoopArgs {
  readonly sessionId: string;
  /**
   * Omitted when attaching to a turn the server started on its own — the goal
   * flow posts a hidden continuation prompt, a queued message drains, another
   * client sends. Present for a locally sent turn.
   */
  readonly message?: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
  /** Turn this attachment belongs to, so the lease starts out identified. */
  readonly attachTurnId?: string;
  /** Resume point to reuse instead of re-anchoring from history. */
  readonly afterCursor?: string;
}

export interface WebuiStreamLoopSink {
  /** Push a single frame through the reducer; called for every frame. */
  readonly applyFrame: (frame: WebuiStreamFrame) => void;
  /** Replace the phase without touching the rest of the state. */
  readonly setPhase: (phase: WebuiStreamState["phase"]) => void;
  /** Replace the transcript without touching the rest of the state. */
  readonly setMessages: (messages: readonly WebuiStreamMessage[]) => void;
  /**
   * Claim the session's live stream for this client before it opens, so a
   * `session.start` event for our own turn adopts the lease instead of
   * opening a second stream. Local sends claim as `local-send`; attachments
   * claim as `recovered` because the turn was not ours.
   *
   * Optional: a caller that does not model subscription ownership (the
   * throw-on-everything failure fixtures, for instance) simply has no lease to
   * claim, and the `session.start` handler stays inert for it.
   */
  readonly claimSubscription?: (
    owner: WebuiStreamSubscription["owner"],
    turnId?: string,
  ) => number | undefined;
  /**
   * Drop the lease. Every terminal exit releases it.
   *
   * The loop calls this one **raw**, never through `safeSink`: the wrapper
   * disables itself after the first failure, which would strand the lease
   * exactly when the store is least able to recover. Cleanup is not a render
   * path, so it does not obey the failure-containment rule.
   */
  readonly releaseSubscription?: () => void;
  /**
   * Extra stream fields an attachment seeds while loading history — the
   * context snapshot and the turn start the live elapsed counter reads.
   */
  readonly setStreamExtra?: (extra: Partial<WebuiStreamState>) => void;
  /**
   * Record an unrecoverable failure with a user-visible reason. The
   * second argument is set when the reducer had already accepted at
   * least one frame before the failure, so the user-visible
   * transcript may be incomplete; the shell renders an additional
   * message in that case.
   */
  readonly refuse: (reason: string, options?: { transcriptIncomplete?: boolean }) => void;
}

/**
 * Snapshot of the first sink callback failure, kept so the loop can
 * commit a refusal (or the fallback diagnostic) and skip the normal
 * `done` commit. The label names the callback that failed; the error
 * is the throw value, normalised to an `Error`.
 */
interface SinkFailure {
  readonly label:
    | "applyFrame"
    | "setPhase"
    | "setMessages"
    | "claimSubscription"
    | "setStreamExtra"
    | "refuse";
  readonly error: Error;
}

function describeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Wrap a sink so a callback throwing never escapes the loop's promise
 * contract. The first failure is recorded and the wrapped callbacks
 * become no-ops afterwards, so a half-broken sink does not cascade
 * further exceptions and does not let the loop commit a normal `done`
 * state. `reportSinkFailure` lets the loop surface the failure once
 * after the loop body finishes — calling `sink.refuse` directly,
 * bypassing the disable guard, and falling back to `console.error`
 * when the raw refuse callback also throws.
 */
function safeSink(
  sink: WebuiStreamLoopSink,
  framesAcceptedBeforeFailureRef: { value: number },
): {
  readonly safe: WebuiStreamLoopSink;
  readonly firstFailure: () => SinkFailure | undefined;
  readonly reportSinkFailure: () => boolean;
} {
  let first: SinkFailure | undefined;
  const wrap =
    <Args extends unknown[]>(
      fn: (...args: Args) => void,
      label: SinkFailure["label"],
    ): ((...args: Args) => void) =>
    (...args) => {
      if (first !== undefined) return;
      try {
        fn(...args);
      } catch (error) {
        first = { label, error: describeError(error) };
      }
    };
  return {
    safe: {
      applyFrame: wrap(sink.applyFrame, "applyFrame"),
      setPhase: wrap(sink.setPhase, "setPhase"),
      setMessages: wrap(sink.setMessages, "setMessages"),
      claimSubscription: sink.claimSubscription
        ? ((owner, turnId) => {
            // `wrap` returns void; the claim's generation has to reach the
            // loop so the caller can still recognise its own writes.
            try {
              return sink.claimSubscription?.(owner, turnId);
            } catch (error) {
              first = { label: "claimSubscription", error: describeError(error) };
              return undefined;
            }
          })
        : () => undefined,
      // `releaseSubscription` is deliberately absent: cleanup must survive
      // the disable rule, so the loop calls the raw sink through
      // `releaseLease` instead.
      setStreamExtra: sink.setStreamExtra
        ? wrap(sink.setStreamExtra, "setStreamExtra")
        : undefined,
      refuse: wrap(sink.refuse, "refuse"),
    },
    firstFailure: () => first,
    reportSinkFailure: () => {
      // Direct, non-wrapped call to sink.refuse. If refuse itself was
      // the failing callback we expect this to throw; the caller
      // catches and falls back to console.error. The second argument
      // carries `transcriptIncomplete` when frames had been accepted
      // before the failure — the shell uses that flag to render a
      // user-visible "transcript may be incomplete" message alongside
      // the refusal.
      if (!first) return true;
      const reason = `Sink callback "${first.label}" failed: ${first.error.message}`;
      try {
        sink.refuse(reason, {
          transcriptIncomplete: framesAcceptedBeforeFailureRef.value > 0,
        });
        return true;
      } catch {
        try {
          // eslint-disable-next-line no-console
          console.error("[webui] sink refusal failed; diagnostic only:", reason, first.error);
        } catch {
          // Even console.error can throw in extreme environments. Give
          // up — the failure has been observed at least once at this
          // point.
        }
        return false;
      }
    },
  };
}

/**
 * Build the React-shell binding for `runWebuiStreamLoop`. The shell's
 * submit handler in `app.tsx` calls this once per submit and feeds the
 * resulting sink into the loop. Tests exercise this helper directly
 * with a recording state reducer — see
 * `webui-shell.test.ts > "binds the composer sink to the React state
 * reducer correctly"`. That test is the strongest evidence available
 * that a misrouted callback (for example, dropping `applyFrame` or
 * putting `refuse` into `setPhase`) would be caught by a failing
 * assertion: it walks each callback through a synthetic state and
 * asserts the resulting reducer transitions.
 */
export function buildWebuiStreamLoopSink(
  setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void,
): WebuiStreamLoopSink {
  // Set when this sink claims a lease. Everything a superseded loop writes —
  // late chunks, a late `[DONE]`, a stray `phase: "streaming"` that would
  // resurrect the "思考中" spinner — is dropped here rather than in the shared
  // reducer, because the reducer cannot tell which loop a frame came from.
  let generation: number | undefined;
  // Fencing is about *other* loops, not about our own lease still being
  // visible. A `[DONE]` frame releases the lease mid-loop and the loop keeps
  // working (a `resume_overflow` may already be pending a resync), so the
  // test is "am I still the newest claimer", not "do I still hold a lease".
  // Comparing against the lease instead would re-admit a superseded loop the
  // moment the newer turn's `[DONE]` cleared it.
  const mine = (current: WebuiStreamState): boolean => {
    if (generation === undefined) return current.subscription === undefined;
    return current.lastClaimedGeneration === generation;
  };
  return {
    claimSubscription: (owner, turnId) => {
      const next = nextWebuiSubscriptionGeneration();
      generation = next;
      setStream((current) => ({
        ...current,
        lastClaimedGeneration: next,
        subscription: {
          owner,
          generation: next,
          ...(turnId ? { turnId } : {}),
        },
      }));
      return next;
    },
    applyFrame: (frame) =>
      setStream((current) =>
        mine(current) ? reduceWebuiStreamFrame(current, frame) : current,
      ),
    setPhase: (phase) =>
      setStream((current) => (mine(current) ? { ...current, phase } : current)),
    setMessages: (messages) =>
      setStream((current) => (mine(current) ? { ...current, messages } : current)),
    setStreamExtra: (extra) =>
      setStream((current) => (mine(current) ? { ...current, ...extra } : current)),
    // Scoped by generation: if a newer loop already claimed, this clears
    // nothing.
    releaseSubscription: () => {
      if (generation === undefined) return;
      setStream((current) => releaseWebuiSubscription(current, { generation }));
    },
    // Refusal is a write to the same shared state as everything else, so it
    // carries the same fence. A loop that was superseded must not stamp
    // `refused` over the turn that replaced it — that would show the user
    // the old turn's failure as the new turn's.
    refuse: (reason, options) =>
      setStream((current) =>
        mine(current)
          ? {
              ...current,
              phase: "refused",
              refusal: reason,
              transcriptIncomplete: options?.transcriptIncomplete ?? false,
            }
          : current,
      ),
  };
}

/**
 * Drives the composer send/resume loop. The two retry cases are unified:
 * a socket drop sets `nextAction = "resume"` and the next iteration calls
 * `resumeSession({ id, afterCursor })`; a `resume_overflow` frame sets
 * `nextAction = "resync"` and the next iteration reloads history via
 * `getMessages` and starts a fresh subscription with no cursor. Either
 * case loops until `[DONE]` arrives without another failure signal.
 *
 * The returned promise resolves once the loop reaches a final state. It
 * never rejects — sink callback failures are contained by `safeSink`
 * above, and transport/load errors are caught and surfaced through
 * `sink.refuse`.
 *
 * It resolves with the subscription generation this loop claimed, or
 * `undefined` if it never claimed one. Callers need that to answer
 * "is my post-loop cleanup still mine to do?": a loop that finished late
 * must not clear the sending flag of a turn that started after it.
 */
export function runWebuiStreamLoop(
  deps: WebuiStreamLoopDeps,
  args: WebuiStreamLoopArgs,
  sink: WebuiStreamLoopSink,
): Promise<number | undefined> {
  const claimed = { value: undefined as number | undefined };
  const observed: WebuiStreamLoopSink = sink.claimSubscription
    ? {
        ...sink,
        claimSubscription: (owner, turnId) => {
          claimed.value = sink.claimSubscription?.(owner, turnId);
          return claimed.value;
        },
      }
    : sink;
  return driveWebuiStreamLoop(deps, args, observed).then(() => claimed.value);
}

async function driveWebuiStreamLoop(
  deps: WebuiStreamLoopDeps,
  args: WebuiStreamLoopArgs,
  sink: WebuiStreamLoopSink,
): Promise<void> {
  const { sendMessage, resumeSession, loadMessages, projection } = deps;
  const { sessionId, message } = args;
  // No message means we are attaching to a turn the server started, not
  // sending one. Both modes share this loop so there is exactly one place
  // that owns the stream, its recovery and its lease.
  const attaching = message === undefined;
  // Count frames the reducer accepted before any sink failure was
  // recorded. `transcriptIncomplete` is part of the R16 contract: when
  // a sink failure ends the turn, the visible transcript may be stale.
  // Frames accepted before the failure are the ones the user already
  // saw, so the flag is set only when the counter is non-zero. We
  // hold the count in a wrapper object so the closure captured by
  // `safeSink` can read the live value when the failure report runs.
  const framesAcceptedBeforeFailureRef = { value: 0 };
  const guarded = safeSink(sink, framesAcceptedBeforeFailureRef);
  const safe = guarded.safe;

  let cursor: string | undefined;
  let nextAction: "resume" | "resync" | undefined;
  let sent = false;
  let leaseReleased = false;

  /**
   * Releases the lease exactly once, through the raw sink, on every exit
   * path — including the ones taken after a sink callback already threw.
   * Idempotent so that a `finalizeOnExit` that runs before the transport
   * error surfaces does not release twice.
   */
  const releaseLease = (): void => {
    if (leaseReleased) return;
    leaseReleased = true;
    try {
      sink.releaseSubscription?.();
    } catch (error) {
      // Cleanup is the last thing standing between a finished turn and a
      // permanently stuck "thinking" indicator. Report and move on: the
      // loop must still resolve.
      try {
        // eslint-disable-next-line no-console
        console.error("[webui] lease release failed:", error);
      } catch {
        // Give up; console.error can throw in extreme environments.
      }
    }
  };

  const captureFrame = (frame: WebuiStreamFrame): void => {
    if (frame.cursor !== undefined) cursor = frame.cursor;
    // The reducer recognises `{type:"resume_overflow"}` and surfaces it
    // through the `reconnecting` phase + `resumeRequired` flag, but the
    // loop also needs to know *which* failure signal fired so it can
    // pick the right recovery path. The shared `recognise…` helper is
    // what the reducer and this loop both use to interpret the JSON
    // body, so a future envelope change touches one site.
    if (recogniseWebuiStreamPayload(frame.dataJson).kind === "resume_overflow") {
      nextAction = "resync";
    }
    // The wrapper catches any throw and records the first failure;
    // subsequent calls become no-ops. We only count a frame when the
    // wrapper was not already disabled at entry — that is the case
    // where the frame actually reached the reducer.
    const wasDisabled = guarded.firstFailure() !== undefined;
    safe.applyFrame(frame);
    if (!wasDisabled && guarded.firstFailure() === undefined) {
      framesAcceptedBeforeFailureRef.value += 1;
    }
  };

  /**
   * Finalization helper called on every early-return path. When the
   * loop is about to exit, this checks whether a sink callback has
   * failed and either surfaces the failure through
   * `guarded.reportSinkFailure()` (which bypasses the disabled
   * wrapper and falls back to `console.error`) or commits a normal
   * refusal with the given reason. The shared helper is non-
   * recursive: it does not call the wrapped sink directly, only the
   * raw sink via `guarded` or the `sink` parameter.
   */
  const finalizeOnExit = (reason: string): void => {
    // The lease is released before anything else, and through the *raw*
    // sink: `safeSink` disables every wrapped callback after the first
    // failure, so a released-by-wrapper call would silently become a no-op
    // exactly when the store is most likely to be wedged. A stuck lease is
    // the "思考中" spinner that never goes away, so cleanup must not be
    // governed by the failure rule that protects the render path.
    releaseLease();
    if (guarded.firstFailure() !== undefined) {
      guarded.reportSinkFailure();
      return;
    }
    // No sink failure recorded yet; commit the normal refusal path.
    // The raw `sink.refuse` is used here on purpose — the loop is
    // about to return, so the wrapper's disable rule does not need to
    // guard against a cascade. If even this raw refuse throws, fall
    // back to `console.error` rather than letting the promise reject.
    try {
      sink.refuse(reason);
    } catch (rawRefuseError) {
      try {
        // eslint-disable-next-line no-console
        console.error("[webui] early-exit refusal failed:", reason, rawRefuseError);
      } catch {
        // Give up; console.error can throw in extreme environments.
      }
    }
  };

  try {
    // Claim before anything opens, inside the try: a claim that throws is a
    // sink failure like any other, and letting it escape would reject the
    // loop's promise, breaking the never-reject contract every caller
    // relies on. An attachment knows its turn up front; a local send
    // learns it from the `session.start` the runtime publishes.
    if (attaching) sink.claimSubscription?.("recovered", args.attachTurnId);
    safe.setPhase("streaming");
    while (true) {
      if (nextAction === "resync") {
        nextAction = undefined;
        if (!resumeSession) {
          finalizeOnExit("resumeSession transport is unavailable");
          return;
        }
        // The server told us our view has fallen too far behind. Reload
        // authoritative history through the existing `getMessages`
        // operation and then establish a fresh subscription with no
        // cursor so the server replays from the latest persisted point.
        safe.setPhase("reconnecting");
        if (loadMessages) {
          try {
            const page = await loadMessages({ id: sessionId });
            safe.setMessages(
              (page.messages ?? []).map(projection.projectMessage),
            );
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            finalizeOnExit(reason);
            return;
          }
        }
        cursor = undefined;
        await resumeSession({ id: sessionId }, captureFrame);
        if (!nextAction) break;
        continue;
      }
      if (nextAction === "resume") {
        nextAction = undefined;
        if (!cursor || !resumeSession) {
          const reason =
            !cursor && !resumeSession
              ? "Cannot resume: no cursor observed before the drop and resumeSession transport is unavailable"
              : !cursor
                ? "Cannot resume: no cursor observed before the drop"
                : "Cannot resume: resumeSession transport is unavailable";
          finalizeOnExit(reason);
          return;
        }
        safe.setPhase("reconnecting");
        await resumeSession(
          { id: sessionId, afterCursor: cursor },
          captureFrame,
        );
        if (!nextAction) break;
        continue;
      }
      if (!sent) {
        sent = true;
        if (attaching) {
          // Attach to a turn the server started without us. An unanchored
          // resume makes the runtime take its unanchored branch and skip
          // every frame the turn produced before we subscribed, so anchor on
          // the newest persisted message (or reuse the cursor we already hold).
          if (!resumeSession) {
            finalizeOnExit("resumeSession transport is unavailable");
            return;
          }
          let anchor: { afterCursor?: string; afterMsgId?: string } = {};
          if (args.afterCursor) anchor = { afterCursor: args.afterCursor };
          else if (loadMessages) {
            let page;
            try {
              page = await loadMessages({ id: sessionId });
            } catch (error) {
              finalizeOnExit(
                error instanceof Error ? error.message : String(error),
              );
              return;
            }
            // Seed the transcript with the turn we are attaching to. Older
            // history is already served by the transcript's own page, so
            // only the latest user turn is projected here — mirroring what
            // this path did before it became the single entry point.
            const history = page.messages ?? [];
            let latestUserIndex = -1;
            for (let index = history.length - 1; index >= 0; index -= 1) {
              const message = history[index];
              if (message?.role === "user" || message?.msgId.startsWith("msg-user-")) {
                latestUserIndex = index;
                break;
              }
            }
            const latestTurn = history.slice(
              latestUserIndex >= 0 ? latestUserIndex : Math.max(0, history.length - 1),
            );
            const anchored = latestTurn.map(projection.projectMessage);
            const startedAt = latestTurn.find((message) => message.role === "user")?.timestamp;
            const contextUsage =
              projection.readContextUsageSnapshot(page.contextSnapshot) ?? projection.latestContextUsage(anchored);
            safe.setMessages(anchored);
            safe.setPhase("streaming");
            safe.setStreamExtra?.({
              ...(contextUsage ? { contextUsage } : {}),
              processingStartedAtMs:
                typeof startedAt === "number" ? startedAt : Date.now(),
              resumeRequired: false,
              refusal: undefined,
            });
            const last = history.at(-1);
            if (last) anchor = { afterMsgId: last.msgId };
          }
          try {
            await resumeSession({ id: sessionId, ...anchor }, captureFrame);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (!cursor) {
              finalizeOnExit(reason);
              return;
            }
            nextAction = "resume";
            continue;
          }
          if (nextAction) continue;
          break;
        }
        if (!sendMessage) {
          finalizeOnExit("sendMessage transport is unavailable");
          return;
        }
        // Claim the subscription before the stream opens. The runtime
        // publishes `session.start` for every turn including locally sent
        // ones, so without this lease the composer would attach a second
        // stream to our own turn.
        sink.claimSubscription?.("local-send");
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
          // Mid-stream socket drop. Schedule a resume and let the loop
          // decide on the next iteration whether the cursor we observed
          // is enough to carry on. A rejection without a cursor is not
          // recoverable — surface it as a refusal instead of looping
          // forever.
          const reason = error instanceof Error ? error.message : String(error);
          if (!cursor) {
            finalizeOnExit(reason);
            return;
          }
          nextAction = "resume";
          continue;
        }
        // `sendMessage` resolves only on `[DONE]`. If the stream also
        // signalled `resume_overflow`, the next iteration will reload
        // via `loadMessages` and start a fresh subscription. A bare
        // `[DONE]` with no failure signal exits the loop normally.
        if (nextAction) continue;
        break;
      }
      break;
    }
    // The normal completion path commits `phase: "done"` only when no
    // sink callback has failed during the loop. If a failure was
    // recorded, the loop refuses the turn and surfaces the failure
    // through `guarded.reportSinkFailure`, which falls back to
    // `console.error` if every sink callback is broken. The never-
    // reject promise contract is preserved on every path.
    // The lease is released before the phase settles, so a `session.start`
    // for the next turn that lands in between sees no owner and attaches
    // instead of colliding with a dead one. `releaseLease` is raw and
    // idempotent, so this still holds when an earlier sink callback threw.
    releaseLease();
    if (guarded.firstFailure() === undefined) {
      safe.setPhase("done");
    } else {
      guarded.reportSinkFailure();
    }
  } catch (error) {
    // Transport/load errors that escape the per-iteration try blocks
    // land here. The never-reject guarantee is honoured: the promise
    // resolves with `safe.refuse` called, not rejected. If a sink
    // callback already failed, prefer the recorded failure over the
    // transport error so we don't lose the diagnostic. Either way the
    // lease goes first — reporting the failure must not skip the cleanup.
    releaseLease();
    if (guarded.firstFailure() === undefined) {
      const reason = error instanceof Error ? error.message : String(error);
      finalizeOnExit(reason);
    } else {
      guarded.reportSinkFailure();
    }
  }
}
