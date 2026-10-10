import type { WebuiStreamFrame } from "../../shared/contracts/stream.js";
import {
  initialWebuiWorkspaceProgress,
  reduceWebuiWorkspaceProgressEvent,
  reduceWebuiWorkspaceProgressMessage,
  type WebuiWorkspaceProgressState,
} from "./workspace-progress.js";
import type {
  WebuiStreamMessage,
  WebuiStreamSubscription,
  WebuiStreamState,
  WebuiSubscriptionReleaseScope,
  WebuiStreamPayloadKind,
  WebuiStreamPayloadRecognised,
} from "../contracts/stream-state.js";
export type {
  WebuiStreamMessage,
  WebuiStreamSubscription,
  WebuiStreamState,
  WebuiSubscriptionReleaseScope,
  WebuiStreamPayloadKind,
  WebuiStreamPayloadRecognised,
} from "../contracts/stream-state.js";

/**
 * Monotonic client-side stream identity. Only the client can tell two
 * concurrent loops apart, so the counter lives here rather than on the wire.
 */

export const initialWebuiStreamState: WebuiStreamState = {
  phase: "idle",
  messages: [],
  runtimeEvents: [],
  actionDeltas: [],
  workspaceProgress: initialWebuiWorkspaceProgress,
  resumeRequired: false,
  transcriptIncomplete: false,
};

/**
 * What a `session.start` event means for this client's stream.
 *
 * - `attach` — nobody owns a stream, so the server started a turn we did not
 *   initiate (goal, queue drain, another client) and we have to open one.
 * - `claim` — our own `sendMessage` stream is already open and has not yet
 *   learned its turn id. Adopt it; opening a second stream would double the
 *   answer text.
 * - `hold` — we already track this exact turn.
 * - `recheck` — we hold a stream for a *different* turn, so we cannot tell
 *   from this event alone whether our stream is stale or whether the two are
 *   genuinely concurrent. The caller must consult the authoritative active
 *   turn before touching the subscription.
 */
export type WebuiSessionStartDecision = "attach" | "claim" | "hold" | "recheck";

export function decideWebuiSessionStart(
  state: WebuiStreamState,
  turnId: string | undefined,
): WebuiSessionStartDecision {
  const owned = state.subscription;
  if (!owned) return "attach";
  if (owned.turnId === undefined) return turnId === undefined ? "hold" : "claim";
  if (turnId === undefined || owned.turnId === turnId) return "hold";
  return "recheck";
}

/** Adopts the turn id reported by `session.start` onto an open subscription. */
export function claimWebuiSubscriptionTurn(
  state: WebuiStreamState,
  turnId: string | undefined,
): WebuiStreamState {
  const owned = state.subscription;
  if (!owned || owned.turnId !== undefined || turnId === undefined) return state;
  return { ...state, subscription: { ...owned, turnId } };
}

/** Drops the subscription. Terminal frames and terminal lifecycle events both
 * release it, so a later `session.start` attaches instead of colliding. */

/** Minimal shape the recheck resolution needs from the active-turn probe. */
export interface WebuiActiveTurnLike {
  readonly turnId: string;
  readonly busyReason: "turn" | "compaction";
}

/**
 * What a successful stop has to do to the stream state. Split out of the
 * composer so the release is reachable by a test: the stop button has no
 * guaranteed `session.abort` event to clean up after it, so if this drops
 * the lease the session stays wedged in "thinking" with no way out.
 */
export function settleAbortedStream(state: WebuiStreamState): WebuiStreamState {
  return {
    // The subscription is cleared in place. `releaseWebuiSubscription` moved to
    // `client/mechanisms/stream-lease.ts`, and a `view` projection may not import
    // a mechanism; this call never passed a scope, so the transition is identical.
    ...{ ...state, phase: "done", status: "aborted", subscription: undefined },
    // The turn is over, so no loop owns the stream any more. Clearing the
    // latest-claim marker is what actually silences the loop the user just
    // stopped: releasing the lease alone left its generation standing, so
    // frames still queued on the old stream would keep passing the fence
    // and write themselves back over the stopped turn.
    lastClaimedGeneration: undefined,
  };
}

