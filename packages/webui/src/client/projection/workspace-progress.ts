import type { WebuiClientMessage } from "../contracts/message-view.js";
import type {
  WebuiWorkspaceTodoStatus,
  WebuiWorkspaceTodo,
  WebuiWorkspaceSubagentStatus,
  WebuiWorkspaceSubagent,
  WebuiWorkspaceProgressState,
} from "../contracts/stream-state.js";
export type {
  WebuiWorkspaceTodoStatus,
  WebuiWorkspaceTodo,
  WebuiWorkspaceSubagentStatus,
  WebuiWorkspaceSubagent,
  WebuiWorkspaceProgressState,
} from "../contracts/stream-state.js";

export const initialWebuiWorkspaceProgress: WebuiWorkspaceProgressState = {
  todos: [],
  subagents: [],
  hasTodoSnapshot: false,
  hasSubagentSnapshot: false,
};

/**
 * The consolidated progress view (plan §7.6 "Progress"; ticket #49 correction 3).
 *
 * Progress keeps **distinct source inputs, not multiple writable final
 * values**: the history baseline, the tree's child metadata and the live
 * overlay stay separate, and this one pure selector derives what the panel
 * renders. It is the shell's former inline merge moved into a testable domain
 * function, and it preserves the current precedence exactly:
 *
 *   * Todos are a *choice*, not a merge. A live todo snapshot overrides the
 *     history baseline — including an empty live snapshot, which still wins
 *     (`hasTodoSnapshot`). Without a live snapshot the history baseline shows.
 *   * Subagents merge history, then tree, then live, later sources winning per
 *     `sessionId`, and the result sorts by `createdAt` ascending.
 */
export interface WebuiWorkspaceProgressInputs {
  readonly history: WebuiWorkspaceProgressState;
  readonly treeSubagents: readonly WebuiWorkspaceSubagent[];
  readonly live: WebuiWorkspaceProgressState;
}

export interface WebuiWorkspaceProgressView {
  readonly todos: readonly WebuiWorkspaceTodo[];
  readonly subagents: readonly WebuiWorkspaceSubagent[];
}

export function selectWebuiWorkspaceProgress(
  inputs: WebuiWorkspaceProgressInputs,
): WebuiWorkspaceProgressView {
  const todos = inputs.live.hasTodoSnapshot
    ? inputs.live.todos
    : inputs.history.todos;
  const merged = new Map<string, WebuiWorkspaceSubagent>();
  for (const subagent of inputs.history.subagents)
    merged.set(subagent.sessionId, subagent);
  for (const subagent of inputs.treeSubagents)
    merged.set(subagent.sessionId, subagent);
  for (const subagent of inputs.live.subagents)
    merged.set(subagent.sessionId, {
      ...merged.get(subagent.sessionId),
      ...subagent,
    });
  const subagents = [...merged.values()].sort(
    (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
  );
  return { todos, subagents };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function numberValue(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate))
      return candidate;
  }
  return undefined;
}

function normalizeTodos(value: unknown): WebuiWorkspaceTodo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((candidate) => {
    const todo = record(candidate);
    const content = stringValue(todo, ["content"]);
    const status = todo?.status;
    if (
      !content ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed" &&
        status !== "cancelled")
    )
      return [];
    const priority = todo?.priority;
    return [
      {
        content,
        status,
        ...(priority === "high" || priority === "medium" || priority === "low"
          ? { priority }
          : {}),
      },
    ];
  });
}

export function webuiWorkspaceSubagentStatus(
  value: unknown,
): WebuiWorkspaceSubagentStatus {
  const objectValue = record(value);
  if (objectValue) {
    return webuiWorkspaceSubagentStatus(
      objectValue.statusType ?? objectValue.status ?? objectValue.type,
    );
  }
  if (value === 1 || value === "running" || value === "started")
    return "running";
  if (
    value === 2 ||
    value === 3 ||
    value === "error" ||
    value === "failed" ||
    value === "aborted" ||
    value === "cancelled"
  )
    return "error";
  return "completed";
}

function eventStatus(value: Record<string, unknown>): WebuiWorkspaceSubagentStatus {
  return webuiWorkspaceSubagentStatus(
    value.status ?? value.statusType ?? record(value.session_status)?.status,
  );
}

function upsertSubagent(
  subagents: readonly WebuiWorkspaceSubagent[],
  next: WebuiWorkspaceSubagent,
): readonly WebuiWorkspaceSubagent[] {
  const index = subagents.findIndex(
    (subagent) => subagent.sessionId === next.sessionId,
  );
  if (index < 0) return [...subagents, next];
  const updated = [...subagents];
  updated[index] = { ...updated[index], ...next };
  return updated;
}

