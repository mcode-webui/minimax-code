// The page bridge's host half: what the client that framed a Mini App does with
// its `window.mcode.miniapp.agent` calls.
//
// The server owns authority — plugin, generation, runtime policy — and the page
// owns nothing. This module owns the part in between: deciding that a message came
// from the frame this view created, adding the identity the client does know (the
// host session, the connection generation and the page's correlation id), and
// carrying one request's answer and events back to that same document.
//
// Three rules make it safe to point at an untrusted page:
//
//   * **The sender is checked, not trusted.** A message is read only when its
//     `source` is the frame this view created and its origin is the one this view
//     framed. Any window can post to this one; a bridge that answered them would let
//     any page in the browser spend the person's turn.
//   * **Identity is the host's.** The page names content and a correlation id. The
//     plugin, the host session, the connection generation — and every runtime fact
//     behind them — are added here, from the view.
//   * **One request id is one call.** A second request naming a live id is answered
//     `busy` rather than sharing that id's events and settlement, and a document
//     that goes away detaches every turn it had open.
//
// Framework-free: it takes a `post` function and a commands object, so a test drives
// the real routing against a fake frame without a browser.

import {
  isMiniAppAgentFailureCode,
  isMiniAppAgentPermissionDecision,
  isMiniAppAgentRequestId,
  MINIAPP_AGENT_MAX_TEXT_LENGTH,
  readMiniAppAgentAnswers,
  readMiniAppAgentCreateRequest,
  readMiniAppAgentModelSelection,
  readMiniAppAgentOpenRequest,
  readMiniAppAgentReplyRequest,
  readMiniAppAgentRunRequest,
  type MiniAppAgentModelSelection,
} from "@mavis/shared/miniapp-surface";

import {
  isWebuiMiniAppAgentTurnMethod,
  readWebuiMiniAppAgentBridgeRequest,
  WEBUI_MINIAPP_AGENT_MAX_ID_LENGTH,
  WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST,
  WEBUI_MINIAPP_BRIDGE_AGENT_EVENT,
  WEBUI_MINIAPP_BRIDGE_AGENT_RESULT,
  type WebuiMiniAppAgentBridgeRequest,
  type WebuiMiniAppAgentBridgeResult,
  type WebuiMiniAppAgentCallRequest,
  type WebuiMiniAppAgentCallResponse,
  type WebuiMiniAppAgentTurnFrame,
  type WebuiMiniAppAgentTurnRequest,
} from "../../../../shared/contracts/miniapp-agent.js";
import { webuiMiniAppBridgeSenderAllowed } from "./miniapp-bridge.js";

/** What the bridge asks the business to do. */
export interface WebuiMiniAppAgentBridgeCommands {
  /** One short call, refusal included in its body. */
  readonly call: (request: WebuiMiniAppAgentCallRequest) => Promise<WebuiMiniAppAgentCallResponse>;
  /**
   * One followed turn. The detach is the teardown: it closes this turn's stream
   * and nothing else.
   */
  readonly watchTurn: (
    request: WebuiMiniAppAgentTurnRequest,
    onFrame: (frame: WebuiMiniAppAgentTurnFrame) => void,
    onFailure: (error: Error) => void,
  ) => () => void;
}

export interface CreateWebuiMiniAppAgentBridgeInput {
  readonly pluginId: string;
  /** The session whose view framed the page; the runtime's `hostSessionId`. */
  readonly hostSessionId: string;
  /** The generation the service issued when it answered `openMiniApp`. */
  readonly connection: number;
  /** The proxy's URL this view framed, so its origin is the one allowed. */
  readonly viewUrl: string;
  /** Posts one frame into the page. Supplied by the view, which holds the frame. */
  readonly post: (message: unknown) => void;
  readonly commands: WebuiMiniAppAgentBridgeCommands;
}

export interface WebuiMiniAppAgentBridgeEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