/**
 * Whether a loop that claimed `generation` still owns the session's stream.
 * Callers use it for cleanup that runs after the loop promise settles —
 * clearing the sending flag, most visibly — so a loop that finished late
 * does not settle a turn that started after it.
 */
export function ownsWebuiStreamGeneration(
  state: WebuiStreamState,
  generation: number | undefined,
): boolean {
  // A loop that never claimed one cannot be told apart from a live one, and
  // skipping its cleanup would strand the "thinking" indicator forever. The
  // never-strand case wins over the never-clobber case here.
  if (generation === undefined) return true;
  return state.lastClaimedGeneration === generation;
}

/**
 * What to do when a `session.start` named a turn we do not hold and we hold
 * one we were not told about. The event cannot tell a stale lease from a
 * genuinely concurrent stream, so the authoritative active turn decides:
 *
 * - `hold` — the active turn is the one we already track.
 * - `release` — nothing is running (or it is a compaction, which produces no
 *   transcript), so our lease is stale and a future start must attach.
 * - `retarget` — a different real turn is running. Drop the stale lease and
 *   attach to it; two streams would otherwise double every chunk and fight
 *   over the cursor.
 */
export type WebuiSubscriptionRecheck = "hold" | "release" | "retarget";

export function resolveWebuiSubscriptionRecheck(
  owned: WebuiStreamSubscription,
  active: WebuiActiveTurnLike | undefined,
): WebuiSubscriptionRecheck {
  if (!active || active.busyReason !== "turn") return "release";
  if (owned.turnId === undefined) {
    // Distinguish by owner. A `local-send` claims before the runtime
    // publishes `session.start`, so a turn-less lease of ours is a send in
    // flight and the active turn is almost certainly that same send —
    // retargeting would hand the user's own turn back as somebody else's.
    // A `recovered` lease is the other way round: it was opened for a turn
    // we were told about, so a turn-less one means we attached without an
    // id and the active turn is the only thing that can say whose it is.
    return owned.owner === "local-send" ? "hold" : "retarget";
  }
  if (owned.turnId === active.turnId) return "hold";
  return "retarget";
}

/**
 * Whether a terminal lifecycle event naming `turnId` still describes the
 * turn this client is following. Terminal events ride the event socket
 * while frames ride the recovered stream socket, so the two genuinely
 * cross: a `session.finish` for an older turn can arrive after we already
 * attached to a newer one. Settling the newer turn's phase and sending flag
 * from the older turn's terminal is the same class of defect as the one
 * this whole file exists to fix — the spinner, appearing or vanishing at
 * the wrong moment.
 */
export function matchesWebuiTerminalTurn(
  state: WebuiStreamState,
  turnId: string | undefined,
): boolean {
  // No turn id to attribute the event to; it is the best signal we have.
  if (turnId === undefined) return true;
  const owned = state.subscription;
  // No lease at all: the terminal is the only thing that can settle a turn
  // we never attached to, and there is nobody newer to protect.
  if (owned === undefined) return true;
  // A lease that has not adopted its turn id yet has an owner still in
  // flight — `runWebuiStreamLoop` claims before the runtime publishes
  // `session.start`, so this is almost always the user's own send between
  // those two moments. A terminal naming some *other* turn must leave it
  // alone, or the answer the user is watching for stops streaming early.
  // The runtime's lifecycle observer always publishes a turn id
  // (`turn-lifecycle-event-observer.ts`), so a missing one is a
  // compatibility gap, not licence to let any terminal through.
  if (owned.turnId === undefined) return false;
  return owned.turnId === turnId;
}

/**
 * Whether an active-turn probe result still describes the lease the probe
 * was asked about. `recheckSubscription` captures the lease *before* the
 * round trip: a local send that claims while the probe is in flight holds a
 * lease the snapshot knows nothing about, and acting on that snapshot would
 * take the user's own turn away from them.
 */
