import type { WebSocket } from "ws";
import {
  isWebuiFrame,
  WebuiErrorCode,
  WEBUI_PROTOCOL_VERSION,
  type WebuiErrorFrame,
  type WebuiEventFrame,
  type WebuiResponseFrame,
} from "../envelope.js";
import type { WebuiOperationRegistryEntry } from "./operations.js";

export async function dispatchWebuiFrame(
  ws: WebSocket,
  parsed: unknown,
  operations: ReadonlyMap<string, WebuiOperationRegistryEntry>,
  accepting: boolean,
  getSignal: () => AbortSignal | undefined,
): Promise<void> {
    if (!isWebuiFrame(parsed)) {
      sendFrame(
        ws,
        errorFrame(
          "anonymous",
          WebuiErrorCode.protocolMismatch,
          "frame does not match the WebUI envelope",
        ),
      );
      return;
    }
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
        // One finalisation, two routes to reach it.
        //
        // The abort listener exists for the case that made this non-obvious: a
        // client that disconnects mid-stream leaves the pump parked on a `next()`
        // that may never settle, so the `finally` below would never run. The
        // listener is the only thing that can finish that iterator.
        //
        // But when the pull DOES settle, the loop breaks and the `finally` runs
        // too — and calling `return()` twice on a live async iterator is a real
        // double-close on whatever subscription it holds. Hence one idempotent
        // gate rather than two call sites. A local `let` is enough: the
        // listener and the `finally` share this closure and this invocation.
        let finalised = false;
        const finalise = async (): Promise<void> => {
          if (finalised) return;
          finalised = true;
          await iterator.return?.();
        };
        const close = () => void finalise();
        signal?.addEventListener("abort", close, { once: true });
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
            const next = await iterator.next();
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
      const errorCode =
        error && typeof error === "object" &&
        typeof (error as { readonly code?: unknown }).code === "string" &&
        Object.values(WebuiErrorCode).includes(
          (error as { readonly code: string }).code as (typeof WebuiErrorCode)[keyof typeof WebuiErrorCode],
        )
          ? ((error as { readonly code: string }).code as (typeof WebuiErrorCode)[keyof typeof WebuiErrorCode])
          : WebuiErrorCode.harnessError;
      sendFrame(
        ws,
        errorFrame(parsed.requestId, errorCode, message),
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
): WebuiErrorFrame {
  return {
    protocolVersion: WEBUI_PROTOCOL_VERSION,
    kind: "error",
    requestId,
    code,
    message,
  };
}