function eventType(value: Record<string, unknown>): string | undefined {
  const generic = record(value.generic);
  return stringValue(generic, ["eventType", "event_type"])
    ?? stringValue(value, ["eventType", "event_type", "type"]);
}

function eventData(value: Record<string, unknown>): Record<string, unknown> {
  const generic = record(value.generic);
  return record(generic?.data) ?? record(value.data) ?? value;
}

function subagentFromEvent(
  value: Record<string, unknown>,
  fallbackParentSessionId?: string,
): WebuiWorkspaceSubagent | undefined {
  const data = eventData(value);
  const sessionId = stringValue(data, [
    "sessionId",
    "session_id",
    "childSessionId",
    "child_session_id",
  ]);
  const agentName = stringValue(data, [
    "agentName",
    "agent_name",
    "childAgentName",
    "child_agent_name",
  ]);
  if (!sessionId || !agentName) return undefined;
  const parentSessionId = stringValue(data, [
    "parentSessionId",
    "parent_session_id",
  ]) ?? fallbackParentSessionId;
  const status = eventStatus(data);
  return {
    sessionId,
    agentName,
    ...(stringValue(data, ["title"]) ? { title: stringValue(data, ["title"]) } : {}),
    status,
    ...(numberValue(data, ["createdAt", "created_at", "joinedAt", "joined_at"]) !== undefined
      ? { createdAt: numberValue(data, ["createdAt", "created_at", "joinedAt", "joined_at"]) }
      : {}),
    ...(numberValue(data, ["updatedAt", "updated_at"]) !== undefined
      ? { updatedAt: numberValue(data, ["updatedAt", "updated_at"]) }
      : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

/**
 * Reduce one raw Desktop-compatible event into WebUI's session-scoped
 * projection. The input is deliberately structural because stream frames
 * contain both protocol-shaped and legacy event-shaped payloads.
 */
/**
 * Event groups the progress reducer dispatches on. They are the single source
 * of truth: `PROGRESS_EVENT_TYPES` below is BUILT from them, so adding a
 * dispatch branch without admitting the name (or admitting a name nothing
 * dispatches on) is not expressible.
 */
const SUBAGENT_SPAWN_EVENT_TYPES = ["session.spawned"] as const;
const SUBAGENT_STATUS_EVENT_TYPES = [
  "session.status_updated",
  "session.finish",
  "session.error",
  "session.abort",
  "session.aborted",
] as const;
const SUBAGENT_REPORTED_EVENT_TYPES = [
  "session_status",
  "session.status",
] as const;
const TODO_EVENT_TYPES = ["todo_updated"] as const;

/**
 * `Array.prototype.includes` accepts any value, but these literal tuples are what
 * make a dispatch branch exhaustive, so membership has to narrow `type` instead of
 * merely comparing it — `type && TODO_EVENT_TYPES.includes(type)` still hands a
 * plain `string` to a `"todo_updated"` parameter. A frame carrying no event name
 * belongs to no branch, which is what `includes(undefined)` already answered.
 */
function isEventTypeOf<T extends string>(
  type: string | undefined,
  allowed: readonly T[],
): type is T {
  return type !== undefined && (allowed as readonly string[]).includes(type);
}

function terminalSubagentStatus(
  type: string,
  data: Record<string, unknown>,
): WebuiWorkspaceSubagent["status"] {
  if (type === "session.finish") return "completed";
  if (type === "session.error" || type === "session.abort" || type === "session.aborted")
    return "error";
  return eventStatus(data);
}

export function reduceWebuiWorkspaceProgressEvent(
  state: WebuiWorkspaceProgressState,
  value: Record<string, unknown>,
  sessionId?: string,
): WebuiWorkspaceProgressState {
  const type = eventType(value);
  if (isEventTypeOf(type, TODO_EVENT_TYPES)) {
    const todos = normalizeTodos(value.todos ?? eventData(value).todos);
    return todos ? { ...state, todos, hasTodoSnapshot: true } : state;
  }
  if (isEventTypeOf(type, SUBAGENT_SPAWN_EVENT_TYPES)) {
    const subagent = subagentFromEvent(value, sessionId);
    return subagent
      ? {
          ...state,
          subagents: upsertSubagent(state.subagents, subagent),
          hasSubagentSnapshot: true,
        }
      : state;
  }
  if (isEventTypeOf(type, SUBAGENT_STATUS_EVENT_TYPES)) {
    const data = eventData(value);
    const childSessionId = stringValue(data, ["sessionId", "session_id"]);
    if (!childSessionId) return state;
    const existing = state.subagents.find(
      (subagent) => subagent.sessionId === childSessionId,
    );
    if (!existing) return state;
    return {
        ...state,
        subagents: upsertSubagent(state.subagents, {
        ...existing,
        status: terminalSubagentStatus(type, data),
        }),
        hasSubagentSnapshot: true,
      };
  }
  if (isEventTypeOf(type, SUBAGENT_REPORTED_EVENT_TYPES)) {
    const data = eventData(value);
    const childSessionId = stringValue(data, ["sessionId", "session_id"]);
    const existing = childSessionId
      ? state.subagents.find((subagent) => subagent.sessionId === childSessionId)
      : undefined;
    return existing
      ? {
          ...state,
          subagents: upsertSubagent(state.subagents, {
            ...existing,
            status: eventStatus(data),
          }),
          hasSubagentSnapshot: true,
        }
      : state;
  }
  return state;
}

function parseHistoryEvent(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/**
 * The only event names the progress projection knows how to act on. Message
 * content is free-form assistant text, so "parses as JSON and has an
 * `eventType`" is far too loose a test: an assistant that pastes
 * `{"eventType":"todo_updated","todos":[]}` as part of an answer would
 * otherwise be able to rewrite the panel. Only these names are honoured, and
 * only in the shapes `reduceWebuiWorkspaceProgressEvent` actually reads.
 */
export const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...TODO_EVENT_TYPES,
  ...SUBAGENT_SPAWN_EVENT_TYPES,
  ...SUBAGENT_STATUS_EVENT_TYPES,
  ...SUBAGENT_REPORTED_EVENT_TYPES,
]);

function historyEvents(message: WebuiClientMessage): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const candidate of [
    message.msgContent,
    (message as unknown as Record<string, unknown>).msg_content,
    (message as unknown as Record<string, unknown>).content,
  ]) {
    const parsed = parseHistoryEvent(candidate);
    if (!parsed) continue;
    const type = eventType(parsed);
    if (type && PROGRESS_EVENT_TYPES.has(type)) result.push(parsed);
  }
  return result;
}

