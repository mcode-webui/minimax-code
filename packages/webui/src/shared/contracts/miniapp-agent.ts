// The Mini App page's agent bridge, as a wire contract.
//
// A Mini App page calls `window.mcode.miniapp.agent.*`. On the desktop client that
// namespace is an Electron preload and its calls ride IPC. Here the page is a
// browser iframe on the proxy's own origin, so every call crosses `postMessage`
// to the client that framed it, and the client relays it to the service. Three
// records make that auditable — the page/host message frames, the operation
// bodies, and the stream frames — and all three are declared here rather than in
// the modules that happen to produce them.
//
// Everything below the identity line is copied from `@mavis/shared/miniapp-surface`
// only by *reference*: the validators and DTOs that contract already publishes are
// imported, not restated. That module is both sides' authority for what a page may
// ask and what a controller may answer, so a second copy here would be a second
// authority that drifts silently.
//
// Two properties are decisions:
//
//   * **The page carries no identity.** A request names its method, its content and
//     a correlation id it chose. Plugin, host session, presentation and process
//     generation are resolved by the host from the frame it owns; a page that could
//     name them could act as another Mini App.
//   * **`observe` travels as its own field.** The transport that carries a turn's
//     events is a stream in this client, so "the page is listening" can no longer be
//     inferred from "a channel exists". A run with `observe: false` reaches the
//     runtime with no listener attached, which is what keeps its permission and
//     questionnaire asks from waiting on a page that is not reading them.

import type {
  MiniAppAgentAgents,
  MiniAppAgentBusyReason,
  MiniAppAgentFailureCode,
  MiniAppAgentModelSelection,
  MiniAppAgentModels,
  MiniAppAgentSessionContext,
  MiniAppAgentSessions,
  MiniAppAgentPermissionDecision,
  MiniAppAgentRunEvent,
  MiniAppAgentRunResult,
} from "@mavis/shared/miniapp-surface";
import {
  isMiniAppAgentPermissionDecision,
  isMiniAppAgentRequestId,
  MINIAPP_AGENT_MAX_ANSWERS,
  MINIAPP_AGENT_MAX_ANSWER_TEXT_LENGTH,
  MINIAPP_AGENT_MAX_REQUEST_ID_LENGTH,
  MINIAPP_AGENT_MAX_TEXT_LENGTH,
  readMiniAppAgentAnswers,
  readMiniAppAgentModelSelection,
} from "@mavis/shared/miniapp-surface";

/** Longest plugin, session or identifier a bridge body may carry. */
export const WEBUI_MINIAPP_AGENT_MAX_ID_LENGTH = 200;

// ---------------------------------------------------------------------------
// Page <-> host: the two frames a Mini App and the client that framed it exchange.
// ---------------------------------------------------------------------------

/** The page's request, page -> host. */
export const WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST = "mcode:miniapp:agent-request" as const;

/** The host's answer to one request, host -> page. */
export const WEBUI_MINIAPP_BRIDGE_AGENT_RESULT = "mcode:miniapp:agent-result" as const;

/** One progress event of a turn the page is observing, host -> page. */
export const WEBUI_MINIAPP_BRIDGE_AGENT_EVENT = "mcode:miniapp:agent-event" as const;

/**
 * The methods a page may call.
 *
 * `cancel` is a method rather than an implicit effect of dropping a promise: an
 * `AbortSignal` does not cross `postMessage`, so a page names the request it wants
 * stopped and the host settles that request through the runtime.
 */
export const WEBUI_MINIAPP_AGENT_METHODS = [
  "run",
  "answer",
  "reply",
  "models",
  "agents",
  "sessions",
  "session",
  "create",
  "open",
  "cancel",
] as const;

export type WebuiMiniAppAgentMethod = (typeof WEBUI_MINIAPP_AGENT_METHODS)[number];

/** The methods that follow a turn and may therefore stream events. */
export const WEBUI_MINIAPP_AGENT_TURN_METHODS = ["run", "answer"] as const;

