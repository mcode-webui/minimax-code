// The WebSocket wire mechanics every operation shares.
//
// Requests normally own a socket; frequent unary inputs may share an idle-bounded
// connection. This module writes the envelope, tells the caller's answer apart from
// whatever else arrives on that socket, and settles. What a frame *means* is
// not shared — a unary response resolves, an `event` frame is forwarded until
// `[DONE]`, a terminal frame is forwarded until the caller stops — so each
// caller supplies its own handlers.
//
// This module names no operation of its own: `operation` arrives as a
// parameter. The domain method table that supplies it — through the canonical
// identifiers in `shared/operation-names.ts` — is
// `client/platform/transport.ts`. Wire lifecycle mechanics here, domain
// method tables there is the whole split.

import type { WebuiDeliveryHandle } from "../features/turn/contracts/execution-port.js";
import type { WebuiStreamFrame } from "../../shared/contracts/stream.js";
import type {
  WebuiMiniAppPresentationIntent,
  WebuiMiniAppPresentationState,
} from "../../shared/contracts/miniapp.js";
import type {
  WebuiMiniAppAgentTurnFrame,
  WebuiMiniAppAgentTurnRequest,
} from "../../shared/contracts/miniapp-agent.js";
import type { WebuiTerminalFrame } from "../../shared/contracts/terminal.js";
import type {
  WebuiBrowserImageFrame,
  WebuiBrowserSurface,
  WebuiBrowserTargetId,
  WebuiBrowserViewport,
  WebuiBrowserWebTabSnapshot,
} from "../../shared/contracts/browser.js";
import type {
  OperationSpec,
  WebuiUnaryOperationName,
} from "../../shared/operation-names.js";
import {
  decodeWebuiServerFrame,
  WEBUI_ANONYMOUS_REQUEST_ID,
  WebuiErrorCode,
  WebuiWireError,
  type WebuiFrameRejectionReason,
} from "../../shared/envelope.js";
import { decodeWebuiOperationResult } from "../../shared/operation-codecs.js";
import {
  createWebuiEventChannel,
  type WebuiClientEventWatcher,
  type WebuiSocket,
  type WireFrame,
} from "./event-channel.js";

export type { WebuiSocket };

