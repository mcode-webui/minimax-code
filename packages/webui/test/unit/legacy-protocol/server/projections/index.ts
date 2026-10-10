import type { WebuiRuntimeEvent, WebuiStreamFrame } from "../port.js";
import { isCompactionEvent, projectCompactionEvent } from "./compaction.js";
import {
  initialProjectionState,
  projectPermissionEvent,
  type WebuiProjectionState,
} from "./permissions.js";

export interface WebuiEventProjection extends WebuiProjectionState {
  readonly compactionBySession: Readonly<
    Record<string, ReturnType<typeof projectCompactionEvent>>
  >;
}

export function reduceEvents(
  state: WebuiEventProjection = {
    ...initialProjectionState,
    compactionBySession: {},
  },
  frame: WebuiRuntimeEvent,
): WebuiEventProjection {
  const permissions = projectPermissionEvent(
    { sessions: state.sessions },
    frame,
  );
  const sessionId =
    typeof frame.payload.sessionId === "string"
      ? frame.payload.sessionId
      : undefined;
  return {
    ...permissions,
    compactionBySession:
      isCompactionEvent(frame.type) && sessionId
      ? {
          ...state.compactionBySession,
          [sessionId]: projectCompactionEvent(frame),
        }
      : state.compactionBySession,
  };
}

function decodeProjectionEvent(
  frame: WebuiStreamFrame,
): WebuiRuntimeEvent | undefined {
  const raw = frame.eventJson ?? frame.dataJson;
  if (!raw || raw === "[DONE]") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.type !== "string" ||
      (!candidate.type.startsWith("permission.") &&
        !candidate.type.startsWith("questionnaire.") &&
        !candidate.type.startsWith("session.compaction."))
    )
      return undefined;
    const payload = candidate.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return undefined;
    return {
      type: candidate.type,
      payload: payload as Record<string, unknown>,
      timestamp:
        typeof candidate.timestamp === "number"
          ? candidate.timestamp
          : Date.now(),
      source:
        typeof candidate.source === "string"
          ? candidate.source
          : "session-stream",
    };
  } catch {
    return undefined;
  }
}

/** Attach the one supported projection mechanism to session stream frames. */
export function projectSessionStream(
  source: AsyncIterable<WebuiStreamFrame> | Iterable<WebuiStreamFrame>,
): AsyncIterable<WebuiStreamFrame> {
  const syncIterator =
    Symbol.asyncIterator in source ? undefined : source[Symbol.iterator]();
  const upstream: AsyncIterator<WebuiStreamFrame> =
    Symbol.asyncIterator in source
      ? source[Symbol.asyncIterator]()
      : {
          next: () => Promise.resolve(syncIterator!.next()),
          return: async (value?: unknown) => {
            syncIterator!.return?.(value);
            return { value, done: true };
          },
        };
  let state: WebuiEventProjection = {
    ...initialProjectionState,
    compactionBySession: {},
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const result = await upstream.next();
          if (result.done) return result;
          const event = decodeProjectionEvent(result.value);
          if (event) state = reduceEvents(state, event);
          return { value: { ...result.value, projection: state }, done: false };
        },
        return: async (value?: unknown) => {
          await upstream.return?.(value);
          return { value, done: true };
        },
      };
    },
  };
}

export { projectContextSnapshot } from "./context-snapshot.js";
export { isCompactionEvent, projectCompactionEvent } from "./compaction.js";
export { isTurnCompactionMessage, projectUsage } from "./usage.js";
export {
  initialProjectionState,
  projectPermissionEvent,
} from "./permissions.js";