export function isWebuiMiniAppAgentTurnMethod(
  value: unknown,
): value is (typeof WEBUI_MINIAPP_AGENT_TURN_METHODS)[number] {
  return value === "run" || value === "answer";
}

/** The page's request. Identity is absent by design; the host supplies it. */
export interface WebuiMiniAppAgentBridgeRequest {
  readonly type: typeof WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST;
  /** The page's own correlation key; echoed in its result and its events. */
  readonly requestId: string;
  readonly method: WebuiMiniAppAgentMethod;
  /** Method-specific content, validated again by the host before it is used. */
  readonly payload: Record<string, unknown>;
  /** Whether the page registered an event listener for this turn. */
  readonly observe: boolean;
}

/** What the page is told about one request. */
export type WebuiMiniAppAgentBridgeResult =
  | { readonly ok: true; readonly value?: unknown }
  | {
      readonly ok: false;
      readonly code: MiniAppAgentFailureCode;
      readonly reason?: MiniAppAgentBusyReason;
    };

export interface WebuiMiniAppAgentBridgeResultMessage {
  readonly type: typeof WEBUI_MINIAPP_BRIDGE_AGENT_RESULT;
  readonly requestId: string;
  readonly result: WebuiMiniAppAgentBridgeResult;
}

export interface WebuiMiniAppAgentBridgeEventMessage {
  readonly type: typeof WEBUI_MINIAPP_BRIDGE_AGENT_EVENT;
  readonly requestId: string;
  readonly event: MiniAppAgentRunEvent;
}

/**
 * One request read out of an untrusted message.
 *
 * The sender check is not here — it belongs to the host, which is the only side
 * that knows the frame it created — so this is the payload bound and nothing more.
 * A malformed request is dropped rather than answered: there is no request id to
 * answer it with, and a reply to an unreadable message is a reply to nobody.
 */
export function readWebuiMiniAppAgentBridgeRequest(
  data: unknown,
): WebuiMiniAppAgentBridgeRequest | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.type !== WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST) return undefined;
  if (!isMiniAppAgentRequestId(record.requestId)) return undefined;
  const method = record.method;
  if (!(WEBUI_MINIAPP_AGENT_METHODS as readonly unknown[]).includes(method)) return undefined;
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (typeof record.observe !== "boolean") return undefined;
  return {
    type: WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST,
    requestId: record.requestId,
    method: method as WebuiMiniAppAgentMethod,
    payload: payload as Record<string, unknown>,
    observe: record.observe,
  };
}

// ---------------------------------------------------------------------------
// Page -> service: the two operation bodies.
//
// `hostSessionId`, `connection` and `requestId` are the host's own facts, added by
// the client after it has satisfied itself about the sender. They travel so the
// service can fence a response to the presentation it was raised under and so one
// request id reaches the runtime and comes back.
// ---------------------------------------------------------------------------

/** What one bridge request carries once the host has resolved the page's identity. */
export interface WebuiMiniAppAgentCaller {
  readonly pluginId: string;
  /** The session whose view framed the page; the runtime's `hostSessionId`. */
  readonly hostSessionId: string;
  /**
   * The presentation and connection the request was raised under.
   *
   * A replaced frame, a navigation or a teardown bumps this, so a response or an
   * event produced for the old document cannot be delivered into the new one.
   */
  readonly connection: number;
  /** The page's correlation key, carried unchanged so the answer names its request. */
  readonly requestId: string;
}

/** One `run` / `answer` call: the turn-following half of the bridge. */
export interface WebuiMiniAppAgentTurnRequest extends WebuiMiniAppAgentCaller {
  readonly method: "run" | "answer";
  /** Whether the page is listening; the runtime only counts a listening run as answerable. */
  readonly observe: boolean;
  /** `run`: the text of the turn. */
  readonly text?: string;
  /** The Mini App session to continue; absent creates one. */
  readonly targetSessionId?: string;
  /** `run` creating a session: the agent it is created for. */
  readonly agent?: string;
  /** A model to switch the session to before the turn. */
  readonly model?: MiniAppAgentModelSelection;
  /** `answer`: the questionnaire being answered. */
  readonly questionRequestId?: string;
  /** `answer`: the answers, already validated by the shared reader. */
  readonly answers?: readonly Record<string, unknown>[];
}