export function isWebuiSubscriptionProbeCurrent(
  captured: WebuiStreamSubscription | undefined,
  current: WebuiStreamSubscription | undefined,
): boolean {
  if (captured === undefined || current === undefined) return false;
  return current.generation === captured.generation;
}

/**
 * Session lists carry `SessionStatusInfoView.statusType` as a numeric enum
 * (`Started` is 1), while early WebUI adapters supplied a status string.
 * Normalize both shapes so refresh recovery can recognize active sessions.
 */
export function webuiSessionStatusType(value: unknown): string {
  const status = record(value);
  const raw = status?.statusType ?? status?.type ?? value;
  if (raw === 1 || raw === "1") return "started";
  if (raw === 0 || raw === "0") return "idle";
  if (raw === 2 || raw === "2") return "error";
  if (raw === 3 || raw === "3") return "aborted";
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys)
    if (typeof value[key] === "string") return value[key] as string;
  return "";
}

function messageId(value: Record<string, unknown>): string {
  return text(value, ["msg_id", "msgId", "id"]);
}

function toolCalls(value: Record<string, unknown>): readonly Record<string, unknown>[] | undefined {
  const direct = value.tool_calls ?? value.toolCalls;
  if (Array.isArray(direct)) return direct as readonly Record<string, unknown>[];
  return undefined;
}

function usageRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  // Live wire frames may carry `usage` at the top level (the `agent_message`
  // envelope) or under `data.usage`. The persisted DB stores it on the
  // message itself. Accept any of the three layouts.
  const direct = value.usage ?? value.Usage;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const data = record(value.data);
  if (data) {
    const nested = data.usage ?? data.Usage;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return undefined;
}

function contextUsageRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = value.context_usage ?? value.contextUsage;
  return direct && typeof direct === "object" && !Array.isArray(direct)
    ? direct as Record<string, unknown>
    : undefined;
}

function upsertMessage(
  messages: readonly WebuiStreamMessage[],
  value: Record<string, unknown>,
  chunk: boolean,
): readonly WebuiStreamMessage[] {
  const id = messageId(value) || `anonymous-${messages.length}`;
  const answer = text(value, ["msg_content", "msgContent", "content"]);
  const thinking = text(value, [
    "thinking_content",
    "thinkingContent",
    "thinking",
    "reasoning_content",
    "reasoningContent",
    "thought_content",
  ]);
  const calls = toolCalls(value);
  const parts = Array.isArray(value.parts)
    ? value.parts.filter((item): item is Record<string, unknown> => !!record(item))
    : undefined;
  const usage = usageRecord(value);
  const contextUsage = contextUsageRecord(value);
  const index = messages.findIndex((message) => message.id === id);
  if (index < 0)
    return [
      ...messages,
      {
        id,
        answer,
        thinking,
        ...(calls ? { toolCalls: calls } : {}),
        ...(parts ? { parts } : {}),
        ...(usage ? { usage } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(id.startsWith("msg-user-") ? ({ role: "user" } as const) : {}),
      },
    ];
  if (
    !chunk &&
    !calls &&
    !usage &&
    messages[index]!.answer === answer &&
    messages[index]!.thinking === thinking
  )
    return messages;
  const next = [...messages];
  next[index] = {
    id,
    answer: chunk
      ? messages[index]!.answer + answer
      : answer || messages[index]!.answer,
    thinking: chunk
      ? messages[index]!.thinking + thinking
      : thinking || messages[index]!.thinking,
    ...(calls || messages[index]!.toolCalls
      ? { toolCalls: calls ?? messages[index]!.toolCalls }
      : {}),
    ...(parts || messages[index]!.parts ? { parts: parts ?? messages[index]!.parts } : {}),
    ...(usage || messages[index]!.usage ? { usage: usage ?? messages[index]!.usage } : {}),
    ...(contextUsage || messages[index]!.contextUsage ? { contextUsage: contextUsage ?? messages[index]!.contextUsage } : {}),
    ...(messages[index]!.role ? { role: messages[index]!.role } : {}),
    ...(messages[index]!.timestamp !== undefined
      ? { timestamp: messages[index]!.timestamp }
      : {}),
    ...(messages[index]!.isGoal ? { isGoal: true } : {}),
  };
  return next;
}

const NO_PAYLOAD: WebuiStreamPayloadRecognised = { kind: "empty" };

/**
 * Recognise a frame's `dataJson` body. Returns the empty-payload kind
 * for whitespace or missing bodies, the done kind for `[DONE]`, the
 * overflow kind for `{type:"resume_overflow"}`, and an event record
 * otherwise (the reducer already had exhaustive branches; this function
 * only surfaces what the reducer and the loop need to share — the
 * overflow kind is the only one the loop branches on, everything else
 * falls through to the reducer).
 */
export function recogniseWebuiStreamPayload(
  dataJson: string | undefined,
): WebuiStreamPayloadRecognised {
  const payload = dataJson?.trim();
  if (!payload) return NO_PAYLOAD;
  if (payload === "[DONE]") return { kind: "done" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: "generic_event" };
  }
  const event = record(parsed);
  if (!event) return { kind: "generic_event" };
  if (event.type === "resume_overflow") return { kind: "resume_overflow" };
  return { kind: "generic_event", event };
}

