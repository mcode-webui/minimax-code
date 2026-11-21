import type { WebSocket } from "ws";
import { judgeWebuiFrame } from "../envelope.js";
import {
  WebuiErrorCode,
  WEBUI_PROTOCOL_VERSION,
  type WebuiErrorFrame,
  type WebuiEventFrame,
  type WebuiResponseFrame,
  type WebuiWireErrorCode,
} from "../../shared/envelope.js";
import type { WebuiOperationRegistryEntry } from "./operations.js";
import { OPEN_MINI_APP_OPERATION_NAME } from "../../shared/operation-names.js";

/**
 * The stable code a thrown failure carries, if it names one.
 *
 * A capability that answers a refusal with its own code has said something more
 * precise than "harness error", and the client's correct response to that is not
 * to flatten it into one. This was the rule before: only the eight codes in
 * `WebuiErrorCode` survived and everything else became `harness_error`, so a
 * runtime's stable code was discarded on its way to the browser.
 */
function stableCodeOf(error: unknown): WebuiWireErrorCode {
  if (error && typeof error === "object") {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return WebuiErrorCode.harnessError;
}

export async function dispatchWebuiFrame(
  ws: WebSocket,
  incoming: unknown,
  operations: ReadonlyMap<string, WebuiOperationRegistryEntry>,
  accepting: boolean,
  getSignal: () => AbortSignal | undefined,
): Promise<void> {
    const judgement = judgeWebuiFrame(incoming);
    if (!judgement.ok) {
      // An unusable frame carries no trustworthy identity, so the refusal is
      // anonymous: attributing it to a requestId we could not verify would tell
      // one request it had failed when the frame was never about it.
      sendFrame(ws, errorFrame("anonymous", judgement.code, judgement.message));
      return;
    }
    const parsed = judgement.frame;
    if (parsed.kind !== "request") {
      sendFrame(
        ws,
        errorFrame(
          parsed.requestId,
          WebuiErrorCode.invalidEnvelope,
          "servers do not accept client non-request frames",
        ),
      );
      return;
    }
    if (!accepting) {
      sendFrame(
        ws,
        errorFrame(
          parsed.requestId,
          WebuiErrorCode.shuttingDown,
          "service is shutting down",
        ),
      );
      return;
    }
    const entry = operations.get(parsed.operation);
    if (!entry) {
      sendFrame(
        ws,
        errorFrame(
          parsed.requestId,
          WebuiErrorCode.unknownOperation,
          `unknown operation: ${parsed.operation}`,
        ),
      );
      return;
    }
    const validated = entry.operation.validate(parsed.body);
    if (!validated.ok) {
      sendFrame(
        ws,
        errorFrame(parsed.requestId, validated.code, validated.message),
      );
      return;
    }
    try {
      const result = await entry.handle(
        {
          requestId: parsed.requestId,
          signal: getSignal(),
        },
        validated.body,
      );
      if ("stream" in result) {
        if (!result.stream.ok) {
          sendFrame(
            ws,
            errorFrame(
              parsed.requestId,
              result.stream.body.key ?? WebuiErrorCode.harnessError,
              result.stream.body.message,
            ),
          );
          return;
        }
        const iterator = toAsyncIterator(
          result.stream.source as AsyncIterable<unknown> | Iterable<unknown>,
        );
        const signal = getSignal();
        // Abort wakes a parked pump. Both paths share finalization, and finally
        // reports its outcome through the existing request error handling.
        let finalisation: Promise<void> | undefined;
        const finalise = (): Promise<void> => {
          finalisation ??= Promise.resolve().then(async () => { await iterator.return?.(); });
          return finalisation;
        };
        let releaseAbort!: () => void;
        const aborted = new Promise<IteratorResult<unknown>>((resolve) => {
          releaseAbort = () => resolve({ done: true, value: undefined });
        });
        const close = () => {
          // finally owns the failure; observe it here while next is parked.
          void finalise().catch(() => undefined);
          releaseAbort();
        };
        signal?.addEventListener("abort", close, { once: true });
        if (signal?.aborted) close();
        // Acknowledge before pumping, but only for the operations that opt
        // in. The data streams keep their original wire shape so any
        // consumer expecting only `event` frames is unaffected. "Accepted"
        // is exactly what this means: the source is not pulled until the
        // loop below, and whatever subscription the source performs on its
        // first pull happens after this frame is on the wire.
        if (entry.operation.acknowledgesStream)
          sendFrame(ws, responseFrame(parsed.requestId, { stream: true }));
        try {
          while (!signal?.aborted) {
            const next = await Promise.race([iterator.next(), aborted]);
            if (next.done || signal?.aborted) break;
            sendFrame(ws, eventFrame(parsed.requestId, next.value));
          }
        } finally {
          signal?.removeEventListener("abort", close);
          await finalise();
        }
        return;
      }
      sendFrame(ws, responseFrame(parsed.requestId, result.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = stableCodeOf(error);
      const miniAppPreparationFailed = parsed.operation === OPEN_MINI_APP_OPERATION_NAME &&
        code === "MINIAPP_PREPARATION_FAILED";
      let reasonCode: string | undefined;
      if (miniAppPreparationFailed) {
        const reason = (error as { reasonCode?: unknown }).reasonCode ??
          (error instanceof Error ? stableCodeOf(error.cause) : undefined);
        if (typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(reason)) {
          reasonCode = reason;
        }
        console.warn("[webui] Mini App publication preparation failed", { code, reasonCode });
      }
      // The capability's own stable code is preserved; only a failure that names
      // no code at all becomes `harness_error`.
      sendFrame(
        ws,
        errorFrame(parsed.requestId, code, message, reasonCode),
      );
    }
}

function toAsyncIterator<T>(
  source: AsyncIterable<T> | Iterable<T>,
): AsyncIterator<T> {
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]();
  const iterator = source[Symbol.iterator]();
  return {
    next: () => Promise.resolve(iterator.next()),
    return: (value?: unknown) =>
      Promise.resolve(iterator.return?.(value) ?? { done: true, value }),
  };
}

export function sendFrame(
  ws: WebSocket,
  frame: WebuiResponseFrame | WebuiErrorFrame | WebuiEventFrame,
) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function eventFrame(requestId: string, body: unknown): WebuiEventFrame {
  return {
    protocolVersion: WEBUI_PROTOCOL_VERSION,
    kind: "event",
    requestId,
    body,
  };
}

function responseFrame(requestId: string, body: unknown): WebuiResponseFrame {
  return {
    protocolVersion: WEBUI_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    body,
  };
}

export function errorFrame(
  requestId: string,
  code: string,
  message: string,
  reasonCode?: string,
): WebuiErrorFrame {
  return {
    protocolVersion: WEBUI_PROTOCOL_VERSION,
    kind: "error",
    requestId,
    code,
    message,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  };
}