/** One frame of a followed turn. */
export type WebuiMiniAppAgentTurnFrame =
  | { readonly kind: "event"; readonly event: MiniAppAgentRunEvent }
  | { readonly kind: "settled"; readonly result: MiniAppAgentRunResult }
  | {
      readonly kind: "failure";
      readonly code: MiniAppAgentFailureCode;
      readonly reason?: MiniAppAgentBusyReason;
    };

/** The short calls: everything that is one round trip. */
export const WEBUI_MINIAPP_AGENT_CALL_METHODS = [
  "models",
  "agents",
  "sessions",
  "session",
  "create",
  "reply",
  "open",
  "panelOpened",
  "panelClosed",
  "cancel",
] as const;

export type WebuiMiniAppAgentCallMethod = (typeof WEBUI_MINIAPP_AGENT_CALL_METHODS)[number];

export interface WebuiMiniAppAgentCallRequest extends WebuiMiniAppAgentCaller {
  readonly method: WebuiMiniAppAgentCallMethod;
  /** `create`: the agent the session is bound to. */
  readonly agent?: string;
  /** `reply` / `open` / `panelOpened` / `panelClosed`: the Mini App session concerned. */
  readonly targetSessionId?: string;
  /** `reply`: the pending permission ask. */
  readonly questionRequestId?: string;
  /** `reply`: `allowOnce` or `deny`; a Mini App never writes the user's rules. */
  readonly decision?: MiniAppAgentPermissionDecision;
}

/**
 * What a short call answers.
 *
 * `method` is echoed so the shape is self-describing: two successes with different
 * payloads would otherwise be told apart by their keys, which is a guess. A refusal
 * is an envelope, never a thrown error, so the page always receives a documented
 * code rather than a promise that never settles.
 */
export type WebuiMiniAppAgentCallResponse =
  | { readonly ok: true; readonly method: "models"; readonly models: MiniAppAgentModels }
  | { readonly ok: true; readonly method: "agents"; readonly agents: MiniAppAgentAgents }
  | { readonly ok: true; readonly method: "sessions"; readonly sessions: MiniAppAgentSessions }
  | {
      readonly ok: true;
      readonly method: "session";
      readonly session: MiniAppAgentSessionContext | undefined;
    }
  | { readonly ok: true; readonly method: "create"; readonly sessionId: string }
  | {
      readonly ok: true;
      readonly method: "open";
      readonly sessionId: string;
      readonly hostSessionId: string;
    }
  | {
      readonly ok: true;
      readonly method: "reply" | "panelOpened" | "panelClosed" | "cancel";
    }
  | {
      readonly ok: false;
      readonly code: MiniAppAgentFailureCode;
      readonly reason?: MiniAppAgentBusyReason;
    };

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= WEBUI_MINIAPP_AGENT_MAX_ID_LENGTH
  );
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Reads one call request's body; `undefined` when any required field is malformed. */
export function readWebuiMiniAppAgentTurnRequest(
  value: unknown,
): { readonly ok: true; readonly request: WebuiMiniAppAgentTurnRequest } | { readonly ok: false } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (!isBoundedId(record.pluginId)) return { ok: false };
  if (!isBoundedId(record.hostSessionId)) return { ok: false };
  if (!isGeneration(record.connection)) return { ok: false };
  if (!isMiniAppAgentRequestId(record.requestId)) return { ok: false };
  if (!isWebuiMiniAppAgentTurnMethod(record.method)) return { ok: false };
  if (typeof record.observe !== "boolean") return { ok: false };

  const base = {
    pluginId: record.pluginId,
    hostSessionId: record.hostSessionId,
    connection: record.connection,
    requestId: record.requestId,
    observe: record.observe,
  } as const;

  if (record.method === "run") {
    const text = record.text;
    if (typeof text !== "string" || text.length > MINIAPP_AGENT_MAX_TEXT_LENGTH) return { ok: false };
    if (record.targetSessionId !== undefined && !isBoundedId(record.targetSessionId))
      return { ok: false };
    if (record.agent !== undefined && typeof record.agent !== "string") return { ok: false };
    const model = record.model === undefined ? undefined : readMiniAppAgentModelSelection(record.model);
    if (record.model !== undefined && model === null) return { ok: false };
    return {
      ok: true,
      request: {
        ...base,
        method: "run",
        text,
        ...(record.targetSessionId !== undefined ? { targetSessionId: record.targetSessionId } : {}),
        ...(typeof record.agent === "string" ? { agent: record.agent } : {}),
        ...(model ? { model } : {}),
      },
    };
  }

  if (!isBoundedId(record.targetSessionId)) return { ok: false };
  if (!isMiniAppAgentRequestId(record.questionRequestId)) return { ok: false };
  const answers = readMiniAppAgentAnswers(record.answers);
  if (!answers) return { ok: false };
  const model = record.model === undefined ? undefined : readMiniAppAgentModelSelection(record.model);
  if (record.model !== undefined && model === null) return { ok: false };
  return {
    ok: true,
    request: {
      ...base,
      method: "answer",
      targetSessionId: record.targetSessionId,
      questionRequestId: record.questionRequestId,
      // The shared reader already enforced the count and per-answer bounds; this
      // type is the wire's structural view of the same list.
      answers: answers as unknown as readonly Record<string, unknown>[],
      ...(model ? { model } : {}),
    },
  };
}