export interface WebuiWireOptions {
  readonly websocketUrl: string;
  readonly token: string;
  readonly webSocket?: new (url: string) => WebuiSocket;
  /** Deadline for unary operations that otherwise could remain pending on a half-open socket. */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** A socket carrying one request, and the only way to settle it. */
export interface WebuiWireSession {
  readonly close: () => void;
}

/**
 * What a caller does with the frames of its own request. Everything but
 * `frame` is optional, because the three call shapes below disagree about what a
 * parse failure, a close or a socket error means — `watchTerminal` ignores all
 * three, a unary request rejects on all three.
 *
 * `invalidFrame` receives the *reason*, not just the fact. A caller that cannot
 * tell "the service said something that was not JSON" from "the service speaks a
 * different protocol version" from "the frame claims this version and is
 * malformed" cannot decide what to do about any of them.
 */
interface WebuiWireHandlers {
  readonly frame: (session: WebuiWireSession, frame: WireFrame) => void;
  readonly invalidFrame?: (
    session: WebuiWireSession,
    reason: WebuiFrameRejectionReason,
  ) => void;
  readonly closed?: (session: WebuiWireSession) => void;
  readonly failed?: (session: WebuiWireSession) => void;
}

/**
 * The refusal a frame that could not be decoded earns.
 *
 * The messages are diagnostic, not product copy — the branchable half is the
 * code, and these match the English wording the rest of this module already uses
 * for its transport failures, so a socket problem reads the same way whichever
 * side noticed it.
 */
function rejectionError(reason: WebuiFrameRejectionReason, operation: string): WebuiWireError {
  switch (reason) {
    case "invalid_json":
      return new WebuiWireError(
        WebuiErrorCode.invalidEnvelope,
        `${operation} returned invalid JSON`,
      );
    case "protocol_mismatch":
      return new WebuiWireError(
        WebuiErrorCode.protocolMismatch,
        `${operation} returned a frame from a different WebUI protocol version`,
      );
    default:
      return new WebuiWireError(
        WebuiErrorCode.invalidEnvelope,
        `${operation} returned a frame that does not match the WebUI envelope`,
      );
  }
}

function defaultWebSocket(): new (url: string) => WebuiSocket {
  return WebSocket as unknown as new (url: string) => WebuiSocket;
}

/** The three request shapes the domain method table drives. */
export interface WebuiWire {
  /**
   * A unary request. The operation name decides both the body and the result:
   * `K` is one of `WebuiUnaryOperationName`, the body must be that operation's
   * declared request, and the promise resolves with its declared response. A
   * caller therefore cannot pick an unrelated result type, and a stream
   * operation is not nameable here at all — it has its own entry points below.
   */
  request<K extends WebuiUnaryOperationName>(
    operation: K,
    body: OperationSpec[K]["request"],
    options?: { readonly reuseConnection?: boolean },
  ): Promise<OperationSpec[K]["response"]>;
  stream(
    operation: string,
    body: unknown,
    onFrame: (frame: WebuiStreamFrame) => void,
    onDelivery?: (handle: WebuiDeliveryHandle) => void,
  ): Promise<void>;
  watchTerminal(
    operation: string,
    requestBody: { readonly terminalId: string },
    onFrame: (frame: WebuiTerminalFrame) => void,
  ): () => void;
  /**
   * A long-lived frame watch for a host-side stream.
   *
   * The remote-control status and the remote terminal are watches rather than
   * request/response streams: the subscription outlives the render that opened
   * it, and detaching has to release the runtime-side resources the socket held
   * rather than merely stop reading them.
   */
  watchFrames<T>(
    operation: string,
    requestBody: unknown,
    onFrame: (frame: T) => void,
  ): () => void;
  /**
   * The browser image stream.
   *
   * A watch rather than a stream: the panel keeps the images flowing for as
   * long as it is showing the browser, and detaching has to release the
   * provider-side resources the stream held rather than merely stop reading
   * them.
   */
  watchBrowserFrames(
    operation: string,
    requestBody: { readonly surface: WebuiBrowserSurface; readonly target: WebuiBrowserTargetId },
    onFrame: (frame: WebuiBrowserImageFrame) => void,
  ): () => void;
  /**
   * The web-tab snapshot stream.
   *
   * A watch rather than a stream, for the same reason the frame stream is one:
   * the subscription outlives the render that opened it, and detaching has to
   * release the runtime-side resources the stream held.
   */
  watchBrowserWebTabs(
    operation: string,
    requestBody: { readonly surface: WebuiBrowserSurface },
    onSnapshot: (snapshot: WebuiBrowserWebTabSnapshot) => void,
  ): () => void;
  /**
   * The standalone presentation lease (ADR 0020).
   *
   * A watch rather than a request because the lease's lifetime *is* the socket's:
   * the service releases the record when this connection closes, which is what
   * makes a standalone tab's presentation end when the tab does. The returned
   * function is the release.
   */
  watchMiniAppPresentation(
    operation: string,
    requestBody: { readonly pluginId: string; readonly sessionId: string },
    onFrame: (state: WebuiMiniAppPresentationState) => void,
    onFailure?: (error: Error) => void,
  ): () => void;
  watchMiniAppPresenter(
    operation: string,
    onFrame: (intent: WebuiMiniAppPresentationIntent) => void,
    onFailure?: (error: Error) => void,
  ): () => void;
  /**
   * One followed Mini App turn, as a stream.
   *
   * The settlement arrives as the stream's last frame rather than as the socket's
   * closing: `settled` carries the turn's result and `failure` its code, so a page
   * always learns how the call ended instead of inferring it from a drop.
   */
  watchMiniAppAgentTurn(
    operation: string,
    requestBody: WebuiMiniAppAgentTurnRequest,
    onFrame: (frame: WebuiMiniAppAgentTurnFrame) => void,
    onFailure?: (error: Error) => void,
  ): () => void;
  /** The one HTTP route, built from the same base and token as the socket. */
  workspaceFileUrl(input: { readonly workspaceDir: string; readonly path: string }): string;
  /**
   * The standalone Mini App's page, built from the same base and token.
   *
   * The page route is admitted like every other document — the service checks the
   * token on an `index.html` read — so the link carries it. The plugin and the
   * session ride the query because they are the deep link's whole content.
   */
  miniappStandaloneUrl(input: {
    readonly pluginId: string;
    readonly sessionId: string;
  }): string;
  /**
   * The process-event socket. It belongs to the wire rather than to the table
   * because it is a long-lived socket with its own reconnect policy, not a
   * named request: the table joins it to the `watchEvents` capability and names
   * no operation for it.
   */
  readonly watchEvents: WebuiClientEventWatcher;
}

export function createWebuiWire({
  websocketUrl: baseWebsocketUrl,
  token,
  webSocket = defaultWebSocket(),
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: WebuiWireOptions): WebuiWire {
  const websocketUrl = () =>
    `${baseWebsocketUrl.replace(/\/$/u, "")}/?token=${encodeURIComponent(token)}`;

  // Frequent inputs share a connection; identity, response and deadline remain per request.
  let reusable: ReturnType<typeof createReusableConnection> | undefined;
  function createReusableConnection() {
    const ws = new webSocket(websocketUrl());
    const pending = new Map<string, {
      session: WebuiWireSession;
      handlers: WebuiWireHandlers;
      payload: string;
    }>();
    let opened = false;
    let closed = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (reusable === connection) reusable = undefined;
      ws.close();
    };
    const failAll = (kind: "closed" | "failed", reason?: WebuiFrameRejectionReason) => {
      if (closed) return;
      const entries = [...pending.values()];
      close();
      for (const { session, handlers } of entries) {
        if (reason) handlers.invalidFrame?.(session, reason);
        else handlers[kind]?.(session);
      }
    };
    const connection = {
      open(operation: string, body: unknown, handlers: WebuiWireHandlers): WebuiWireSession {
        if (idleTimer) clearTimeout(idleTimer);
        const requestId = crypto.randomUUID();
        const session = {
          close: () => {
            pending.delete(requestId);
            if (!closed && pending.size === 0) idleTimer = setTimeout(close, 1000);
          },
        };
        const payload = JSON.stringify({ protocolVersion: 1, kind: "request", requestId, operation, body });
        pending.set(requestId, { session, handlers, payload });
        if (opened) {
          try {
            ws.send(payload);
          } catch {
            failAll("failed");
          }
        }
        return session;
      },
    };
    ws.addEventListener("open", () => {
      opened = true;
      try {
        for (const { payload } of pending.values()) ws.send(payload);
      } catch {
        failAll("failed");
      }
    });
    ws.addEventListener("message", (event) => {
      if (closed) return;
      const decoded = decodeWebuiServerFrame(String(event.data));
      if (!decoded.ok) {
        failAll("failed", decoded.reason);
        return;
      }
      const frame = decoded.frame;
      if (frame.kind === "error" && frame.requestId === WEBUI_ANONYMOUS_REQUEST_ID) {
        for (const { session, handlers } of [...pending.values()]) handlers.frame(session, frame);
        close();
        return;
      }
      const entry = pending.get(frame.requestId);
      entry?.handlers.frame(entry.session, frame);
    });
    ws.addEventListener("close", () => failAll("closed"));
    ws.addEventListener("error", () => failAll("failed"));
    return connection;
  }

  /**
   * One socket, one request frame, one requestId.
   *
   * Every operation opens a socket, writes the same envelope once the socket
   * opens, and then has to tell its own answer apart from whatever else arrives
   * on that socket. That part is shared. What a frame *means* is not, so the
   * handler decides. The session is passed back to each handler because settling
   * means closing this socket, and a handler that reached for it by closure would
   * be reading a `const` that does not exist yet when the socket opens
   * synchronously.
   */
  function openWireSession(
    operation: string,
    body: unknown,
    handlers: WebuiWireHandlers,
  ): WebuiWireSession {
    const ws = new webSocket(websocketUrl());
    const requestId = crypto.randomUUID();
    const session: WebuiWireSession = { close: () => ws.close() };
    ws.addEventListener("open", () =>
      ws.send(
        JSON.stringify({
          protocolVersion: 1,
          kind: "request",
          requestId,
          operation,
          body,
        }),
      ),
    );
    ws.addEventListener("message", (event) => {
      // Every inbound frame is judged here, once, by the shared decoder: parse,
      // then protocol version, then kind, then the identity it claims. The client
      // used to `JSON.parse(...) as WireFrame` and check nothing else, so a
      // service speaking a different protocol version was read as though it had
      // answered, and a frame that merely *claimed* to be a response was treated
      // as one.
      const decoded = decodeWebuiServerFrame(String(event.data));
      if (!decoded.ok) {
        handlers.invalidFrame?.(session, decoded.reason);
        return;
      }
      if (decoded.frame.requestId !== requestId) {
        // A refusal the service could not attribute belongs to the socket it
        // arrived on, and this socket carries exactly one request: the read that
        // failed to establish the identity is exactly the read this client must
        // be told about. Dropping it would leave the caller waiting for a timeout
        // while the answer was already on the wire.
        const attributable =
          decoded.frame.kind === "error" &&
          decoded.frame.requestId === WEBUI_ANONYMOUS_REQUEST_ID;
        // Any other identity belongs to another request on another socket.
        // Dropping it is the only correct action: it is not an error, and
        // settling this request with it would answer the wrong question.
        if (!attributable) return;
      }
      handlers.frame(session, decoded.frame);
    });
    ws.addEventListener("close", () => handlers.closed?.(session));
    ws.addEventListener("error", () => handlers.failed?.(session));
    return session;
  }

  function request<K extends WebuiUnaryOperationName>(
    operation: K,
    body: OperationSpec[K]["request"],
    options?: { readonly reuseConnection?: boolean },
  ): Promise<OperationSpec[K]["response"]> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const fail = (session: WebuiWireSession, error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        session.close();
        reject(error);
      };
      const open = options?.reuseConnection
        ? (reusable ??= createReusableConnection()).open
        : openWireSession;
      const session = open(operation, body, {
        frame: (session, frame) => {
          if (frame.kind === "error") {
            // The service's own code travels with the refusal. This is what lets a
            // caller branch on `shutting_down` or `unknown_operation` without
            // matching on an English message, and it keeps an unfamiliar but
            // stable code intact instead of turning every refusal into one shape.
            fail(
              session,
              new WebuiWireError(frame.code, frame.message, frame.requestId),
            );
            return;
          }
          if (frame.kind !== "response") return;
          // The body is judged before it is committed: a frame that is a valid
          // envelope but not this operation's result is a wire refusal, not a
          // value for a caller to discover a missing field in later.
          let decoded: OperationSpec[K]["response"];
          try {
            decoded = decodeWebuiOperationResult(operation, frame.body);
          } catch (error) {
            fail(session, error instanceof Error ? error : new Error(String(error)));
            return;
          }
          settled = true;
          clearTimeout(timeout);
          session.close();
          resolve(decoded);
        },
        invalidFrame: (session, reason) => fail(session, rejectionError(reason, operation)),
        closed: (session) =>
          fail(session, new Error("WebUI connection closed before the response")),
        failed: (session) => fail(session, new Error("WebUI connection failed")),
      });
      timeout = setTimeout(
        () =>
          fail(
            session,
            new Error(`WebUI request timed out after ${requestTimeoutMs}ms (${operation})`),
          ),
        requestTimeoutMs,
      );
    });
  }

  // `sendMessage` and `resumeSession` share the same wire shape: the
  // operation returns an `event`-framed iterable that ends with a
  // `[DONE]` payload (see `session-stream-delivery.ts`). One helper keeps the
  // close/error race in lockstep across both operations.
  function stream(
    operation: string,
    body: unknown,
    onFrame: (frame: WebuiStreamFrame) => void,
    onDelivery?: (handle: WebuiDeliveryHandle) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      // A detached delivery must not deliver, and `close()` is not a promise that
      // the socket stops emitting — the same rule `watchTerminal` follows.
      let detached = false;
      const fail = (session: WebuiWireSession, error: Error) => {
        if (settled) return;
        settled = true;
        session.close();
        reject(error);
      };
      const session = openWireSession(operation, body, {
        frame: (session, frame) => {
          if (detached) return;
          if (frame.kind === "error") {
            fail(
              session,
              new WebuiWireError(frame.code, frame.message ?? `${operation} refused`, frame.requestId),
            );
            return;
          }
          if (frame.kind !== "event") return;
          const streamFrame = frame.body as WebuiStreamFrame;
          onFrame(streamFrame);
          if (streamFrame.dataJson === "[DONE]") {
            settled = true;
            session.close();
            resolve();
          }
        },
        invalidFrame: (session, reason) => fail(session, rejectionError(reason, operation)),
        closed: (session) => fail(session, new Error("WebUI connection closed before [DONE]")),
        failed: (session) => fail(session, new Error("WebUI connection failed")),
      });
      onDelivery?.({
        close: () => {
          if (settled) return;
          // Detaching SETTLES the operation rather than failing it: the host
          // accepted this request long ago, so there is no error to report and no
          // recovery to attempt — the client simply stops watching. Failing here
          // would hand the loop a transport error and make a deliberate detach
          // look like a dropped connection.
          detached = true;
          settled = true;
          session.close();
          resolve();
        },
      });
    });
  }

  function watchTerminal(
    operation: string,
    requestBody: { readonly terminalId: string },
    onFrame: (frame: WebuiTerminalFrame) => void,
  ): () => void {
    let stopped = false;
    const session = openWireSession(operation, requestBody, {
      frame: (_session, frame) => {
        // A stopped watch must not deliver, and `close()` is not a promise that
        // the socket stops emitting: the caller's flag is what guarantees it.
        if (stopped) return;
        if (frame.kind !== "event" || !frame.body || typeof frame.body !== "object") return;
        onFrame(frame.body as WebuiTerminalFrame);
      },
    });
    return () => {
      stopped = true;
      session.close();
    };
  }

  function watchFrames<T>(
    operation: string,
    requestBody: unknown,
    onFrame: (frame: T) => void,
  ): () => void {
    let stopped = false;
    const session = openWireSession(operation, requestBody, {
      frame: (_session, frame) => {
        // A stopped watch must not deliver, and `close()` is not a promise that
        // the socket stops emitting: the caller's flag is what guarantees it.
        if (stopped) return;
        if (frame.kind !== "event" || !frame.body || typeof frame.body !== "object") return;
        onFrame(frame.body as T);
      },
    });
    return () => {
      stopped = true;
      session.close();
    };
  }

  function watchBrowserFrames(
    operation: string,
    requestBody: {
      readonly surface: WebuiBrowserSurface;
      readonly target: WebuiBrowserTargetId;
      readonly viewport?: WebuiBrowserViewport;
    },
    onFrame: (frame: WebuiBrowserImageFrame) => void,
  ): () => void {
    let stopped = false;
    const session = openWireSession(operation, requestBody, {
      frame: (_session, frame) => {
        // A stopped watch must not deliver, and `close()` is not a promise that
        // the socket stops emitting: the caller's flag is what guarantees it.
        if (stopped) return;
        if (frame.kind !== "event" || !frame.body || typeof frame.body !== "object") return;
        onFrame(frame.body as WebuiBrowserImageFrame);
      },
    });
    return () => {
      stopped = true;
      session.close();
    };
  }

  function watchBrowserWebTabs(
    operation: string,
    requestBody: { readonly surface: WebuiBrowserSurface },
    onSnapshot: (snapshot: WebuiBrowserWebTabSnapshot) => void,
  ): () => void {
    let stopped = false;
    const session = openWireSession(operation, requestBody, {
      frame: (_session, frame) => {
        // A stopped watch must not deliver, and `close()` is not a promise that
        // the socket stops emitting: the caller's flag is what guarantees it.
        if (stopped) return;
        if (frame.kind !== "event" || !frame.body || typeof frame.body !== "object") return;
        onSnapshot(frame.body as WebuiBrowserWebTabSnapshot);
      },
    });
    return () => {
      stopped = true;
      session.close();
    };
  }

  /**
   * The standalone presentation lease: one frame, then the socket stays open.
   *
   * The same shape as the terminal and browser watches, and for the same reason —
   * a stop must not deliver, and `close()` is not a promise that the socket stops
   * emitting. What differs is what the open socket *means*: the service holds the
   * lease while it lives, so closing this watch is the release.
   */
  function watchMiniAppPresentation(
    operation: string,
    requestBody: { readonly pluginId: string; readonly sessionId: string },
    onFrame: (state: WebuiMiniAppPresentationState) => void,
    onFailure?: (error: Error) => void,
  ): () => void {
    let stopped = false;
    let session: WebuiWireSession | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelayMs = 250;
    let failureReported = false;
    const reconnect = (currentSession: WebuiWireSession | undefined, error: Error): void => {
      if (stopped) return;
      if (retryTimer !== undefined) return;
      if (!failureReported) {
        failureReported = true;
        onFailure?.(error);
      }
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (stopped) return;
        open();
        retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
      }, retryDelayMs);
      currentSession?.close();
    };
    const open = (): void => {
      session = openWireSession(operation, requestBody, {
      frame: (currentSession, frame) => {
        if (stopped) return;
        if (frame.kind === "error") {
          // A refusal is a failure, not an absent lease: the service could not
          // establish the presentation, and saying "no lease" would let the
          // caller read a broken host as a closed tab. The socket is closed with
          // it, because nothing is being held on the other end.
          stopped = true;
          currentSession.close();
          onFailure?.(
            new WebuiWireError(
              frame.code,
              frame.message ?? `${operation} refused`,
              frame.requestId,
            ),
          );
          return;
        }
        if (frame.kind !== "event" || !frame.body || typeof frame.body !== "object") return;
        failureReported = false;
        if (stableTimer !== undefined) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          stableTimer = undefined;
          retryDelayMs = 250;
        }, 10_000);
        onFrame(frame.body as WebuiMiniAppPresentationState);
      },
      invalidFrame: (currentSession, reason) => {
        reconnect(currentSession, rejectionError(reason, operation));
      },
      closed: (currentSession) =>
        reconnect(currentSession, new WebuiWireError("runtime_unavailable", `${operation} connection closed`)),
      failed: (currentSession) =>
        reconnect(currentSession, new WebuiWireError("runtime_unavailable", `${operation} connection failed`)),
      });
    };
    open();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (stableTimer !== undefined) clearTimeout(stableTimer);
      session?.close();
    };
  }

  function watchMiniAppAgentTurn(
    operation: string,
    requestBody: WebuiMiniAppAgentTurnRequest,
    onFrame: (frame: WebuiMiniAppAgentTurnFrame) => void,
    onFailure?: (error: Error) => void,
  ): () => void {
    let stopped = false;
    const transportFailure = (session: WebuiWireSession, message: string): void => {
      if (stopped) return;
      stopped = true;
      session.close();
      onFailure?.(new WebuiWireError("result_unknown", message));
    };
    const session = openWireSession(operation, requestBody, {
      frame: (session, frame) => {
        if (stopped) return;
        if (frame.kind === "error") {
          // The service refused the turn before running it, or the stream broke.
          // Either way this turn is over: the caller decides what the code means.
          stopped = true;
          session.close();
          onFailure?.(
            new WebuiWireError(
              frame.code,
              frame.message ?? `${operation} refused`,
              frame.requestId,
            ),
          );
          return;
        }
        if (frame.kind !== "event" || !frame.body || typeof frame.body !== "object") return;
        const decoded = frame.body as WebuiMiniAppAgentTurnFrame;
        // The settlement is the last frame; nothing after it belongs to this turn.
        if (decoded.kind === "settled" || decoded.kind === "failure") stopped = true;
        onFrame(decoded);
      },
      invalidFrame: (session) =>
        transportFailure(session, `${operation} returned an invalid turn frame`),
      closed: (session) =>
        transportFailure(session, `${operation} connection closed before settlement`),
      failed: (session) =>
        transportFailure(session, `${operation} connection failed before settlement`),
    });
    return () => {
      stopped = true;
      session.close();
    };
  }

  function watchMiniAppPresenter(
    operation: string,
    onFrame: (intent: WebuiMiniAppPresentationIntent) => void,
    onFailure?: (error: Error) => void,
  ): () => void {
    let stopped = false;
    let session: WebuiWireSession | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let delayMs = 250;
    let failureReported = false;
    const reconnect = (current: WebuiWireSession, error: Error): void => {
      if (stopped || retryTimer !== undefined) return;
      if (!failureReported) {
        failureReported = true;
        onFailure?.(error);
      }
      current.close();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!stopped) open();
        delayMs = Math.min(delayMs * 2, 5_000);
      }, delayMs);
    };
    const open = (): void => {
      session = openWireSession(operation, undefined, {
        frame: (current, frame) => {
          if (stopped) return;
          if (frame.kind === "error") {
            stopped = true;
            current.close();
            onFailure?.(new WebuiWireError(frame.code, frame.message ?? `${operation} refused`));
            return;
          }
          if (frame.kind !== "event" || !frame.body || typeof frame.body !== "object") return;
          failureReported = false;
          if (stableTimer !== undefined) clearTimeout(stableTimer);
          stableTimer = setTimeout(() => {
            stableTimer = undefined;
            delayMs = 250;
          }, 10_000);
          onFrame(frame.body as WebuiMiniAppPresentationIntent);
        },
        invalidFrame: (current, reason) => reconnect(current, rejectionError(reason, operation)),
        closed: (current) => reconnect(current, new WebuiWireError("runtime_unavailable", `${operation} connection closed`)),
        failed: (current) => reconnect(current, new WebuiWireError("runtime_unavailable", `${operation} connection failed`)),
      });
    };
    open();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (stableTimer !== undefined) clearTimeout(stableTimer);
      session?.close();
    };
  }

  function miniappStandaloneUrl({
    pluginId,
    sessionId,
  }: {
    readonly pluginId: string;
    readonly sessionId: string;
  }): string {
    // Same base rule as `workspaceFileUrl`: the socket URL carries the token, the
    // page route checks it, and `ws:`/`wss:` share a prefix so one substitution
    // reaches `http:`/`https:`.
    const base = baseWebsocketUrl.replace(/\/$/u, "").replace(/^ws/iu, "http");
    const query = new URLSearchParams({ token, plugin: pluginId, session: sessionId });
    return `${base}/miniapp?${query.toString()}`;
  }

  function workspaceFileUrl({
    workspaceDir,
    path: filePath,
  }: {
    readonly workspaceDir: string;
    readonly path: string;
  }): string {
    // `ws:`/`wss:` share the `ws` prefix, so one substitution lands on
    // `http:`/`https:` respectively, and it must happen before the token is
    // appended — the server checks the token on this route like any other.
    const base = baseWebsocketUrl.replace(/\/$/u, "").replace(/^ws/iu, "http");
    const query = new URLSearchParams({ dir: workspaceDir, path: filePath, token });
    return `${base}/workspace-file?${query.toString()}`;
  }

  return {
    request,
    stream,
    watchTerminal,
    watchFrames,
    watchBrowserFrames,
    watchBrowserWebTabs,
    watchMiniAppPresentation,
    watchMiniAppPresenter,
    watchMiniAppAgentTurn,
    workspaceFileUrl,
    miniappStandaloneUrl,
    watchEvents: createWebuiEventChannel({ websocketUrl, webSocket }),
  };
}