/**
 * Apply every non-cursor effect from a single frame. The cursor rides on
 * the LAST mapped frame of a source-frame group, so this function must
 * run BEFORE any cursor application — see `applyFrameCursor` below and
 * the test in `webui-stream.test-instrumentation.test.ts` (test-only).
 */
export function applyFrameData(
  state: WebuiStreamState,
  frame: WebuiStreamFrame,
): WebuiStreamState {
  let next: WebuiStreamState = state;
  if (frame.messageActionDeltas)
    next = {
      ...next,
      actionDeltas: [...next.actionDeltas, ...frame.messageActionDeltas],
    };
  if (frame.projection !== undefined)
    next = { ...next, projection: frame.projection };
  const recognised = recogniseWebuiStreamPayload(frame.dataJson);
  if (recognised.kind === "empty") return next;
  if (recognised.kind === "done")
    // The subscription ends with the turn. Releasing it here is what lets a
    // later `session.start` attach instead of colliding with a stale owner.
    // A superseded loop never reaches this branch: its frames are dropped by
    // the generation guard in `buildWebuiStreamLoopSink` before the reducer
    // sees them, so an old `[DONE]` cannot clear the current loop's lease.
    // Cleared in place for the same reason as `settleAbortedStream` above.
    return { ...next, phase: "done", subscription: undefined };
  if (recognised.kind === "resume_overflow") {
    // The harness signals that this client has fallen too far behind
    // the server's authoritative history. The shell observes
    // `resumeRequired` and re-establishes a fresh subscription after
    // `getMessages`.
    return { ...next, phase: "reconnecting", resumeRequired: true };
  }
  // `generic_event` — same exhaustive dispatch the reducer had. The
  // reducer and the loop used to parse this payload twice; this is the
  // single parse site. If the payload did not parse (or did not parse
  // to an object) `recognised.event` is undefined and we leave the
  // state unchanged, mirroring the previous guard against bad bodies.
  const event = recognised.event;
  if (!event) return next;
  const workspaceProgress = reduceWebuiWorkspaceProgressEvent(
    next.workspaceProgress,
    event,
  );
  next = { ...next, workspaceProgress };
  const type = event.type;
  if (type === 10 || type === "heartbeat") {
    return { ...next, phase: "streaming" };
  }
  if (type === 2 || type === "agent_message") {
    const message = record(event.agent_message) ?? record(event.agentMessage);
    if (!message) return next;
    const nestedMessages = Array.isArray(message.messages) ? message.messages : undefined;
    const messages = nestedMessages
      ? nestedMessages.reduce(
          (all, item) =>
            record(item) ? upsertMessage(all, record(item)!, false) : all,
          next.messages,
        )
      : upsertMessage(next.messages, message, false);
    const contextUsage = nestedMessages
      ? [...nestedMessages].reverse().map(record).find((item) => item ? contextUsageRecord(item) : undefined)
      : contextUsageRecord(message);
    // Todo progress and subagent bookkeeping ride inside the message itself
    // rather than on the global bus, so the frame has to be unwrapped here or
    // the panel keeps showing the start-of-session snapshot.
    //
    // A batched frame is owned by its nested messages: the transcript upsert
    // just above replaces the outer message with the `messages[]` entries
    // rather than merging both, so reducing the outer snapshot as well would
    // let the panel show a subagent the transcript never accepted. Follow the
    // same authority, in array order.
    const workspaceProgress = nestedMessages
      ? nestedMessages.reduce(
          (progress, item) => {
            const nested = record(item);
            return nested
              ? reduceWebuiWorkspaceProgressMessage(progress, nested)
              : progress;
          },
          next.workspaceProgress,
        )
      : reduceWebuiWorkspaceProgressMessage(next.workspaceProgress, message);
    return {
      ...next,
      phase: "streaming",
      messages,
      workspaceProgress,
      ...(contextUsage ? { contextUsage } : {}),
    };
  }
  if (type === 6 || type === "agent_message_chunk") {
    const message =
      record(event.agent_message_chunk) ?? record(event.agentMessageChunk);
    return message
      ? {
          ...next,
          phase: "streaming",
          messages: upsertMessage(next.messages, message, true),
        }
      : next;
  }
  if (type === "session_status" || type === 3 || type === 4) {
    const status = record(event.session_status);
    return {
      ...next,
      phase: "streaming",
      status: text(status ?? event, ["type", "status"]) || undefined,
    };
  }
  if (type === "session.error" || type === "session_error") {
    return {
      ...next,
      phase: "error",
      refusal: text(event, ["error", "message", "reason"]) || undefined,
    };
  }
  if (
    type === "runtime-event" ||
    type === "action-required" ||
    typeof type === "string"
  )
    return {
      ...next,
      phase: "streaming",
      runtimeEvents: [...next.runtimeEvents, event],
    };
  return next;
}