/** Reads one short-call body; `undefined` when any field the method requires is malformed. */
export function readWebuiMiniAppAgentCallRequest(
  value: unknown,
): WebuiMiniAppAgentCallRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isBoundedId(record.pluginId)) return undefined;
  if (!isBoundedId(record.hostSessionId)) return undefined;
  if (!isGeneration(record.connection)) return undefined;
  if (!isMiniAppAgentRequestId(record.requestId)) return undefined;
  const method = record.method;
  if (!(WEBUI_MINIAPP_AGENT_CALL_METHODS as readonly unknown[]).includes(method)) return undefined;
  const base = {
    pluginId: record.pluginId,
    hostSessionId: record.hostSessionId,
    connection: record.connection,
    requestId: record.requestId,
  } as const;
  switch (method) {
    case "models":
    case "agents":
    case "cancel":
      return { ...base, method };
    case "sessions":
      return { ...base, method };
    case "session":
      if (record.sessionId !== undefined && !isBoundedId(record.sessionId)) return undefined;
      return {
        ...base,
        method: "session",
        ...(typeof record.sessionId === "string" ? { targetSessionId: record.sessionId } : {}),
      };
    case "create":
      if (record.agent !== undefined && typeof record.agent !== "string") return undefined;
      return {
        ...base,
        method: "create",
        ...(typeof record.agent === "string" ? { agent: record.agent } : {}),
      };
    case "open":
    case "panelOpened":
    case "panelClosed":
      if (!isBoundedId(record.targetSessionId)) return undefined;
      return { ...base, method, targetSessionId: record.targetSessionId };
    case "reply": {
      if (!isBoundedId(record.targetSessionId)) return undefined;
      if (!isMiniAppAgentRequestId(record.questionRequestId)) return undefined;
      if (!isMiniAppAgentPermissionDecision(record.decision)) return undefined;
      return {
        ...base,
        method: "reply",
        targetSessionId: record.targetSessionId,
        questionRequestId: record.questionRequestId,
        decision: record.decision,
      };
    }
    default:
      return undefined;
  }
}

/** Re-exported so one module states the page's bounds as well as its shapes. */
export const WEBUI_MINIAPP_AGENT_BOUNDS = {
  requestId: MINIAPP_AGENT_MAX_REQUEST_ID_LENGTH,
  text: MINIAPP_AGENT_MAX_TEXT_LENGTH,
  answers: MINIAPP_AGENT_MAX_ANSWERS,
  answerText: MINIAPP_AGENT_MAX_ANSWER_TEXT_LENGTH,
} as const;