export interface WebuiMiniAppAgentBridgeHost {
  /**
   * Handles one message. `frame` is the browser object the view created, so the
   * check can compare it with the message's source.
   */
  readonly handleMessage: (event: WebuiMiniAppAgentBridgeEvent, frame: unknown) => void;
  /**
   * The framed document was replaced by a navigation.
   *
   * The page's pending map dies with it, so the turns it opened are cancelled
   * through the service and detached here. Leaving them attached would keep the
   * runtime counting a listener that no longer exists, and the replacement document
   * would inherit a settlement addressed to nobody.
   */
  readonly handleDocumentReplaced: () => void;
  /** Detaches every turn this document had open and stops answering. */
  readonly close: () => void;
  /** The turn ids in flight, for teardown and for a test. */
  readonly inFlight: () => readonly string[];
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= WEBUI_MINIAPP_AGENT_MAX_ID_LENGTH
  );
}

/** The model a page may name, or nothing when it named none. */
function modelOf(payload: Record<string, unknown>): MiniAppAgentModelSelection | undefined {
  if (payload.model === undefined) return undefined;
  return readMiniAppAgentModelSelection(payload.model) ?? undefined;
}

/**
 * Builds the host half for one mounted view.
 *
 * The host is per document: a replacement view gets a new one with the new
 * generation, and the old one's `close` is what stops its turns. That is the
 * client-side half of generation fencing — the service enforces the other half by
 * refusing a call whose connection it never issued.
 */