/**
 * Record the cursor on a state snapshot. The reducer applies this LAST,
 * after `applyFrameData`, so the cursor only ever advances after the
 * frame's data change has been applied. The previous behaviour
 * committed the cursor at the top of the reducer and left a window
 * where the cursor advanced without its corresponding state change.
 */
export function applyFrameCursor(
  state: WebuiStreamState,
  frame: WebuiStreamFrame,
): WebuiStreamState {
  if (frame.cursor === undefined || frame.cursor === state.cursor) return state;
  return { ...state, cursor: frame.cursor };
}

/**
 * Checkpoint labels for the reducer's optional probe. The ordering the
 * probe exposes is not observable from the reducer's return value — the
 * cursor and the data step apply disjoint fields, so a reducer that
 * swapped them still produces the same final state. The test-only module
 * `client/stream-instrumentation.ts` is the only caller that supplies one.
 */
export type WebuiStreamReduceCheckpoint = "after-data" | "after-cursor";

/**
 * The reducer's optional third argument. Production callers MUST NOT
 * supply it: the probe is a test-only surface, reached through
 * `client/stream-instrumentation.ts`. The shape is declared here, beside
 * the parameter that uses it, because this module is a `view` projection
 * and may not import the `mechanisms` module that drives the probe.
 */
export interface WebuiStreamReduceOptions {
  readonly probe?: (
    snapshot: WebuiStreamState,
    checkpoint: WebuiStreamReduceCheckpoint,
  ) => void;
}

/**
 * Pure reduction of the mixed session stream. Unknown or malformed
 * payloads are ignored safely.
 *
 * The probe fires once after the data step and once after the cursor
 * step; the cursor-ordering test asserts that the post-data snapshot
 * has not yet advanced the cursor.
 */
export function reduceWebuiStreamFrame(
  state: WebuiStreamState,
  frame: WebuiStreamFrame,
  options?: WebuiStreamReduceOptions,
): WebuiStreamState {
  const next = applyFrameData(state, frame);
  options?.probe?.(next, "after-data");
  const withCursor = applyFrameCursor(next, frame);
  options?.probe?.(withCursor, "after-cursor");
  return withCursor;
}