/** A `todowrite` call carries the full todo list in its input, so it is the
 * most direct carrier of progress state. Both the history rebuild and the
 * live path read it, which is why they can not drift apart. */
function applyTodoToolCalls(
  state: WebuiWorkspaceProgressState,
  message: WebuiClientMessage | Record<string, unknown>,
): WebuiWorkspaceProgressState {
  const loose = message as Record<string, unknown>;
  // `message` is a union, and its `Record<string, unknown>` arm types `toolCalls`
  // as `unknown` — so `message.toolCalls ?? []` leaves a non-iterable on the
  // right-hand side. Read the declared field through the same `Array.isArray`
  // guard as the snake_case one below it.
  const calls = [
    ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
    ...(Array.isArray(loose.tool_calls) ? loose.tool_calls : []),
  ];
  let next = state;
  for (const raw of calls) {
    const call = record(raw);
    if (!call) continue;
    // History carries the normalised `{ name, arguments }`; the live wire frame
    // still nests them under `function`, so read both shapes.
    const fn = record(call.function);
    const name = String(call.name ?? call.toolName ?? fn?.name ?? "").toLowerCase();
    if (name !== "todowrite" && name !== "todo_write") continue;
    const input = record(call.input) ?? parseHistoryEvent(fn?.arguments) ?? parseHistoryEvent(call.arguments);
    const todos = normalizeTodos(input?.todos);
    if (todos) next = { ...next, todos, hasTodoSnapshot: true };
  }
  return next;
}

/**
 * Reduce the Desktop-compatible events a LIVE stream message carries in its
 * serialized content.
 *
 * The runtime delivers `todo_updated` and friends as a system event inside
 * `msg_content` rather than on the global event bus, so the live path has to
 * dig them out itself. Without this the progress panel only ever showed the
 * start-of-session snapshot: `reduceWebuiWorkspaceProgressEvent` was handed
 * the whole frame, whose `type` is `agent_message`, so `eventType()` matched
 * nothing. The history rebuild above has understood this shape all along,
 * which is exactly why a refresh "fixed" it.
 */
export function reduceWebuiWorkspaceProgressMessage(
  state: WebuiWorkspaceProgressState,
  message: WebuiClientMessage | Record<string, unknown>,
  sessionId?: string,
): WebuiWorkspaceProgressState {
  let next = applyTodoToolCalls(state, message);
  for (const event of historyEvents(message as WebuiClientMessage))
    next = reduceWebuiWorkspaceProgressEvent(next, event, sessionId);
  return next;
}

/** Rebuild the last known Desktop-compatible state when opening a session. */
export function projectWebuiWorkspaceHistory(
  messages: readonly WebuiClientMessage[],
  sessionId?: string,
): WebuiWorkspaceProgressState {
  let state = initialWebuiWorkspaceProgress;
  for (const message of messages) {
    state = applyTodoToolCalls(state, message);
    for (const event of historyEvents(message))
      state = reduceWebuiWorkspaceProgressEvent(state, event, sessionId);
  }
  return state;
}