export function createWebuiMiniAppAgentBridge(
  input: CreateWebuiMiniAppAgentBridgeInput,
): WebuiMiniAppAgentBridgeHost {
  /** One detach per in-flight turn, so a teardown can end exactly those. */
  const turns = new Map<string, () => void>();
  /** Request ids are shared across short calls and streamed turns. */
  const inFlightIds = new Set<string>();
  let closed = false;

  function postToPage(message: unknown): void {
    if (closed) return;
    input.post(message);
  }

  function answer(requestId: string, result: WebuiMiniAppAgentBridgeResult): void {
    postToPage({ type: WEBUI_MINIAPP_BRIDGE_AGENT_RESULT, requestId, result });
  }

  /** The identity every body carries: resolved here, never page-supplied. */
  function base(requestId: string) {
    return {
      pluginId: input.pluginId,
      hostSessionId: input.hostSessionId,
      connection: input.connection,
      requestId,
    } as const;
  }

  /**
   * One turn, followed to its settlement.
   *
   * The settlement is the page's promise: a `settled` frame resolves it with the
   * run's result and a `failure` frame rejects it with the code the service chose.
   * A stream that fails at the transport level (the service went away, the socket
   * dropped) is `result_unknown`, because the turn may already have been accepted.
   */
  function startTurn(
    request: WebuiMiniAppAgentBridgeRequest,
    body: WebuiMiniAppAgentTurnRequest,
  ): void {
    const requestId = request.requestId;
    /**
     * Whether the watch is still open.
     *
     * A watch can settle synchronously — a host with no capability, a view with no
     * host session — and it settles before it has returned its detach. Recording
     * the id first would leave a settled turn in flight, where it would answer a
     * retry `busy` and forward a cancellation for a turn that never started.
     */
    let live = true;
    const settle = (result: WebuiMiniAppAgentBridgeResult): void => {
      live = false;
      turns.delete(requestId);
      inFlightIds.delete(requestId);
      answer(requestId, result);
    };
    const detach = input.commands.watchTurn(
      body,
      (frame) => {
        if (frame.kind === "event") {
          postToPage({
            type: WEBUI_MINIAPP_BRIDGE_AGENT_EVENT,
            requestId,
            event: frame.event,
          });
          return;
        }
        settle(
          frame.kind === "settled"
            ? { ok: true, value: frame.result }
            : { ok: false, code: frame.code, ...(frame.reason ? { reason: frame.reason } : {}) },
        );
      },
      (error) => {
        // A refused or broken stream: the runtime may have accepted the turn before
        // the failure, so it is never reported as a clean rejection.
        const failureCode = (error as { code?: unknown } | undefined)?.code;
        settle({
          ok: false,
          code: isMiniAppAgentFailureCode(failureCode) ? failureCode : "result_unknown",
        });
      },
    );
    if (live) turns.set(requestId, detach);
    else detach();
  }

  /** Turns one page payload into the wire body the service validates. */
  function turnBody(
    request: WebuiMiniAppAgentBridgeRequest,
  ): WebuiMiniAppAgentTurnRequest | undefined {
    const payload = request.payload;
    if (request.method === "run") {
      const read = readMiniAppAgentRunRequest({
        text: payload.text,
        sessionId: payload.sessionId,
        model: payload.model,
        agent: payload.agent,
        requestId: request.requestId,
      });
      if (!read) return undefined;
      const model = modelOf(payload);
      return {
        ...base(request.requestId),
        method: "run",
        observe: request.observe,
        text: read.text.slice(0, MINIAPP_AGENT_MAX_TEXT_LENGTH),
        ...(read.sessionId !== undefined ? { targetSessionId: read.sessionId } : {}),
        ...(read.agent !== undefined ? { agent: read.agent } : {}),
        ...(model ? { model } : {}),
      };
    }
    if (!isBoundedId(payload.sessionId)) return undefined;
    if (!isBoundedId(payload.questionId ?? payload.requestId)) return undefined;
    const answers = readMiniAppAgentAnswers(payload.answers);
    if (!answers) return undefined;
    const model = modelOf(payload);
    return {
      ...base(request.requestId),
      method: "answer",
      observe: request.observe,
      targetSessionId: payload.sessionId,
      questionRequestId: String(payload.questionId ?? payload.requestId),
      answers: answers as unknown as readonly Record<string, unknown>[],
      ...(model ? { model } : {}),
    };
  }

  /** Turns one short-call payload into the wire body the service validates. */
  function callBody(
    request: WebuiMiniAppAgentBridgeRequest,
  ): WebuiMiniAppAgentCallRequest | undefined {
    const payload = request.payload;
    switch (request.method) {
      case "models":
      case "agents":
      case "sessions":
        return { ...base(request.requestId), method: request.method };
      case "session": {
        if (payload.sessionId !== undefined &&
            (typeof payload.sessionId !== "string" || payload.sessionId.length === 0 || payload.sessionId.length > WEBUI_MINIAPP_AGENT_MAX_ID_LENGTH)) {
          return undefined;
        }
        return {
          ...base(request.requestId),
          method: "session",
          ...(typeof payload.sessionId === "string" ? { targetSessionId: payload.sessionId } : {}),
        };
      }
      case "cancel":
        return { ...base(request.requestId), method: "cancel" };
      case "create": {
        const read = readMiniAppAgentCreateRequest(payload);
        if (!read) return undefined;
        return {
          ...base(request.requestId),
          method: "create",
          ...(read.agent !== undefined ? { agent: read.agent } : {}),
        };
      }
      case "open": {
        const read = readMiniAppAgentOpenRequest(payload);
        if (!read) return undefined;
        return { ...base(request.requestId), method: "open", targetSessionId: read.sessionId };
      }
      case "reply": {
        const read = readMiniAppAgentReplyRequest(payload);
        if (!read) return undefined;
        if (!isMiniAppAgentPermissionDecision(read.decision)) return undefined;
        return {
          ...base(request.requestId),
          method: "reply",
          targetSessionId: read.sessionId,
          questionRequestId: read.requestId,
          decision: read.decision,
        };
      }
      default:
        return undefined;
    }
  }

  function dispatch(request: WebuiMiniAppAgentBridgeRequest): void {
    // A cancellation names a turn this document already opened — so it is the one
    // method whose request id is *expected* to be in flight, and it is decided
    // before the duplicate guard rather than being refused by it.
    if (request.method === "cancel") {
      if (!turns.has(request.requestId)) {
        answer(request.requestId, { ok: false, code: "request_not_found" });
        return;
      }
      void input.commands
        .call({ ...base(request.requestId), method: "cancel" })
        .then((response) => {
          if (!response.ok) answer(request.requestId, response);
          // A successful cancellation is answered by the turn's own failure frame,
          // which is the settlement the page's promise is waiting on.
        })
        .catch(() => undefined);
      return;
    }
    // Two calls sharing an id would also share its events and its settlement.
    if (inFlightIds.has(request.requestId)) {
      answer(request.requestId, { ok: false, code: "busy" });
      return;
    }
    if (isWebuiMiniAppAgentTurnMethod(request.method)) {
      const body = turnBody(request);
      if (!body) {
        answer(request.requestId, { ok: false, code: "invalid_request" });
        return;
      }
      inFlightIds.add(request.requestId);
      startTurn(request, body);
      return;
    }
    const body = callBody(request);
    if (!body) {
      answer(request.requestId, { ok: false, code: "invalid_request" });
      return;
    }
    inFlightIds.add(request.requestId);
    void input.commands.call(body).then(
      (response) => {
        answer(
          request.requestId,
          response.ok
            ? { ok: true, value: pageValueOf(response) }
            : {
                ok: false,
                code: response.code,
                ...(response.reason ? { reason: response.reason } : {}),
              },
        );
      },
      () => {
        // A transport failure on a call that may have applied: the code says so.
        answer(request.requestId, { ok: false, code: "result_unknown" });
      },
    ).finally(() => inFlightIds.delete(request.requestId));
  }

  return {
    handleMessage(event, frame) {
      if (closed) return;
      if (
        !webuiMiniAppBridgeSenderAllowed({
          origin: event.origin,
          viewUrl: input.viewUrl,
          source: event.source,
          frame,
        })
      ) {
        return;
      }
      const request = readWebuiMiniAppAgentBridgeRequest(event.data);
      if (request) {
        dispatch(request);
        return;
      }
      if (
        event.data &&
        typeof event.data === "object" &&
        !Array.isArray(event.data)
      ) {
        const raw = event.data as Record<string, unknown>;
        if (
          raw.type === WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST &&
          isMiniAppAgentRequestId(raw.requestId)
        ) {
          answer(raw.requestId, { ok: false, code: "invalid_request" });
        }
      }
    },
    handleDocumentReplaced() {
      if (closed) return;
      // Cancel before detaching: the service settles the abort and frees the id, so
      // the replacement document cannot inherit a turn it never opened.
      for (const requestId of [...turns.keys()]) {
        void input.commands
          .call({
            ...base(requestId),
            method: "cancel",
          })
          .catch(() => undefined);
      }
      for (const detach of turns.values()) detach();
      turns.clear();
      inFlightIds.clear();
    },
    close() {
      if (closed) return;
      closed = true;
      for (const detach of turns.values()) detach();
      turns.clear();
      inFlightIds.clear();
    },
    inFlight: () => [...turns.keys()],
  };
}

/**
 * What a page's method resolves.
 *
 * The shipped preload resolves the payload of a call, not the envelope around it:
 * `models()` answers the catalogue with its default, `agents()` answers the agent
 * list, `create()` answers the created session, and the calls with nothing to
 * return answer nothing. A page written against the desktop client destructures
 * those values, so an extra layer here is a page that breaks on its first line.
 */
function pageValueOf(
  response: Extract<WebuiMiniAppAgentCallResponse, { readonly ok: true }>,
): unknown {
  switch (response.method) {
    case "models":
      return response.models;
    case "agents":
      return response.agents;
    case "sessions":
      return response.sessions;
    case "session":
      return response.session;
    case "create":
      return { sessionId: response.sessionId };
    default:
      // `open`, `reply`, the two panel reports and `cancel` settle with nothing to
      // read, exactly as the preload's `invoke` returns for them.
      return undefined;
  }
}
